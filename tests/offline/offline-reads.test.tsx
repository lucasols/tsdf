import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createOfflineSession } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { createMockLocalStorageStore } from '../mocks/mockLocalStorageStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  flushAllTimers,
  pick,
  waitForScheduledCleanup,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
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

test('when an already-loaded document refetches while offline, it keeps the last successful data as a success state', async () => {
  network.setOffline();

  // Start from an already successful document snapshot so this exercise is about
  // what happens during an offline refetch, not an initial load.
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => 'offline-read-cache-session',
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'offline-read-cache-session',
          config: { network: network.config },
        }),
        operations: {},
      },
    },
  });

  await Promise.resolve();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  const requestHistoryBeforeOfflineRefetch = structuredClone(
    env.serverMock.fetchHistory,
  );

  // Move the session into offline mode before triggering the refetch.
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  // The refetch should keep the last successful data visible and preserve the
  // success state instead of surfacing an error over cached data.
  expect(env.store.state).toMatchInlineSnapshot(`
    data: { value: 1 }
    error: null
    refetchOnMount: '❌'
    status: 'success'
  `);
  // The offline-aware fetch path should short-circuit before touching the server.
  expect(env.serverMock.fetchHistory).toEqual(
    requestHistoryBeforeOfflineRefetch,
  );
});

test('when a document mounts offline with no cached snapshot, it returns the normalized offline error', async () => {
  // With no prior successful data, an offline read should fail with the shared
  // offline error shape instead of pretending the document loaded.
  network.setOffline();

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => 'offline-read-empty-session',
    testScenario: 'idle',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => 'offline-read-empty-session',
          config: { network: network.config },
        }),
        operations: {},
      },
    },
  });

  await Promise.resolve();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  env.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(env.store.state).toMatchInlineSnapshot(`
    data: null
    error: { code: 0, id: 'offline', message: 'Offline' }
    refetchOnMount: '❌'
    status: 'error'
  `);
  expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
});

