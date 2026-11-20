import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import { isOfflineStoreError, type StoreError } from '../../src/main';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { createMockLocalStorageStore } from '../mocks/mockLocalStorageStore';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
  waitForScheduledCleanup,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { userRowSchema } from './offlineReplayTestShared';
import {
  collectionSchema,
  docSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

type PartialUserRow = { id: number; name: string; age?: number; city?: string };

const partialUserRowSchema: PersistentStorageSchema<PartialUserRow> = rc_object(
  {
    id: rc_number,
    name: rc_string,
    age: rc_number.optionalKey(),
    city: rc_string.optionalKey(),
  },
);

const partialUserResourcesConfig: PartialResourcesConfig<PartialUserRow> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const itemRecord = __LEGIT_CAST__<Record<string, unknown>, PartialUserRow>(
      item,
    );
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in itemRecord) {
        result[field] = itemRecord[field];
      }
    }
    return __LEGIT_CAST__<PartialUserRow, Record<string, unknown>>(result);
  },
  inferFields: (item) => Object.keys(item),
};

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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'offline-read-cache-session',
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => 'offline-read-empty-session',
      offlineSession: { network: network.config },
    }),
    testScenario: 'idle',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
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

test('when a document that kept its cached data after a failed refresh refetches offline, the offline error is not shown over the cached data', async () => {
  const sessionKey = 'offline-read-document-error-then-offline-session';
  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    testScenario: 'loaded',
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const renders = createLoggerStore();

  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    renders.add({
      status: doc.status,
      data: doc.data,
      error: doc.error?.id ?? null,
    });
  });
  await flushAllTimers();

  // A refresh fails on the server: the document keeps showing the cached data
  // together with the server error. This is the state the offline refetch
  // below starts from.
  renders.addMark('a refresh fails on the server');
  env.serverMock.setNextFetchError('Internal server error');
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  // The server copy changes while the session is offline, so the recovery
  // below has something new to bring in.
  env.serverMock.setData(2);

  // Offline, the refetch cannot be sent. The cached data is all the hook can
  // return, so it must not be covered by the offline error. (A document
  // refetched from the error state reports `loading` while the attempt runs,
  // online or offline.)
  renders.addMark('offline, the document is refetched');
  act(() => {
    network.goOffline();
  });
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  // The refresh that could not run offline is still owed: recovering runs it
  // without a remount or a manual invalidation.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {value:1} ⋅ error: null

    >>> a refresh fails on the server

    -> status: error ⋅ data: {value:1} ⋅ error: fetch-error

    >>> offline, the document is refetched

    -> status: loading ⋅ data: {value:1} ⋅ error: null
    -> status: success ⋅ data: {value:1} ⋅ error: null

    >>> back online

    -> status: success ⋅ data: {value:2} ⋅ error: null
    "
  `);

  hook.unmount();
});

test('isOfflineStoreError tells the offline error of a read with nothing cached apart from an app error that uses the same `offline` id', async () => {
  const sessionKey = 'offline-read-is-offline-store-error-session';
  network.setOffline();

  // An app whose own error ids collide with TSDF's: its normalizer reports
  // every server failure with the `offline` id too.
  const appErrorNormalizer = (exception: Error): StoreError => ({
    code: 503,
    id: 'offline',
    message: exception.message,
  });

  const env = createDocumentStoreTestEnv(1, {
    getSessionKey: () => sessionKey,
    storeManager: createStoreManager({
      errorNormalizer: appErrorNormalizer,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
    },
  });
  const renders = createLoggerStore();

  // Nothing is cached, so the offline mount can only expose the offline error.
  const hook = renderHook(() => {
    const doc = env.apiStore.useDocument();
    renders.add({
      status: doc.status,
      errorId: doc.error?.id ?? null,
      isOfflineStoreError: isOfflineStoreError(doc.error),
    });
  });
  await flushAllTimers();

  // The `StoreFetchError` of the await APIs is recognised as well.
  renders.addMark('awaitFetch while offline');
  const awaitedWhileOffline = await resolveAfterAllTimers(
    env.apiStore.awaitFetch(),
  );
  expect(isOfflineStoreError(awaitedWhileOffline.error)).toBe(true);

  // Back online the server is failing: the fetch is sent this time and the
  // app's own error comes back, sharing only the `offline` id.
  renders.addMark('back online, the server is failing');
  env.serverMock.setNextFetchError('Service unavailable');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ errorId: null ⋅ isOfflineStoreError: ❌
    -> status: error ⋅ errorId: offline ⋅ isOfflineStoreError: ✅

    >>> awaitFetch while offline

    -> status: loading ⋅ errorId: null ⋅ isOfflineStoreError: ❌
    -> status: error ⋅ errorId: offline ⋅ isOfflineStoreError: ✅

    >>> back online, the server is failing

    -> status: loading ⋅ errorId: null ⋅ isOfflineStoreError: ❌
    -> status: error ⋅ errorId: offline ⋅ isOfflineStoreError: ❌
    "
  `);

  hook.unmount();
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
    storeManager: createStoreManager({
      errorNormalizer: normalizeError,
      getSessionKey: () => sessionKey,
      offlineSession: { network: network.config },
    }),
    persistentStorage: {
      adapter: 'local-sync',
      schema: docSchema,
      offline: { operations: {} },
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'offline-collection-cache-session',
        offlineSession: { network: network.config },
      }),
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: { operations: {} },
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

