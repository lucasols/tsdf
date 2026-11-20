import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
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
import type { OfflineNetworkModeConfig } from '../../src/persistentStorage/offline/types';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { type Row } from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { getParsedOpfsFileData } from '../utils/persistentStorageOptimizationTestUtils';
import {
  createEnv,
  createListQueryOpfsTestStore,
} from './listQueryStorePersistenceOpfsTestShared';
import {
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  sumPersistedEntryBytes,
} from './persistentStorageByteBudgetTestUtils';

const utf8Encoder = new TextEncoder();

const fullLoadedFields = ['age', 'email', 'id', 'name'];
let network = createOfflineNetworkMock();

function getLogicalListItemEntrySizeBytes(payload: string, data: Row): number {
  return utf8Encoder.encode(JSON.stringify({ data, payload })).byteLength;
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
  const { listQueryScope } = createListQueryOpfsTestStore({
    storeName: options.storeName,
    sessionKey: 'sess1',
  });
  const projectRowsBytes = sumPersistedEntryBytes(
    getAsyncListItemEntrySizeBytes('projects||1', { id: 1, name: 'Project 1' }),
    getAsyncListItemEntrySizeBytes('projects||2', { id: 2, name: 'Project 2' }),
  );
  // The item budget fits the two project rows, plus a single user row when
  // only "User 1" is meant to be evicted.
  const maxItemBytes =
    options.evictedRows === 'all'
      ? projectRowsBytes
      : projectRowsBytes +
        getAsyncListItemEntrySizeBytes('users||2', { id: 2, name: 'User 2' });

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

  if (options.evictedRows === 'User 1') {
    // Read recency is tracked in 6h buckets, so the next read has to happen
    // in a later one to count as more recent.
    await advanceTime(7 * 60 * 60 * 1000);

    // In a new session only "User 2" is opened, which refreshes its recency.
    session = startNextSession();
    const userDetails = renderHook(() => session.apiStore.useItem('users||2'));
    await flushAllTimers();
    userDetails.unmount();
  }
  await advanceTime(60_000);

  // Loading the projects list pushes the items over maxItemBytes: the least
  // recently read rows are evicted.
  const projectsList = renderHook(() =>
    session.apiStore.useListQuery(projectsQuery),
  );
  await flushAllTimers();
  await advanceTime(1100);
  await flushAllTimers();
  projectsList.unmount();

  return { listQueryScope, startNextSession };
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
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});
describe('opfs: list query store persistence', () => {
  test('cold persisted query items can be evicted during unrelated maxItemBytes cleanup and later hydrate with missing items filtered out', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-cold-query-items';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    listQueryScope.seedItem('users', 1, { id: 1, name: 'Older cached' });
    await advanceTime(100);
    listQueryScope.seedItem('users', 2, { id: 2, name: 'Newer cached' });
    listQueryScope.seedQuery(usersQuery, [
      listQueryScope.itemKey('users', 1),
      listQueryScope.itemKey('users', 2),
    ]);
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
      ),
    });

    // Adding a standalone item forces maxItemBytes cleanup without rewriting the
    // cold query payload, leaving one referenced item missing from storage.
    writerEnv.apiStore.addItemToState('users||3', {
      id: 3,
      name: 'Fresh standalone',
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(`
      ['{tableId:"users"}']
    `);
    expect(listQueryScope.listStoredItemKeys().sort()).toMatchInlineSnapshot(`
      ['"users||2', '"users||3']
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-query-items/lq.%7BtableId%3A%22users%22%7D.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
      ),
      serverData: {
        users: [
          { id: 1, name: 'Older cached' },
          { id: 2, name: 'Newer cached' },
          { id: 3, name: 'Fresh standalone' },
        ],
      },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    // The reader hydrates the remaining cached item, but the list is missing a
    // row it was cached with: it is reported as loading (not as a complete
    // `success`) until the fetch restores the missing server items.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: loading ⋅ names: [Newer cached]
      -> status: success ⋅ names: [Older cached, Newer cached, Fresh standalone]
      "
    `);
    // The incomplete hydrated query is always fetched on mount.
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

  test('a cached list that lost some rows to maxItemBytes shows the remaining rows as still loading, then the full list', async () => {
    const storeName = 'lq-opfs-evicted-rows-partial';
    const { listQueryScope, startNextSession } =
      await cacheUsersListAndEvictRows({ storeName, evictedRows: 'User 1' });

    // The least recently read row ("User 1") was evicted, but the users query
    // is still cached and still lists it.
    expect(listQueryScope.listStoredItemKeys().sort()).toMatchInlineSnapshot(
      `['"projects||1', '"projects||2', '"users||2']`,
    );
    expect(
      getParsedOpfsFileData(
        `tsdf/sess1/${storeName}/lq.%7BtableId%3A%22users%22%7D.p.json`,
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);

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
  });

  test('a cached list that lost all its rows to maxItemBytes shows a loading state instead of an empty list', async () => {
    const storeName = 'lq-opfs-evicted-rows-all';
    const { listQueryScope, startNextSession } =
      await cacheUsersListAndEvictRows({ storeName, evictedRows: 'all' });

    // Both user rows were evicted, but the users query is still cached.
    expect(listQueryScope.listStoredItemKeys().sort()).toMatchInlineSnapshot(
      `['"projects||1', '"projects||2']`,
    );
    expect(
      getParsedOpfsFileData(
        `tsdf/sess1/${storeName}/lq.%7BtableId%3A%22users%22%7D.p.json`,
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);

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
      storeName: 'lq-opfs-evicted-rows-partial-offline',
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
      storeName: 'lq-opfs-evicted-rows-all-offline',
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

  test('persisted list item maxItemBytes policy is enforced on cold startup before the store mounts', async () => {
    const storeName = 'lq-opfs-cold-policy-max-items';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const keptOlderItem = { id: 2, name: 'Older kept' };
    const keptNewestItem = { id: 3, name: 'Newest kept' };

    listQueryScope.seedItem('users', 1, { id: 1, name: 'Older cached' });
    await advanceTime(100);
    listQueryScope.seedItem('users', 2, keptOlderItem);
    await advanceTime(100);
    listQueryScope.seedItem('users', 3, keptNewestItem);
    listQueryScope.setItemStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes('users||2', keptOlderItem),
        getAsyncListItemEntrySizeBytes('users||3', keptNewestItem),
      ),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||2', '"users||3']
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-max-items/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "users||2: { a: 1735689600100, p: 'users||2', z: 62 }
        "users||3: { a: 1735689600200, p: 'users||3', z: 63 }

      s: { b: 125 }
    `);
  });

  test('maxItemBytes rewrites the surviving standalone item after a newer item is removed', async () => {
    const storeName = 'lq-opfs-rewrite-after-item-byte-eviction';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const olderPayload = 'users||1';
    const newerPayload = 'users||2';
    const olderItem = { id: 1, name: 'Older kept later' };
    const newerItem = { id: 2, name: 'Newer evicted later' };
    const maxItemBytes = sumPersistedEntryBytes(
      getAsyncListItemEntrySizeBytes(olderPayload, olderItem),
      getLogicalListItemEntrySizeBytes(newerPayload, newerItem),
    );

    expect(maxItemBytes).toBeLessThan(
      sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(olderPayload, olderItem),
        getAsyncListItemEntrySizeBytes(newerPayload, newerItem),
      ),
    );

    const env = createEnv({ storeName, sessionKey, maxItemBytes });

    env.apiStore.addItemToState(olderPayload, olderItem);
    await advanceTime(1100);
    await flushAllTimers();

    env.apiStore.addItemToState(newerPayload, newerItem);
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||2']
    `);

    env.apiStore.deleteItemState(newerPayload);
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||1']
    `);

    opfsPersistentStorage.resetForTests?.();
    const readerEnv = createEnv({ storeName, sessionKey });

    await expect(
      resolveAfterAllTimers(
        readerEnv.apiStore.preloadItemFromStorage(olderPayload),
      ),
    ).resolves.toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);
  });

  test('persisted list query maxQueryBytes policy is enforced on cold startup before the store mounts', async () => {
    const storeName = 'lq-opfs-cold-policy-max-queries';
    const sessionKey = 'sess1';
    const firstQuery = { tableId: 'users-1' };
    const secondQuery = { tableId: 'users-2' };
    const thirdQuery = { tableId: 'users-3' };
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.seedQuery(secondQuery, []);
    await advanceTime(100);
    listQueryScope.seedQuery(thirdQuery, []);
    listQueryScope.setQueryStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, []),
        getAsyncListQueryEntrySizeBytes(thirdQuery, []),
      ),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(
      `['{tableId:"users-2"}', '{tableId:"users-3"}']`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-max-queries/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users-2"}:
          a: 1735689600100
          p: { tableId: 'users-2' }
          z: 47
        {tableId:"users-3"}:
          a: 1735689600200
          p: { tableId: 'users-3' }
          z: 47

      s: { b: 94 }
    `);
  });

  test('maxQueryBytes keeps the two newest async-written queries when they exactly fit', async () => {
    const storeName = 'lq-opfs-inline-query-byte-budget';
    const sessionKey = 'sess1';
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const secondItemKey = getCompositeKey('second||1');
    const thirdItemKey = getCompositeKey('third||1');
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, [secondItemKey]),
        getAsyncListQueryEntrySizeBytes(thirdQuery, [thirdItemKey]),
      ),
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
        third: [{ id: 1, name: 'Third' }],
      },
    });

    writerEnv.scheduleFetch('highPriority', firstQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    writerEnv.scheduleFetch('highPriority', secondQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    opfsPersistentStorage.resetForTests?.();
    const readerEnv = createEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, [secondItemKey]),
        getAsyncListQueryEntrySizeBytes(thirdQuery, [thirdItemKey]),
      ),
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
        third: [{ id: 1, name: 'Third' }],
      },
    });

    readerEnv.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(`
      ['{tableId:"second"}', '{tableId:"third"}']
    `);
  });

  test('persisted pinned list item keys survive cold startup cleanup', async () => {
    const storeName = 'lq-opfs-cold-policy-pinned-item';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedItem('users', 1, { id: 1, name: 'Pinned older' });
    await advanceTime(100);
    listQueryScope.seedItem('users', 2, { id: 2, name: 'Newer other' });
    listQueryScope.setItemStaticPolicy({
      k: [listQueryScope.itemKey('users', 1)],
      b: getAsyncListItemEntrySizeBytes('users||1', {
        id: 1,
        name: 'Pinned older',
      }),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||1']
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-pinned-item/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1', z: 64 }

      s:
        b: 64
        k: ['"users||1']
    `);
  });

  test('persisted pinned query keys survive cold startup cleanup', async () => {
    const storeName = 'lq-opfs-cold-policy-pinned-query';
    const sessionKey = 'sess1';
    const pinnedQuery = { tableId: 'users-pinned' };
    const otherQuery = { tableId: 'users-other' };
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedQuery(pinnedQuery, []);
    await advanceTime(100);
    listQueryScope.seedQuery(otherQuery, []);
    listQueryScope.setQueryStaticPolicy({
      k: [listQueryScope.queryKey(pinnedQuery)],
      b: getAsyncListQueryEntrySizeBytes(pinnedQuery, []),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(
      `['{tableId:"users-pinned"}']`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-pinned-query/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users-pinned"}:
          a: 1735689600000
          p: { tableId: 'users-pinned' }
          z: 52

      s:
        b: 52
        k: ['{tableId:"users-pinned"}']
    `);
  });

  test('maxQuerySize persists only the first items from each query', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-max-query-size';
    const sessionKey = 'sess1';
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });

    writerEnv.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-max-query-size/lq.%7BtableId%3A%22users%22%7D.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 1))).toBe(
      true,
    );
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 2))).toBe(
      true,
    );
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 3))).toBe(
      false,
    );

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    // Only the query is preloaded; the mounted hook hydrates its items and then
    // revalidates the full list.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Alice, Bob]
      -> status: refetching ⋅ names: [Alice, Bob]
      -> status: success ⋅ names: [Alice, Bob, Carol]
      "
    `);
    // Revalidation can include the evicted third item even though the OPFS
    // maxQuerySize limit kept only two items persisted.
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
});
