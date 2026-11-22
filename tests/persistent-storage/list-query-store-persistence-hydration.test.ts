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
import { readManagedLocalStorageNamespaceEntryByPayload } from '../../src/persistentStorage/localStorageMetadata';
import { SYNC_STORAGE_TOUCH_THROTTLE_MS } from '../../src/persistentStorage/persistentStorageManager';
import { type Row } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  persistentStore,
  rawItemPayload,
  storeItemKey,
  queryStorageKey,
  setCachedItem,
  setCachedQuery,
  listStoredKeys,
  createEnv,
} from './listQueryStorePersistenceTestShared';

function getStoredEntryTimestamp(key: string): number {
  const itemIndex = key.indexOf('.li.');
  const queryIndex = key.indexOf('.lq.');
  if (queryIndex !== -1) {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      throw new Error(`Missing localStorage entry for ${key}`);
    }

    const parsed = __LEGIT_CAST__<{ a: number }, unknown>(JSON.parse(raw));
    return parsed.a;
  }

  const splitIndex = itemIndex;
  const prefix = splitIndex === -1 ? `${key}.` : key.slice(0, splitIndex + 4);
  const entry = readManagedLocalStorageNamespaceEntryByPayload(key, prefix);
  if (entry === null) {
    throw new Error(`Missing managed localStorage metadata for ${key}`);
  }

  return entry.lastAccessAt;
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
});

