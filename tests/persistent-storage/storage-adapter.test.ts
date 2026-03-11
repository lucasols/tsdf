import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { murmur3 } from '@ls-stack/utils/hash';
import {
  localPersistentStorage,
  opfsPersistentStorage,
} from '../../src/persistentStorage/storageAdapter';
import type { StorageAdapter } from '../../src/persistentStorage/types';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage adapter', () => {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = localPersistentStorage;
  });

  test('read returns null for missing key', async () => {
    const result = await adapter.read('nonexistent');
    expect(result).toBeNull();
  });

  test('write and read roundtrip', async () => {
    await adapter.write('test-key', { name: 'Alice', age: 30 });
    const result = await adapter.read('test-key');

    expect(result).toMatchInlineSnapshot(`
      age: 30
      name: 'Alice'
    `);
  });

  test('remove deletes key', async () => {
    await adapter.write('to-remove', { value: 42 });
    await adapter.remove('to-remove');

    const result = await adapter.read('to-remove');
    expect(result).toBeNull();
  });

  test('removeByPrefix removes all matching keys', async () => {
    await adapter.write('tsdf.session1.store1', { a: 1 });
    await adapter.write('tsdf.session1.store2', { b: 2 });
    await adapter.write('tsdf.session2.store1', { c: 3 });

    await adapter.removeByPrefix('tsdf.session1.');

    const result1 = await adapter.read('tsdf.session1.store1');
    const result2 = await adapter.read('tsdf.session1.store2');
    const result3 = await adapter.read('tsdf.session2.store1');

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(result3).toMatchInlineSnapshot(`c: 3`);
  });

  test('listKeys returns matching keys', async () => {
    await adapter.write('tsdf.s1.a', 1);
    await adapter.write('tsdf.s1.b', 2);
    await adapter.write('tsdf.s2.a', 3);

    const keys = await adapter.listKeys('tsdf.s1.');

    expect(keys.sort()).toMatchInlineSnapshot(`['tsdf.s1.a', 'tsdf.s1.b']`);
  });

  test('read handles invalid JSON gracefully', async () => {
    localStorage.setItem('bad-json', '{invalid');

    const result = await adapter.read('bad-json');
    expect(result).toBeNull();
  });

  test('write propagates quota exceeded error', () => {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const setItemSpy = vi
      .spyOn(localStorage, 'setItem')
      .mockImplementation((key: string, value: string) => {
        if (key === 'quota-test') {
          throw new DOMException('QuotaExceededError');
        }
        originalSetItem(key, value);
      });

    expect(() => adapter.write('quota-test', { large: 'data' })).toThrow(
      'QuotaExceededError',
    );

    setItemSpy.mockRestore();
  });
});

