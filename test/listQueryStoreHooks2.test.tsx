import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createDefaultListQueryStore,
  ListQueryParams,
  Tables,
} from './utils/createDefaultListQueryStore';
import { pick } from './utils/objectUtils';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { createRenderStore, shouldNotSkip } from './utils/storeUtils';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

const createTestEnv = createDefaultListQueryStore;

const CompWithItemLoaded = ({
  disableRefetchOnMount = true,
  store,
  loadItem,
  renderStore,
}: {
  disableRefetchOnMount?: boolean;
  store: ReturnType<typeof createTestEnv>['store'];
  loadItem: string;
  renderStore: ReturnType<typeof createRenderStore>;
}) => {
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
};

const CompWithQueryLoaded = ({
  disableRefetchOnMount = true,
  store,
  loadTable,
  filters,
  renderStore,
}: {
  disableRefetchOnMount?: boolean;
  store: ReturnType<typeof createTestEnv>['store'];
  loadTable: string;
  renderStore: ReturnType<typeof createRenderStore>;
  filters?: ListQueryParams['filters'];
}) => {
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
};

function renderComponents({
  store,
  loadItem,
  loadTable,
  disableRefetchOnMount,
}: {
  store: ReturnType<typeof createTestEnv>['store'];
  loadItem: string;
  loadTable: string;
  disableRefetchOnMount: boolean;
}) {
  const compWithItemLoadedRenders = createRenderStore();

  const compWithQueryLoadedRenders = createRenderStore();

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

afterEach(() => {
  cleanup();
});

test('refetch an query and after a few ms refetch an item', async () => {
  const { store, serverMock } = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    disableInitialDataInvalidation: true,
  });

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  serverMock.setFetchDuration(50);

  shouldNotSkip(
    store.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
  );

  await sleep(40);

  shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||1'));

  await serverMock.waitFetchIdle();

  expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    "
  `);
  expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    "
  `);
});

test('load an query and item at same time', async () => {
  const { store, serverMock } = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  });

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      loadItem: 'users||1',
      loadTable: 'users',
      disableRefetchOnMount: false,
    });

  await serverMock.waitFetchIdle();

  expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    "
  `);
  expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    "
  `);

  expect(serverMock.fetchsCount).toBe(2);
});

test('load a query and a few ms after load a item with different data', async () => {
  const { store, serverMock } = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    disableInitialDataInvalidation: true,
  });

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  serverMock.setFetchDuration(50);

  shouldNotSkip(
    store.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
  );

  await sleep(45);
  serverMock.produceData((draft) => {
    draft.users![0]!.name = 'User 1 changed';
  });

  shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||1'));

  await serverMock.waitFetchIdle();

  expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- error: null -- items: [{id:1, name:User 1 changed}, ...(4 more)] -- payload: {tableId:users}
    "
  `);
  expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: success -- error: null -- data: {id:1, name:User 1 changed} -- itemId: users||1
    "
  `);

  expect(serverMock.fetchsSequence()).toMatchInlineSnapshot(`
    "
    started: 0, result: [{id: 1, name: User 1}, ...(4 more)], params: users
    started: 1, result: {id: 1, name: User 1 changed}, params: users||1
    "
  `);

  expect(serverMock.fetchsCount).toBe(2);
});

test('load a item and a few ms after load a query with different data', async () => {
  const { store, serverMock } = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    disableInitialDataInvalidation: true,
  });

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  serverMock.setFetchDuration(50);

  shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||1'));

  await sleep(45);
  serverMock.produceData((draft) => {
    draft.users![0]!.name = 'User 1 changed';
  });

  shouldNotSkip(
    store.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
  );

  await serverMock.waitFetchIdle();

  expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- error: null -- items: [{id:1, name:User 1 changed}, ...(4 more)] -- payload: {tableId:users}
    "
  `);
  expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: success -- error: null -- data: {id:1, name:User 1 changed} -- itemId: users||1
    "
  `);

  expect(serverMock.fetchsSequence()).toMatchInlineSnapshot(`
    "
    started: 0, result: {id: 1, name: User 1}, params: users||1
    started: 1, result: [{id: 1, name: User 1 changed}, ...(4 more)], params: users
    "
  `);

  expect(serverMock.fetchsCount).toBe(2);
});