test('when the app starts offline, startup cleanup keeps an expired document cache available for offline reads', async () => {
  // Startup cleanup should not eagerly delete stale document data if that cache
  // is the only snapshot an offline session can still use.
  const staleTimestamp = TEST_INITIAL_TIME - 8 * 24 * 60 * 60 * 1000;
  const sessionKey = 'offline-read-expired-document-session';
  const storeName = 'offline-read-expired-document';
  const persistedStore = createMockLocalStorageStore({
    storeName,
    sessionKey,
    initialState: {
      document: { data: { value: 1 }, timestamp: staleTimestamp },
    },
  });

  // Start offline before the store boots so hydration and startup cleanup both
  // see the same connectivity state a real cold start would.
  network.setOffline();

  const env = createDocumentStoreTestEnv(2, {
    id: storeName,
    getSessionKey: () => sessionKey,
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

  // Let startup hydration settle before checking what the delayed cleanup did
  // to persistence.
  await flushAllTimers();

  expect(pick(env.store.state, ['data', 'error', 'refetchOnMount', 'status']))
    .toMatchInlineSnapshot(`
      data: { value: 1 }
      error: null
      refetchOnMount: 'lowPriority'
      status: 'success'
    `);

  // Advance through the one-off startup sweep and confirm it keeps the stale
  // cached snapshot around for later offline reads.
  await waitForScheduledCleanup();

  expect({
    entryStillPersisted: persistedStore.has(
      persistedStore.document.storageKey(),
    ),
    state: pick(env.store.state, ['data', 'error', 'status']),
  }).toMatchInlineSnapshot(`
    entryStillPersisted: '✅'

    state:
      data: { value: 1 }
      error: null
      status: 'success'
  `);
  expect(env.serverMock.fetchHistory).toMatchInlineSnapshot(`[]`);
});

test('when a loaded collection item refetches while offline, it keeps the last successful item as a success state', async () => {
  const env = createCollectionStoreTestEnv(
    { 'users||1': { name: 'Ada' } },
    {
      getSessionKey: () => 'offline-collection-cache-session',
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-collection-cache-session',
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    },
  );

  const hook = renderHook(() =>
    env.apiStore.useItem('users||1', {
      selector: (item) => item?.value.name ?? null,
    }),
  );
  await flushAllTimers();

  expect(pick(hook.result.current, ['data', 'status'])).toMatchInlineSnapshot(`
    data: 'Ada'
    status: 'success'
  `);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();
  const requestHistoryBeforeOfflineRefetch = structuredClone(
    env.serverTable.getRequestHistory('item', { includeTime: false }),
  );

  env.scheduleFetch('highPriority', 'users||1');
  await flushAllTimers();

  expect(pick(hook.result.current, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: 'Ada'
      error: null
      status: 'success'
    `);
  expect(
    env.serverTable.getRequestHistory('item', { includeTime: false }),
  ).toEqual(requestHistoryBeforeOfflineRefetch);

  hook.unmount();
});

test('when a loaded list query refetches while offline, it keeps the last successful items as a success state', async () => {
  // This covers the list-query version of the document refetch case above: a
  // failed offline refetch must not blank a previously successful query.
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'offline-list-query-cache-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-list-query-cache-session',
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));

    return query;
  });

  // Start from a real successful query snapshot before forcing the session offline.
  await flushAllTimers();
  expect(pick(hook.result.current, ['items', 'status'])).toMatchInlineSnapshot(`
    items: ['Ada']
    status: 'success'
  `);
  const requestHistoryBeforeOfflineRefetch = structuredClone(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  );

  // Once offline, a manual refetch should keep the cached items visible without
  // degrading the query into an error state.
  env.clearTimeline();
  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  env.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();

  expect(pick(hook.result.current, ['error', 'items', 'status']))
    .toMatchInlineSnapshot(`
      error: null
      items: ['Ada']
      status: 'success'
    `);
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toEqual(requestHistoryBeforeOfflineRefetch);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items | query-status |
    3.81s | Ada         | success      | -- timeline-cleared
    .     | Ada         | success      | scheduled-fetch-triggered
    "
  `);

  hook.unmount();
});

test('when a loaded list-query item refetches while offline, it keeps the last successful item as a success state', async () => {
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'offline-list-item-cache-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-list-item-cache-session',
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    },
  );

  const hook = renderHook(() =>
    env.apiStore.useItem('users||1', {
      selector: (item) => item?.name ?? null,
    }),
  );
  await flushAllTimers();

  // Exercise the standalone item fetch path before going offline so this
  // covers the item executor instead of relying only on the loaded query state.
  act(() => {
    env.scheduleItemFetch('highPriority', 'users||1');
  });
  await flushAllTimers();

  expect(pick(hook.result.current, ['data', 'status'])).toMatchInlineSnapshot(`
    data: 'Ada'
    status: 'success'
  `);
  const requestHistoryBeforeOfflineRefetch = structuredClone(
    env.serverTable.getRequestHistory('item', { includeTime: false }),
  );

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  env.scheduleItemFetch('highPriority', 'users||1');
  await flushAllTimers();

  expect(pick(hook.result.current, ['data', 'error', 'status']))
    .toMatchInlineSnapshot(`
      data: 'Ada'
      error: null
      status: 'success'
    `);
  expect(
    env.serverTable.getRequestHistory('item', { includeTime: false }),
  ).toEqual(requestHistoryBeforeOfflineRefetch);

  hook.unmount();
});

test('when the app starts offline, startup cleanup keeps an expired list-query cache available for offline reads', async () => {
  // Startup cleanup should preserve stale list-query snapshots too, otherwise a
  // cold offline launch would erase the only cached query the UI can show.
  const staleTimestamp = TEST_INITIAL_TIME - 8 * 24 * 60 * 60 * 1000;
  const sessionKey = 'offline-read-expired-list-session';
  const storeName = 'offline-read-expired-list';
  const usersQuery = { tableId: 'users' } as const;
  const persistedStore = createMockLocalStorageStore({
    storeName,
    sessionKey,
    initialState: {
      listQuery: {
        items: [
          {
            tableId: 'users',
            id: 1,
            data: { id: 1, name: 'Ada' },
            timestamp: staleTimestamp,
          },
        ],
        queries: [
          {
            params: usersQuery,
            items: [{ tableId: 'users', id: 1 }],
            timestamp: staleTimestamp,
          },
        ],
      },
    },
  });

  // Match a real cold start where the app opens while the browser is already offline.
  network.setOffline();

  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
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

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));

    return query;
  });

  // Let the offline refetch settle before checking the delayed cleanup pass.
  await flushAllTimers();

  expect(pick(hook.result.current, ['error', 'items', 'status']))
    .toMatchInlineSnapshot(`
      error: null
      items: ['Ada']
      status: 'success'
    `);

  // The startup sweep should leave both the query snapshot and its cached item
  // in place so a later offline mount can still reuse them.
  await waitForScheduledCleanup();

  expect({
    itemStillPersisted: persistedStore.has(
      persistedStore.listQuery.itemStorageKey('users', 1),
    ),
    queryStillPersisted: persistedStore.has(
      persistedStore.listQuery.queryStorageKey(usersQuery),
    ),
    state: pick(hook.result.current, ['error', 'items', 'status']),
  }).toMatchInlineSnapshot(`
    itemStillPersisted: '✅'
    queryStillPersisted: '✅'

    state:
      error: null
      items: ['Ada']
      status: 'success'
  `);
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);

  hook.unmount();
});

test('when a list query mounts offline with no cached snapshot, it returns the normalized offline error', async () => {
  // Fresh offline mounts should expose the connectivity error directly because
  // there is no previous query snapshot to keep visible.
  const usersQuery = { tableId: 'users' } as const;
  network.setOffline();

  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'offline-list-query-empty-session',
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'offline-list-query-empty-session',
            config: { network: network.config },
          }),
          operations: {},
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));

    return query;
  });
  await flushAllTimers();

  expect(pick(hook.result.current, ['error', 'items', 'status']))
    .toMatchInlineSnapshot(`
      error: { code: 0, id: 'offline', message: 'Offline' }
      items: []
      status: 'error'
    `);
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | query-items | query-status |
    0    |             | loading      | [query-status, query-items] ui-initialized
    10ms |             | error        | [query-status] ui-changed
    "
  `);

  hook.unmount();
});
