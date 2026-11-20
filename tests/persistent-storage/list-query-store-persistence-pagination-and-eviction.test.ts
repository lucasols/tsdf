import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCompactLocalStorageEntry } from '../../src/persistentStorage/compactLocalStorageEntry';
import type { OfflineNetworkModeConfig } from '../../src/persistentStorage/offline/types';
import { SYNC_STORAGE_TOUCH_THROTTLE_MS } from '../../src/persistentStorage/persistentStorageManager';
import { type ListQueryParams, type Row } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { getParsedLocalStorageValue } from '../utils/persistentStorageOptimizationTestUtils';
import {
  persistentStore,
  rawItemPayload,
  storeItemKey,
  itemStorageKey,
  queryStorageKey,
  setCachedItem,
  setCachedQuery,
  listStoredKeys,
  createEnv,
} from './listQueryStorePersistenceTestShared';
import {
  getLocalListItemEntrySizeBytes,
  getLocalListQueryEntrySizeBytes,
  sumPersistedEntryBytes,
} from './persistentStorageByteBudgetTestUtils';

const fullLoadedFields = ['age', 'email', 'id', 'name'];
let network = createOfflineNetworkMock();

function getStoredQueryItemKeys(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
): string[] {
  const raw = localStorage.getItem(
    queryStorageKey(storeName, sessionKey, params),
  );
  if (raw === null) {
    throw new Error(`Missing localStorage entry for ${storeName}`);
  }

  const parsed = __LEGIT_CAST__<{ i: string[] }, unknown>(JSON.parse(raw));
  return parsed.i;
}

const usersListQuery = { tableId: 'users' };

/**
 * Runs the app sessions that leave the users list (two rows) cached while
 * some of its rows were evicted by `maxItemBytes`, and returns a function that
 * starts the next app session (a cold start).
 */
async function cacheUsersListAndEvictRows(options: {
  storeName: string;
  evictedRows: 'User 1' | 'all';
  offlineNetwork?: OfflineNetworkModeConfig;
}) {
  const projectsQuery = { tableId: 'projects' };
  const serverData = {
    users: [
      { id: 1, name: 'User 1' },
      { id: 2, name: 'User 2' },
    ],
    projects: [
      { id: 1, name: 'Project 1' },
      { id: 2, name: 'Project 2' },
    ],
  };
  const projectRowsBytes = sumPersistedEntryBytes(
    getLocalListItemEntrySizeBytes(rawItemPayload('projects', 1), {
      id: 1,
      name: 'Project 1',
    }),
    getLocalListItemEntrySizeBytes(rawItemPayload('projects', 2), {
      id: 2,
      name: 'Project 2',
    }),
  );
  // The item budget fits the two project rows, plus a single user row when
  // only "User 1" is meant to be evicted.
  const maxItemBytes =
    options.evictedRows === 'all'
      ? projectRowsBytes
      : projectRowsBytes +
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'User 2',
        });

  function startNextSession() {
    return createEnv({
      storeName: options.storeName,
      sessionKey: 'sess1',
      maxItemBytes,
      offlineNetwork: options.offlineNetwork,
      serverData: structuredClone(serverData),
    });
  }

  // The users list is loaded and cached with both rows.
  let session = startNextSession();
  const usersList = renderHook(() =>
    session.apiStore.useListQuery(usersListQuery),
  );
  await flushAllTimers();
  usersList.unmount();
  await advanceTime(60_000);

  if (options.evictedRows === 'User 1') {
    // In a new session only "User 2" is opened, which refreshes its recency.
    session = startNextSession();
    const userDetails = renderHook(() =>
      session.apiStore.useItem(rawItemPayload('users', 2)),
    );
    await flushAllTimers();
    // Wait for the localStorage touch throttle so the read recency is stored.
    await advanceTime(SYNC_STORAGE_TOUCH_THROTTLE_MS + 100);
    userDetails.unmount();
  }

  // Loading the projects list pushes the items over maxItemBytes: the least
  // recently read rows are evicted.
  const projectsList = renderHook(() =>
    session.apiStore.useListQuery(projectsQuery),
  );
  await flushAllTimers();
  await advanceTime(1100);
  await flushAllTimers();
  projectsList.unmount();

  return { startNextSession };
}