describe('opfs adapter', () => {
  /**
   * Creates an in-memory mock of the OPFS filesystem APIs
   * so we can test the real OPFS adapter logic (hashed buckets, prefix matching).
   */
  function setupMockOpfs(settings?: { maxFileNameLength?: number }) {
    const files = new Map<string, string>();

    const mockCacheDir = {
      getFileHandle(name: string, options?: { create?: boolean }) {
        if (
          options?.create &&
          settings?.maxFileNameLength !== undefined &&
          name.length > settings.maxFileNameLength
        ) {
          return Promise.reject(
            new DOMException('File name too long', 'InvalidModificationError'),
          );
        }
        if (!files.has(name) && !options?.create) {
          return Promise.reject(new DOMException('Not found', 'NotFoundError'));
        }
        if (!files.has(name)) {
          files.set(name, '');
        }
        return Promise.resolve({
          getFile: () =>
            Promise.resolve({
              text: () => Promise.resolve(files.get(name) ?? ''),
            }),
          createWritable: () => {
            let content = '';
            return Promise.resolve({
              write: (data: string) => {
                content = data;
                return Promise.resolve();
              },
              close: () => {
                files.set(name, content);
                return Promise.resolve();
              },
            });
          },
        });
      },
      removeEntry(name: string) {
        files.delete(name);
        return Promise.resolve();
      },
      entries() {
        const snapshot = [...files.keys()];
        return (async function* (): AsyncGenerator<[string, unknown]> {
          await Promise.resolve();
          for (const name of snapshot) {
            yield [name, {}];
          }
        })();
      },
    };

    const mockRootDir = {
      getDirectoryHandle: () => Promise.resolve(mockCacheDir),
    };

    const originalStorage = navigator.storage;

    Object.defineProperty(navigator, 'storage', {
      value: { getDirectory: () => Promise.resolve(mockRootDir) },
      writable: true,
      configurable: true,
    });

    return {
      files,
      cleanup: () => {
        Object.defineProperty(navigator, 'storage', {
          value: originalStorage,
          writable: true,
          configurable: true,
        });
      },
    };
  }

  test('read returns null for missing key', async () => {
    const { cleanup } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;
      const result = await adapter.read('nonexistent');
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('write and read roundtrip', async () => {
    const { cleanup, files } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;

      await adapter.write('my-key', { name: 'Alice', age: 30 });
      const result = await adapter.read('my-key');

      expect(result).toMatchInlineSnapshot(`
        age: 30
        name: 'Alice'
      `);
      expect([...files.keys()]).toMatchInlineSnapshot(`
        ['1844492593.json']
      `);
    } finally {
      cleanup();
    }
  });

  test('very long keys roundtrip even when the filesystem rejects long filenames', async () => {
    const { cleanup } = setupMockOpfs({ maxFileNameLength: 40 });
    try {
      const adapter = opfsPersistentStorage;
      const longKey = `tsdf.session.store.${'query-segment.'.repeat(40)}`;

      await adapter.write(longKey, { value: 42 });

      expect(await adapter.read(longKey)).toMatchInlineSnapshot(`value: 42`);
    } finally {
      cleanup();
    }
  });

  test('removeByPrefix correctly matches keys sharing a prefix', async () => {
    const { cleanup } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;

      await adapter.write('tsdf.session1.store1', { a: 1 });
      await adapter.write('tsdf.session1.store2', { b: 2 });
      await adapter.write('tsdf.session2.store1', { c: 3 });

      await adapter.removeByPrefix('tsdf.session1.');

      expect(await adapter.read('tsdf.session1.store1')).toBeNull();
      expect(await adapter.read('tsdf.session1.store2')).toBeNull();
      expect(await adapter.read('tsdf.session2.store1')).toMatchInlineSnapshot(
        `c: 3`,
      );
    } finally {
      cleanup();
    }
  });

  test('remove deletes key', async () => {
    const { cleanup } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;

      await adapter.write('to-remove', { value: 42 });
      await adapter.remove('to-remove');

      const result = await adapter.read('to-remove');
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('listKeys returns decoded keys matching a prefix', async () => {
    const { cleanup } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;

      await adapter.write('tsdf.s1.a', 1);
      await adapter.write('tsdf.s1.b', 2);
      await adapter.write('tsdf.s2.a', 3);

      const keys = await adapter.listKeys('tsdf.s1.');

      expect(keys.sort()).toMatchInlineSnapshot(`['tsdf.s1.a', 'tsdf.s1.b']`);
    } finally {
      cleanup();
    }
  });

  test('colliding keys share a bucket without corrupting each other', async () => {
    const { cleanup } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;
      const firstKey = 'collision-key-1ndo-m1';
      const secondKey = 'collision-key-2hwp-xd';

      expect(murmur3(firstKey, 'uint32')).toBe(murmur3(secondKey, 'uint32'));

      await adapter.write(firstKey, { name: 'first' });
      await adapter.write(secondKey, { name: 'second' });

      expect(await adapter.read(firstKey)).toMatchInlineSnapshot(
        `name: 'first'`,
      );
      expect(await adapter.read(secondKey)).toMatchInlineSnapshot(
        `name: 'second'`,
      );
      expect(await adapter.listKeys('collision-key-')).toMatchInlineSnapshot(`
        ['collision-key-1ndo-m1', 'collision-key-2hwp-xd']
      `);

      await adapter.remove(firstKey);

      expect(await adapter.read(firstKey)).toBeNull();
      expect(await adapter.read(secondKey)).toMatchInlineSnapshot(
        `name: 'second'`,
      );

      await adapter.removeByPrefix('collision-key-2hwp');

      expect(await adapter.read(secondKey)).toBeNull();
      expect(await adapter.listKeys('collision-key-')).toMatchInlineSnapshot(
        `[]`,
      );
    } finally {
      cleanup();
    }
  });

  test('malformed buckets are ignored on read and replaced on write', async () => {
    const { cleanup, files } = setupMockOpfs();
    try {
      const adapter = opfsPersistentStorage;
      const key = 'broken-key';
      files.set(`${murmur3(key, 'uint32')}.json`, '{broken');

      expect(await adapter.read(key)).toBeNull();
      expect(await adapter.listKeys('broken')).toMatchInlineSnapshot(`[]`);

      await adapter.write(key, { restored: true });

      expect(await adapter.read(key)).toMatchInlineSnapshot(`restored: '✅'`);
      expect(files.get(`${murmur3(key, 'uint32')}.json`)).toBe(
        '{"entries":[{"key":"broken-key","value":{"restored":true}}]}',
      );
    } finally {
      cleanup();
    }
  });
});
