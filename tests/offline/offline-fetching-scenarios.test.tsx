import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createOfflineSession } from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { createMockLocalStorageStore } from '../mocks/mockLocalStorageStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import {
  getOpfsDirTree,
  getParsedOpfsFileData,
} from '../utils/persistentStorageOptimizationTestUtils';
import { userRowSchema } from './offlineReplayTestShared';
import {
  collectionSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
  localStorage.clear();
});

describe('offline fetching scenarios', () => {
  test('document scheduleFetch keeps cached data and does not hit the server while offline', async () => {
    const sessionKey = 'offline-fetching-document-scheduled';
    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    });

    await flushAllTimers();

    const requestHistoryBeforeOfflineFetch = structuredClone(
      env.serverMock.fetchHistory,
    );

    // Move into offline mode after a real successful load so this checks the
    // fetch API behavior, not boot-time hydration.
    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    env.scheduleFetch('highPriority');
    await flushAllTimers();

    expect(pick(env.store.state, ['data', 'error', 'status']))
      .toMatchInlineSnapshot(`
        data: { value: 1 }
        error: null
        status: 'success'
      `);
    expect(env.serverMock.fetchHistory).toEqual(
      requestHistoryBeforeOfflineFetch,
    );
  });

  test('document awaitFetch returns the normalized offline error when there is no cached data', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-document-await-cold';
    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'idle',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    });

    await Promise.resolve();

    const resultPromise = env.apiStore.awaitFetch();
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data: null
      error{Error}:
        message: 'Offline'
        name: 'StoreFetchError'
        code: 0
        id: 'offline'
        type: 'fetch'
    `);
    expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
  });

  test('multiple document awaitFetch calls resolve from the same cached offline snapshot without touching the server', async () => {
    const sessionKey = 'offline-fetching-document-await-concurrent';
    const env = createDocumentStoreTestEnv(1, {
      getSessionKey: () => sessionKey,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    });

    await flushAllTimers();

    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    const requestHistoryBeforeOfflineFetch = structuredClone(
      env.serverMock.fetchHistory,
    );

    const promiseA = env.apiStore.awaitFetch();
    const promiseB = env.apiStore.awaitFetch();
    const promiseC = env.apiStore.awaitFetch();

    await flushAllTimers();

    const [resultA, resultB, resultC] = await Promise.all([
      promiseA,
      promiseB,
      promiseC,
    ]);

    expect([resultA, resultB, resultC]).toMatchInlineSnapshot(`
      - data: { value: 1 }
        error: null
      - data: { value: 1 }
        error: null
      - data: { value: 1 }
        error: null
    `);
    expect(env.serverMock.fetchHistory).toEqual(
      requestHistoryBeforeOfflineFetch,
    );
  });

  test('document sync persistence hydrates cached storage into memory before offline fetch APIs run', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-document-storage-hydrated-at-boot';
    const storeName = 'offline-fetching-document-storage-hydrated-at-boot';
    createMockLocalStorageStore({
      storeName,
      sessionKey,
      initialState: { document: { data: { value: 7 } } },
    });

    const env = createDocumentStoreTestEnv(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'idle',
      persistentStorage: {
        adapter: 'local-sync',
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    });

    // For the sync local-storage adapter, document persistence is read during
    // createInitialState, so the cached snapshot is already materialized before
    // any offline fetch API runs.
    expect(pick(env.store.state, ['data', 'error', 'status']))
      .toMatchInlineSnapshot(`
        data: { value: 7 }
        error: null
        status: 'success'
      `);

    const resultPromise = env.apiStore.awaitFetch();
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data: { value: 7 }
      error: null
    `);
    expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
  });

  test('document async persistence returns cached storage data while memory starts cold and offline', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-document-async-storage-only';
    const storeName = 'offline-fetching-document-async-storage-only';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: { storeName, sessionKey, document: { data: { value: 8 } } },
    });

    // Snapshot the seeded OPFS state so this cold-boot hydration test also
    // protects the persisted document shape it depends on.
    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.32 kb)
      └ offline-fetching-document-async-storage-only (0.31 kb)
        └ offline-fetching-document-async-storage-only (0.22 kb)
          ├ d._i.r.json (0.10 kb)
          └ d.e.p.json (0.04 kb)"
    `);
    expect(getParsedOpfsFileData(`tsdf/${sessionKey}/${storeName}/d._i.r.json`))
      .toMatchInlineSnapshot(`
        e:
          - a: 1735689600000
      `);
    expect(
      getParsedOpfsFileData(`tsdf/${sessionKey}/${storeName}/d.e.p.json`),
    ).toMatchInlineSnapshot(`value: 8`);

    const env = createDocumentStoreTestEnv(1, {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: 'idle',
      persistentStorage: {
        adapter: opfsPersistentStorage,
        schema: docSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => sessionKey,
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    });

    expect(pick(env.store.state, ['data', 'error', 'status']))
      .toMatchInlineSnapshot(`
        data: null
        error: null
        status: 'idle'
      `);

    const result = await resolveAfterAllTimers(env.apiStore.awaitFetch());

    expect(result).toMatchInlineSnapshot(`
      data: { value: 8 }
      error: null
    `);
    expect(pick(env.store.state, ['data', 'error', 'status']))
      .toMatchInlineSnapshot(`
        data: { value: 8 }
        error: null
        status: 'success'
      `);
    expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
  });

  test('collection fetch APIs keep the cached item visible while offline', async () => {
    const sessionKey = 'offline-fetching-collection-cached';
    const env = createCollectionStoreTestEnv(
      { 'users||1': { name: 'Ada' } },
      {
        getSessionKey: () => sessionKey,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    await flushAllTimers();

    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    const requestHistoryBeforeOfflineFetch = structuredClone(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    );

    env.scheduleFetch('highPriority', 'users||1');
    await flushAllTimers();

    const awaitedResultPromise = env.apiStore.awaitFetch('users||1');
    await flushAllTimers();
    const awaitedResult = await awaitedResultPromise;

    expect({
      awaitedResult,
      itemState: pick(env.apiStore.getItemState('users||1'), [
        'data',
        'error',
        'status',
      ]),
    }).toMatchInlineSnapshot(`
      awaitedResult:
        data:
          value: { name: 'Ada' }
        error: null

      itemState:
        data:
          value: { name: 'Ada' }
        error: null
        status: 'success'
    `);
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toEqual(requestHistoryBeforeOfflineFetch);
  });

  test('collection awaitFetch returns the offline error for a missing item while offline', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-collection-missing';
    const env = createCollectionStoreTestEnv(
      { 'users||1': { name: 'Ada' } },
      {
        getSessionKey: () => sessionKey,
        testScenario: 'idle',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    await Promise.resolve();

    const resultPromise = env.apiStore.awaitFetch('users||2');
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data: null
      error{Error}:
        message: 'Offline'
        name: 'StoreFetchError'
        code: 0
        id: 'offline'
        type: 'fetch'
    `);
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('collection awaitFetch returns cached persisted data when storage is warm but state memory is cold', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-collection-storage-only';
    const storeName = 'offline-fetching-collection-storage-only';
    createMockLocalStorageStore({
      storeName,
      sessionKey,
      initialState: {
        collection: [
          {
            payload: 'users||1',
            data: { value: { name: 'Ada from storage' } },
          },
        ],
      },
    });

    const env = createCollectionStoreTestEnv(
      { 'users||1': { name: 'Ada from server' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'idle',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    await Promise.resolve();

    expect(Object.keys(env.store.state)).toMatchInlineSnapshot(`[]`);

    const resultPromise = env.apiStore.awaitFetch('users||1');
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data:
        value: { name: 'Ada from storage' }

      error: null
    `);
    expect(pick(env.apiStore.getItemState('users||1'), ['data', 'status']))
      .toMatchInlineSnapshot(`
        data:
          value: { name: 'Ada from storage' }

        status: 'success'
      `);
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('collection async persistence returns cached storage data while memory starts cold and offline', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-collection-async-storage-only';
    const storeName = 'offline-fetching-collection-async-storage-only';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName,
        sessionKey,
        collection: [
          {
            payload: 'users||1',
            data: { value: { name: 'Ada from async storage' } },
          },
        ],
      },
    });

    // Snapshot the seeded OPFS state so this offline hydration flow also
    // protects the exact stored collection payload it consumes.
    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.44 kb)
      └ offline-fetching-collection-async-storage-only (0.44 kb)
        └ offline-fetching-collection-async-storage-only (0.35 kb)
          ├ ci._i.r.json (0.13 kb)
          └ ci.h~228010772.p.json (0.13 kb)"
    `);
    expect(
      getParsedOpfsFileData(`tsdf/${sessionKey}/${storeName}/ci._i.r.json`),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1' }
    `);
    expect(
      getParsedOpfsFileData(
        `tsdf/${sessionKey}/${storeName}/ci.<"users||1>.p.json`,
      ),
    ).toMatchInlineSnapshot(`value: { name: 'Ada from async storage' }`);

    const env = createCollectionStoreTestEnv(
      { 'users||1': { name: 'Ada from server' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'idle',
        persistentStorage: {
          adapter: opfsPersistentStorage,
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    expect(Object.keys(env.store.state)).toMatchInlineSnapshot(`[]`);

    const result = await resolveAfterAllTimers(
      env.apiStore.awaitFetch('users||1'),
    );

    expect(result).toMatchInlineSnapshot(`
      data:
        value: { name: 'Ada from async storage' }

      error: null
    `);
    expect(pick(env.apiStore.getItemState('users||1'), ['data', 'status']))
      .toMatchInlineSnapshot(`
        data:
          value: { name: 'Ada from async storage' }

        status: 'success'
      `);
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('list-query fetch APIs keep cached query and item data available while offline', async () => {
    const sessionKey = 'offline-fetching-list-query-cached';
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => sessionKey,
        testScenario: { loaded: { queries: [usersQuery] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    await flushAllTimers();

    // Warm the direct item fetch path too so both list and item executors are
    // covered once the session goes offline.
    env.scheduleItemFetch('highPriority', 'users||1');
    await flushAllTimers();

    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    const listRequestHistoryBeforeOfflineFetch = structuredClone(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    );
    const itemRequestHistoryBeforeOfflineFetch = structuredClone(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    );

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();

    const queryResultPromise = env.apiStore.awaitListQueryFetch(usersQuery);
    const itemResultPromise = env.apiStore.awaitItemFetch('users||1');

    await flushAllTimers();

    const [queryResult, itemResult] = await Promise.all([
      queryResultPromise,
      itemResultPromise,
    ]);

    expect({ itemResult, queryResult }).toMatchInlineSnapshot(`
      itemResult:
        data: { id: 1, name: 'Ada' }
        error: null

      queryResult:
        error: null
        hasMore: '❌'
        items:
          - data: { id: 1, name: 'Ada' }
            itemPayload: 'users||1'
    `);
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toEqual(listRequestHistoryBeforeOfflineFetch);
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toEqual(itemRequestHistoryBeforeOfflineFetch);
  });

  test('list-query await APIs return cached persisted data when storage is warm but state memory is cold', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-list-query-storage-only';
    const storeName = 'offline-fetching-list-query-storage-only';
    const usersQuery = { tableId: 'users' } as const;
    createMockLocalStorageStore({
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [
            {
              tableId: 'users',
              id: 1,
              data: { id: 1, name: 'Ada from storage' },
            },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });

    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada from server' }] },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'idle',
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    await Promise.resolve();

    expect({
      items: Object.keys(env.store.state.items),
      queries: Object.keys(env.store.state.queries),
    }).toMatchInlineSnapshot(`
      items: []
      queries: []
    `);

    const queryResultPromise = env.apiStore.awaitListQueryFetch(usersQuery);
    const itemResultPromise = env.apiStore.awaitItemFetch('users||1');
    await flushAllTimers();
    const [queryResult, itemResult] = await Promise.all([
      queryResultPromise,
      itemResultPromise,
    ]);

    expect({ itemResult, queryResult }).toMatchInlineSnapshot(`
      itemResult:
        data: { id: 1, name: 'Ada from storage' }
        error: null

      queryResult:
        error: null
        hasMore: '❌'
        items:
          - data: { id: 1, name: 'Ada from storage' }
            itemPayload: 'users||1'
    `);
    expect(
      env.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('list-query async persistence returns cached storage data while memory starts cold and offline', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-list-query-async-storage-only';
    const storeName = 'offline-fetching-list-query-async-storage-only';
    const usersQuery = { tableId: 'users' } as const;
    const mockAdapter = createOpfsPersistentStorageTestStore({
      initialState: {
        storeName,
        sessionKey,
        listQuery: {
          items: [
            {
              tableId: 'users',
              id: 1,
              data: { id: 1, name: 'Ada from async storage' },
            },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });

    // Snapshot the seeded OPFS contents so the cold list-query hydration test
    // protects both the cached item and the exact persisted query membership.
    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.67 kb)
      └ offline-fetching-list-query-async-storage-only (0.67 kb)
        └ offline-fetching-list-query-async-storage-only (0.58 kb)
          ├ li._i.r.json (0.13 kb)
          ├ li.h~228010772.p.json (0.12 kb)
          ├ lq._i.r.json (0.17 kb)
          └ lq.h~2902406637.p.json (0.07 kb)"
    `);
    expect(
      getParsedOpfsFileData(`tsdf/${sessionKey}/${storeName}/li._i.r.json`),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1' }
    `);
    expect(
      getParsedOpfsFileData(`tsdf/${sessionKey}/${storeName}/lq._i.r.json`),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users"}:
          a: 1735689600000
          p: { tableId: 'users' }
    `);
    expect(
      getParsedOpfsFileData(
        `tsdf/${sessionKey}/${storeName}/li.<"users||1>.p.json`,
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Ada from async storage'
    `);
    expect(
      getParsedOpfsFileData(
        `tsdf/${sessionKey}/${storeName}/lq.<{tableId:"users"}>.p.json`,
      ),
    ).toMatchInlineSnapshot(`['"users||1']`);

    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada from server' }] },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        testScenario: 'idle',
        persistentStorage: {
          adapter: opfsPersistentStorage,
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    expect({
      items: Object.keys(env.store.state.items),
      queries: Object.keys(env.store.state.queries),
    }).toMatchInlineSnapshot(`
      items: []
      queries: []
    `);

    const [queryResult, itemResult] = await Promise.all([
      resolveAfterAllTimers(env.apiStore.awaitListQueryFetch(usersQuery)),
      resolveAfterAllTimers(env.apiStore.awaitItemFetch('users||1')),
    ]);

    expect({ itemResult, queryResult }).toMatchInlineSnapshot(`
      itemResult:
        data: { id: 1, name: 'Ada from async storage' }
        error: null

      queryResult:
        error: null
        hasMore: '❌'
        items:
          - data: { id: 1, name: 'Ada from async storage' }
            itemPayload: 'users||1'
    `);
    expect(
      env.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('list-query awaitListQueryFetch returns the offline error for a cold query while offline', async () => {
    network.setOffline();

    const sessionKey = 'offline-fetching-list-query-cold';
    const usersQuery = { tableId: 'users' } as const;
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => sessionKey,
        testScenario: 'idle',
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => sessionKey,
              config: { network: network.config },
            }),
            operations: {},
          },
        },
      },
    );

    await Promise.resolve();

    const resultPromise = env.apiStore.awaitListQueryFetch(usersQuery);
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      error{Error}:
        message: 'Offline'
        name: 'StoreFetchError'
        code: 0
        id: 'offline'
        type: 'fetch'

      hasMore: '❌'
      items: []
    `);
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });
});
