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
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  localPersistentStorage,
  opfsPersistentStorage,
} from '../../src/persistentStorage/storageAdapter';
import {
  resetManagedLocalStorageState,
  upsertManagedLocalStorageNamespaceEntry,
} from '../../src/persistentStorage/localStorageMetadata';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetManagedLocalStorageState();
});

describe('localStorage adapter', () => {
  const adapter = localPersistentStorage;

  beforeEach(() => {
    vi.setSystemTime(TEST_INITIAL_TIME);
  });

  test('read returns null for missing key', () => {
    const result = adapter.read('nonexistent');
    expect(result).toBeNull();
  });

  test('write and read roundtrip', () => {
    adapter.write('test-key', { name: 'Alice', age: 30 });
    const result = adapter.read('test-key');

    expect(result).toMatchInlineSnapshot(`
      age: 30
      name: 'Alice'
    `);
  });

  test('remove deletes key', () => {
    adapter.write('to-remove', { value: 42 });
    adapter.remove('to-remove');

    const result = adapter.read('to-remove');
    expect(result).toBeNull();
  });

  test('removeByPrefix removes all matching keys', () => {
    adapter.write('tsdf.session1.store1', { a: 1 });
    adapter.write('tsdf.session1.store2', { b: 2 });
    adapter.write('tsdf.session2.store1', { c: 3 });

    adapter.removeByPrefix('tsdf.session1.');

    const result1 = adapter.read('tsdf.session1.store1');
    const result2 = adapter.read('tsdf.session1.store2');
    const result3 = adapter.read('tsdf.session2.store1');

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(result3).toMatchInlineSnapshot(`c: 3`);
  });

  test('listKeys returns matching keys', () => {
    adapter.write('tsdf.s1.a', 1);
    adapter.write('tsdf.s1.b', 2);
    adapter.write('tsdf.s2.a', 3);

    const keys = adapter.listKeys('tsdf.s1.');

    expect(keys.sort()).toMatchInlineSnapshot(`['tsdf.s1.a', 'tsdf.s1.b']`);
  });

  test('read handles invalid JSON gracefully', () => {
    localStorage.setItem('bad-json', '{invalid');

    const result = adapter.read('bad-json');
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

  test('missing navigator.locks falls back to unlocked local storage coordination and warns once', () => {
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: null,
      writable: true,
      configurable: true,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    adapter.write('disabled-key', { name: 'Alice' });
    const firstRead = adapter.read('disabled-key');
    const keys = adapter.listKeys('disabled');
    adapter.remove('disabled-key');

    expect(firstRead).toMatchInlineSnapshot(`name: 'Alice'`);
    expect(keys).toMatchInlineSnapshot(`['disabled-key']`);
    expect(localStorage.getItem('disabled-key')).toBeNull();
    expect(warnSpy.mock.calls).toMatchInlineSnapshot(`
      - - '[TSDF] navigator.locks is unavailable; localPersistentStorage is using unlocked localStorage coordination.'
    `);

    warnSpy.mockRestore();
  });

  test('namespace metadata is stored without redundant root and payload keys', () => {
    const prefix = 'tsdf.sess1.compact-metadata.collection.item.';
    const rootKey = localPersistentStorage.getRootKeyForPrefix(prefix);

    upsertManagedLocalStorageNamespaceEntry({
      sessionKey: 'sess1',
      storeName: 'compact-metadata',
      storagePrefix: prefix,
      entryKey: '"a',
      payloadKey: `${prefix}"a`,
      maxAgeMs: 60_000,
      lastAccessAt: 1,
    });

    expect(rootKey).toMatchInlineSnapshot(
      `"tsdf._m.r.n:sess1.compact-metadata.ci"`,
    );
    expect(JSON.parse(localStorage.getItem('tsdf._m.c') ?? 'null'))
      .toMatchInlineSnapshot(`
        roots:
          - cleanupIntervalMs: 86400000
            lastCleanupAt: null
            maxAgeMs: 60000
            mode: 'namespace'
            sessionKey: 'sess1'
            storageKey: null
            storagePrefix: 'tsdf.sess1.compact-metadata.collection.item.'
            storeName: 'compact-metadata'
            version: 1
        version: 1
      `);
    expect(JSON.parse(localStorage.getItem(`${rootKey}.m`) ?? 'null'))
      .toMatchInlineSnapshot(`
        entries:
          - entryKey: '"a'
            lastAccessAt: 1
        version: 1
      `);
  });

  test('unlocked metadata reads pick up external manifest updates instead of serving stale cached data', () => {
    const prefix = 'tsdf.sess1.external-sync.collection.item.';
    const rootKey = localPersistentStorage.getRootKeyForPrefix(prefix);
    const manifestKey = `${rootKey}.m`;

    // Prime metadata using the normal managed-local-storage write path.
    upsertManagedLocalStorageNamespaceEntry({
      sessionKey: 'sess1',
      storeName: 'external-sync',
      storagePrefix: prefix,
      entryKey: '"a',
      payloadKey: `${prefix}"a`,
      maxAgeMs: 60_000,
      lastAccessAt: 1,
    });

    // First read warms the current runtime's metadata path.
    expect(localPersistentStorage.listEntryMetadata(prefix))
      .toMatchInlineSnapshot(`
        - entryKey: '"a'
          lastAccessAt: 1
          payloadKey: 'tsdf.sess1.external-sync.collection.item."a'
      `);

    // Simulate another tab rewriting the manifest directly in localStorage.
    localStorage.setItem(
      manifestKey,
      JSON.stringify({
        version: 1,
        entries: [{ entryKey: '"b', lastAccessAt: 2 }],
      }),
    );

    expect(localPersistentStorage.listEntryMetadata(prefix))
      .toMatchInlineSnapshot(`
        - entryKey: '"b'
          lastAccessAt: 2
          payloadKey: 'tsdf.sess1.external-sync.collection.item."b'
      `);
  });

  test('locked metadata cache stays coherent across awaits until the lock is released', async () => {
    const prefix = 'tsdf.sess1.awaited-lock.collection.item.';
    const rootKey = localPersistentStorage.getRootKeyForPrefix(prefix);
    const manifestKey = `${rootKey}.m`;

    upsertManagedLocalStorageNamespaceEntry({
      sessionKey: 'sess1',
      storeName: 'awaited-lock',
      storagePrefix: prefix,
      entryKey: '"a',
      payloadKey: `${prefix}"a`,
      maxAgeMs: 60_000,
      lastAccessAt: 1,
    });

    await localPersistentStorage.runLocked(async () => {
      expect(localPersistentStorage.listEntryMetadata(prefix))
        .toMatchInlineSnapshot(`
          - entryKey: '"a'
            lastAccessAt: 1
            payloadKey: 'tsdf.sess1.awaited-lock.collection.item."a'
        `);

      await Promise.resolve();

      // Simulate a non-coordinated external write while this tab still holds the lock.
      localStorage.setItem(
        manifestKey,
        JSON.stringify({
          version: 1,
          entries: [{ entryKey: '"b', lastAccessAt: 2 }],
        }),
      );

      expect(localPersistentStorage.listEntryMetadata(prefix))
        .toMatchInlineSnapshot(`
          - entryKey: '"a'
            lastAccessAt: 1
            payloadKey: 'tsdf.sess1.awaited-lock.collection.item."a'
        `);
    });

    expect(localPersistentStorage.listEntryMetadata(prefix))
      .toMatchInlineSnapshot(`
        - entryKey: '"b'
          lastAccessAt: 2
          payloadKey: 'tsdf.sess1.awaited-lock.collection.item."b'
      `);
  });

  test('locked metadata cache invalidates a cleared root before recreating it', async () => {
    const prefix = 'tsdf.sess1.clear-recreate.collection.item.';
    const rootKey = localPersistentStorage.getRootKeyForPrefix(prefix);

    upsertManagedLocalStorageNamespaceEntry({
      sessionKey: 'sess1',
      storeName: 'clear-recreate',
      storagePrefix: prefix,
      entryKey: '"a',
      payloadKey: `${prefix}"a`,
      maxAgeMs: 60_000,
      lastAccessAt: 1,
    });

    await localPersistentStorage.runLocked(() => {
      // Warm the lock-scoped metadata path, then clear and recreate the root.
      expect(localPersistentStorage.listEntryMetadata(prefix))
        .toMatchInlineSnapshot(`
          - entryKey: '"a'
            lastAccessAt: 1
            payloadKey: 'tsdf.sess1.clear-recreate.collection.item."a'
        `);

      localPersistentStorage.clearRoot(rootKey);
      localPersistentStorage.upsertNamespaceEntry({
        sessionKey: 'sess1',
        storeName: 'clear-recreate',
        storagePrefix: prefix,
        entryKey: '"b',
        payloadKey: `${prefix}"b`,
        maxAgeMs: 60_000,
        lastAccessAt: 2,
      });

      expect(localPersistentStorage.listEntryMetadata(prefix))
        .toMatchInlineSnapshot(`
          - entryKey: '"b'
            lastAccessAt: 2
            payloadKey: 'tsdf.sess1.clear-recreate.collection.item."b'
        `);
    });
  });

  test('persistent storage config accepts the local-sync adapter sentinel', () => {
    createLocalStoragePersistentTestStore()
      .scope('custom-sync', 'test-session')
      .document.seed({ value: { name: 'cached', value: 1 } });

    const env = createDocumentStoreTestEnv(
      { name: 'server', value: 2 },
      {
        persistentStorage: {
          storeName: 'custom-sync',
          adapter: 'local-sync',
          schema: rc_object({
            value: rc_object({ name: rc_string, value: rc_number }),
          }),
        },
      },
    );

    expect(env.store.state).toMatchInlineSnapshot(`
      data:
        value: { name: 'cached', value: 1 }

      error: null
      refetchOnMount: 'lowPriority'
      status: 'success'
    `);
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