test('when cached and uncached collection items are read together offline, only the uncached item shows the offline error and both load after recovering', async () => {
  const sessionKey = 'offline-collection-mixed-cache-session';
  const env = createCollectionStoreTestEnv(
    { 'users||1': { name: 'Ada' }, 'users||2': { name: 'Grace' } },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      // Both items are requested in the same batch request, so the offline
      // failure of that single request has to be split per item.
      useBatchFetch: true,
      persistentStorage: {
        adapter: 'local-sync',
        schema: collectionSchema,
        payloadSchema: rc_string,
        offline: { operations: {} },
      },
    },
  );

  // Only the first user is loaded (and so cached) before going offline.
  const firstUserHook = renderHook(() => env.apiStore.useItem('users||1'));
  await flushAllTimers();
  firstUserHook.unmount();

  env.serverTable.updateItem('users||1', { name: 'Ada L.' });

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  const renders = createLoggerStore();
  const hook = renderHook(() => {
    const [cachedUser, uncachedUser] = env.apiStore.useMultipleItems([
      { payload: 'users||1' },
      { payload: 'users||2' },
    ]);

    renders.add({
      cached: `${cachedUser?.status} (${cachedUser?.data?.value.name ?? 'no data'})`,
      cachedError: cachedUser?.error?.id ?? null,
      uncached: `${uncachedUser?.status} (${uncachedUser?.data?.value.name ?? 'no data'})`,
      uncachedError: uncachedUser?.error?.id ?? null,
    });

    return { cachedUser, uncachedUser };
  });
  await flushAllTimers();

  // The offline error of the uncached item is the one the app has to explain.
  expect({
    cachedUser: isOfflineStoreError(hook.result.current.cachedUser?.error),
    uncachedUser: isOfflineStoreError(hook.result.current.uncachedUser?.error),
  }).toMatchInlineSnapshot(`
    cachedUser: '❌'
    uncachedUser: '✅'
  `);

  // Recovering refetches both without a remount: the uncached item loads and
  // the cached item, whose refresh could not run offline, gets the server
  // change.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ cached: success (Ada)
    ⋅ cachedError: null
    ⋅ uncached: loading (no data)
    ⋅ uncachedError: null
    └─
    ┌─
    ⋅ cached: success (Ada)
    ⋅ cachedError: null
    ⋅ uncached: error (no data)
    ⋅ uncachedError: offline
    └─

    >>> back online

    ┌─
    ⋅ cached: success (Ada)
    ⋅ cachedError: null
    ⋅ uncached: loading (no data)
    ⋅ uncachedError: null
    └─
    ┌─
    ⋅ cached: success (Ada L.)
    ⋅ cachedError: null
    ⋅ uncached: success (Grace)
    ⋅ uncachedError: null
    └─
    "
  `);
  // Nothing was sent while offline: the first load, then one batch request
  // for both items after recovering.
  expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
      - _type: 'list'
        payload:
          fields: '*'
          itemIds: ['users||1', 'users||2']
          pos: { offset: 0 }
        returned_items: 2
    `);

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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'offline-list-query-cache-session',
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
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

test('when a loaded offset-paginated list query refetches its pages in chunks while offline, it keeps the loaded pages as a success state', async () => {
  const sessionKey = 'offline-list-query-chunked-refetch-session';
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
        { id: 3, name: 'Linus' },
        { id: 4, name: 'Margaret' },
      ],
    },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      // Pages of 2 and refetches limited to 2 items per request: once two
      // pages are loaded, a refetch is split into two parallel chunk requests.
      defaultQuerySize: 2,
      offsetPagination: { maxInvalidationLimit: 2 },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );
  const renders = createLoggerStore();

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    renders.add({
      status: query.status,
      items: query.items.join(', '),
      error: query.error?.id ?? null,
    });
  });
  await flushAllTimers();

  // Load the second page, so the list holds more items than a single refetch
  // request may ask for.
  act(() => {
    env.apiStore.loadMore(usersQuery);
  });
  await flushAllTimers();

  env.serverTable.updateItem('users||1', { name: 'Ada L.' });

  // The chunked refetch cannot be sent offline: the loaded pages stay visible
  // without an error, like a refetch sent as a single request.
  renders.addMark('offline, the list is refetched');
  act(() => {
    network.goOffline();
  });
  env.scheduleFetch('highPriority', usersQuery);
  await flushAllTimers();

  // The refetch is still owed and runs by itself after recovering.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ items: '' ⋅ error: null
    -> status: success ⋅ items: Ada, Grace ⋅ error: null
    -> status: loadingMore ⋅ items: Ada, Grace ⋅ error: null
    -> status: success ⋅ items: Ada, Grace, Linus, Margaret ⋅ error: null

    >>> offline, the list is refetched

    -> status: success ⋅ items: Ada, Grace, Linus, Margaret ⋅ error: null

    >>> back online

    -> status: success ⋅ items: Ada, Grace, Linus, Margaret ⋅ error: null
    -> status: success ⋅ items: Ada L., Grace, Linus, Margaret ⋅ error: null
    "
  `);
  // Two page loads, nothing while offline, then the two chunks of the
  // recovery refetch.
  expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 2, offset: 0 }
        returned_items: 2
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 2, offset: 2 }
        returned_items: 2
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 2, offset: 0 }
        returned_items: 2
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 2, offset: 2 }
        returned_items: 2
    `);

  hook.unmount();
});