function mountUsersList(env: ReturnType<typeof createEnv>) {
  const renders = createLoggerStore({ arrays: 'all' });

  const { unmount } = renderHook(() => {
    const { items, status, error } = env.apiStore.useListQuery(usersListQuery, {
      returnRefetchingStatus: true,
    });

    renders.add({
      status,
      error: error?.id ?? null,
      names: items.map((item) => item.name),
    });
  });

  return { renders, unmount };
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage: list query store persistence', () => {
  test('round-trip persistence preserves offset-pagination progress for loadMore', async () => {
    const productsQuery = { tableId: 'products' };
    const products = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Product ${index + 1}`,
    }));
    const storeName = 'lq-offset-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products },
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    // Persist two pages so the reader starts from a 10-item hydrated query
    // instead of a fresh first page.
    writerEnv.apiStore.scheduleListQueryFetch('highPriority', productsQuery, 5);
    await flushAllTimers();

    writerEnv.apiStore.loadMore(productsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products },
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    const renders = createLoggerStore();

    // The reader should show the restored 10 items immediately, then
    // revalidate exactly that restored window on mount.
    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { returnRefetchingStatus: true },
      );

      renders.add({
        status,
        count: items.length,
        lastName: items.at(-1)?.name ?? null,
        hasMore,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      "
    `);
    // Hydration revalidation should reconcile the same 10-item range that was
    // restored from localStorage.
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 10, offset: 0 }
        returned_items: 10
    `);

    // After hydration revalidation settles, loadMore should continue paging
    // from the restored size rather than refetching the head again.
    readerEnv.serverTable.clearFetchHistory();
    readerEnv.apiStore.loadMore(productsQuery);
    await flushAllTimers();

    expect(
      readerEnv.apiStore.getQueryState(productsQuery)?.items.length,
    ).toMatchInlineSnapshot(`15`);
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 5, offset: 10 }
        returned_items: 5
    `);
  });

  test('hook loadSize smaller than hydrated query keeps the persisted larger size during refetch', async () => {
    const productsQuery = { tableId: 'products' };
    const cachedProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Cached Product ${index + 1}`,
    }));
    const freshProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Fresh Product ${index + 1}`,
    }));
    const storeName = 'lq-hook-loadsize-smaller';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: cachedProducts },
      defaultQuerySize: 5,
    });

    writerEnv.apiStore.scheduleListQueryFetch(
      'highPriority',
      productsQuery,
      10,
    );
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: freshProducts },
      defaultQuerySize: 5,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { loadSize: 5, returnRefetchingStatus: true },
      );

      renders.add({
        status,
        count: items.length,
        lastName: items.at(-1)?.name ?? null,
        hasMore,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 10 ⋅ lastName: Cached Product 10 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 10 ⋅ lastName: Cached Product 10 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Fresh Product 10 ⋅ hasMore: ✅
      "
    `);
    expect(
      readerEnv.serverTable.fetchHistory.map((entry) => {
        if (entry.type !== 'list') return entry.type;
        return {
          type: entry.type,
          offset: entry.offset,
          limit: entry.limit,
          itemIds:
            entry.results === 'aborted'
              ? 'aborted'
              : entry.results.map((result) => result.itemId).join(','),
        };
      }),
    ).toMatchInlineSnapshot(`
      - itemIds: 'products||1,products||2,products||3,products||4,products||5,products||6,products||7,products||8,products||9,products||10'
        limit: 10
        offset: 0
        type: 'list'
    `);
  });

  test('hook loadSize larger than hydrated query expands the persisted list on refetch', async () => {
    const productsQuery = { tableId: 'products' };
    const cachedProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Cached Product ${index + 1}`,
    }));
    const freshProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Fresh Product ${index + 1}`,
    }));
    const storeName = 'lq-hook-loadsize-larger';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: cachedProducts },
      defaultQuerySize: 5,
    });

    // Persist only the default first page so the reader can prove a larger
    // hook loadSize expands the hydrated query during revalidation.
    writerEnv.apiStore.scheduleListQueryFetch('highPriority', productsQuery, 5);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: freshProducts },
      defaultQuerySize: 5,
    });

    const renders = createLoggerStore();

    // Hydration starts with the cached 5 items, then mount revalidation should
    // refetch from the head using the hook's larger requested size.
    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { loadSize: 10, returnRefetchingStatus: true },
      );

      renders.add({
        status,
        count: items.length,
        lastName: items.at(-1)?.name ?? null,
        hasMore,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 5 ⋅ lastName: Cached Product 5 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 5 ⋅ lastName: Cached Product 5 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Fresh Product 10 ⋅ hasMore: ✅
      "
    `);
    // The revalidation request uses limit 10, showing the persisted query did
    // not lock the reader to the original cached page size.
    expect(
      readerEnv.serverTable.fetchHistory.map((entry) => {
        if (entry.type !== 'list') return entry.type;
        return {
          type: entry.type,
          offset: entry.offset,
          limit: entry.limit,
          itemIds:
            entry.results === 'aborted'
              ? 'aborted'
              : entry.results.map((result) => result.itemId).join(','),
        };
      }),
    ).toMatchInlineSnapshot(`
      - itemIds: 'products||1,products||2,products||3,products||4,products||5,products||6,products||7,products||8,products||9,products||10'
        limit: 10
        offset: 0
        type: 'list'
    `);
  });

  test('round-trip persistence keeps state-manipulated query membership and item updates', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-state-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    // Persist local-only state changes so the reader can prove manual edits and
    // query membership changes round-trip through localStorage.
    writerEnv.apiStore.scheduleListQueryFetch('highPriority', usersQuery);
    await flushAllTimers();

    writerEnv.apiStore.updateItemState('users||1', (draft) => {
      draft.name = 'Edited Alice';
    });
    writerEnv.apiStore.addItemToState(
      'users||20',
      { id: 20, name: 'Local User' },
      { addItemToQueries: { queries: usersQuery, appendTo: 'end' } },
    );

    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    const renders = createLoggerStore();

    // The hook should synchronously hydrate the locally edited query before any
    // mount revalidation has a chance to reconcile with the server.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Edited Alice, …(2 more)]
      "
    `);
    // No request has run yet because this assertion intentionally happens
    // before effects are flushed.
    expect(readerEnv.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);
    // The local-only item must be available as an item state, not only as a
    // query membership key.
    expect(readerEnv.apiStore.getItemState('users||20')).toMatchInlineSnapshot(`
      id: 20
      name: 'Local User'
    `);
  });

  test('deleteItemState removes deleted items from persisted storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-delete-persisted-item';
    const sessionKey = 'sess1';
    const deletedItemStorageKey = itemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    env.apiStore.scheduleListQueryFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem(deletedItemStorageKey)).not.toBeNull();
    expect(getStoredQueryItemKeys(storeName, sessionKey, usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);

    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem(deletedItemStorageKey)).toBeNull();
    expect(getStoredQueryItemKeys(storeName, sessionKey, usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||2']
      `);
  });

  test('when maxQueryBytes is exceeded, the least recently read query is evicted first', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-lru';
    const sessionKey = 'sess1';

    setCachedQuery(storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, secondQuery, []);

    const env = createEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getLocalListQueryEntrySizeBytes(firstQuery, []),
        getLocalListQueryEntrySizeBytes(thirdQuery, [storeItemKey('third', 1)]),
      ),
      serverData: { first: [], third: [{ id: 1, name: 'Third' }] },
    });

    const renders = createLoggerStore();

    // Reading the older query refreshes its recency before the later third
    // query write forces maxQueryBytes maintenance. Assert the immediate
    // hydrated value before timers run because this test is about persisted read
    // recency, not server reconciliation.
    renderHook(() => {
      const { items, status, hasMore } = env.apiStore.useListQuery(firstQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, count: items.length, hasMore });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 0 ⋅ hasMore: ❌
      "
    `);

    // Let the read-recency touch flush before writing the third query; the
    // second query should now be the least recently read persisted entry.
    await advanceTime(2100);

    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"first"}', '{tableId:"third"}']`);
  });

  test('when maxItemBytes is exceeded, the least recently read item is evicted first', async () => {
    const storeName = 'lq-item-lru';
    const sessionKey = 'sess1';
    const oldestPayload = rawItemPayload('users', 1);
    const freshPayload = rawItemPayload('users', 3);
    const oldestItem = { id: 1, name: 'Oldest cached' };
    const freshItem = { id: 3, name: 'Fresh' };

    setCachedItem(storeName, sessionKey, 'users', 1, oldestItem);
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newer cached',
    });

    const env = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(oldestPayload, oldestItem),
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(oldestPayload, oldestItem),
          getLocalListItemEntrySizeBytes(freshPayload, freshItem, {
            loadedFields: fullLoadedFields,
          }),
        ),
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
          getLocalListItemEntrySizeBytes(freshPayload, freshItem, {
            loadedFields: fullLoadedFields,
          }),
        ),
      ),
      serverData: { users: [oldestItem] },
    });

    const renders = createLoggerStore();

    // Reading the oldest item refreshes its recency before a later standalone
    // item write forces maxItemBytes maintenance. Assert the immediate hydrated
    // value before timers run because this test is about persisted read recency,
    // not server reconciliation.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { disableRefetchOnMount: true, returnRefetchingStatus: true },
      );

      renders.add({ status, data: data ?? null });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Oldest cached}
      "
    `);

    // Wait for the localStorage touch throttle so the recency update is visible
    // to eviction maintenance.
    await advanceTime(2100);

    env.apiStore.addItemToState(freshPayload, freshItem);

    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||1', '"users||3']`);
  });

  test('cold persisted query items are trimmed by recency during unrelated maxItemBytes cleanup', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-cold-query-items';
    const sessionKey = 'sess1';
    const newerPayload = rawItemPayload('users', 2);
    const standalonePayload = rawItemPayload('users', 3);
    const newerItem = { id: 2, name: 'Newer cached' };
    const standaloneItem = { id: 3, name: 'Fresh standalone' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Older cached',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, newerItem);
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getLocalListItemEntrySizeBytes(newerPayload, newerItem),
        getLocalListItemEntrySizeBytes(standalonePayload, standaloneItem),
      ),
    });

    // Write an unrelated standalone item without ever hydrating the cached query.
    env.apiStore.addItemToState(standalonePayload, standaloneItem);

    await advanceTime(1100);
    await flushAllTimers();

    // The cold query stays persisted, but maintenance now keeps the newer
    // cached item and the unrelated standalone item by recency. The trimmed
    // query entry records that it no longer lists every row of the query.
    expect(listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`))
      .toMatchInlineSnapshot(`
        ['{tableId:"users"}']
      `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(usersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||2']
      missingItems: '✅'
      payload: { tableId: 'users' }
    `);
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);
  });

  test('a cached list that lost some rows to maxItemBytes shows the remaining rows as still loading, then the full list', async () => {
    const storeName = 'lq-evicted-rows-partial';
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName,
      evictedRows: 'User 1',
    });

    // The least recently read row ("User 1") was evicted. The users query is
    // still cached: its entry lists the row that is left and records that it
    // is not the whole list anymore (`m`).
    expect(
      listStoredKeys(`tsdf.sess1.${storeName}.li.`).sort(),
    ).toMatchInlineSnapshot(`['"projects||1', '"projects||2', '"users||2']`);
    expect(
      getParsedLocalStorageValue(
        queryStorageKey(storeName, 'sess1', usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689729530
      i: ['"users||2']
      m: '✅'
      p: { tableId: 'users' }
    `);

    // A cold start mounts the users list again.
    const session = startNextSession();
    const { renders } = mountUsersList(session);
    await flushAllTimers();

    // The cached list is missing a row, so it must not be reported as a
    // complete `success`: the remaining row is available while the list is
    // reported as loading, until the fetch delivers every row.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 2]
      -> status: success ⋅ error: null ⋅ names: [User 1, User 2]
      "
    `);
    expect(
      session.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
    `);

    // The refetched list is cached as a complete list again.
    await advanceTime(1100);
    await flushAllTimers();
    expect(
      getParsedLocalStorageValue(
        queryStorageKey(storeName, 'sess1', usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689732440
      i: ['"users||1', '"users||2']
      p: { tableId: 'users' }
    `);
  });

  test('a cached list that lost all its rows to maxItemBytes shows a loading state instead of an empty list', async () => {
    const storeName = 'lq-evicted-rows-all';
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName,
      evictedRows: 'all',
    });

    // Both user rows were evicted, but the users query is still cached.
    expect(
      listStoredKeys(`tsdf.sess1.${storeName}.li.`).sort(),
    ).toMatchInlineSnapshot(`['"projects||1', '"projects||2']`);
    expect(
      getParsedLocalStorageValue(
        queryStorageKey(storeName, 'sess1', usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689665620
      i: []
      m: '✅'
      p: { tableId: 'users' }
    `);

    // A cold start mounts the users list again.
    const { renders } = mountUsersList(startNextSession());
    await flushAllTimers();

    // None of the cached rows can be restored: an empty `success` list would
    // read as "no records", so the list loads as if it was never cached.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: success ⋅ error: null ⋅ names: [User 1, User 2]
      "
    `);
  });

  test('starting offline with a cached list that lost some rows to maxItemBytes shows the remaining rows next to the offline error', async () => {
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName: 'lq-evicted-rows-partial-offline',
      evictedRows: 'User 1',
      offlineNetwork: network.config,
    });

    // The app starts offline and mounts the users list.
    network.setOffline();
    const session = startNextSession();
    const usersList = mountUsersList(session);
    await flushAllTimers();

    // The cached list is missing "User 1" and cannot be refetched: it must
    // not be presented as the complete list. The remaining row stays
    // available next to the offline error.
    expect(usersList.renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 2]
      -> status: error ⋅ error: offline ⋅ names: [User 2]
      "
    `);

    // Imperative reads do not return the incomplete list as a result.
    expect(
      await resolveAfterAllTimers(
        session.apiStore.awaitListQueryFetch(usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
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
      session.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    // The offline session neither drops what is left of the cached list nor
    // turns it into a complete one: the next offline start gets the same
    // rows and error.
    await advanceTime(1100);
    await flushAllTimers();
    usersList.unmount();
    const { renders: nextStartRenders } = mountUsersList(startNextSession());
    await flushAllTimers();

    expect(nextStartRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 2]
      -> status: error ⋅ error: offline ⋅ names: [User 2]
      "
    `);
  });

  test('starting offline with a cached list that lost all its rows to maxItemBytes reports the offline error instead of an empty list', async () => {
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName: 'lq-evicted-rows-all-offline',
      evictedRows: 'all',
      offlineNetwork: network.config,
    });

    // The app starts offline and mounts the users list.
    network.setOffline();
    const session = startNextSession();
    const { renders } = mountUsersList(session);
    await flushAllTimers();

    // An empty `success` list would read as "no records": with no row left
    // the list behaves as if it was never cached.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: error ⋅ error: offline ⋅ names: []
      "
    `);
    expect(
      session.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('a cached list with a row the schema no longer accepts shows the remaining rows as still loading, then the full list', async () => {
    const storeName = 'lq-rejected-row';
    const sessionKey = 'sess1';
    const scope = persistentStore.scope(storeName, sessionKey).listQuery;

    // "User 2" was cached by an older version of the app, in a shape the
    // current schema rejects (no `name`), so it is discarded when read.
    scope.seedItem('users', 1, { id: 1, name: 'User 1' });
    scope.seedItem('users', 2, { id: 2, fullName: 'User 2' });
    setCachedQuery(storeName, sessionKey, usersListQuery, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'User 1' },
          { id: 2, name: 'User 2' },
        ],
      },
    });
    const { renders } = mountUsersList(env);
    await flushAllTimers();

    // Only one of the two cached rows can be restored: the list is not
    // reported as a complete `success` until it is fetched again.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 1]
      -> status: success ⋅ error: null ⋅ names: [User 1, User 2]
      "
    `);
  });

  test('items and queries are saved per entry and pinned entries survive eviction', async () => {
    const pinnedItemPayload = rawItemPayload('second', 1);
    const pinnedQueryPayload = { tableId: 'second' };
    const env = createEnv({
      storeName: 'lq-evict',
      sessionKey: 'sess1',
      maxItemBytes: getLocalListItemEntrySizeBytes(
        rawItemPayload('second', 1),
        { id: 1, name: 'Second' },
      ),
      maxQueryBytes: getLocalListQueryEntrySizeBytes(pinnedQueryPayload, [
        storeItemKey('second', 1),
      ]),
      pinnedItems: [pinnedItemPayload],
      pinnedQueries: [pinnedQueryPayload],
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
      },
    });

    env.scheduleFetch('highPriority', { tableId: 'first' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'second' });
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem('tsdf.sess1.lq-evict')).toBeNull();

    expect(listStoredKeys('tsdf.sess1.lq-evict.lq.')).toMatchInlineSnapshot(
      `['{tableId:"second"}']`,
    );
    expect(listStoredKeys('tsdf.sess1.lq-evict.li.')).toMatchInlineSnapshot(
      `['"second||1']`,
    );
  });

  test('pinned items survive eviction even when their query is evicted', async () => {
    const env = createEnv({
      storeName: 'lq-pinned-item-only',
      sessionKey: 'sess1',
      maxItemBytes: getLocalListItemEntrySizeBytes(
        rawItemPayload('second', 1),
        { id: 1, name: 'Second' },
      ),
      maxQueryBytes: getLocalListQueryEntrySizeBytes({ tableId: 'first' }, [
        storeItemKey('first', 1),
      ]),
      pinnedItems: [rawItemPayload('second', 1)],
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
      },
    });

    // Load the pinned item first, then make a different query the one that survives maxQueryBytes cleanup.
    env.scheduleFetch('highPriority', { tableId: 'second' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'first' });
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys('tsdf.sess1.lq-pinned-item-only.lq.').length,
    ).toMatchInlineSnapshot(`1`);
    expect(
      listStoredKeys('tsdf.sess1.lq-pinned-item-only.li.'),
    ).toMatchInlineSnapshot(`['"second||1']`);
  });

  test('default persistence byte budgets comfortably keep 125 items and 25 queries', async () => {
    const storeName = 'lq-default-limits';
    const sessionKey = 'sess1';
    const serverData = Object.fromEntries(
      Array.from({ length: 25 }, (tableEntry_, tableIdx) => [
        `table-${tableIdx + 1}`,
        Array.from({ length: 5 }, (itemEntry_, itemIdx) => ({
          id: itemIdx + 1,
          name: `Item ${tableIdx + 1}-${itemIdx + 1}`,
        })),
      ]),
    );
    const env = createEnv({ storeName, sessionKey, serverData });

    for (let tableIndex = 0; tableIndex < 25; tableIndex++) {
      env.scheduleFetch('highPriority', { tableId: `table-${tableIndex + 1}` });
      await flushAllTimers();
    }

    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`).length,
    ).toMatchInlineSnapshot(`25`);
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`).length,
    ).toMatchInlineSnapshot(`125`);
  }, 5_000);

  test('maxQuerySize persists only the first items from each query', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-max-query-size',
      sessionKey: 'sess1',
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(getStoredQueryItemKeys('lq-max-query-size', 'sess1', usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);
    expect(listStoredKeys('tsdf.sess1.lq-max-query-size.li.'))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);

    const readerEnv = createEnv({
      storeName: 'lq-max-query-size',
      sessionKey: 'sess1',
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });
    const renders = createLoggerStore();

    // Only the truncated query is restored from localStorage; the mount
    // revalidation should fetch the full server list again.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Alice, Bob]
      -> status: refetching ⋅ names: [Alice, Bob]
      -> status: success ⋅ names: [Alice, …(2 more)]
      "
    `);
    // Revalidation can include the evicted third item even though maxQuerySize
    // kept only the first two items persisted.
    expect(
      readerEnv.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 3
    `);
  });

  test('ignoreItems excludes matching item payloads from persisted items and queries', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-ignore',
      sessionKey: 'sess1',
      ignoreItems: ['users||2'],
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredKeys('tsdf.sess1.lq-ignore.li.')).toMatchInlineSnapshot(
      `['"users||1']`,
    );
    expect(getStoredQueryItemKeys('lq-ignore', 'sess1', usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||1']
      `);

    const readerEnv = createEnv({
      storeName: 'lq-ignore',
      sessionKey: 'sess1',
      ignoreItems: ['users||2'],
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });
    const renders = createLoggerStore();

    // The ignored item is absent from storage, but a normal mount revalidation
    // should still reconcile the full server response.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Alice]
      -> status: refetching ⋅ names: [Alice]
      -> status: success ⋅ names: [Alice, Bob]
      "
    `);
    // The fetch proves ignoreItems only limits what is persisted, not what the
    // live query can receive from the server.
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
    `);
  });

  test('preload hydrates cached local queries and items without reporting an error', async () => {
    const onPersistentStorageError = vi.fn();
    setCachedItem('lq-preload-local', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });
    setCachedQuery('lq-preload-local', 'sess1', { tableId: 'users' }, [
      storeItemKey('users', 1),
    ]);
    const env = createEnv({
      storeName: 'lq-preload-local',
      sessionKey: 'sess1',
      onPersistentStorageError,
    });

    await expect(env.apiStore.preloadQueryFromStorage({ tableId: 'users' }))
      .resolves.toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await expect(env.apiStore.preloadItemFromStorage('users||1')).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);

    expect(env.apiStore.getQueryState({ tableId: 'users' }))
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached'
    `);
    expect(onPersistentStorageError).not.toHaveBeenCalled();
  });

  test('invalid cached query entries are cleaned up only after a direct read', async () => {
    const key = setCachedQuery(
      'lq-invalid',
      'sess1',
      { tableId: 'users' },
      [storeItemKey('users', 1)],
      false,
      1,
    );

    const env = createEnv({
      storeName: 'lq-invalid',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(env.apiStore.getQueryState({ tableId: 'users' })).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('scheduled maintenance does not clean invalid cached query entries before they are read', async () => {
    const key = setCachedQuery(
      'lq-invalid-maintenance',
      'sess1',
      { tableId: 'users' },
      [storeItemKey('users', 1)],
      false,
      1,
    );

    createEnv({
      storeName: 'lq-invalid-maintenance',
      sessionKey: 'sess1',
      version: 2,
    });

    await advanceTime(2100);
    await flushAllTimers();

    expect(localStorage.getItem(key)).not.toBeNull();
  });

  test('invalid cached query entries are also cleaned up after a hook read', async () => {
    const usersQuery = { tableId: 'users' };
    const key = setCachedQuery(
      'lq-invalid-hook',
      'sess1',
      usersQuery,
      [storeItemKey('users', 1)],
      false,
      1,
    );

    const env = createEnv({
      storeName: 'lq-invalid-hook',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(localStorage.getItem(key)).not.toBeNull();

    renderHook(() => {
      env.apiStore.useListQuery(usersQuery, {
        // The hook should exercise the lazy query read path without
        // kicking off a fetch that could hide the cleanup behavior.
        isOffScreen: true,
      });
    });
    await flushAllTimers();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid cached item payloads are cleaned up only after a direct read', async () => {
    const key = itemStorageKey('lq-invalid-item-payload', 'sess1', 'users', 1);
    persistentStore
      .scope('lq-invalid-item-payload', 'sess1')
      .listQuery.seedItem('users', 1, { id: 1, name: 'Alice' });
    const entry = persistentStore
      .scope('lq-invalid-item-payload', 'sess1')
      .listQuery.readItemEntry<Row>('users', 1);
    localStorage.setItem(
      key,
      JSON.stringify(
        createCompactLocalStorageEntry(
          {
            d: entry.data.data,
            p: true,
            ...(entry.data.loadedFields ? { lf: entry.data.loadedFields } : {}),
          },
          entry.version,
        ),
      ),
    );

    const env = createEnv({
      storeName: 'lq-invalid-item-payload',
      sessionKey: 'sess1',
    });

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(
      env.apiStore.getItemState(rawItemPayload('users', 1)),
    ).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid cached query payloads are cleaned up only after a direct read', async () => {
    const usersQuery = { tableId: 'users' };
    const queryKey = queryStorageKey(
      'lq-invalid-query-payload',
      'sess1',
      usersQuery,
    );
    const scope = persistentStore.scope('lq-invalid-query-payload', 'sess1');
    scope.listQuery.seedItem('users', 1, { id: 1, name: 'Alice' });
    scope.listQuery.seedQuery(usersQuery, [{ tableId: 'users', id: 1 }]);
    const entry = persistentStore.storage.readEntry<{
      a: number;
      i: string[];
      p: unknown;
      h?: true;
      o?: true;
      v?: number;
    }>(queryKey);
    if (entry === null) {
      throw new Error(`Missing seeded entry for ${queryKey}`);
    }
    localStorage.setItem(queryKey, JSON.stringify({ ...entry, p: true }));

    const env = createEnv({
      storeName: 'lq-invalid-query-payload',
      sessionKey: 'sess1',
    });

    expect(localStorage.getItem(queryKey)).not.toBeNull();
    expect(env.apiStore.getQueryState(usersQuery)).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(queryKey)).toBeNull();
  });
});
