import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { clearSessionStorage } from '../../src/main';
import { createAsyncStorageAdapter } from '../../src/persistentStorage/asyncStorageAdapter';
import { resetManagedLocalStorageState } from '../../src/persistentStorage/localStorageMetadata';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getPayloadRecordKey,
} from '../../src/persistentStorage/opfsFileNaming';
import type {
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageNamespaceScope,
  PersistentStorageSchema,
} from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedDocumentSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

const wrappedCollectionItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

type ListRow = { id: number; name: string };

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<ListRow>, unknown>(
  rc_object({ id: rc_number, name: rc_string }),
);
const listQueryParamsSchema = rc_object({ tableId: rc_string });
const persistentStore = createLocalStoragePersistentTestStore();

function createInMemoryAsyncStorageDriver(
  options: { cloneValues?: boolean; readDelayMs?: number } = {},
): AsyncStorageDriver & {
  getCallCount: () => number;
  getManyCallCount: () => number;
  setManyCallCount: () => number;
} {
  const storage = new Map<
    string,
    { bucket: Map<string, unknown>; scope: AsyncStorageNamespaceScope }
  >();
  let getCalls = 0;
  let getManyCalls = 0;
  let setManyCalls = 0;

  function cloneValue<T>(value: T): T {
    return options.cloneValues === true ? structuredClone(value) : value;
  }

  function readValue<T>(value: T): Promise<T> {
    const snapshot = cloneValue(value);
    if ((options.readDelayMs ?? 0) === 0) {
      return Promise.resolve(snapshot);
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(snapshot);
      }, options.readDelayMs ?? 0);
    });
  }

  function getScopeId(scope: AsyncStorageNamespaceScope): string {
    return JSON.stringify(scope);
  }

  function getScopeBucket(
    scope: AsyncStorageNamespaceScope,
  ): Map<string, unknown> {
    const scopeId = getScopeId(scope);
    const existing = storage.get(scopeId);
    if (existing) return existing.bucket;

    const created = new Map<string, unknown>();
    storage.set(scopeId, { bucket: created, scope });
    return created;
  }

  function listDiscoveredScopes(): AsyncStorageDiscoveredScope[] {
    return [...storage.values()].map(({ bucket, scope }) => {
      return { scope, knownRecordKeys: [...bucket.keys()] };
    });
  }

  return {
    clear: (scope) => {
      storage.delete(getScopeId(scope));
      return Promise.resolve();
    },
    get: (scope, key) => {
      getCalls++;
      return readValue(getScopeBucket(scope).get(key));
    },
    getMany: (scope, keys) => {
      getManyCalls++;
      const bucket = getScopeBucket(scope);
      return readValue(keys.map((key) => bucket.get(key)));
    },
    listKeys: (scope) => {
      return Promise.resolve([...getScopeBucket(scope).keys()]);
    },
    listScopes: (sessionKey) => {
      return Promise.resolve(
        listDiscoveredScopes()
          .map(({ scope }) => scope)
          .filter((scope) => {
            return sessionKey === undefined || scope.sessionKey === sessionKey;
          }),
      );
    },
    listScopesWithKnownRecordKeys: (sessionKey) => {
      return Promise.resolve(
        listDiscoveredScopes().filter(({ scope }) => {
          return sessionKey === undefined || scope.sessionKey === sessionKey;
        }),
      );
    },
    remove: (scope, key) => {
      getScopeBucket(scope).delete(key);
      return Promise.resolve();
    },
    removeMany: (scope, keys) => {
      const bucket = getScopeBucket(scope);
      for (const key of keys) {
        bucket.delete(key);
      }
      return Promise.resolve();
    },
    set: (scope, key, value) => {
      getScopeBucket(scope).set(key, cloneValue(value));
      return Promise.resolve();
    },
    setMany: (scope, entries) => {
      setManyCalls++;
      const bucket = getScopeBucket(scope);
      for (const entry of entries) {
        bucket.set(entry.key, cloneValue(entry.value));
      }
      return Promise.resolve();
    },
    getCallCount: () => getCalls,
    getManyCallCount: () => getManyCalls,
    setManyCallCount: () => setManyCalls,
  };
}

