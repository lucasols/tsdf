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
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, range } from '../utils/genericTestUtils';
import { shouldNotSkip } from '../utils/listQueryHooksTestUtils';

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

type ListQueryStoreApi = ReturnType<
  typeof createListQueryStoreTestEnv<Row>
>['apiStore'];

function CompWithItemLoaded({
  disableRefetchOnMount = true,
  store,
  loadItem,
  renderStore,
}: {
  disableRefetchOnMount?: boolean;
  store: ListQueryStoreApi;
  loadItem: string;
  renderStore: ReturnType<typeof createLoggerStore>;
}) {
  const {
    status,
    error,
    data,
    payload: itemId,
  } = store.useItem(loadItem, {
    disableRefetchOnMount,
    returnRefetchingStatus: true,
  });

  renderStore.add({ status, error, data, itemId });

  return <div />;
}

function CompWithQueryLoaded({
  disableRefetchOnMount = true,
  store,
  loadTable,
  filters,
  renderStore,
}: {
  disableRefetchOnMount?: boolean;
  store: ListQueryStoreApi;
  loadTable: string;
  renderStore: ReturnType<typeof createLoggerStore>;
  filters?: ListQueryParams['filters'];
}) {
  const { status, error, items, payload } = store.useListQuery(
    { tableId: loadTable, filters },
    {
      disableRefetchOnMount,
      returnRefetchingStatus: true,
      itemSelector: (data) => data,
    },
  );

  renderStore.add({ status, error, items, payload });

  return <div />;
}

function renderComponents({
  store,
  loadItem,
  loadTable,
  disableRefetchOnMount,
}: {
  store: ListQueryStoreApi;
  loadItem: string;
  loadTable: string;
  disableRefetchOnMount: boolean;
}) {
  const compWithItemLoadedRenders = createLoggerStore();

  const compWithQueryLoadedRenders = createLoggerStore();

  render(
    <>
      <CompWithItemLoaded
        store={store}
        loadItem={loadItem}
        disableRefetchOnMount={disableRefetchOnMount}
        renderStore={compWithItemLoadedRenders}
      />
      <CompWithQueryLoaded
        store={store}
        loadTable={loadTable}
        disableRefetchOnMount={disableRefetchOnMount}
        renderStore={compWithQueryLoadedRenders}
      />
    </>,
  );

  return { compWithItemLoadedRenders, compWithQueryLoadedRenders };
}

function userIdGreaterThanFilter(
  value: number,
): NonNullable<ListQueryParams['filters']> {
  return [{ op: 'gt', field: 'id', value }];
}

test('refetch an query and after a few ms refetch an item', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });
  const store = env.apiStore;

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  shouldNotSkip(
    store.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
  );

  await advanceTime(790);

  shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||1'));

  await flushAllTimers();

  expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    "
  `);
  expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: refetching
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    "
  `);
});

test('load an query and item at same time', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });
  const store = env.apiStore;

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      loadItem: 'users||1',
      loadTable: 'users',
      disableRefetchOnMount: false,
    });

  await flushAllTimers();

  expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    "
  `);
  expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: refetching
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    "
  `);

  expect(env.serverTable.numOfFinishedFetches).toBe(2);
});

