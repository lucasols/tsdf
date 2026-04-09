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
import { flushAllTimers } from '../utils/genericTestUtils';
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

function createInMemoryAsyncStorageDriver(): AsyncStorageDriver & {
  setManyCallCount: () => number;
} {
  const storage = new Map<
    string,
    { bucket: Map<string, unknown>; scope: AsyncStorageNamespaceScope }
  >();
  let setManyCalls = 0;

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
      return Promise.resolve(getScopeBucket(scope).get(key));
    },
    getMany: (scope, keys) => {
      const bucket = getScopeBucket(scope);
      return Promise.resolve(keys.map((key) => bucket.get(key)));
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
      getScopeBucket(scope).set(key, value);
      return Promise.resolve();
    },
    setMany: (scope, entries) => {
      setManyCalls++;
      const bucket = getScopeBucket(scope);
      for (const entry of entries) {
        bucket.set(entry.key, entry.value);
      }
      return Promise.resolve();
    },
    setManyCallCount: () => setManyCalls,
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