describe('syncMutationAndInvalidation', () => {
  test('invalidate related queries after item invalidation', async () => {
    const { store, serverMock } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: { tables: ['users', 'products'] },
    });

    const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
      renderComponents({
        store,
        disableRefetchOnMount: true,
        loadItem: 'users||1',
        loadTable: 'users',
      });

    const comp3Renders = createRenderStore();

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

    store.invalidateItem('users||1');

    await serverMock.waitFetchIdle();

    expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
      status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
      status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
      "
    `);
    expect(comp3Renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- items: [{id:products||1, data:{id:1, name:Product 1}}, ...(49 more)]
      "
    `);
    expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
      status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
      status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
      "
    `);

    expect(serverMock.fetchsCount).toBe(2);
  });

  test('invalidate related item and query after query invalidation', async () => {
    const { store, serverMock } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: {
        tables: ['users', 'products'],
        queries: [{ tableId: 'users', filters: { idIsGreaterThan: 3 } }],
      },
    });

    const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
      renderComponents({
        store,
        disableRefetchOnMount: true,
        loadItem: 'users||1',
        loadTable: 'users',
      });

    const ignoreItemRenders = createRenderStore();
    const ignoreQueryRenders = createRenderStore();
    const relatedQueryRenders = createRenderStore();

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
          filters={{
            idIsGreaterThan: 3,
          }}
          renderStore={relatedQueryRenders}
        />
      </>,
    );

    store.invalidateQuery({ tableId: 'users' });

    await serverMock.waitFetchIdle();

    expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
      status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
      status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
      "
    `);

    expect(ignoreItemRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- data: {id:1, name:Product 1} -- itemId: products||1
      "
    `);
    expect(ignoreQueryRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products}
      "
    `);

    expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
      status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
      status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
      "
    `);
    expect(relatedQueryRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- error: null -- items: [{id:4, name:User 4}, {id:5, name:User 5}] -- payload: {tableId:users, filters:{idIsGreaterThan:3}}
      status: refetching -- error: null -- items: [{id:4, name:User 4}, {id:5, name:User 5}] -- payload: {tableId:users, filters:{idIsGreaterThan:3}}
      status: success -- error: null -- items: [{id:4, name:User 4}, {id:5, name:User 5}] -- payload: {tableId:users, filters:{idIsGreaterThan:3}}
      "
    `);

    expect(serverMock.fetchsCount).toBe(3);
  });
});

test('receive a RTU', async () => {
  const { store, serverMock } = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users', 'products'] },
    emulateRTU: true,
    disableInitialDataInvalidation: true,
  });

  const { compWithItemLoadedRenders, compWithQueryLoadedRenders } =
    renderComponents({
      store,
      disableRefetchOnMount: true,
      loadItem: 'users||1',
      loadTable: 'users',
    });

  const ignoreQueryRenders = createRenderStore();

  render(
    <CompWithQueryLoaded
      store={store}
      loadTable="products"
      renderStore={ignoreQueryRenders}
    />,
  );

  serverMock.produceData((draft) => {
    draft.users![0]!.name = 'User 1 updated';
  });

  await serverMock.waitFetchIdle();

  expect(compWithQueryLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: refetching -- error: null -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- error: null -- items: [{id:1, name:User 1 updated}, ...(4 more)] -- payload: {tableId:users}
    "
  `);
  expect(compWithItemLoadedRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: refetching -- error: null -- data: {id:1, name:User 1} -- itemId: users||1
    status: refetching -- error: null -- data: {id:1, name:User 1 updated} -- itemId: users||1
    status: success -- error: null -- data: {id:1, name:User 1 updated} -- itemId: users||1
    "
  `);
  expect(ignoreQueryRenders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- error: null -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products}
    "
  `);
});

test('useItem loadFromStateOnly', async () => {
  const env = createTestEnv({
    initialServerData,
    disableFetchItemFn: true,
    useLoadedSnapshot: { tables: ['users', 'products'] },
  });

  const renders = createRenderStore();

  renderHook(() => {
    const { data, status, isLoading } = env.store.useItem('users||1', {
      loadFromStateOnly: true,
    });

    renders.add({ status, data, isLoading });
  });

  await sleep(200);

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- data: {id:1, name:User 1} -- isLoading: false
    "
  `);
});

