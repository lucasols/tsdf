/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- The OPFS test doubles implement browser APIs with minimal fixtures, which trips rules meant for production code. */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createStorageAdapter } from '../../src/persistentStorage/storageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageNamespaceScope,
  SyncStorageAdapter,
} from '../../src/persistentStorage/types';

type DirNode = { dirs: Map<string, DirNode>; files: Map<string, string> };

function createDirNode(): DirNode {
  return { dirs: new Map(), files: new Map() };
}

function createDirectoryHandle(node: DirNode): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name: '',
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      const existing = node.dirs.get(name);
      if (existing) {
        return createDirectoryHandle(existing);
      }
      if (!options?.create) {
        throw new DOMException('Not found', 'NotFoundError');
      }
      const next = createDirNode();
      node.dirs.set(name, next);
      return createDirectoryHandle(next);
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!node.files.has(name) && !options?.create) {
        throw new DOMException('Not found', 'NotFoundError');
      }
      if (!node.files.has(name)) {
        node.files.set(name, '');
      }
      return {
        kind: 'file',
        name,
        async getFile() {
          return {
            async text() {
              return node.files.get(name) ?? '';
            },
          } as File;
        },
        async createWritable() {
          let nextContent = node.files.get(name) ?? '';
          return {
            async write(data: string) {
              nextContent = data;
            },
            async close() {
              node.files.set(name, nextContent);
            },
          } as FileSystemWritableFileStream;
        },
      } as FileSystemFileHandle;
    },
    async removeEntry(name: string, options?: { recursive?: boolean }) {
      if (node.files.delete(name)) return;
      const dir = node.dirs.get(name);
      if (!dir) {
        throw new DOMException('Not found', 'NotFoundError');
      }
      if (!options?.recursive && (dir.files.size > 0 || dir.dirs.size > 0)) {
        throw new DOMException(
          'Directory not empty',
          'InvalidModificationError',
        );
      }
      node.dirs.delete(name);
    },
    entries() {
      const items: Array<[string, FileSystemHandle]> = [
        ...[...node.dirs.entries()].map(
          ([name, child]) =>
            [name, createDirectoryHandle(child)] as [string, FileSystemHandle],
        ),
        ...[...node.files.keys()].map(
          (name) =>
            [name, { kind: 'file', name } as FileSystemHandle] as [
              string,
              FileSystemHandle,
            ],
        ),
      ];

      return (async function* (): AsyncGenerator<[string, FileSystemHandle]> {
        for (const item of items) {
          yield item;
        }
      })();
    },
  } as FileSystemDirectoryHandle;
}

function createOpfsTestEnv() {
  const rootNode = createDirNode();
  const originalStorage = navigator.storage;

  Object.defineProperty(navigator, 'storage', {
    value: { getDirectory: async () => createDirectoryHandle(rootNode) },
    configurable: true,
    writable: true,
  });

  return {
    cleanup() {
      Object.defineProperty(navigator, 'storage', {
        value: originalStorage,
        configurable: true,
        writable: true,
      });
    },
  };
}

function getLocalAdapter(): SyncStorageAdapter {
  return createStorageAdapter('localStorage') as SyncStorageAdapter;
}

function getOpfsAdapter(): AsyncStorageAdapter {
  return createStorageAdapter('opfs') as AsyncStorageAdapter;
}

const collectionScope: AsyncStorageNamespaceScope = {
  sessionKey: 'sess-1',
  storeName: 'users',
  kind: 'collection.item',
};

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage adapter', () => {
  test('read returns null for missing keys', async () => {
    const adapter = getLocalAdapter();
    await expect(Promise.resolve(adapter.read('missing'))).resolves.toBeNull();
  });

  test('write/read/remove roundtrip works', async () => {
    const adapter = getLocalAdapter();

    adapter.write('item', { value: 1 });
    await expect(Promise.resolve(adapter.read('item'))).resolves
      .toMatchInlineSnapshot(`
      value: 1
    `);

    adapter.remove('item');
    await expect(Promise.resolve(adapter.read('item'))).resolves.toBeNull();
  });

  test('removeByPrefix and listKeys work with prefixes', async () => {
    const adapter = getLocalAdapter();

    adapter.write('tsdf.a.one', 1);
    adapter.write('tsdf.a.two', 2);
    adapter.write('tsdf.b.one', 3);

    await expect(Promise.resolve(adapter.listKeys('tsdf.a.'))).resolves.toEqual(
      ['tsdf.a.one', 'tsdf.a.two'],
    );

    adapter.removeByPrefix('tsdf.a.');
    await expect(Promise.resolve(adapter.listKeys('tsdf.'))).resolves.toEqual([
      'tsdf.b.one',
    ]);
  });
});