test('when a loaded list-query item refetches while offline, it keeps the last successful item as a success state', async () => {
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'offline-list-item-cache-session',
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'offline-list-item-cache-session',
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
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

test('partial-resource field invalidations should still refetch `fields: *` after reconnecting from an offline failure', async () => {
  const sessionKey = 'offline-read-list-item-field-invalidation-retry';
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', age: 30, city: 'London' }] },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      partialResources: partialUserResourcesConfig,
      persistentStorage: {
        adapter: 'local-sync',
        schema: partialUserRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );

  const renderTrackedItem = () =>
    renderHook(() => {
      const item = env.apiStore.useItem('users||1', {
        fields: '*',
        selector: (row) => pick(row, ['age', 'id', 'name']),
      });

      env.trackItemUI('item-status', item.status);
      env.trackItemUI('item-data', JSON.stringify(item.data));

      return item;
    });

  // Start with a real `fields: *` item hook so the offline step is exercising
  // a refetch of previously loaded data, not an initial load edge case.
  const hook = renderTrackedItem();
  await flushAllTimers();
  expect(pick(hook.result.current, ['data', 'status'])).toMatchInlineSnapshot(`
    data: { age: 30, id: 1, name: 'Ada' }
    status: 'success'
  `);

  // Update the server copy so the later reconnect path has a real field-level
  // change to recover.
  env.serverTable.updateItem('users||1', { age: 31 });

  // Focus the timeline on the offline invalidation and reconnect story.
  env.clearTimeline();

  // Invalidate only `age` while offline. The attempted refetch should fail
  // offline, keep cached data visible, and preserve the pending field retry.
  env.addTimelineComments('beforeNextAction', [
    'invalidate only `age` while offline; the hook should stay on cached data',
  ]);
  act(() => {
    network.goOffline();
    env.apiStore.invalidateQueryAndItems({
      itemPayload: 'users||1',
      queryPayload: false,
      fields: ['age'],
    });
  });
  await flushAllTimers();
  expect(pick(hook.result.current, ['data', 'status'])).toMatchInlineSnapshot(`
    data: { age: 30, id: 1, name: 'Ada' }
    status: 'success'
  `);

  // Unmount before reconnecting so the retry path must come from the next
  // mount noticing the unresolved invalidated field.
  hook.unmount();

  act(() => {
    network.goOnline();
  });

  // Remount the same wildcard hook. Recovering from offline mode marks the
  // whole store as stale (anything could have changed while offline), so the
  // remount refetches the full item, which covers the invalidated field, and
  // then exposes the refreshed item data.
  env.addTimelineComments('beforeNextAction', [
    'remount after reconnecting; the wildcard hook should refetch the item, including the pending `age` field',
  ]);
  const remountedHook = renderTrackedItem();
  await flushAllTimers();

  // The remounted hook should show the refreshed field rather than keeping the
  // stale cached age indefinitely.
  expect(pick(remountedHook.result.current, ['data', 'status']))
    .toMatchInlineSnapshot(`
      data: { age: 31, id: 1, name: 'Ada' }
      status: 'success'
    `);
  // Exactly one request after reconnecting: the offline recovery revalidation
  // and the pending `age` invalidation are served by the same full refetch.
  expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
    - _type: 'item'
      payload: { itemId: 'users||1' }
      time: '10ms -> 810ms | duration: 800ms'
    - _type: 'item'
      payload: { itemId: 'users||1' }
      time: '2.83s -> 3.63s | duration: 800ms'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item-data                      | item-status |
    1.81s | {"age":30,"id":1,"name":"Ada"} | success     | -- timeline-cleared
    2.83s | {"age":30,"id":1,"name":"Ada"} | success     | -- invalidate only \`age\` while offline; the hook should stay on cached data
    .     | {"age":30,"id":1,"name":"Ada"} | success     | -- remount after reconnecting; the wildcard hook should refetch the item, including the pending \`age\` field
    .     | {"age":30,"id":1,"name":"Ada"} | success     | 🟠 [users||1] >fetch-started
    3.63s | {"age":30,"id":1,"name":"Ada"} | success     | 🟠 [users||1] <fetch-finished (value: {"id":1,"name":"Ada","age":31,"city":"London"})
    .     | {"age":31,"id":1,"name":"Ada"} | success     | [item-data] ui-changed
    "
  `);

  remountedHook.unmount();
});

function createPartialUsersEnv(sessionKey: string) {
  return createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', age: 30, city: 'London' }] },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      partialResources: partialUserResourcesConfig,
      persistentStorage: {
        adapter: 'local-sync',
        schema: partialUserRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );
}

test('when item hooks request fields that are not cached while offline, they show the offline error without retrying, the hook on cached fields is unaffected, and all load after recovering', async () => {
  const env = createPartialUsersEnv('offline-partial-item-uncached-fields');

  // Only `name` is loaded (and so cached) before going offline.
  const nameHook = renderHook(() =>
    env.apiStore.useItem('users||1', { fields: ['name'] }),
  );
  await flushAllTimers();
  nameHook.unmount();

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // Three rows of the same item mount while offline: one needs only the cached
  // field, the other two need data that was never loaded.
  const renders = createLoggerStore();
  let renderCount = 0;
  const hook = renderHook(() => {
    const cachedFields = env.apiStore.useItem('users||1', {
      fields: ['name'],
      // A `refetching` status here would mean the cached row is disturbed by
      // the fetch attempts of the other rows.
      returnRefetchingStatus: true,
    });
    const uncachedFields = env.apiStore.useItem('users||1', {
      fields: ['name', 'age'],
    });
    const allFields = env.apiStore.useItem('users||1', { fields: '*' });

    renderCount++;
    renders.add({
      cachedFields: `${cachedFields.status} (${JSON.stringify(cachedFields.data)}) error: ${cachedFields.error?.id ?? null}`,
      uncachedFields: `${uncachedFields.status} (${JSON.stringify(uncachedFields.data)}) error: ${uncachedFields.error?.id ?? null}`,
      allFields: `${allFields.status} (${JSON.stringify(allFields.data)}) error: ${allFields.error?.id ?? null}`,
    });

    return { cachedFields, uncachedFields, allFields };
  });
  // Flushing every timer only returns if the hooks settle: a hook that keeps
  // retrying its missing fields would keep scheduling fetches forever.
  await flushAllTimers();

  // The rows settle right away instead of re-rendering on every fetch attempt.
  expect(renderCount).toMatchInlineSnapshot(`1`);
  // The offline error of the rows with missing fields is the one the app has
  // to explain; the row on cached fields has no error.
  expect({
    cachedFields: isOfflineStoreError(hook.result.current.cachedFields.error),
    uncachedFields: isOfflineStoreError(
      hook.result.current.uncachedFields.error,
    ),
    allFields: isOfflineStoreError(hook.result.current.allFields.error),
  }).toMatchInlineSnapshot(`
    allFields: '✅'
    cachedFields: '❌'
    uncachedFields: '✅'
  `);

  // Recovering refetches the item without a remount, now with every field the
  // mounted rows need.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ cachedFields: success ({"name":"Ada"}) error: null
    ⋅ uncachedFields: error (null) error: offline
    ⋅ allFields: error (null) error: offline
    └─

    >>> back online

    ┌─
    ⋅ cachedFields: success ({"name":"Ada"}) error: null
    ⋅ uncachedFields: loading (null) error: null
    ⋅ allFields: loading (null) error: null
    └─
    ┌─
    ⋅ cachedFields: refetching ({"name":"Ada"}) error: null
    ⋅ uncachedFields: loading (null) error: null
    ⋅ allFields: loading (null) error: null
    └─
    ┌─
    ⋅ cachedFields: success ({"name":"Ada"}) error: null
    ⋅ uncachedFields: success ({"name":"Ada","age":30}) error: null
    ⋅ allFields: success ({"name":"Ada","id":1,"age":30,"city":"London"}) error: null
    └─
    "
  `);
  // Nothing was sent while offline: the first `name` load, then the requests
  // made after recovering.
  expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['name']
          itemId: 'users||1'
      - _type: 'item'
        payload: { itemId: 'users||1' }
    `);

  hook.unmount();
});

