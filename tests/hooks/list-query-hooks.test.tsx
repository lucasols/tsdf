import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import '@testing-library/react/dont-cleanup-after-each';
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
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { pick, range } from '../utils/genericTestUtils';
import {
  advanceTime,
  flushAllTimers,
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
        (item) => ({
          payload: item,
          returnRefetchingStatus: true,
        }),
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
          (item) => ({
            payload: item,
            returnRefetchingStatus: true,
          }),
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

  test('do not fetch more than expected with multiple components connected to the same items', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;
    const usersRender = createLoggerStore();
    const productsRender = createLoggerStore();

    renderHook(() => {
      const queryResult = listQueryStore.useMultipleListQueries(
        [getFetchQueryForTable('users'), getFetchQueryForTable('products')].map(
          (item) => ({
            payload: item,
            returnRefetchingStatus: true,
          }),
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
          (item) => ({
            payload: item,
          }),
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
          (item) => ({
            payload: item,
            returnRefetchingStatus: true,
          }),
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
          (item) => ({
            payload: item,
            returnRefetchingStatus: true,
          }),
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
          payload.map((item) => ({
          payload: item,
        })),
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
          (item) => ({
          payload: item,
          disableRefetchOnMount: true,
          }),
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
          (item) => ({
          payload: item,
          queryMetadata: { test: item },
          }),
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
  test('disable then enable the initial fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    type Props = {
      payload: FetchQueryParams | false | undefined | null;
    };

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

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ items: [User 1, …(4 more)]
      -> status: success ⋅ isLoading: ❌ ⋅ items: [User 1, …(4 more)]
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
      const selectionResult = listQueryStore.useListQuery(
        { tableId: 'users' },
        { itemSelector: (data) => data.name },
      );

      renders.add(pick(selectionResult, ['status', 'isLoading', 'items']));
    });

    await flushAllTimers();

    expect(renders.snapshot).toMatchInlineSnapshot(`
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

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ isLoading: ❌ ⋅ items: []
      "
    `);

    rerender(<Comp payload={{ tableId: 'users' }} />);

    await flushAllTimers();

    expect(renders.snapshot).toMatchInlineSnapshot(`
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

  test('disableRefetchOnMount', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const compRenders = createRenderStore();

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
    await sleep(200);

    expect(compRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- items: [{id:users||1, data:{id:1, name:User 1}}, ...(4 more)]
      "
    `);

    expect(serverMock.fetchsCount).toBe(0);
  });
});