describe('opfs adapter', () => {
  test('commit/get/listMetadata/clear roundtrip works per namespace', async () => {
    const env = createOpfsTestEnv();
    try {
      const adapter = getOpfsAdapter();
      const namespace = adapter.openNamespace<
        { data: { id: string } },
        { payload: string }
      >(collectionScope);

      await namespace.commit({
        upserts: [
          {
            key: 'user:1',
            value: { data: { id: '1' } },
            version: 2,
            metadata: { payload: '1' },
          },
        ],
      });

      await expect(
        namespace.get('user:1', { touch: 'never' }),
      ).resolves.toMatchObject({
        value: { data: { id: '1' } },
        metadata: {
          key: 'user:1',
          lastAccessAt: 1773230400000,
          payload: '1',
          sizeBytes: 19,
          version: 2,
          writtenAt: 1773230400000,
        },
      });
      await expect(
        namespace.get('user:1', { touch: 'never' }),
      ).resolves.toSatisfy(
        (entry) => typeof entry?.metadata.payloadRef === 'string',
      );

      const metadata = await namespace.listMetadata({ order: 'key' });
      expect(metadata.entries.map((entry) => entry.key)).toEqual(['user:1']);

      await namespace.clear();
      await expect(
        namespace.get('user:1', { touch: 'never' }),
      ).resolves.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  test('listMetadata paginates by cursor without requiring payload reads', async () => {
    const env = createOpfsTestEnv();
    try {
      const adapter = getOpfsAdapter();
      const namespace = adapter.openNamespace<{ value: number }>(
        collectionScope,
      );

      await namespace.commit({
        upserts: [
          { key: 'a', value: { value: 1 }, version: 1 },
          { key: 'b', value: { value: 2 }, version: 1 },
          { key: 'c', value: { value: 3 }, version: 1 },
        ],
      });

      const firstPage = await namespace.listMetadata({
        order: 'key',
        limit: 2,
      });
      const secondPage = await namespace.listMetadata({
        order: 'key',
        cursor: firstPage.cursor,
        limit: 2,
      });

      expect({
        firstPageCursorPresent: firstPage.cursor !== null,
        firstPageKeys: firstPage.entries.map((entry) => entry.key),
        secondPageCursorPresent: secondPage.cursor !== null,
        secondPageKeys: secondPage.entries.map((entry) => entry.key),
      }).toMatchInlineSnapshot(`
        firstPageCursorPresent: '✅'
        firstPageKeys: ['a', 'b']
        secondPageCursorPresent: '❌'
        secondPageKeys: ['c']
      `);
    } finally {
      env.cleanup();
    }
  });

  test('getMany returns values in requested order and coarse touch only updates outside the bucket', async () => {
    const env = createOpfsTestEnv();
    try {
      const adapter = getOpfsAdapter();
      const namespace = adapter.openNamespace<{ value: number }>(
        collectionScope,
      );

      await namespace.commit({
        upserts: [
          { key: 'a', value: { value: 1 }, version: 1 },
          { key: 'b', value: { value: 2 }, version: 1 },
        ],
      });

      const firstRead = await namespace.getMany(['b', 'missing', 'a'], {
        touch: 'coarse',
      });
      expect(firstRead.map((entry) => entry?.value.value ?? null)).toEqual([
        2,
        null,
        1,
      ]);

      const firstMetadata = await namespace.listMetadata({ order: 'key' });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await namespace.get('a', { touch: 'coarse' });
      const secondMetadata = await namespace.listMetadata({ order: 'key' });
      expect(secondMetadata.entries[0]?.lastAccessAt).toBe(
        firstMetadata.entries[0]?.lastAccessAt,
      );

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      await namespace.get('a', { touch: 'coarse' });
      const thirdMetadata = await namespace.listMetadata({ order: 'key' });
      expect(thirdMetadata.entries[0]?.lastAccessAt).toBeGreaterThan(
        secondMetadata.entries[0]?.lastAccessAt ?? 0,
      );
    } finally {
      env.cleanup();
    }
  });

  test('startup cleanup lease respects holder ownership and finish updates maintenance state', async () => {
    const env = createOpfsTestEnv();
    try {
      const adapter = getOpfsAdapter();

      await expect(
        adapter.tryAcquireStartupCleanupLease({
          holderId: 'tab-a',
          ttlMs: 60_000,
        }),
      ).resolves.toBe(true);
      await expect(
        adapter.tryAcquireStartupCleanupLease({
          holderId: 'tab-b',
          ttlMs: 60_000,
        }),
      ).resolves.toBe(false);

      await adapter.finishStartupCleanup({
        holderId: 'tab-a',
        finishedAt: Date.now(),
      });

      await expect(adapter.readMaintenanceState()).resolves.toEqual({
        lastSuccessfulCleanupAt: 1773230400000,
        startupCleanupLease: null,
      });
    } finally {
      env.cleanup();
    }
  });
});