test('when an online component reads an item with fields that are not cached next to a list query, the missing fields load instead of looping on renders', async () => {
  const env = createPartialUsersEnv('online-partial-item-next-to-list-query');

  // Only `name` is loaded (and so cached) before the component mounts.
  const nameHook = renderHook(() =>
    env.apiStore.useItem('users||1', { fields: ['name'] }),
  );
  await flushAllTimers();
  nameHook.unmount();

  // The list query hook subscribes to the offline status, so anything that
  // writes the offline status while the item hook renders re-renders this
  // component, which would loop until React gives up.
  const renders = createLoggerStore();
  const hook = renderHook(() => {
    const item = env.apiStore.useItem('users||1', { fields: ['name', 'age'] });
    const list = env.apiStore.useListQuery(
      { tableId: 'users' },
      { fields: ['name'] },
    );

    renders.add({
      item: `${item.status} (${JSON.stringify(item.data)}) error: ${item.error?.id ?? null}`,
      list: `${list.status} (${list.items.length} items)`,
    });
  });
  await flushAllTimers();

  // The item loads its missing field and the list loads; a render loop would
  // have thrown before getting here.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> item: loading (null) error: null ⋅ list: loading (0 items)
    -> item: success ({"name":"Ada","age":30}) error: null ⋅ list: loading (0 items)
    -> item: success ({"name":"Ada","age":30}) error: null ⋅ list: success (1 items)
    "
  `);

  hook.unmount();
});

test('fetches made while online do not re-render a component showing the offline status', async () => {
  const sessionKey = 'online-fetches-offline-status-banner';
  const storeManager = createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => sessionKey,
      storeManager,
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );

  // An offline banner, as an app would show it.
  let bannerRenders = 0;
  const banner = renderHook(() => {
    bannerRenders++;
    return storeManager.useOfflineStatus().isOfflineMode;
  });
  await flushAllTimers();
  const bannerRendersBeforeFetches = bannerRenders;

  // Each fetch reads the offline status to decide if it can be sent. Reading
  // it must not rewrite it, which would re-render every status subscriber.
  const list = renderHook(() =>
    env.apiStore.useListQuery({ tableId: 'users' }),
  );
  await flushAllTimers();
  env.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  expect(list.result.current.status).toBe('success');
  expect(bannerRenders - bannerRendersBeforeFetches).toBe(0);

  list.unmount();
  banner.unmount();
});

test('when list query hooks request fields that are not cached while offline, they show the offline error without retrying, the hook on cached fields is unaffected, and all load after recovering', async () => {
  const env = createPartialUsersEnv('offline-partial-query-uncached-fields');
  const usersQuery = { tableId: 'users' };

  // Only `name` is loaded (and so cached) before going offline.
  const nameHook = renderHook(() =>
    env.apiStore.useListQuery(usersQuery, { fields: ['name'] }),
  );
  await flushAllTimers();
  nameHook.unmount();

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // Three lists of the same query mount while offline: one needs only the
  // cached field, the other two need data that was never loaded.
  const renders = createLoggerStore();
  let renderCount = 0;
  const hook = renderHook(() => {
    const cachedFields = env.apiStore.useListQuery(usersQuery, {
      fields: ['name'],
      // A `refetching` status here would mean the cached list is disturbed by
      // the fetch attempts of the other lists.
      returnRefetchingStatus: true,
    });
    const uncachedFields = env.apiStore.useListQuery(usersQuery, {
      fields: ['name', 'age'],
    });
    const allFields = env.apiStore.useListQuery(usersQuery, { fields: '*' });

    renderCount++;
    renders.add({
      cachedFields: `${cachedFields.status} (${JSON.stringify(cachedFields.items)}) error: ${cachedFields.error?.id ?? null}`,
      uncachedFields: `${uncachedFields.status} (${JSON.stringify(uncachedFields.items)}) error: ${uncachedFields.error?.id ?? null}`,
      allFields: `${allFields.status} (${JSON.stringify(allFields.items)}) error: ${allFields.error?.id ?? null}`,
    });

    return { cachedFields, uncachedFields, allFields };
  });
  // Flushing every timer only returns if the hooks settle: a hook that keeps
  // retrying its missing fields would keep scheduling fetches forever.
  await flushAllTimers();

  // The lists settle right away instead of re-rendering on every fetch
  // attempt.
  expect(renderCount).toMatchInlineSnapshot(`1`);
  // The offline error of the lists with missing fields is the one the app has
  // to explain; the list on cached fields has no error.
  expect({
    cachedFields: isOfflineStoreError(hook.result.current.cachedFields.error),
    uncachedFields: isOfflineStoreError(
      hook.result.current.uncachedFields.error,
    ),
    allFields: isOfflineStoreError(hook.result.current.allFields.error),
  }).toMatchInlineSnapshot(`
    allFields: '✅'
    cachedFields: '❌'
    uncachedFields: '✅'
  `);

  // Recovering refetches the query without a remount, now with every field
  // the mounted lists need.
  // While that refetch is in flight the lists with missing fields stay
  // `loading` with their items hidden, as they would online.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ cachedFields: success ([{"name":"Ada"}]) error: null
    ⋅ uncachedFields: error ([]) error: offline
    ⋅ allFields: error ([]) error: offline
    └─

    >>> back online

    ┌─
    ⋅ cachedFields: refetching ([{"name":"Ada"}]) error: null
    ⋅ uncachedFields: loading ([]) error: null
    ⋅ allFields: loading ([]) error: null
    └─
    ┌─
    ⋅ cachedFields: success ([{"name":"Ada"}]) error: null
    ⋅ uncachedFields: success ([{"name":"Ada","age":30}]) error: null
    ⋅ allFields: success ([{"name":"Ada","id":1,"age":30,"city":"London"}]) error: null
    └─
    "
  `);
  // Nothing was sent while offline: the first `name` load, then the requests
  // made after recovering.
  expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['name']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);

  hook.unmount();
});