test('load a query and a few ms after load a item with different data', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });
  const store = env.apiStore;

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  shouldNotSkip(
    store.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
  );

  await advanceTime(1000);
  env.serverTable.updateItem('users||1', { name: 'User 1 changed' });

  shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||1'));

  await flushAllTimers();

  expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: refetching
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1 changed}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    "
  `);
  expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ data: {id:1, name:User 1 changed}
    ⋅ itemId: users||1
    └─
    "
  `);

  expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
    - duration: 800
      limit: 50
      offset: 0
      results:
        - data: { id: 1, name: 'User 1' }
          itemId: 'users||1'
        - data: { id: 2, name: 'User 2' }
          itemId: 'users||2'
        - data: { id: 3, name: 'User 3' }
          itemId: 'users||3'
        - data: { id: 4, name: 'User 4' }
          itemId: 'users||4'
        - data: { id: 5, name: 'User 5' }
          itemId: 'users||5'
      startedAt: 10
      type: 'list'
    - duration: 800
      itemId: 'users||1'
      result: { id: 1, name: 'User 1 changed' }
      startedAt: 1010
      type: 'fetch'
  `);

  expect(env.serverTable.numOfFinishedFetches).toBe(2);
});

test('load a item and a few ms after load a query with different data', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });
  const store = env.apiStore;

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||1'));

  await advanceTime(1000);
  env.serverTable.updateItem('users||1', { name: 'User 1 changed' });

  shouldNotSkip(
    store.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
  );

  await flushAllTimers();

  expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: refetching
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1 changed}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    "
  `);
  expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ data: {id:1, name:User 1 changed}
    ⋅ itemId: users||1
    └─
    "
  `);

  expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
    - duration: 800
      itemId: 'users||1'
      result: { id: 1, name: 'User 1' }
      startedAt: 10
      type: 'fetch'
    - duration: 800
      limit: 50
      offset: 0
      results:
        - data: { id: 1, name: 'User 1 changed' }
          itemId: 'users||1'
        - data: { id: 2, name: 'User 2' }
          itemId: 'users||2'
        - data: { id: 3, name: 'User 3' }
          itemId: 'users||3'
        - data: { id: 4, name: 'User 4' }
          itemId: 'users||4'
        - data: { id: 5, name: 'User 5' }
          itemId: 'users||5'
      startedAt: 1010
      type: 'list'
  `);

  expect(env.serverTable.numOfFinishedFetches).toBe(2);
});

describe('syncMutationAndInvalidation', () => {
  test('invalidate related queries after item invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });
    const store = env.apiStore;

    const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
      renderComponents({
        store,
        disableRefetchOnMount: true,
        loadItem: 'users||1',
        loadTable: 'users',
      });

    const comp3Renders = createLoggerStore();

    renderHook(() => {
      const { status, error, items } = store.useListQuery(
        { tableId: 'products' },
        {
          disableRefetchOnMount: true,
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      comp3Renders.add({ status, error, items });
    });

    act(() => {
      store.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: (payload) => payload.tableId === 'users',
      });
    });

    await flushAllTimers();

    expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
      -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
      -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
      "
    `);
    expect(comp3Renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:\\products||1, data:{id:1, name:Product 1}}, …(49 more)]
      └─
      "
    `);
    expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:1, name:User 1}, …(4 more)]
      ⋅ payload: {tableId:users}
      └─
      ┌─
      ⋅ status: refetching
      ⋅ error: null
      ⋅ items: [{id:1, name:User 1}, …(4 more)]
      ⋅ payload: {tableId:users}
      └─
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:1, name:User 1}, …(4 more)]
      ⋅ payload: {tableId:users}
      └─
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('invalidate related item and query after query invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: {
        loaded: {
          tables: ['users', 'products'],
          queries: [{ tableId: 'users', filters: userIdGreaterThanFilter(3) }],
        },
      },
    });
    const store = env.apiStore;

    const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
      renderComponents({
        store,
        disableRefetchOnMount: true,
        loadItem: 'users||1',
        loadTable: 'users',
      });

    const ignoreItemRenders = createLoggerStore();
    const ignoreQueryRenders = createLoggerStore();
    const relatedQueryRenders = createLoggerStore();

    render(
      <>
        <CompWithItemLoaded
          store={store}
          loadItem="products||1"
          renderStore={ignoreItemRenders}
        />
        <CompWithQueryLoaded
          store={store}
          loadTable="products"
          renderStore={ignoreQueryRenders}
        />
        <CompWithQueryLoaded
          store={store}
          loadTable="users"
          filters={userIdGreaterThanFilter(3)}
          renderStore={relatedQueryRenders}
        />
      </>,
    );

    act(() => {
      store.invalidateQueryAndItems({
        itemPayload: (payload) => payload.startsWith('users||'),
        queryPayload: (payload) => payload.tableId === 'users',
      });
    });

    await flushAllTimers();

    expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:1, name:User 1}, …(4 more)]
      ⋅ payload: {tableId:users}
      └─
      ┌─
      ⋅ status: refetching
      ⋅ error: null
      ⋅ items: [{id:1, name:User 1}, …(4 more)]
      ⋅ payload: {tableId:users}
      └─
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:1, name:User 1}, …(4 more)]
      ⋅ payload: {tableId:users}
      └─
      "
    `);

    expect(ignoreItemRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ data: {id:1, name:Product 1}
      ⋅ itemId: products||1
      └─
      "
    `);
    expect(ignoreQueryRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:1, name:Product 1}, …(49 more)]
      ⋅ payload: {tableId:products}
      └─
      "
    `);

    expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
      -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
      -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
      "
    `);
    expect(relatedQueryRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:4, name:User 4}, {id:5, name:User 5}]
      ⋅ payload: {tableId:users, filters:[{op:gt, field:id, value:3}]}
      └─
      ┌─
      ⋅ status: refetching
      ⋅ error: null
      ⋅ items: [{id:4, name:User 4}, {id:5, name:User 5}]
      ⋅ payload: {tableId:users, filters:[{op:gt, field:id, value:3}]}
      └─
      ┌─
      ⋅ status: success
      ⋅ error: null
      ⋅ items: [{id:4, name:User 4}, {id:5, name:User 5}]
      ⋅ payload: {tableId:users, filters:[{op:gt, field:id, value:3}]}
      └─
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(3);
  });
});

