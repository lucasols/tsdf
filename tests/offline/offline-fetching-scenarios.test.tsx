import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOfflineConfigForSessionKey } from '../utils/offlineConfig';
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
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
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
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: network.config,
          operations: {},
        }),
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
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: network.config,
          operations: {},
        }),
      },
    });

    await Promise.resolve();

    const resultPromise = env.apiStore.awaitFetch();
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data: null
      error{Error}: { message: 'Offline', name: 'StoreFetchError' }
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
        offline: createOfflineConfigForSessionKey(() => sessionKey, {
          network: network.config,
          operations: {},
        }),
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
          offline: createOfflineConfigForSessionKey(() => sessionKey, {
            network: network.config,
            operations: {},
          }),
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
          offline: createOfflineConfigForSessionKey(() => sessionKey, {
            network: network.config,
            operations: {},
          }),
        },
      },
    );

    await Promise.resolve();

    const resultPromise = env.apiStore.awaitFetch('users||2');
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data: null
      error{Error}: { message: 'Offline', name: 'StoreFetchError' }
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
          offline: createOfflineConfigForSessionKey(() => sessionKey, {
            network: network.config,
            operations: {},
          }),
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
          offline: createOfflineConfigForSessionKey(() => sessionKey, {
            network: network.config,
            operations: {},
          }),
        },
      },
    );

    await Promise.resolve();

    const resultPromise = env.apiStore.awaitListQueryFetch(usersQuery);
    await flushAllTimers();
    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      error{Error}: { message: 'Offline', name: 'StoreFetchError' }
      hasMore: '❌'
      items: []
    `);
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });
});