test('when fields of a loaded list query are invalidated while offline, the list keeps its cached items without retrying and refetches them after recovering', async () => {
  const env = createPartialUsersEnv('offline-partial-query-stale-fields');
  const usersQuery = { tableId: 'users' };

  const renders = createLoggerStore();
  let renderCount = 0;
  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      fields: ['name', 'age'],
    });

    renderCount++;
    renders.add({
      status: query.status,
      items: JSON.stringify(query.items),
      error: query.error?.id ?? null,
    });

    return query;
  });
  await flushAllTimers();

  // The server copy changes, so the refetch after recovering is observable.
  env.serverTable.updateItem('users||1', { age: 31 });

  // `age` is invalidated while offline: its refetch cannot run, but the cached
  // value is still displayable.
  renders.addMark('offline, `age` invalidated');
  renderCount = 0;
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();
  act(() => {
    env.apiStore.invalidateQueryAndItems({
      itemPayload: 'users||1',
      queryPayload: usersQuery,
      fields: ['age'],
    });
  });
  // Flushing every timer only returns if the hook settles: a hook that keeps
  // retrying the stale field would keep scheduling fetches forever.
  await flushAllTimers();

  // The list settles after the single refetch attempt of the invalidation
  // (which is not sent) instead of re-rendering on every retry.
  expect(renderCount).toMatchInlineSnapshot(`4`);

  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ items: [] ⋅ error: null
    -> status: success ⋅ items: [{"name":"Ada","age":30}] ⋅ error: null

    >>> offline, \`age\` invalidated

    -> status: success ⋅ items: [{"name":"Ada","age":30}] ⋅ error: null

    >>> back online

    -> status: success ⋅ items: [{"name":"Ada","age":30}] ⋅ error: null
    -> status: success ⋅ items: [{"name":"Ada","age":31}] ⋅ error: null
    "
  `);
  // Nothing was sent while offline: the first load, then the refetch after
  // recovering.
  expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['name', 'age']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
      - _type: 'list'
        payload:
          fields: ['age', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);

  hook.unmount();
});