test('useItem loadFromStateOnly with not found item', async () => {
  const env = createTestEnv({
    initialServerData,
    disableFetchItemFn: true,
    useLoadedSnapshot: { tables: ['users', 'products'] },
  });

  const renders = createRenderStore();

  renderHook(() => {
    const { data, status, error, isLoading } = env.store.useItem('users||100', {
      loadFromStateOnly: true,
    });

    renders.add({ status, data, error, isLoading });
  });

  await sleep(200);

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    status: loading -- data: null -- error: null -- isLoading: true
    "
  `);
});

test.concurrent(
  'emulate realidateOnWindowFocus behaviour for list queries',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
      emulateRTU: true,
      disableInitialDataInvalidation: false,
    });

    function emulateWindowFocus() {
      env.store.invalidateQuery(() => true, 'lowPriority');
      env.store.invalidateItem(() => true, 'lowPriority');
    }

    function getState(table = 'users') {
      return pick(
        env.store.getQueryState({
          tableId: table,
        }),
        ['refetchOnMount', 'status', 'wasLoaded'],
        { refetchOnMount: 'rom', wasLoaded: 'wl' },
      );
    }

    expect(getState()).toEqual({
      rom: 'lowPriority',
      status: 'success',
      wl: true,
    });

    renderHook(() => {
      env.store.useListQuery({ tableId: 'users' });
    });

    await env.serverMock.waitFetchIdle(); // initial invalidation

    await sleep(1000);

    expect(getState()).toEqual({ rom: false, status: 'success', wl: true });

    emulateWindowFocus(); // this should not be skippe

    expect(getState()).toEqual({ rom: false, status: 'refetching', wl: true });

    await env.serverMock.waitFetchIdle();

    expect(getState()).toEqual({ rom: false, status: 'success', wl: true });

    emulateWindowFocus(); // this should be skipped by the throttle

    // as the query is active we should not change the revalidateOnMount state
    expect(getState()).toEqual({ rom: false, status: 'success', wl: true });
    expect(getState('products')).toEqual({
      rom: 'lowPriority',
      status: 'success',
      wl: true,
    });

    await sleep(1000);

    emulateWindowFocus(); // this should not be skipped

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(3);
  },
);

test.concurrent(
  'emulate realidateOnWindowFocus behaviour for item queries',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
      emulateRTU: true,
      disableInitialDataInvalidation: false,
    });

    function emulateWindowFocus() {
      env.store.invalidateQuery(() => true, 'lowPriority');
      env.store.invalidateItem(() => true, 'lowPriority');
    }

    function getItemState(itemId = 'users||1') {
      return pick(
        env.store.store.state.itemQueries[itemId] ?? undefined,
        ['refetchOnMount', 'status', 'wasLoaded'],
        { refetchOnMount: 'rom', wasLoaded: 'wl' },
      );
    }

    expect(getItemState()).toEqual({
      rom: 'lowPriority',
      status: 'success',
      wl: true,
    });

    renderHook(() => {
      env.store.useItem('users||1');
    });

    await env.serverMock.waitFetchIdle(); // initial invalidation

    await sleep(1000);

    expect(getItemState()).toEqual({ rom: false, status: 'success', wl: true });

    emulateWindowFocus(); // this should not be skippe

    expect(getItemState()).toEqual({
      rom: false,
      status: 'refetching',
      wl: true,
    });

    await env.serverMock.waitFetchIdle();

    expect(getItemState()).toEqual({ rom: false, status: 'success', wl: true });

    emulateWindowFocus(); // this should be skipped by the throttle

    // as the query is active we should not change the revalidateOnMount state
    expect(getItemState()).toEqual({ rom: false, status: 'success', wl: true });
    expect(getItemState('users||2')).toEqual({
      rom: 'lowPriority',
      status: 'success',
      wl: true,
    });

    await sleep(1000);

    emulateWindowFocus(); // this should not be skipped

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(3);
  },
);

test.concurrent(
  'emulate realidateOnWindowFocus behaviour for list queries 2',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users'] },
      emulateRTU: true,
      disableInitialDataInvalidation: false,
    });

    function emulateWindowFocus() {
      env.store.invalidateQuery(() => true, 'lowPriority');
      env.store.invalidateItem(() => true, 'lowPriority');
    }

    function getState(table = 'products') {
      return pick(
        env.store.getQueryState({
          tableId: table,
        }),
        ['refetchOnMount', 'status', 'wasLoaded'],
        { refetchOnMount: 'rom', wasLoaded: 'wl' },
      );
    }

    expect(getState()).toEqual({
      rom: 'lowPriority',
      status: 'success',
      wl: true,
    });

    renderHook(() => {
      env.store.useListQuery({ tableId: 'products' });
    });

    await env.serverMock.waitFetchIdle(); // initial invalidation

    await sleep(1000);

    expect(getState()).toEqual({ rom: false, status: 'success', wl: true });

    emulateWindowFocus(); // this should not be skippe

    expect(getState()).toEqual({ rom: false, status: 'refetching', wl: true });

    await env.serverMock.waitFetchIdle();

    expect(getState()).toEqual({ rom: false, status: 'success', wl: true });

    emulateWindowFocus(); // this should be skipped by the throttle

    // as the query is active we should not change the revalidateOnMount state
    expect(getState()).toEqual({ rom: false, status: 'success', wl: true });
    expect(getState('users')).toEqual({
      rom: 'lowPriority',
      status: 'success',
      wl: true,
    });

    await sleep(1000);

    emulateWindowFocus(); // this should not be skipped

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(3);
  },
);