function installMockBroadcastChannel() {
  const OriginalBroadcastChannel = globalThis.BroadcastChannel;
  const listenersByChannel = new Map<string, Set<MockBroadcastChannel>>();

  function cloneMessage<T>(value: T): T {
    return structuredClone(value);
  }

  class MockBroadcastChannel extends EventTarget implements BroadcastChannel {
    readonly name: string;
    onmessage: ((this: BroadcastChannel, ev: MessageEvent) => unknown) | null =
      null;
    onmessageerror:
      | ((this: BroadcastChannel, ev: MessageEvent) => unknown)
      | null = null;

    constructor(name: string) {
      super();
      this.name = name;
      const listeners = listenersByChannel.get(name) ?? new Set();
      listeners.add(this);
      listenersByChannel.set(name, listeners);
    }

    postMessage(message: unknown) {
      for (const peer of listenersByChannel.get(this.name) ?? []) {
        if (peer === this) continue;

        setTimeout(() => {
          peer.#dispatch(cloneMessage(message));
        }, 0);
      }
    }

    close() {
      const listeners = listenersByChannel.get(this.name);
      if (listeners === undefined) return;
      listeners.delete(this);
      if (listeners.size === 0) {
        listenersByChannel.delete(this.name);
      }
    }

    #dispatch(message: unknown) {
      const event = new MessageEvent('message', { data: message });
      this.onmessage?.call(this, event);
      this.dispatchEvent(event);
    }
  }

  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

  return () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('BroadcastChannel', OriginalBroadcastChannel);
  };
}

function createDocumentEnv(options: {
  storeName: string;
  sessionKey: string;
  serverData?: { name: string; value: number };
}) {
  return createDocumentStoreTestEnv(
    options.serverData ?? { name: 'fresh', value: 42 },
    {
      id: options.storeName,
      getSessionKey: () => options.sessionKey,
      persistentStorage: {
        adapter: 'local-sync',
        schema: wrappedDocumentSchema,
      },
    },
  );
}

function createCollectionEnv(options: {
  storeName: string;
  sessionKey: string;
  serverData?: Record<string, { id: string; name: string }>;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: wrappedCollectionItemSchema,
      payloadSchema: rc_string,
    },
  });
}