test('when cached fields are invalidated while offline, hooks that return the refetching status show the cached data as settled instead of a refetch that cannot run', async () => {
  const env = createPartialUsersEnv('offline-partial-stale-refetching-status');
  const usersQuery = { tableId: 'users' };

  // Every field of the item is loaded online, so all hooks have cached data.
  const renders = createLoggerStore();
  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      fields: ['name', 'age'],
      returnRefetchingStatus: true,
    });
    const item = env.apiStore.useItem('users||1', {
      fields: '*',
      returnRefetchingStatus: true,
    });

    renders.add({
      query: `${query.status} ${JSON.stringify(query.items)} loadingFields: ${JSON.stringify(query.loadingFields ?? null)}`,
      item: `${item.status} ${JSON.stringify(item.data)} loadingFields: ${JSON.stringify(item.loadingFields ?? null)}`,
    });
  });
  await flushAllTimers();

  // The server copy changes, so the refetch after recovering is observable.
  env.serverTable.updateItem('users||1', { age: 31 });

  // `age` is invalidated while offline: its refetch cannot run, so the hooks
  // must not report a `refetching` that would keep a refresh spinner visible
  // for the whole offline period.
  renders.addMark('offline, `age` invalidated');
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();
  act(() => {
    env.apiStore.invalidateQueryAndItems({
      itemPayload: 'users||1',
      queryPayload: usersQuery,
      fields: ['age'],
    });
  });
  await flushAllTimers();

  // Recovering refetches the invalidated field, which is when `refetching` is
  // shown until the new data arrives.
  renders.addMark('back online');
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // Offline, each hook only shows `refetching` while the single refetch attempt
  // of the invalidation runs (it is not sent), then settles on `success` with
  // the cached data for the rest of the offline period.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> query: loading [] loadingFields: null ⋅ item: loading null loadingFields: null
    ┌─
    ⋅ query: success [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: loading null loadingFields: null
    └─
    ┌─
    ⋅ query: success [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: success {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─

    >>> offline, \`age\` invalidated

    ┌─
    ⋅ query: success [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: success {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─
    ┌─
    ⋅ query: refetching [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: success {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─
    ┌─
    ⋅ query: success [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: success {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─
    ┌─
    ⋅ query: success [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: refetching {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─
    ┌─
    ⋅ query: success [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: success {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─

    >>> back online

    ┌─
    ⋅ query: refetching [{"name":"Ada","age":30}] loadingFields: null
    ⋅ item: refetching {"name":"Ada","age":30,"id":1,"city":"London"} loadingFields: null
    └─
    ┌─
    ⋅ query: success [{"name":"Ada","age":31}] loadingFields: null
    ⋅ item: refetching {"name":"Ada","age":31,"id":1,"city":"London"} loadingFields: null
    └─
    ┌─
    ⋅ query: success [{"name":"Ada","age":31}] loadingFields: null
    ⋅ item: success {"name":"Ada","age":31,"id":1,"city":"London"} loadingFields: null
    └─
    "
  `);

  hook.unmount();
});