test('receive a RTU', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users', 'products'] } },
    usesRealTimeUpdates: true,
  });
  const store = env.apiStore;

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  const ignoreQueryRenders = createLoggerStore();

  render(
    <CompWithQueryLoaded
      store={store}
      loadTable="products"
      renderStore={ignoreQueryRenders}
    />,
  );

  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: 'User 1 updated' },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  expect(compWithQueryLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: refetching
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:User 1 updated}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    "
  `);
  expect(compWithItemLoadedRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    -> status: refetching ⋅ error: null ⋅ data: {id:1, name:User 1} ⋅ itemId: users||1
    ┌─
    ⋅ status: refetching
    ⋅ error: null
    ⋅ data: {id:1, name:User 1 updated}
    ⋅ itemId: users||1
    └─
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ data: {id:1, name:User 1 updated}
    ⋅ itemId: users||1
    └─
    "
  `);
  expect(ignoreQueryRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ error: null
    ⋅ items: [{id:1, name:Product 1}, …(49 more)]
    ⋅ payload: {tableId:products}
    └─
    "
  `);
});

test('useItem loadFromStateOnly', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users', 'products'] } },
    disableFetchItemFn: true,
  });
  const store = env.apiStore;

  const renders = createLoggerStore();

  renderHook(() => {
    const { data, status, isLoading } = store.useItem('users||1', {
      loadFromStateOnly: true,
    });

    renders.add({ status, data, isLoading });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {id:1, name:User 1} ⋅ isLoading: ❌
    "
  `);
});

test('useItem loadFromStateOnly with not found item', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users', 'products'] } },
    disableFetchItemFn: true,
  });
  const store = env.apiStore;

  const renders = createLoggerStore();

  renderHook(() => {
    const { data, status, error, isLoading } = store.useItem('users||100', {
      loadFromStateOnly: true,
    });

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

test('invalidation should not throw error when fetchItemFn is not used', () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users', 'products'] } },
    disableFetchItemFn: true,
  });
  const store = env.apiStore;

  expect(() => {
    store.invalidateQueryAndItems({
      itemPayload: () => true,
      queryPayload: () => true,
      type: 'lowPriority',
    });
  }).not.toThrow();
});