describe('localStorage: list query store persistence', () => {
  test('dev-only check rejects store ids containing dots', () => {
    expect(() =>
      createEnv({ storeName: 'users.with-dot', sessionKey: 'sess1' }),
    ).toThrow(
      '[tsdf] store id "users.with-dot" must not contain "." when persistentStorage is enabled.',
    );
  });

  test('direct query reads lazily hydrate only the requested query and its items', () => {
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const usersItem1 = storeItemKey('users', 1);
    const usersItem2 = storeItemKey('users', 2);
    const projectsItem1 = storeItemKey('projects', 1);

    setCachedItem('lq-local', 'sess1', 'users', 1, { id: 1, name: 'Alice' });
    setCachedItem('lq-local', 'sess1', 'users', 2, { id: 2, name: 'Bob' });
    setCachedItem('lq-local', 'sess1', 'projects', 1, {
      id: 1,
      name: 'Secret',
    });
    setCachedQuery('lq-local', 'sess1', usersQuery, [usersItem1, usersItem2]);
    setCachedQuery('lq-local', 'sess1', projectsQuery, [projectsItem1]);

    const env = createEnv({ storeName: 'lq-local', sessionKey: 'sess1' });

    expect(env.apiStore.getQueriesState(() => true)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getQueriesRelatedToItem(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        []
      `);

    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(env.apiStore.getQueriesState(() => true).map(({ key }) => key))
      .toMatchInlineSnapshot(`
        ['{tableId:"users"}']
      `);
    expect(
      env.apiStore
        .getItemState(() => true)
        .map(({ payload }) => payload)
        .sort(),
    ).toMatchInlineSnapshot(`
      ['users||1', 'users||2']
    `);
  });

  test('direct item reads lazily hydrate only the requested cached item', () => {
    setCachedItem('lq-item-local', 'sess1', 'users', 1, {
      id: 1,
      name: 'Alice',
    });
    setCachedItem('lq-item-local', 'sess1', 'users', 2, { id: 2, name: 'Bob' });

    const env = createEnv({ storeName: 'lq-item-local', sessionKey: 'sess1' });

    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Alice'
      `);
    expect(env.apiStore.getItemState(() => true).map(({ payload }) => payload))
      .toMatchInlineSnapshot(`
        ['users||1']
      `);
  });

  test('direct cold item reads materialize state and stop consulting localStorage', () => {
    const storeName = 'lq-item-external-overwrite';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached v1',
    });

    const env = createEnv({ storeName, sessionKey });

    // First cold read hydrates from the persisted item entry.
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached v1'
      `);
    expect(env.store.state.items[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached v1'
      `);

    // Once the cached entry is read through into state, later storage changes
    // should not silently replace the live in-memory state.
    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached v2',
    });

    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached v1'
      `);
  });

  test('direct cold query reads materialize state and stop consulting localStorage', () => {
    const storeName = 'lq-query-external-overwrite';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const usersItem1 = storeItemKey('users', 1);
    const usersItem2 = storeItemKey('users', 2);

    setCachedItem(storeName, sessionKey, 'users', 1, { id: 1, name: 'Alice' });
    setCachedQuery(storeName, sessionKey, usersQuery, [usersItem1]);

    const env = createEnv({ storeName, sessionKey });

    // First cold read hydrates the persisted query metadata.
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.queries[getCompositeKey(usersQuery)])
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);

    // Once the cached query is read through into state, later storage changes
    // should not silently replace the live in-memory query snapshot.
    setCachedItem(storeName, sessionKey, 'users', 2, { id: 2, name: 'Bob' });
    setCachedQuery(storeName, sessionKey, usersQuery, [usersItem1, usersItem2]);

    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('first item hook read returns cached data then refetches', async () => {
    setCachedItem('lq-item-hook', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });

    const env = createEnv({
      storeName: 'lq-item-hook',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { returnRefetchingStatus: true },
      );

      renders.add({ status, name: data?.name ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      -> status: refetching ⋅ name: Cached
      -> status: success ⋅ name: Fresh
      "
    `);
  });

  test('loadFromStateOnly ignores cold persisted items', async () => {
    const storeName = 'lq-load-from-state-only';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached only',
    });

    const env = createEnv({ storeName, sessionKey });
    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status, error, isLoading } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { loadFromStateOnly: true },
      );

      renders.add({ status, data, error, isLoading });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: error
      ⋅ data: null
      ⋅ error: {code:460, id:cache-miss, message:Cache miss}
      ⋅ isLoading: ❌
      └─
      "
    `);
  });

  test('first query hook read returns cached data then refetches', async () => {
    const usersQuery = { tableId: 'users' };
    const usersItem = storeItemKey('users', 1);

    setCachedItem('lq-hook', 'sess1', 'users', 1, { id: 1, name: 'Cached' });
    setCachedQuery('lq-hook', 'sess1', usersQuery, [usersItem]);

    const env = createEnv({
      storeName: 'lq-hook',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
  });

  test('disabled persistence neither restores nor saves queries and items', async () => {
    let persistenceEnabled = false;
    const usersQuery = { tableId: 'users' };

    // A query persisted by an earlier session where persistence was enabled
    setCachedItem('lq-switch', 'sess1', 'users', 1, { id: 1, name: 'Cached' });
    setCachedQuery('lq-switch', 'sess1', usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createEnv({
      storeName: 'lq-switch',
      sessionKey: 'sess1',
      serverData: {
        users: [
          { id: 1, name: 'Fresh 1' },
          { id: 2, name: 'Fresh 2' },
        ],
      },
      persistenceEnabled: () => persistenceEnabled,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery);
      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    // The persisted query is not restored: the hook loads it from the server
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Fresh 1, Fresh 2]
      "
    `);

    // ...and neither the fetched query nor its rows are saved
    const scope = persistentStore.scope('lq-switch', 'sess1');
    expect(
      scope.listQuery.readQueryEntry(usersQuery).data.items,
    ).toMatchInlineSnapshot(`['"users||1']`);
    expect(scope.listQuery.readItemData('users', 1)).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached'
    `);
    expect(scope.listQuery.readItemData('users', 2)).toBeNull();

    // Once enabled, the next fetch results are saved again
    persistenceEnabled = true;
    env.apiStore.invalidateQueryAndItems({
      queryPayload: usersQuery,
      itemPayload: false,
    });
    await flushAllTimers();

    expect(
      scope.listQuery.readQueryEntry(usersQuery).data.items,
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(scope.listQuery.readItemData('users', 1)).toMatchInlineSnapshot(`
      id: 1
      name: 'Fresh 1'
    `);
    expect(scope.listQuery.readItemData('users', 2)).toMatchInlineSnapshot(`
      id: 2
      name: 'Fresh 2'
    `);
  });

  test('realtime stores revalidate cached localStorage query after first hydration', async () => {
    const usersQuery = { tableId: 'users' };
    const usersItem = storeItemKey('users', 1);

    // Seed the browser cache with stale data so the hook can show persisted
    // state immediately before doing its first server reconciliation.
    setCachedItem('lq-rtu-first-sync', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });
    setCachedQuery('lq-rtu-first-sync', 'sess1', usersQuery, [usersItem]);

    const env = createEnv({
      storeName: 'lq-rtu-first-sync',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
      usesRealTimeUpdates: true,
    });

    const renders = createLoggerStore();

    // usesRealTimeUpdates should not skip the first hydration refetch; only
    // later freshness is expected to come from realtime invalidations.
    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    // The cached row is stale-while-revalidate data: visible immediately, then
    // replaced by the server row after the mount revalidation finishes.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('disableRefetchOnMount still revalidates cached query data marked refetchOnMount', async () => {
    const usersQuery = { tableId: 'users' };
    // Make both persisted entries old enough that the touch-throttle path must
    // refresh their timestamps when they are read back from localStorage.
    const originalTimestamp = Date.now() - SYNC_STORAGE_TOUCH_THROTTLE_MS - 1;
    const usersItem = setCachedItem(
      'lq-hook-no-refetch',
      'sess1',
      'users',
      1,
      { id: 1, name: 'Cached' },
      undefined,
      originalTimestamp,
    );
    const usersQueryKey = setCachedQuery(
      'lq-hook-no-refetch',
      'sess1',
      usersQuery,
      [storeItemKey('users', 1)],
      false,
      undefined,
      originalTimestamp,
    );
    const originalItemTimestamp = getStoredEntryTimestamp(usersItem);
    const originalQueryTimestamp = getStoredEntryTimestamp(usersQueryKey);

    const env = createEnv({
      storeName: 'lq-hook-no-refetch',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    // disableRefetchOnMount only suppresses the hook's own mount policy. It
    // must not ignore the persisted refetchOnMount marker restored from cache.
    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    // The cached data still revalidates because the restored query explicitly
    // asked for it, and the storage entries are touched as part of hydration.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
    expect(getStoredEntryTimestamp(usersItem)).toBeGreaterThan(
      originalItemTimestamp,
    );
    expect(getStoredEntryTimestamp(usersQueryKey)).toBeGreaterThan(
      originalQueryTimestamp,
    );
  });

  test('failed list-query hook fetch does not create persisted query or item entries', async () => {
    const storeName = 'lq-fetch-error-no-persist';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Alice' }] },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    // Fail the first hook-triggered list fetch before anything can be cached.
    env.serverTable.setNextListFetchError('Network error');

    renderHook(() => {
      const { items, status, error } = env.apiStore.useListQuery(usersQuery);

      renders.add({ status, names: items.map((item) => item.name), error });
    });

    await flushAllTimers();

    // Wait past the debounced persistence window so accidental writes would materialize.
    await advanceTime(1100);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: [] ⋅ error: null
      ┌─
      ⋅ status: error
      ⋅ names: []
      ⋅ error: {code:500, id:fetch-error, message:Network error}
      └─
      "
    `);
    expect(
      persistentStore.storage.readEntry(
        queryStorageKey(storeName, sessionKey, usersQuery),
      ),
    ).toBeNull();
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('failed refetch keeps the previous persisted list-query snapshots', async () => {
    const storeName = 'lq-refetch-error-keeps-cache';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    // Seed both the cached query metadata and its hydrated item snapshot.
    setCachedItem(storeName, sessionKey, 'users', 1, { id: 1, name: 'Cached' });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    env.serverTable.setNextListFetchError('Network error');

    renderHook(() => {
      const { items, status, error } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name), error });
    });

    await flushAllTimers();
    await advanceTime(1100);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached] ⋅ error: null
      -> status: refetching ⋅ names: [Cached] ⋅ error: null
      ┌─
      ⋅ status: error
      ⋅ names: [Cached]
      ⋅ error: {code:500, id:fetch-error, message:Network error}
      └─
      "
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(usersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readItemEntry<Row>('users', 1).data,
    ).toMatchInlineSnapshot(`
      data: { id: 1, name: 'Cached' }
      payload: 'users||1'
    `);
  });
});