test('when rows show partial data while their missing fields load, going offline keeps the partial data visible next to the offline error', async () => {
  const env = createPartialUsersEnv('offline-partial-show-partial');
  const usersQuery = { tableId: 'users' };

  // Only `name` is loaded (and so cached) before going offline.
  const nameHook = renderHook(() =>
    env.apiStore.useListQuery(usersQuery, { fields: ['name'] }),
  );
  await flushAllTimers();
  nameHook.unmount();

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  // `showPartialAsRefetching` opts into rendering the cached fields while the
  // other requested fields are pending.
  const hook = renderHook(() => ({
    item: env.apiStore.useItem('users||1', {
      fields: ['name', 'age'],
      showPartialAsRefetching: true,
    }),
    query: env.apiStore.useListQuery(usersQuery, {
      fields: ['name', 'age'],
      showPartialAsRefetching: true,
    }),
  }));
  await flushAllTimers();

  // The cached `name` stays visible, `loadingFields` still tells which fields
  // are missing, and the offline error explains why they are not coming.
  expect({
    item: pick(hook.result.current.item, [
      'status',
      'error',
      'data',
      'loadingFields',
    ]),
    query: pick(hook.result.current.query, [
      'status',
      'error',
      'items',
      'loadingFields',
    ]),
  }).toMatchInlineSnapshot(`
    item:
      data: { name: 'Ada' }
      error: { code: 0, id: 'offline', message: 'Offline' }
      loadingFields: ['age']
      status: 'error'

    query:
      error: { code: 0, id: 'offline', message: 'Offline' }
      items:
        - name: 'Ada'
      loadingFields: ['age']
      status: 'error'
  `);

  hook.unmount();
});

test('when the fetch of the missing fields of an item is what reveals a backend outage, the row shows the offline error without retrying and loads after the backend recovers', async () => {
  const sessionKey = 'offline-partial-item-outage';
  let backendIsUp = true;
  let recoveryChecks = 0;
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', age: 30, city: 'London' }] },
    {
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: {
          // No network signal here: offline mode is only known after a fetch
          // fails and is classified as an outage.
          classifyFailure: () => 'outage',
          outage: {
            enabled: true,
            recoveryCheck: () => {
              recoveryChecks++;
              return backendIsUp;
            },
            // The default probe delays are randomized (jitter) and back off
            // from 30s, so whether a probe runs inside the time windows of
            // this test would depend on `Math.random()`. A fixed interval
            // makes the backend be re-checked every 5s.
            recoveryProbe: {
              initialIntervalMs: 5_000,
              maxIntervalMs: 5_000,
              backoffMultiplier: 1,
              jitterRatio: 0,
            },
          },
        },
      }),
      partialResources: partialUserResourcesConfig,
      persistentStorage: {
        adapter: 'local-sync',
        schema: partialUserRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
      },
    },
  );

  // Only `name` is loaded (and so cached) before the backend goes down.
  const nameHook = renderHook(() =>
    env.apiStore.useItem('users||1', { fields: ['name'] }),
  );
  await flushAllTimers();
  nameHook.unmount();

  backendIsUp = false;
  env.serverTable.setNextFetchError('users||1', 'backend is down');

  const renders = createLoggerStore();
  let renderCount = 0;
  const hook = renderHook(() => {
    const item = env.apiStore.useItem('users||1', { fields: ['name', 'age'] });

    renderCount++;
    renders.add({
      status: item.status,
      data: JSON.stringify(item.data),
      error: item.error?.id ?? null,
    });

    return item;
  });
  // Long enough for the failed fetch and for several failed recovery probes.
  await advanceTime(30_000);

  // The backend was re-checked while it was down...
  expect(recoveryChecks).toMatchInlineSnapshot(`5`);
  // ...but one fetch attempt was enough to reveal the outage, and the row
  // then settles instead of re-rendering on every retry or failed probe.
  expect(renderCount).toMatchInlineSnapshot(`4`);
  expect(isOfflineStoreError(hook.result.current.error)).toBe(true);

  renders.addMark('backend is back');
  backendIsUp = true;
  await advanceTime(60_000);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null ⋅ error: null
    -> status: error ⋅ data: null ⋅ error: offline

    >>> backend is back

    -> status: loading ⋅ data: null ⋅ error: null
    -> status: success ⋅ data: {"name":"Ada","age":30} ⋅ error: null
    "
  `);
  // The first `name` load, the attempt that failed, then the requests made
  // after recovering.
  expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['name']
          itemId: 'users||1'
      - _type: 'item'
        payload:
          fields: ['age']
          itemId: 'users||1'
      - _type: 'item'
        payload:
          fields: ['age', 'name']
          itemId: 'users||1'
    `);

  hook.unmount();
});

/** Summarizes an imperative read result: its data, or whether it failed with the offline error. */
function describeRead(
  result:
    | { ok: true; value: unknown }
    | { ok: false; error: { id: string; code: number; message: string } },
): string {
  if (result.ok) return `ok ${JSON.stringify(result.value)}`;
  return isOfflineStoreError(result.error)
    ? 'offline error'
    : `error ${result.error.id}`;
}

