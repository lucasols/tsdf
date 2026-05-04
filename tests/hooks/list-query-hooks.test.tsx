import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import '@testing-library/react/dont-cleanup-after-each';
import React from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import {
  getDefaultLowPriorityThrottleMs,
  TEST_INITIAL_TIME,
} from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  range,
} from '../utils/genericTestUtils';
import {
  getFetchCountFromHere,
  shouldNotSkip,
} from '../utils/listQueryHooksTestUtils';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

afterAll(() => {
  cleanup();
});

type FetchQueryParams = { tableId: string };

function getFetchQueryForTable(tableId: string): FetchQueryParams {
  return { tableId };
}

describe('useMultipleItemsQuery invalidation tests', () => {
  test('load the queries', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const usersRender = createLoggerStore();
    const productsRender = createLoggerStore();

    renderHook(() => {
      const queryResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, returnRefetchingStatus: true }),
        ),
        {
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      const [users, products] = queryResult;

      usersRender.add(pick(users, ['status', 'payload', 'items']));
      productsRender.add(pick(products, ['status', 'payload', 'items']));
    });

    await advanceTime(1);
    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    expect(usersRender.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: {tableId:users} ⋅ items: []
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ items: [{id:\\users||1, data:{id:1, name:User 1}}, …(4 more)]
      └─
      "
    `);

    expect(productsRender.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: {tableId:products} ⋅ items: []
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:products}
      ⋅ items: [{id:\\products||1, data:{id:1, name:Product 1}}, …(49 more)]
      └─
      "
    `);
  });

  test('invalidate one query', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const usersRender = createLoggerStore();
    const productsRender = createLoggerStore();

    renderHook(() => {
      const queryResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, returnRefetchingStatus: true }),
        ),
        {
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      const [users, products] = queryResult;

      usersRender.add(pick(users, ['status', 'payload', 'items']));
      productsRender.add(pick(products, ['status', 'payload', 'items']));
    });

    await flushAllTimers();

    usersRender.reset();
    productsRender.reset();

    const fetchCount = getFetchCountFromHere(env);

    env.serverTable.updateItem('users||1', { name: 'Updated User 1' });
    listQueryStore.invalidateQueryAndItems({
      itemPayload: false,
      queryPayload: getFetchQueryForTable('users'),
    });

    await flushAllTimers();

    expect(usersRender.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: refetching
      ⋅ payload: {tableId:users}
      ⋅ items: [{id:\\users||1, data:{id:1, name:User 1}}, …(4 more)]
      └─
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ items: [{id:\\users||1, data:{id:1, name:Updated User 1}}, …(4 more)]
      └─
      "
    `);
    expect(productsRender.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:products}
      ⋅ items: [{id:\\products||1, data:{id:1, name:Product 1}}, …(49 more)]
      └─
      "
    `);

    expect(fetchCount()).toBe(1);
  });

  test('query invalidation keeps the mounted hook loadSize instead of falling back to defaultQuerySize', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      defaultQuerySize: 4,
    });
    const listQueryStore = env.apiStore;

    renderHook(() => {
      listQueryStore.useListQuery(getFetchQueryForTable('products'), {
        loadSize: 2,
        returnRefetchingStatus: true,
        itemSelector(data) {
          return data.name;
        },
      });
    });

    await flushAllTimers();

    // The initial mount should respect the hook's explicit load size.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: '*'
            pos: { limit: 2, offset: 0 }
          returned_items: 2
      `);

    env.serverTable.updateItem('products||1', { name: 'Updated Product 1' });

    // Invalidating the mounted query should preserve the same list size.
    listQueryStore.invalidateQueryAndItems({
      itemPayload: false,
      queryPayload: getFetchQueryForTable('products'),
    });

    await flushAllTimers();

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
            pos: { limit: 2, offset: 0 }
          returned_items: 2
      `);
  });

  test('do not fetch more than expected with multiple components connected to the same items', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const usersRender = createLoggerStore();
    const productsRender = createLoggerStore();

    renderHook(() => {
      const queryResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, returnRefetchingStatus: true }),
        ),
        {
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      const [users, products] = queryResult;

      usersRender.add(pick(users, ['status', 'payload', 'items']));
      productsRender.add(pick(products, ['status', 'payload', 'items']));
    });

    await flushAllTimers();

    const getFetchCount = getFetchCountFromHere(env);

    const { unmount } = renderHook(() => {
      const selectionResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item }),
        ),
        {
          itemSelector(data) {
            return data.name;
          },
        },
      );

      return selectionResult;
    });

    env.serverTable.updateItem('users||1', { name: 'Updated User 1 again' });
    env.serverTable.updateItem('products||1', { name: 'Updated Product 1' });

    listQueryStore.invalidateQueryAndItems({
      itemPayload: false,
      queryPayload: () => true,
    });

    await flushAllTimers();

    unmount();

    expect(getFetchCount()).toBe(2);
  });

  test('refetch data after invalidations', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const usersRender = createLoggerStore();
    const productsRender = createLoggerStore();

    renderHook(() => {
      const queryResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, returnRefetchingStatus: true }),
        ),
        {
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      const [users, products] = queryResult;

      usersRender.add(pick(users, ['status', 'payload', 'items']));
      productsRender.add(pick(products, ['status', 'payload', 'items']));
    });

    await flushAllTimers();

    usersRender.reset();
    productsRender.reset();

    env.serverTable.updateItem('users||1', { name: 'Updated User 1 again' });
    env.serverTable.updateItem('products||1', { name: 'Updated Product 1' });

    listQueryStore.invalidateQueryAndItems({
      itemPayload: false,
      queryPayload: () => true,
    });

    await flushAllTimers();

    expect(usersRender.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: refetching
      ⋅ payload: {tableId:users}
      ⋅ items: [{id:\\users||1, data:{id:1, name:User 1}}, …(4 more)]
      └─
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ items: [{id:\\users||1, data:{id:1, name:Updated User 1 again}}, …(4 more)]
      └─
      "
    `);
    expect(productsRender.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:products}
      ⋅ items: [{id:\\products||1, data:{id:1, name:Product 1}}, …(49 more)]
      └─
      ┌─
      ⋅ status: refetching
      ⋅ payload: {tableId:products}
      ⋅ items: [{id:\\products||1, data:{id:1, name:Product 1}}, …(49 more)]
      └─
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:products}
      ⋅ items: [{id:\\products||1, data:{id:1, name:Updated Product 1}}, …(49 more)]
      └─
      "
    `);
  });

  test('data selector', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const extraComponentMounted = createLoggerStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, returnRefetchingStatus: true }),
        ),
        {
          itemSelector(data) {
            return data.name;
          },
        },
      );

      extraComponentMounted.add({
        status: selectionResult[0]?.status,
        payload: selectionResult[0]?.payload,
        items: selectionResult[0]?.items,
      });
    });

    await flushAllTimers();

    env.serverTable.updateItem('users||1', { name: 'Updated User 1 again' });
    listQueryStore.invalidateQueryAndItems({
      itemPayload: false,
      queryPayload: (payload) => payload.tableId === 'users',
    });

    await flushAllTimers();

    expect(extraComponentMounted.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: {tableId:users} ⋅ items: []
      -> status: success ⋅ payload: {tableId:users} ⋅ items: [User 1, …(4 more)]
      -> status: refetching ⋅ payload: {tableId:users} ⋅ items: [User 1, …(4 more)]
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ items: [Updated User 1 again, …(4 more)]
      └─
      "
    `);
  });
});

describe('useMultipleItemsQuery isolated tests', () => {
  test('rerender when payload changes', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });
    const listQueryStore = env.apiStore;

    const usersRenders = createLoggerStore();
    const productsRenders = createLoggerStore();

    const { rerender } = renderHook(
      ({ payload }: { payload: FetchQueryParams[] }) => {
        const [users, products] = listQueryStore.useMultipleListQueries(
          payload.map((item) => ({ payload: item })),
          { itemSelector: (data) => data.name },
        );

        usersRenders.add(pick(users, ['status', 'payload', 'items']));
        productsRenders.add(pick(products, ['status', 'payload', 'items']));
      },
      {
        initialProps: {
          payload: [
            getFetchQueryForTable('users'),
            getFetchQueryForTable('products'),
          ],
        },
      },
    );

    await flushAllTimers();

    act(() => {
      rerender({
        payload: [
          getFetchQueryForTable('users'),
          getFetchQueryForTable('not-found'),
        ],
      });
    });

    await flushAllTimers();

    expect(usersRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: {tableId:users} ⋅ items: [User 1, …(4 more)]
      "
    `);
    expect(productsRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: {tableId:products} ⋅ items: [Product 1, …(49 more)]
      -> status: loading ⋅ payload: {tableId:not-found} ⋅ items: []
      -> status: error ⋅ payload: {tableId:not-found} ⋅ items: []
      "
    `);
  });

  test('with disableRefetchOnMount', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const usersRenders = createLoggerStore();
    const productsRenders = createLoggerStore();

    renderHook(() => {
      const [users, products] = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, disableRefetchOnMount: true }),
        ),
        { itemSelector: (data) => data.name },
      );

      usersRenders.add(pick(users, ['status', 'payload', 'items']));
      productsRenders.add(pick(products, ['status', 'payload', 'items']));
    });

    await flushAllTimers();

    expect(usersRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: {tableId:users} ⋅ items: []
      -> status: success ⋅ payload: {tableId:users} ⋅ items: [User 1, …(4 more)]
      "
    `);
    expect(productsRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: {tableId:products} ⋅ items: []
      -> status: success ⋅ payload: {tableId:products} ⋅ items: [Product 1, …(49 more)]
      "
    `);
  });

  test('with queryMetadata', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const usersRenders = createLoggerStore();
    const productsRenders = createLoggerStore();

    renderHook(() => {
      const [users, products] = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({ payload: item, queryMetadata: { test: item } }),
        ),
        { itemSelector: (data) => data.name },
      );

      usersRenders.add(
        pick(users, ['status', 'payload', 'items', 'queryMetadata']),
      );
      productsRenders.add(
        pick(products, ['status', 'payload', 'items', 'queryMetadata']),
      );
    });

    await flushAllTimers();

    expect(usersRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: loading
      ⋅ payload: {tableId:users}
      ⋅ items: []
      ⋅ queryMetadata: {test:{tableId:users}}
      └─
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ items: [User 1, …(4 more)]
      ⋅ queryMetadata: {test:{tableId:users}}
      └─
      "
    `);
    expect(productsRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: loading
      ⋅ payload: {tableId:products}
      ⋅ items: []
      ⋅ queryMetadata: {test:{tableId:products}}
      └─
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:products}
      ⋅ items: [Product 1, …(49 more)]
      ⋅ queryMetadata: {test:{tableId:products}}
      └─
      "
    `);
  });
});

describe('useQuery', () => {
  test('return error state for empty string payload', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    renderHook(() => {
      const queryResult = listQueryStore.useListQuery(
        __LEGIT_CAST__<FetchQueryParams, string>(''),
        {
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      renders.add(pick(queryResult, ['status', 'payload', 'error', 'items']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: error
      ⋅ payload: undefined
      ⋅ error: {code:461, id:invalid-payload, message:Invalid payload}
      ⋅ items: []
      └─
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('disable then enable the initial fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    type Props = { payload: FetchQueryParams | false | undefined | null };

    const { rerender } = renderHook(
      ({ payload }: Props) => {
        const queryResult = listQueryStore.useListQuery(payload, {
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        });

        renders.add(pick(queryResult, ['status', 'payload', 'items']));
        return queryResult;
      },
      { initialProps: { payload: false } },
    );

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ items: []
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    rerender({ payload: { tableId: 'users' } });

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ items: []
      ⋅⋅⋅
      -> status: loading ⋅ payload: {tableId:users} ⋅ items: []
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ items: [{id:\\users||1, data:{id:1, name:User 1}}, …(4 more)]
      └─
      "
    `);
  });

  test('use ensureIsLoaded prop', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    listQueryStore.scheduleListQueryFetch('highPriority', { tableId: 'users' });

    await flushAllTimers();

    expect(listQueryStore.store.state.queries).toMatchInlineSnapshot(`
      {tableId:"users"}:
        error: null
        hasMore: '❌'
        items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
        payload: { tableId: 'users' }
        refetchOnMount: '❌'
        status: 'success'
        wasLoaded: '✅'
    `);

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useListQuery(
        { tableId: 'users' },
        { ensureIsLoaded: true, itemSelector: (data) => data.name },
      );

      renders.add(pick(selectionResult, ['status', 'isLoading', 'items']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ items: [User 1, …(4 more)]
      -> status: success ⋅ isLoading: ❌ ⋅ items: [User 1, …(4 more)]
      "
    `);
  });

  test('ensureIsLoaded stops forcing loading when the first query fetch fails', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const renders = createLoggerStore();

    // Force the mount-triggered query fetch to fail before any successful load.
    env.serverTable.setNextListFetchError('error');

    renderHook(() => {
      const selectionResult = listQueryStore.useListQuery(
        { tableId: 'users' },
        { ensureIsLoaded: true, itemSelector: (data) => data.name },
      );

      renders.add(
        pick(selectionResult, ['status', 'isLoading', 'items', 'error']),
      );
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ items: [] ⋅ error: null
      ┌─
      ⋅ status: error
      ⋅ isLoading: ❌
      ⋅ items: []
      ⋅ error: {code:500, id:fetch-error, message:error}
      └─
      "
    `);
  });

  test('fast query errors suppress immediate rerender retries', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    env.serverTable.setNextListFetchError('fast failure');

    const { rerender, result } = renderHook(
      ({ version }: { version: number }) => {
        const [query] = listQueryStore.useMultipleListQueries(
          [{ payload: { tableId: 'users' }, loadSize: 5 }],
          { itemSelector: (data) => `${data.name}-${version}` },
        );

        return query;
      },
      { initialProps: { version: 0 } },
    );

    await flushAllTimers();

    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    for (const version of [1, 2, 3]) {
      rerender({ version });
      await flushAllTimers();
    }

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('off-screen queries re-enter like a fresh mount after a fast error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    env.serverTable.setNextListFetchError('fast failure');

    const { rerender, result } = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) => {
        const [query] = listQueryStore.useMultipleListQueries([
          { payload: { tableId: 'users' }, loadSize: 5, isOffScreen },
        ]);

        return query;
      },
      { initialProps: { isOffScreen: false } },
    );

    await flushAllTimers();

    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    // Moving off-screen is equivalent to unmounting this subscription, so its
    // hook-local automatic retry lock should not survive when it becomes visible.
    rerender({ isOffScreen: true });
    await flushAllTimers();

    // Wait only for the normal low-priority scheduler throttle. This is still
    // inside the automatic retry lockout window, so a refetch here proves the
    // off-screen subscription re-entered like a fresh mount.
    await advanceTime(getDefaultLowPriorityThrottleMs() + 1);

    rerender({ isOffScreen: false });
    await flushAllTimers();

    expect(result.current?.status).toBe('success');
    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('fast query errors lock out automatic rerender retries but manual invalidation works', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      transportReconnectCooldownMs: 0,
      usesRealTimeUpdates: true,
    });
    const listQueryStore = env.apiStore;

    env.serverTable.setNextListFetchError('fast failure');
    const initialQueries = [{ payload: { tableId: 'users' }, loadSize: 5 }];

    const { rerender, result } = renderHook(
      ({
        queries,
        version,
      }: {
        queries: { payload: { tableId: string }; loadSize: number }[];
        version: number;
      }) => {
        const [query] = listQueryStore.useMultipleListQueries(queries, {
          itemSelector: (data) => `${data.name}-${version}`,
        });

        return query;
      },
      { initialProps: { queries: initialQueries, version: 0 } },
    );

    await flushAllTimers();

    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    await advanceTime(10_001);

    rerender({
      queries: [{ payload: { tableId: 'users' }, loadSize: 5 }],
      version: 1,
    });
    await flushAllTimers();

    // The first rerender after the fast failure can happen after 10s; the lock
    // is based on observing the error, not on when the rerender happens.
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    for (const version of [2, 3]) {
      rerender({
        queries: [{ payload: { tableId: 'users' }, loadSize: 5 }],
        version,
      });
      await flushAllTimers();
    }

    // Recreated query/options objects should not schedule automatic retries after the fast error.
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    env.serverTable.setNextListFetchError('manual failure');

    act(() => {
      listQueryStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'users' },
      });
    });

    await flushAllTimers();

    // Manual public invalidation bypasses the lock even inside the 10s window.
    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    rerender({
      queries: [{ payload: { tableId: 'users' }, loadSize: 5 }],
      version: 4,
    });
    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    env.serverTable.setNextListFetchError('reconnect failure');

    act(() => {
      listQueryStore.onTransportReconnect();
    });

    await flushAllTimers();

    // Lifecycle invalidation is a real refresh signal and bypasses the retry lock.
    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(3);

    act(() => {
      listQueryStore.scheduleListQueryFetch('highPriority', {
        tableId: 'users',
      });
    });

    await flushAllTimers();

    expect(result.current?.status).toBe('success');
    expect(env.serverTable.numOfFinishedFetches).toBe(4);

    rerender({
      queries: [{ payload: { tableId: 'products' }, loadSize: 5 }],
      version: 5,
    });
    await flushAllTimers();

    // Changing the query key creates a new resource signature and allows one automatic fetch.
    expect(result.current?.status).toBe('success');
    expect(result.current?.items[0]).toBe('Product 1-5');
    expect(env.serverTable.numOfFinishedFetches).toBe(5);
  });

  test('ignore refetchingStatus by default', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useListQuery(
        { tableId: 'users' },
        { itemSelector: (data) => data.name },
      );

      renders.add(pick(selectionResult, ['status', 'isLoading', 'items']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ isLoading: ❌ ⋅ items: [User 1, …(4 more)]
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    function Comp({ payload }: { payload?: FetchQueryParams }) {
      const selectionResult = listQueryStore.useListQuery(payload, {
        ensureIsLoaded: true,
        itemSelector: (data) => data.name,
      });

      renders.add(
        pick(selectionResult, ['status', 'payload', 'isLoading', 'items']),
      );

      return <div />;
    }

    const { rerender } = render(<Comp />);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ isLoading: ❌ ⋅ items: []
      "
    `);

    rerender(<Comp payload={{ tableId: 'users' }} />);

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ isLoading: ❌ ⋅ items: []
      ⋅⋅⋅
      ┌─
      ⋅ status: loading
      ⋅ payload: {tableId:users}
      ⋅ isLoading: ✅
      ⋅ items: [User 1, …(4 more)]
      └─
      ┌─
      ⋅ status: success
      ⋅ payload: {tableId:users}
      ⋅ isLoading: ❌
      ⋅ items: [User 1, …(4 more)]
      └─
      "
    `);
  });

  test('throws when ensureIsLoaded is combined with debouncePayload', () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    expect(() =>
      renderHook(() =>
        listQueryStore.useListQuery(
          { tableId: 'users' },
          {
            ensureIsLoaded: true,
            debouncePayload: { ms: 100 },
            itemSelector: (data) => data.name,
          },
        ),
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      Error#:
        message: 'useListQuery does not support using ensureIsLoaded together with debouncePayload.'
        name: 'Error'
      `,
    );
  });

  test('disableRefetchOnMount', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    const compRenders = createLoggerStore();

    renderHook(() => {
      const data = listQueryStore.useListQuery(
        { tableId: 'users' },
        {
          disableRefetchOnMount: true,
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      compRenders.add({ status: data.status, items: data.items });
    });

    // wait some time to make sure the query is not refetched
    await advanceTime(200);

    expect(compRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{id:\\users||1, data:{id:1, name:User 1}}, …(4 more)]
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('useItem', () => {
  test('return error state for empty string payload', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    function Comp() {
      const queryResult = listQueryStore.useItem('');

      renders.add(pick(queryResult, ['status', 'payload', 'error', 'data']));

      return <div />;
    }

    render(<Comp />);

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: error
      ⋅ payload: null
      ⋅ error: {code:461, id:invalid-payload, message:Invalid payload}
      ⋅ data: null
      └─
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('disable then enable the initial fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    function Comp({ payload }: { payload: string | false | undefined | null }) {
      const queryResult = listQueryStore.useItem(payload);

      renders.add(pick(queryResult, ['status', 'payload', 'data']));

      return <div />;
    }

    const { rerender } = render(<Comp payload={false} />);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: null ⋅ data: null
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    rerender(<Comp payload="users||1" />);

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: null ⋅ data: null
      ⋅⋅⋅
      -> status: loading ⋅ payload: users||1 ⋅ data: null
      -> status: success ⋅ payload: users||1 ⋅ data: {id:1, name:User 1}
      "
    `);
  });

  test('ignore refetchingStatus by default', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useItem('users||1', {
        selector: (data) => data?.name,
      });

      renders.add(pick(selectionResult, ['status', 'isLoading', 'data']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ isLoading: ❌ ⋅ data: User 1
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('use ensureIsLoaded prop', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await flushAllTimers();

    expect(listQueryStore.store.state.itemQueries['"users||1'])
      .toMatchInlineSnapshot(`
        error: null
        payload: 'users||1'
        refetchOnMount: '❌'
        status: 'success'
        wasLoaded: '✅'
      `);

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useItem('users||1', {
        ensureIsLoaded: true,
        selector: (data) => data?.name,
      });

      renders.add(pick(selectionResult, ['status', 'isLoading', 'data']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ data: User 1
      -> status: success ⋅ isLoading: ❌ ⋅ data: User 1
      "
    `);
  });

  test('ensureIsLoaded stops forcing loading when the first item fetch fails', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const renders = createLoggerStore();

    // Force the mount-triggered item fetch to fail before the item has ever loaded.
    env.serverTable.setNextFetchError('users||1', 'error');

    renderHook(() => {
      const selectionResult = listQueryStore.useItem('users||1', {
        ensureIsLoaded: true,
        selector: (data) => data?.name ?? null,
      });

      renders.add(
        pick(selectionResult, ['status', 'isLoading', 'data', 'error']),
      );
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ data: null ⋅ error: null
      ┌─
      ⋅ status: error
      ⋅ isLoading: ❌
      ⋅ data: null
      ⋅ error: {code:500, id:fetch-error, message:error}
      └─
      "
    `);
  });

  test('fast item errors suppress immediate rerender retries', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    env.serverTable.setNextFetchError('users||1', 'fast failure');

    const { rerender, result } = renderHook(
      ({ version }: { version: number }) => {
        const [item] = listQueryStore.useMultipleItems(
          [{ payload: 'users||1' }],
          { selector: (data) => (data ? `${data.name}-${version}` : null) },
        );

        return item;
      },
      { initialProps: { version: 0 } },
    );

    await flushAllTimers();

    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    for (const version of [1, 2, 3]) {
      rerender({ version });
      await flushAllTimers();
    }

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('off-screen item hooks re-enter like a fresh mount after a fast error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    env.serverTable.setNextFetchError('users||1', 'fast failure');

    const { rerender, result } = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) => {
        const [item] = listQueryStore.useMultipleItems([
          { payload: 'users||1', isOffScreen },
        ]);

        return item;
      },
      { initialProps: { isOffScreen: false } },
    );

    await flushAllTimers();

    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    // Moving off-screen is equivalent to unmounting this subscription, so its
    // hook-local automatic retry lock should not survive when it becomes visible.
    rerender({ isOffScreen: true });
    await flushAllTimers();

    // Wait only for the normal low-priority scheduler throttle. This is still
    // inside the automatic retry lockout window, so a refetch here proves the
    // off-screen subscription re-entered like a fresh mount.
    await advanceTime(getDefaultLowPriorityThrottleMs() + 1);

    rerender({ isOffScreen: false });
    await flushAllTimers();

    expect(result.current?.status).toBe('success');
    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('fast item errors lock out automatic rerender retries but manual item fetches work', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      transportReconnectCooldownMs: 0,
      usesRealTimeUpdates: true,
    });
    const listQueryStore = env.apiStore;

    env.serverTable.setNextFetchError('users||1', 'fast failure');
    const initialQueries = [{ payload: 'users||1' }];

    const { rerender, result } = renderHook(
      ({
        queries,
        version,
      }: {
        queries: { payload: string }[];
        version: number;
      }) => {
        const [item] = listQueryStore.useMultipleItems(queries, {
          selector: (data) => (data ? `${data.name}-${version}` : null),
        });

        return item;
      },
      { initialProps: { queries: initialQueries, version: 0 } },
    );

    await flushAllTimers();

    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    await advanceTime(10_001);

    rerender({ queries: [{ payload: 'users||1' }], version: 1 });
    await flushAllTimers();

    // The first rerender after the fast failure can happen after 10s; the lock
    // is based on observing the error, not on when the rerender happens.
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    for (const version of [2, 3]) {
      rerender({ queries: [{ payload: 'users||1' }], version });
      await flushAllTimers();
    }

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    env.serverTable.setNextFetchError(
      'users||1',
      'public invalidation failure',
    );

    act(() => {
      listQueryStore.invalidateItem('users||1');
    });

    await flushAllTimers();

    // Public item invalidation bypasses the hook-level automatic retry lock.
    expect(result.current?.status).toBe('error');
    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    rerender({ queries: [{ payload: 'users||1' }], version: 4 });
    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    act(() => {
      listQueryStore.scheduleItemFetch('highPriority', 'users||1');
    });

    await flushAllTimers();

    expect(result.current?.status).toBe('success');
    expect(env.serverTable.numOfFinishedFetches).toBe(3);

    rerender({ queries: [{ payload: 'products||1' }], version: 5 });
    await flushAllTimers();

    expect(result.current?.status).toBe('success');
    expect(result.current?.data).toBe('Product 1-5');
    expect(env.serverTable.numOfFinishedFetches).toBe(4);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    function Comp({ payload }: { payload?: string }) {
      const selectionResult = listQueryStore.useItem(payload, {
        ensureIsLoaded: true,
        selector: (data) => data?.name ?? null,
      });

      renders.add(
        pick(selectionResult, ['status', 'payload', 'isLoading', 'data']),
      );

      return <div />;
    }

    const { rerender } = render(<Comp />);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: null ⋅ isLoading: ❌ ⋅ data: null
      "
    `);

    rerender(<Comp payload="users||1" />);

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: null ⋅ isLoading: ❌ ⋅ data: null
      ⋅⋅⋅
      -> status: loading ⋅ payload: users||1 ⋅ isLoading: ✅ ⋅ data: User 1
      -> status: success ⋅ payload: users||1 ⋅ isLoading: ❌ ⋅ data: User 1
      "
    `);
  });

  test('throws when ensureIsLoaded is combined with debouncePayload', () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    expect(() =>
      renderHook(() =>
        listQueryStore.useItem('users||1', {
          ensureIsLoaded: true,
          debouncePayload: { ms: 100 },
        }),
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      Error#:
        message: 'useItem does not support using ensureIsLoaded together with debouncePayload.'
        name: 'Error'
      `,
    );
  });

  test('disableRefetchOnMount', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const listQueryStore = env.apiStore;

    const compRenders = createLoggerStore();

    renderHook(() => {
      const data = listQueryStore.useItem('users||1', {
        disableRefetchOnMount: true,
      });

      compRenders.add({ status: data.status, data: data.data });
    });

    // wait some time to make sure the query is not refetched
    await advanceTime(200);

    expect(compRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('use deleted item', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });
    const store = env.apiStore;

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = store.useItem('users||2', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add(pick(selectionResult, ['status', 'payload', 'data']));
    });

    act(() => {
      store.deleteItemState('users||2');
      env.serverTable.removeItem('users||2');
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: users||2 ⋅ data: {id:2, name:User 2}
      -> status: deleted ⋅ payload: users||2 ⋅ data: null
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||2'));
    });

    await flushAllTimers();

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: loading ⋅ payload: users||2 ⋅ data: null
      -> status: error ⋅ payload: users||2 ⋅ data: null
      "
    `);
  });

  test('invalidate one item', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });
    const listQueryStore = env.apiStore;

    const users2 = createLoggerStore();
    const products1 = createLoggerStore();

    const { result } = renderHook(() => {
      const [usersResult, productsResult] = listQueryStore.useMultipleItems(
        ['users||2', 'products||1'].map((payload) => ({
          payload,
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        })),
      );

      users2.add(pick(usersResult, ['status', 'payload', 'data']));
      products1.add(pick(productsResult, ['status', 'payload', 'data']));

      return { usersResult, productsResult };
    });

    env.serverTable.updateItem('users||2', { name: 'Updated User 2' });

    act(() => {
      listQueryStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: 'users||2',
      });
    });

    await flushAllTimers();

    expect(users2.logsCount()).toBeGreaterThan(0);

    expect(users2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: users||2 ⋅ data: {id:2, name:User 2}
      -> status: refetching ⋅ payload: users||2 ⋅ data: {id:2, name:User 2}
      -> status: success ⋅ payload: users||2 ⋅ data: {id:2, name:Updated User 2}
      "
    `);
    expect(result.current.usersResult?.data?.name).toBe('Updated User 2');
    expect(products1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: products||1 ⋅ data: {id:1, name:Product 1}
      "
    `);
  });

  test('useMultipleItems with queryMetadata', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });
    const listQueryStore = env.apiStore;

    const users2 = createLoggerStore();
    const products1 = createLoggerStore();

    renderHook(() => {
      const [usersResult, productsResult] = listQueryStore.useMultipleItems(
        ['users||2', 'products||1'].map((payload) => ({
          payload,
          queryMetadata: { test: payload },
        })),
      );

      users2.add(
        pick(usersResult, ['status', 'payload', 'data', 'queryMetadata']),
      );
      products1.add(
        pick(productsResult, ['status', 'payload', 'data', 'queryMetadata']),
      );

      return { usersResult, productsResult };
    });

    await flushAllTimers();

    expect(users2.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ payload: users||2
      ⋅ data: {id:2, name:User 2}
      ⋅ queryMetadata: {test:users||2}
      └─
      "
    `);
    expect(products1.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ payload: products||1
      ⋅ data: {id:1, name:Product 1}
      ⋅ queryMetadata: {test:products||1}
      └─
      "
    `);
  });
});