function createListQueryEnv(options: {
  storeName: string;
  sessionKey: string;
  serverData?: Record<string, ListRow[]>;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey,
    persistentStorage: {
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetManagedLocalStorageState();
});

describe('persistent storage integration', () => {
  test('async adapter does not flush a pending touch when reading a different key in the same namespace', async () => {
    const driver = createInMemoryAsyncStorageDriver();
    const adapter = createAsyncStorageAdapter(driver);
    const namespace = adapter.openNamespace<{ value: string }>({
      sessionKey: 'sess1',
      storeName: 'async-driver-read-path',
      kind: 'collection.item',
    });

    const seedPromise = namespace.commit({
      upserts: [
        { key: 'a', value: { value: 'A' }, version: 1 },
        { key: 'b', value: { value: 'B' }, version: 1 },
      ],
    });
    await flushAllTimers();
    await seedPromise;

    const setManyCallsAfterSeed = driver.setManyCallCount();
    vi.setSystemTime(TEST_INITIAL_TIME + 7 * 60 * 60 * 1000);

    expect(await namespace.get('a')).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'a'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:a'
        version: 1
        writtenAt: 1735689600040

      value: { value: 'A' }
    `);
    expect(driver.setManyCallCount()).toBe(setManyCallsAfterSeed);

    expect(await namespace.get('b')).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'b'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:b'
        version: 1
        writtenAt: 1735689600040

      value: { value: 'B' }
    `);
    expect(driver.setManyCallCount()).toBe(setManyCallsAfterSeed);

    await flushAllTimers();
    expect(driver.setManyCallCount()).toBe(setManyCallsAfterSeed + 1);
  });

  test('async adapter drops cached index and payload reads after a sibling-tab commit broadcast', async () => {
    const restoreBroadcastChannel = installMockBroadcastChannel();
    const driver = createInMemoryAsyncStorageDriver();
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-cross-tab-commit',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;

    try {
      const adapterA = createAsyncStorageAdapter(driver);
      const adapterB = createAsyncStorageAdapter(driver);
      const namespaceA = adapterA.openNamespace<{ value: string }>(scope);
      const namespaceB = adapterB.openNamespace<{ value: string }>(scope);

      const seedPromise = namespaceA.commit({
        upserts: [{ key: 'a', value: { value: 'first' }, version: 1 }],
      });
      await flushAllTimers();
      await seedPromise;

      expect(await namespaceA.get('a')).toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'a'
          lastAccessAt: 1735689600040
          payloadRef: '__tsdf_payload__:a'
          version: 1
          writtenAt: 1735689600040

        value: { value: 'first' }
      `);

      const countsAfterWarmRead = {
        get: driver.getCallCount(),
        getMany: driver.getManyCallCount(),
      };

      const updatePromise = namespaceB.commit({
        upserts: [{ key: 'a', value: { value: 'second' }, version: 1 }],
      });
      await flushAllTimers();
      await updatePromise;
      await vi.advanceTimersByTimeAsync(0);

      const countsBeforeReload = {
        get: driver.getCallCount(),
        getMany: driver.getManyCallCount(),
      };

      const reloadedEntry = await namespaceA.get('a');
      expect(reloadedEntry).not.toBeNull();
      expect({
        metadata:
          reloadedEntry === null
            ? null
            : {
                customMetadata: reloadedEntry.metadata.customMetadata,
                key: reloadedEntry.metadata.key,
                payloadRef: reloadedEntry.metadata.payloadRef,
                version: reloadedEntry.metadata.version,
              },
        value: reloadedEntry?.value ?? null,
      }).toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'a'
          payloadRef: '__tsdf_payload__:a'
          version: 1

        value: { value: 'second' }
      `);
      expect(driver.getCallCount()).toBeGreaterThan(countsBeforeReload.get);
      expect(driver.getManyCallCount()).toBeGreaterThan(
        countsBeforeReload.getMany,
      );
      expect(countsAfterWarmRead).toMatchInlineSnapshot(`
        get: 2
        getMany: 0
      `);
    } finally {
      restoreBroadcastChannel();
    }
  });

  test('async adapter drops cached namespace state after a sibling-tab clear broadcast', async () => {
    const restoreBroadcastChannel = installMockBroadcastChannel();
    const driver = createInMemoryAsyncStorageDriver();
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-cross-tab-clear',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;

    try {
      const adapterA = createAsyncStorageAdapter(driver);
      const adapterB = createAsyncStorageAdapter(driver);
      const namespaceA = adapterA.openNamespace<{ value: string }>(scope);
      const namespaceB = adapterB.openNamespace<{ value: string }>(scope);

      const seedPromise = namespaceA.commit({
        upserts: [{ key: 'a', value: { value: 'first' }, version: 1 }],
      });
      await flushAllTimers();
      await seedPromise;

      expect(await namespaceA.get('a')).toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'a'
          lastAccessAt: 1735689600040
          payloadRef: '__tsdf_payload__:a'
          version: 1
          writtenAt: 1735689600040

        value: { value: 'first' }
      `);

      const clearPromise = namespaceB.clear();
      await clearPromise;
      await vi.advanceTimersByTimeAsync(0);

      const countsBeforeReload = {
        get: driver.getCallCount(),
        getMany: driver.getManyCallCount(),
      };

      expect(await namespaceA.get('a')).toBeNull();
      expect(driver.getCallCount()).toBeGreaterThan(countsBeforeReload.get);
      expect(driver.getManyCallCount()).toBe(countsBeforeReload.getMany);
    } finally {
      restoreBroadcastChannel();
    }
  });

  test('async adapter clears cached reads when the page becomes visible again', async () => {
    const driver = createInMemoryAsyncStorageDriver();
    const adapter = createAsyncStorageAdapter(driver);
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-resume-visibility',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;
    const namespace = adapter.openNamespace<{ value: string }>(scope);

    const originalHidden = document.hidden;
    Object.defineProperty(document, 'hidden', {
      value: false,
      writable: true,
      configurable: true,
    });

    try {
      const seedPromise = namespace.commit({
        upserts: [{ key: 'a', value: { value: 'first' }, version: 1 }],
      });
      await flushAllTimers();
      await seedPromise;

      expect(await namespace.get('a')).toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'a'
          lastAccessAt: 1735689600040
          payloadRef: '__tsdf_payload__:a'
          version: 1
          writtenAt: 1735689600040

        value: { value: 'first' }
      `);

      await driver.setMany(scope, [
        { key: getPayloadRecordKey('a'), value: { value: 'second' } },
        {
          key: ASYNC_NAMESPACE_INDEX_RECORD_KEY,
          value: { e: { a: { a: 1735689600040 } } },
        },
      ]);

      expect(await namespace.get('a')).toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'a'
          lastAccessAt: 1735689600040
          payloadRef: '__tsdf_payload__:a'
          version: 1
          writtenAt: 1735689600040

        value: { value: 'first' }
      `);

      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      expect(await namespace.get('a')).toMatchInlineSnapshot(`
        metadata:
          customMetadata: {}
          key: 'a'
          lastAccessAt: 1735689600040
          payloadRef: '__tsdf_payload__:a'
          version: 1
          writtenAt: 1735689600040

        value: { value: 'second' }
      `);
    } finally {
      Object.defineProperty(document, 'hidden', {
        value: originalHidden,
        writable: true,
        configurable: true,
      });
    }
  });

  test('async adapter clears cached reads on pageshow', async () => {
    const driver = createInMemoryAsyncStorageDriver();
    const adapter = createAsyncStorageAdapter(driver);
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-resume-pageshow',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;
    const namespace = adapter.openNamespace<{ value: string }>(scope);

    const seedPromise = namespace.commit({
      upserts: [{ key: 'a', value: { value: 'first' }, version: 1 }],
    });
    await flushAllTimers();
    await seedPromise;

    expect(await namespace.get('a')).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'a'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:a'
        version: 1
        writtenAt: 1735689600040

      value: { value: 'first' }
    `);

    await driver.setMany(scope, [
      { key: getPayloadRecordKey('a'), value: { value: 'second' } },
      {
        key: ASYNC_NAMESPACE_INDEX_RECORD_KEY,
        value: { e: { a: { a: 1735689600040 } } },
      },
    ]);

    window.dispatchEvent(new Event('pageshow'));

    expect(await namespace.get('a')).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'a'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:a'
        version: 1
        writtenAt: 1735689600040

      value: { value: 'second' }
    `);
  });

  test('async adapter ignores a stale in-flight get after a sibling-tab commit', async () => {
    const restoreBroadcastChannel = installMockBroadcastChannel();
    const driver = createInMemoryAsyncStorageDriver({ readDelayMs: 50 });
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-in-flight-get-race',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;

    try {
      const adapterA = createAsyncStorageAdapter(driver);
      const adapterB = createAsyncStorageAdapter(driver);
      const namespaceA = adapterA.openNamespace<{ value: string }>(scope);
      const namespaceB = adapterB.openNamespace<{ value: string }>(scope);

      // Seed the namespace so the first read starts from persisted data.
      const seedPromise = namespaceB.commit({
        upserts: [{ key: 'a', value: { value: 'first' }, version: 1 }],
      });
      await flushAllTimers();
      await seedPromise;

      // Start a read before the sibling tab updates the same record.
      const firstReadPromise = namespaceA.get('a');
      await advanceTime(10);

      // Commit a newer value while the original read is still waiting on storage.
      const updatePromise = namespaceB.commit({
        upserts: [{ key: 'a', value: { value: 'second' }, version: 1 }],
      });
      await flushAllTimers();
      await updatePromise;
      await advanceTime(0);

      // The original read can still resolve to the older snapshot it started with.
      const firstRead = await firstReadPromise;
      expect({
        metadata:
          firstRead === null
            ? null
            : {
                key: firstRead.metadata.key,
                version: firstRead.metadata.version,
              },
        value: firstRead?.value ?? null,
      }).toMatchInlineSnapshot(`
        metadata: { key: 'a', version: 1 }
        value: { value: 'first' }
      `);

      // The follow-up read must bypass the stale async result and reload fresh storage.
      const secondReadPromise = namespaceA.get('a');
      await flushAllTimers();
      const secondRead = await secondReadPromise;
      expect({
        metadata:
          secondRead === null
            ? null
            : {
                key: secondRead.metadata.key,
                version: secondRead.metadata.version,
              },
        value: secondRead?.value ?? null,
      }).toMatchInlineSnapshot(`
        metadata: { key: 'a', version: 1 }
        value: { value: 'second' }
      `);
    } finally {
      restoreBroadcastChannel();
    }
  });

  test('async adapter ignores a stale in-flight listKeys read after a sibling-tab commit', async () => {
    const restoreBroadcastChannel = installMockBroadcastChannel();
    const driver = createInMemoryAsyncStorageDriver({ readDelayMs: 50 });
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-in-flight-list-keys-race',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;

    try {
      const adapterA = createAsyncStorageAdapter(driver);
      const adapterB = createAsyncStorageAdapter(driver);
      const namespaceA = adapterA.openNamespace<{ value: string }>(scope);
      const namespaceB = adapterB.openNamespace<{ value: string }>(scope);

      // Seed one entry so the first key listing snapshots the older namespace index.
      const seedPromise = namespaceB.commit({
        upserts: [{ key: 'a', value: { value: 'first' }, version: 1 }],
      });
      await flushAllTimers();
      await seedPromise;

      // Start listing keys before the sibling tab adds a new record.
      const firstListKeysPromise = namespaceA.listKeys();
      await advanceTime(10);

      // Add a second key while the original namespace-index read is still pending.
      const updatePromise = namespaceB.commit({
        upserts: [{ key: 'b', value: { value: 'second' }, version: 1 }],
      });
      await flushAllTimers();
      await updatePromise;
      await advanceTime(0);

      // The original listing can still resolve from the older snapshot.
      expect(await firstListKeysPromise).toMatchInlineSnapshot(`['a']`);

      // A second listing must see the sibling commit immediately instead of reusing the stale async read.
      const secondListKeysPromise = namespaceA.listKeys();
      await flushAllTimers();
      expect(await secondListKeysPromise).toMatchInlineSnapshot(`['a', 'b']`);
    } finally {
      restoreBroadcastChannel();
    }
  });

  test('async adapter caches a snapshot of committed payload values', async () => {
    const driver = createInMemoryAsyncStorageDriver({ cloneValues: true });
    const adapter = createAsyncStorageAdapter(driver);
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-commit-snapshot',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;
    const namespace = adapter.openNamespace<{ nested: { count: number } }>(
      scope,
    );

    const committedValue = { nested: { count: 1 } };

    // Commit a payload object through the normal public namespace API.
    const commitPromise = namespace.commit({
      upserts: [{ key: 'a', value: committedValue, version: 1 }],
    });
    await flushAllTimers();
    await commitPromise;

    // Mutate the original object after persistence to simulate caller-owned state changing later.
    committedValue.nested.count = 2;

    // The cached value should still reflect the persisted snapshot, not the mutated input object.
    expect(await namespace.get('a')).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'a'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:a'
        version: 1
        writtenAt: 1735689600040

      value:
        nested: { count: 1 }
    `);
  });

  test('async adapter returns cloned payload snapshots from the read cache', async () => {
    const driver = createInMemoryAsyncStorageDriver({ cloneValues: true });
    const adapter = createAsyncStorageAdapter(driver);
    const scope = {
      sessionKey: 'sess1',
      storeName: 'async-read-snapshot',
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;
    const namespace = adapter.openNamespace<{ nested: { count: number } }>(
      scope,
    );

    // Seed a persisted payload so both reads go through the adapter's payload cache.
    const seedPromise = namespace.commit({
      upserts: [{ key: 'a', value: { nested: { count: 1 } }, version: 1 }],
    });
    await flushAllTimers();
    await seedPromise;

    // Read once and mutate the returned object to simulate a caller mutating cached data locally.
    const firstEntry = await namespace.get('a');
    if (firstEntry === null) {
      throw new Error('Expected seeded entry to be available.');
    }
    firstEntry.value.nested.count = 2;

    // A second read should still return the persisted snapshot instead of the mutated object.
    expect(await namespace.get('a')).toMatchInlineSnapshot(`
      metadata:
        customMetadata: {}
        key: 'a'
        lastAccessAt: 1735689600040
        payloadRef: '__tsdf_payload__:a'
        version: 1
        writtenAt: 1735689600040

      value:
        nested: { count: 1 }
    `);
  });

  test('document persistence still hydrates and refetches when navigator.locks is unavailable', async () => {
    const storeName = 'doc-without-locks';
    const sessionKey = 'sess1';
    const originalLocksDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'locks',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    persistentStore
      .scope(storeName, sessionKey)
      .document.seed({ value: { name: 'cached', value: 1 } });

    Object.defineProperty(globalThis.navigator, 'locks', {
      value: null,
      writable: true,
      configurable: true,
    });

    try {
      const env = createDocumentEnv({
        storeName,
        sessionKey,
        serverData: { name: 'fresh', value: 2 },
      });
      const renders = createLoggerStore();

      // The real store should keep working even when lock coordination is unavailable.
      renderHook(() => {
        const { data, status } = env.apiStore.useDocument({
          returnRefetchingStatus: true,
        });

        renders.add({ status, data: data?.value ?? null });
      });

      await flushAllTimers();

      expect(renders.changesSnapshot).toMatchInlineSnapshot(`
        "
        -> status: success ⋅ data: {name:cached, value:1}
        -> status: refetching ⋅ data: {name:cached, value:1}
        -> status: success ⋅ data: {name:fresh, value:2}
        "
      `);
      expect(warnSpy.mock.calls).toMatchInlineSnapshot(`
        - - '[TSDF] navigator.locks is unavailable; localPersistentStorage is using unlocked localStorage coordination.'
      `);
    } finally {
      warnSpy.mockRestore();

      if (originalLocksDescriptor) {
        Object.defineProperty(
          globalThis.navigator,
          'locks',
          originalLocksDescriptor,
        );
      } else {
        Reflect.deleteProperty(globalThis.navigator, 'locks');
      }
    }
  });

  test('clearSessionStorage removes one session cache across document, collection, and list-query stores', async () => {
    const clearedSession = 'sess-clear';
    const keptSession = 'sess-keep';
    const documentStoreName = 'clear-doc';
    const collectionStoreName = 'clear-collection';
    const listQueryStoreName = 'clear-list-query';
    const usersQuery: ListQueryParams = { tableId: 'users' };

    // Seed two sessions so the assertion proves session-scoped clearing instead of global deletion.
    persistentStore
      .scope(documentStoreName, clearedSession)
      .document.seed({ value: { name: 'Cleared document', value: 1 } });
    persistentStore
      .scope(documentStoreName, keptSession)
      .document.seed({ value: { name: 'Kept document', value: 2 } });

    persistentStore
      .scope(collectionStoreName, clearedSession)
      .collection.seedItem('1', { value: { id: '1', name: 'Cleared item' } });
    persistentStore
      .scope(collectionStoreName, keptSession)
      .collection.seedItem('1', { value: { id: '1', name: 'Kept item' } });

    const clearedListScope = persistentStore.scope(
      listQueryStoreName,
      clearedSession,
    );
    const keptListScope = persistentStore.scope(
      listQueryStoreName,
      keptSession,
    );
    const clearedListItem = clearedListScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Cleared row',
    });
    const keptListItem = keptListScope.listQuery.seedItem('users', 1, {
      id: 1,
      name: 'Kept row',
    });

    clearedListScope.listQuery.seedQuery(usersQuery, [clearedListItem.itemKey]);
    keptListScope.listQuery.seedQuery(usersQuery, [keptListItem.itemKey]);

    await clearSessionStorage(clearedSession, 'local-sync');

    // Each store type should now observe an empty cache for the cleared session.
    const clearedDocumentEnv = createDocumentEnv({
      storeName: documentStoreName,
      sessionKey: clearedSession,
    });
    const clearedCollectionEnv = createCollectionEnv({
      storeName: collectionStoreName,
      sessionKey: clearedSession,
    });
    const clearedListQueryEnv = createListQueryEnv({
      storeName: listQueryStoreName,
      sessionKey: clearedSession,
    });

    expect(clearedDocumentEnv.store.state).toMatchInlineSnapshot(`
      data: null
      error: null
      refetchOnMount: '❌'
      status: 'idle'
    `);
    expect(clearedCollectionEnv.apiStore.getItemState('1')).toBeUndefined();
    expect(
      clearedListQueryEnv.apiStore.getQueryState(usersQuery),
    ).toBeUndefined();

    // The untouched session should still hydrate normally from the same localStorage namespace family.
    const keptDocumentEnv = createDocumentEnv({
      storeName: documentStoreName,
      sessionKey: keptSession,
    });
    const keptCollectionEnv = createCollectionEnv({
      storeName: collectionStoreName,
      sessionKey: keptSession,
    });
    const keptListQueryEnv = createListQueryEnv({
      storeName: listQueryStoreName,
      sessionKey: keptSession,
    });

    expect(keptDocumentEnv.store.state).toMatchInlineSnapshot(`
      data:
        value: { name: 'Kept document', value: 2 }

      error: null
      refetchOnMount: 'lowPriority'
      status: 'success'
    `);
    expect(keptCollectionEnv.apiStore.getItemState('1')).toMatchInlineSnapshot(`
      data:
        value: { id: '1', name: 'Kept item' }

      error: null
      payload: '1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(keptListQueryEnv.apiStore.getQueryState(usersQuery))
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);
    expect(keptListQueryEnv.apiStore.getItemState('users||1'))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Kept row'
      `);
  });
});