test('when imperative item reads ask for fields that are not cached while offline, they fail with the offline error instead of returning the partial item, and succeed after recovering', async () => {
  const env = createPartialUsersEnv('offline-partial-item-imperative-reads');

  // Only `name` is loaded (and so cached) before going offline.
  await resolveAfterAllTimers(
    env.apiStore.awaitItemFetch('users||1', { fields: ['name'] }),
  );

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  async function readAll() {
    const awaitUncached = await resolveAfterAllTimers(
      env.apiStore.awaitItemFetch('users||1', { fields: ['name', 'age'] }),
    );

    return {
      // A read of the cached field is served from the cache.
      cachedFields: describeRead(
        await resolveAfterAllTimers(
          env.apiStore.getItemFromStateOrFetch('users||1', {
            fields: ['name'],
          }),
        ),
      ),
      // Reads of data that was never loaded cannot be answered offline: they
      // must not report success with the requested fields missing.
      uncachedFields: describeRead(
        await resolveAfterAllTimers(
          env.apiStore.getItemFromStateOrFetch('users||1', {
            fields: ['name', 'age'],
          }),
        ),
      ),
      allFields: describeRead(
        await resolveAfterAllTimers(
          env.apiStore.getItemFromStateOrFetch('users||1', { fields: '*' }),
        ),
      ),
      awaitUncachedFields: awaitUncached.error
        ? describeRead({ ok: false, error: awaitUncached.error })
        : describeRead({ ok: true, value: awaitUncached.data }),
    };
  }

  expect(await readAll()).toMatchInlineSnapshot(`
    allFields: 'offline error'
    awaitUncachedFields: 'offline error'
    cachedFields: 'ok {"name":"Ada"}'
    uncachedFields: 'offline error'
  `);

  // The failed reads leave the cached item untouched, so hooks and state
  // getters still show it as loaded.
  expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(
    `name: 'Ada'`,
  );
  const itemQuery =
    env.store.state.itemQueries[env.apiStore.getItemKey('users||1')];
  expect(itemQuery && pick(itemQuery, ['status', 'error']))
    .toMatchInlineSnapshot(`
    error: null
    status: 'success'
  `);

  // After recovering, the same reads fetch the missing fields. The cached-field
  // read now also shows `age`, merged into the cached item by the first read.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(await readAll()).toMatchInlineSnapshot(`
    allFields: 'ok {"name":"Ada","age":30,"id":1,"city":"London"}'
    awaitUncachedFields: 'ok {"name":"Ada","age":30}'
    cachedFields: 'ok {"name":"Ada","age":30}'
    uncachedFields: 'ok {"name":"Ada","age":30}'
  `);
});

test('when imperative list query reads ask for fields that are not cached while offline, they fail with the offline error instead of returning partial items, and succeed after recovering', async () => {
  const env = createPartialUsersEnv('offline-partial-query-imperative-reads');
  const usersQuery = { tableId: 'users' };

  // Only `name` is loaded (and so cached) before going offline.
  await resolveAfterAllTimers(
    env.apiStore.awaitListQueryFetch(usersQuery, { fields: ['name'] }),
  );

  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  function itemsData(
    result: Awaited<ReturnType<typeof env.apiStore.getQueryFromStateOrFetch>>,
  ) {
    return result.ok
      ? { ok: true as const, value: result.value.items.map((i) => i.data) }
      : result;
  }

  async function readAll() {
    const awaitUncached = await resolveAfterAllTimers(
      env.apiStore.awaitListQueryFetch(usersQuery, { fields: ['name', 'age'] }),
    );

    return {
      // A read of the cached field is served from the cache.
      cachedFields: describeRead(
        itemsData(
          await resolveAfterAllTimers(
            env.apiStore.getQueryFromStateOrFetch(usersQuery, {
              fields: ['name'],
            }),
          ),
        ),
      ),
      // Reads of data that was never loaded cannot be answered offline: they
      // must not report success with the requested fields missing.
      uncachedFields: describeRead(
        itemsData(
          await resolveAfterAllTimers(
            env.apiStore.getQueryFromStateOrFetch(usersQuery, {
              fields: ['name', 'age'],
            }),
          ),
        ),
      ),
      allFields: describeRead(
        itemsData(
          await resolveAfterAllTimers(
            env.apiStore.getQueryFromStateOrFetch(usersQuery, { fields: '*' }),
          ),
        ),
      ),
      awaitUncachedFields: awaitUncached.error
        ? describeRead({ ok: false, error: awaitUncached.error })
        : describeRead({
            ok: true,
            value: awaitUncached.items.map((i) => i.data),
          }),
    };
  }

  expect(await readAll()).toMatchInlineSnapshot(`
    allFields: 'offline error'
    awaitUncachedFields: 'offline error'
    cachedFields: 'ok [{"name":"Ada"}]'
    uncachedFields: 'offline error'
  `);

  // The failed reads leave the cached query untouched.
  const queryState = env.apiStore.getQueryState(usersQuery);
  expect(queryState && pick(queryState, ['status', 'error']))
    .toMatchInlineSnapshot(`
    error: null
    status: 'success'
  `);

  // After recovering, the same reads fetch the missing fields. The cached-field
  // read now also shows `age`, merged into the cached item by the first read.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(await readAll()).toMatchInlineSnapshot(`
    allFields: 'ok [{"name":"Ada","age":30,"id":1,"city":"London"}]'
    awaitUncachedFields: 'ok [{"name":"Ada","age":30}]'
    cachedFields: 'ok [{"name":"Ada","age":30}]'
    uncachedFields: 'ok [{"name":"Ada","age":30}]'
  `);
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'offline-list-query-empty-session',
        offlineSession: { network: network.config },
      }),
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: { operations: {} },
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