describe('useItem', () => {
  test('disable then enable the initial fetch', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
    });

    const renders = createRenderStore();

    const Comp = ({
      payload,
    }: {
      payload: string | false | undefined | null;
    }) => {
      const queryResult = listQueryStore.useItem(payload);

      renders.add(pick(queryResult, ['status', 'payload', 'data']));

      return <div />;
    };

    const { rerender } = render(<Comp payload={false} />);

    expect(renders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: idle -- payload: null -- data: null
      "
    `);

    expect(serverMock.fetchsCount).toBe(0);

    rerender(<Comp payload="users||1" />);

    await serverMock.waitFetchIdle();

    expect(serverMock.fetchsCount).toBe(1);

    expect(renders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: idle -- payload: null -- data: null
      ---
      status: loading -- payload: users||1 -- data: null
      status: success -- payload: users||1 -- data: {id:1, name:User 1}
      "
    `);
  });

  test('ignore refetchingStatus by default', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useItem('users||1', {
        selector: (data) => data?.name,
      });

      renders.add(pick(selectionResult, ['status', 'isLoading', 'data']));
    });

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- isLoading: false -- data: User 1
      "
    `);
  });

  test('use ensureIsLoaded prop', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = listQueryStore.useItem('users||1', {
        ensureIsLoaded: true,
        selector: (data) => data?.name,
      });

      renders.add(pick(selectionResult, ['status', 'isLoading', 'data']));
    });

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: loading -- isLoading: true -- data: User 1
      status: success -- isLoading: false -- data: User 1
      "
    `);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const { store: listQueryStore, serverMock } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const renders = createRenderStore();

    const Comp = ({ payload }: { payload?: string }) => {
      const selectionResult = listQueryStore.useItem(payload, {
        ensureIsLoaded: true,
        selector: (data) => data?.name ?? null,
      });

      renders.add(
        pick(selectionResult, ['status', 'payload', 'isLoading', 'data']),
      );

      return <div />;
    };

    const { rerender } = render(<Comp />);

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: null -- isLoading: false -- data: null
      "
    `);

    rerender(<Comp payload="users||1" />);

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: null -- isLoading: false -- data: null
      ---
      status: loading -- payload: users||1 -- isLoading: true -- data: User 1
      status: success -- payload: users||1 -- isLoading: false -- data: User 1
      "
    `);
  });

  test('disableRefetchOnMount', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    const compRenders = createRenderStore();

    renderHook(() => {
      const data = listQueryStore.useItem('users||1', {
        disableRefetchOnMount: true,
      });

      compRenders.add({ status: data.status, data: data.data });
    });

    // wait some time to make sure the query is not refetched
    await sleep(200);

    expect(compRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- data: {id:1, name:User 1}
      "
    `);

    expect(serverMock.fetchsCount).toBe(0);
  });

  test('use deleted item', async () => {
    const { serverMock, store } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = store.useItem('users||2', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add(pick(selectionResult, ['status', 'payload', 'data']));
    });

    store.deleteItemState('users||2');
    serverMock.produceData((draft) => {
      draft.users!.splice(1, 1);
    });

    await renders.waitNextRender();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: users||2 -- data: {id:2, name:User 2}
      status: deleted -- payload: users||2 -- data: null
      "
    `);

    shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||2'));

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: users||2 -- data: {id:2, name:User 2}
      status: deleted -- payload: users||2 -- data: null
      ---
      status: loading -- payload: users||2 -- data: null
      status: error -- payload: users||2 -- data: null
      "
    `);
  });

  test('invalidate one item', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
    });

    const users2 = createRenderStore();
    const products1 = createRenderStore();

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

    serverMock.produceData((draft) => {
      draft.users![1]!.name = 'Updated User 2';
    });

    listQueryStore.invalidateQueryAndItems({
      queryPayload: false,
      itemPayload: 'users||2',
    });

    await serverMock.waitFetchIdle();

    expect(users2.renderCount()).toBeGreaterThan(0);

    expect(users2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: users||2 -- data: {id:2, name:User 2}
      status: refetching -- payload: users||2 -- data: {id:2, name:User 2}
      status: success -- payload: users||2 -- data: {id:2, name:Updated User 2}
      "
    `);
    expect(result.current.usersResult?.data?.name).toBe('Updated User 2');
    expect(products1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: products||1 -- data: {id:1, name:Product 1}
      "
    `);
  });

  test('useMultipleItems with queryMetadata', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      disableInitialDataInvalidation: false,
      useLoadedSnapshot: { tables: ['users', 'products'] },
    });

    const users2 = createRenderStore();
    const products1 = createRenderStore();

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

    await serverMock.waitFetchIdle();

    expect(users2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: users||2 -- data: {id:2, name:User 2} -- queryMetadata: {test:users||2}
      "
    `);
    expect(products1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: products||1 -- data: {id:1, name:Product 1} -- queryMetadata: {test:products||1}
      "
    `);
  });
});

test.concurrent(
  'initial data is invalidated on first load in item query',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
      disableInitialDataInvalidation: false,
    });

    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = 'Updated User 1';
    });

    const renders = createRenderStore();

    renderHook(() => {
      const { data, status } = env.store.useItem('users||1', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, data });
    });

    await env.serverMock.waitFetchIdle(0, 1500);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- data: {id:1, name:User 1}
    status: refetching -- data: {id:1, name:User 1}
    status: success -- data: {id:1, name:Updated User 1}
    "
  `);
  },
);

test.concurrent(
  'initial data is invalidated on first load in list query',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
      disableInitialDataInvalidation: false,
    });

    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = '🆕';
    });

    const renders = createRenderStore();

    renderHook(() => {
      const { items, status } = env.store.useListQuery(
        { tableId: 'users' },
        {
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
          itemSelector(data, _, itemKey) {
            return { id: itemKey, data };
          },
        },
      );

      renders.add({ status, items });
    });

    await env.serverMock.waitFetchIdle(0, 1500);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- items: [{id:users||1, data:{id:1, name:User 1}}, ...(4 more)]
    status: refetching -- items: [{id:users||1, data:{id:1, name:User 1}}, ...(4 more)]
    status: success -- items: [{id:users||1, data:{id:1, name:🆕}}, ...(4 more)]
    "
  `);
  },
);
