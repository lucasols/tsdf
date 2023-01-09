import { cleanup, render, renderHook } from '@testing-library/react';
import { act } from 'react-dom/test-utils';
import { afterAll, describe, expect, test } from 'vitest';
import {
  createDefaultListQueryStore,
  Tables,
} from './utils/createDefaultListQueryStore';
import { pick } from './utils/objectUtils';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { createRenderStore, createValueStore } from './utils/storeUtils';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

afterAll(() => {
  cleanup();
});

type FetchQueryParams = { tableId: string };

function getFetchQueryForTable(tableId: string): FetchQueryParams {
  return { tableId };
}

describe('useMultipleItemsQuery sequential tests', () => {
  const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
    initialServerData,
  });

  const usersRender = createRenderStore();
  const productsRender = createRenderStore();

  const { result } = renderHook(() => {
    const queryResult = listQueryStore.useMultipleListQueries(
      [getFetchQueryForTable('users'), getFetchQueryForTable('products')],
      { returnRefetchingStatus: true },
    );

    const [users, products] = queryResult;

    usersRender.add(pick(users, ['status', 'payload', 'items']));
    productsRender.add(pick(products, ['status', 'payload', 'items']));

    return { users, products };
  });

  test('load the queries', async () => {
    await serverMock.waitFetchIdle();

    expect(serverMock.numOfFetchs).toBe(2);

    expect(usersRender.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: loading -- payload: {tableId:users} -- items: []
      status: success -- payload: {tableId:users} -- items: [{id:users||1, data:{id:1, name:User 1}}, ...(4 more)]
      "
    `);

    expect(productsRender.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: loading -- payload: {tableId:products} -- items: []
      status: success -- payload: {tableId:products} -- items: [{id:products||1, data:{id:1, name:Product 1}}, ...(49 more)]
      "
    `);
  });

  test('invalidate one query', async () => {
    usersRender.reset();
    productsRender.reset();

    serverMock.produceData((draft) => {
      draft.users![0]!.name = 'Updated User 1';
    });
    listQueryStore.invalidateQuery(getFetchQueryForTable('users'));

    await serverMock.waitFetchIdle();

    expect(usersRender.renderCount()).toBeGreaterThan(0);

    expect(usersRender.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: refetching -- payload: {tableId:users} -- items: [{id:users||1, data:{id:1, name:User 1}}, ...(4 more)]
      status: success -- payload: {tableId:users} -- items: [{id:users||1, data:{id:1, name:Updated User 1}}, ...(4 more)]
      "
    `);
    expect(result.current.users?.items[0]!.data.name).toBe('Updated User 1');
    expect(productsRender.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: success -- payload: {tableId:products} -- items: [{id:products||1, data:{id:1, name:Product 1}}, ...(49 more)]
      "
    `);
  });

  describe('invalidate all queries', async () => {
    const extraComponentMounted = createRenderStore();

    let getFetchCount: () => number;

    // eslint-disable-next-line vitest/expect-expect
    test('setup block', async () => {
      getFetchCount = serverMock.numOfFetchsFromHere();

      // mount a new hook to check if there are more fetchs than expected
      const { unmount } = renderHook(() => {
        const selectionResult = listQueryStore.useMultipleListQueries(
          [getFetchQueryForTable('users'), getFetchQueryForTable('products')],
          {
            itemSelector(_, data) {
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

      productsRender.reset();
      usersRender.reset();

      serverMock.setFetchDuration((param) => {
        return param === '1' ? 20 : 40;
      });

      serverMock.produceData((draft) => {
        draft.users![0]!.name = 'Updated User 1 again';
        draft.products![0]!.name = 'Updated Product 1';
      });

      listQueryStore.invalidateQuery(() => true);

      await serverMock.waitFetchIdle();

      serverMock.undoTimeoutChange();

      unmount();
    });

    test('do not fetch more than expected with multiple components connected to the same items', () => {
      expect(getFetchCount()).toBe(2);
    });

    test('refetch data after invalidations', () => {
      expect(usersRender.getSnapshot()).toMatchInlineSnapshot(`
        "
        status: refetching -- payload: {tableId:users} -- items: [{id:users||1, data:{id:1, name:Updated User 1}}, ...(4 more)]
        status: success -- payload: {tableId:users} -- items: [{id:users||1, data:{id:1, name:Updated User 1 again}}, ...(4 more)]
        "
      `);

      expect(productsRender.getSnapshot()).toMatchInlineSnapshot(`
        "
        status: refetching -- payload: {tableId:products} -- items: [{id:products||1, data:{id:1, name:Product 1}}, ...(49 more)]
        status: success -- payload: {tableId:products} -- items: [{id:products||1, data:{id:1, name:Updated Product 1}}, ...(49 more)]
        "
      `);
    });

    test('data selector', () => {
      expect(extraComponentMounted.getSnapshot()).toMatchInlineSnapshot(`
        "
        status: success -- payload: {tableId:users} -- items: [Updated User 1, ...(4 more)]
        status: success -- payload: {tableId:users} -- items: [Updated User 1 again, ...(4 more)]
        "
      `);
    });
  });
});

describe('useMultipleItemsQuery isolated tests', () => {
  test('rerender when payload changes', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
    });

    const payload = createValueStore([
      getFetchQueryForTable('users'),
      getFetchQueryForTable('products'),
    ]);

    const usersRenders = createRenderStore();
    const productsRenders = createRenderStore();

    renderHook(() => {
      const [users, products] = listQueryStore.useMultipleListQueries(
        payload.useValue(),
        { itemSelector: (_, data) => data.name },
      );

      usersRenders.add(pick(users, ['status', 'payload', 'items']));
      productsRenders.add(pick(products, ['status', 'payload', 'items']));
    });

    payload.set([
      getFetchQueryForTable('users'),
      getFetchQueryForTable('not-found'),
    ]);

    await serverMock.waitFetchIdle();

    expect(usersRenders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: success -- payload: {tableId:users} -- items: [User 1, ...(4 more)]
      "
    `);
    expect(productsRenders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: success -- payload: {tableId:products} -- items: [Product 1, ...(49 more)]
      status: loading -- payload: {tableId:not-found} -- items: []
      status: error -- payload: {tableId:not-found} -- items: []
      "
    `);
  });
});

describe('useQuery', () => {
  test('disable then enable the initial fetch', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
    });

    const renders = createRenderStore();

    type Props = {
      payload: FetchQueryParams | false | undefined | null;
    };

    const { rerender } = renderHook(
      ({ payload }) => {
        const queryResult = listQueryStore.useListQuery(payload);

        renders.add(pick(queryResult, ['status', 'payload', 'items']));

        return queryResult;
      },
      { initialProps: { payload: false } as Props },
    );

    expect(renders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- items: []
      "
    `);

    expect(serverMock.numOfFetchs).toBe(0);

    rerender({ payload: { tableId: 'users' } });

    await serverMock.waitFetchIdle();

    expect(serverMock.numOfFetchs).toBe(1);

    expect(renders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- items: []
      ---
      status: loading -- payload: {tableId:users} -- items: []
      status: success -- payload: {tableId:users} -- items: [{id:users||1, data:{id:1, name:User 1}}, ...(4 more)]
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
      const selectionResult = listQueryStore.useListQuery(
        { tableId: 'users' },
        { ensureIsLoaded: true, itemSelector: (_, data) => data.name },
      );

      renders.add(pick(selectionResult, ['status', 'isLoading', 'items']));
    });

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: loading -- isLoading: true -- items: [User 1, ...(4 more)]
      status: success -- isLoading: false -- items: [User 1, ...(4 more)]
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
      const selectionResult = listQueryStore.useListQuery(
        { tableId: 'users' },
        { itemSelector: (_, data) => data.name },
      );

      renders.add(pick(selectionResult, ['status', 'isLoading', 'items']));
    });

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- isLoading: false -- items: [User 1, ...(4 more)]
      "
    `);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const { store: listQueryStore, serverMock } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const renders = createRenderStore();

    const Comp = ({ payload }: { payload?: FetchQueryParams }) => {
      const selectionResult = listQueryStore.useListQuery(payload, {
        ensureIsLoaded: true,
        itemSelector: (_, data) => data.name,
      });

      renders.add(
        pick(selectionResult, ['status', 'payload', 'isLoading', 'items']),
      );

      return <div />;
    };

    const { rerender } = render(<Comp />);

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- isLoading: false -- items: []
      "
    `);

    rerender(<Comp payload={{ tableId: 'users' }} />);

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- isLoading: false -- items: []
      ---
      status: loading -- payload: {tableId:users} -- isLoading: true -- items: [User 1, ...(4 more)]
      status: success -- payload: {tableId:users} -- isLoading: false -- items: [User 1, ...(4 more)]
      "
    `);
  });

  test('disableRefetchOnMount', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const compRenders = createRenderStore();

    renderHook(() => {
      const data = listQueryStore.useListQuery(
        { tableId: 'users' },
        { disableRefetchOnMount: true },
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

    expect(serverMock.numOfFetchs).toBe(0);
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

      renders.add(pick(queryResult, ['status', 'itemId', 'data']));

      return <div />;
    };

    const { rerender } = render(<Comp payload={false} />);

    expect(renders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: idle -- itemId: '' -- data: null
      "
    `);

    expect(serverMock.numOfFetchs).toBe(0);

    rerender(<Comp payload="users||1" />);

    await serverMock.waitFetchIdle();

    expect(serverMock.numOfFetchs).toBe(1);

    expect(renders.getSnapshot()).toMatchInlineSnapshot(`
      "
      status: idle -- itemId: '' -- data: null
      ---
      status: loading -- itemId: users||1 -- data: null
      status: success -- itemId: users||1 -- data: {id:1, name:User 1}
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
        pick(selectionResult, ['status', 'itemId', 'isLoading', 'data']),
      );

      return <div />;
    };

    const { rerender } = render(<Comp />);

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- itemId: '' -- isLoading: false -- data: null
      "
    `);

    rerender(<Comp payload="users||1" />);

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- itemId: '' -- isLoading: false -- data: null
      ---
      status: loading -- itemId: users||1 -- isLoading: true -- data: User 1
      status: success -- itemId: users||1 -- isLoading: false -- data: User 1
      "
    `);
  });

  test('disableRefetchOnMount', async () => {
    const { serverMock, store: listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
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

    expect(serverMock.numOfFetchs).toBe(0);
  });

  test.only('use deleted item', async () => {
    const { serverMock, store, shouldNotSkip } = createDefaultListQueryStore({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = store.useItem('users||2', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add(pick(selectionResult, ['status', 'itemId', 'data']));
    });

    store.deleteItemState('users||2');
    serverMock.produceData((draft) => {
      draft.users!.splice(1, 1);
    });

    await renders.waitNextRender();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- itemId: users||2 -- data: {id:2, name:User 2}
      status: deleted -- itemId: users||2 -- data: null
      "
    `);

    shouldNotSkip(store.scheduleItemFetch('highPriority', 'users||2'));

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- itemId: users||2 -- data: {id:2, name:User 2}
      status: deleted -- itemId: users||2 -- data: null
      ---
      status: loading -- itemId: users||2 -- data: null
      status: error -- itemId: users||2 -- data: null
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
        ['users||2', 'products||1'],
        {
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        },
      );

      users2.add(pick(usersResult, ['status', 'itemId', 'data']));
      products1.add(pick(productsResult, ['status', 'itemId', 'data']));

      return { usersResult, productsResult };
    });

    serverMock.produceData((draft) => {
      draft.users![1]!.name = 'Updated User 2';
    });
    listQueryStore.invalidateItem('users||2');

    await serverMock.waitFetchIdle();

    expect(users2.renderCount()).toBeGreaterThan(0);

    expect(users2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- itemId: users||2 -- data: {id:2, name:User 2}
      status: refetching -- itemId: users||2 -- data: {id:2, name:User 2}
      status: success -- itemId: users||2 -- data: {id:2, name:Updated User 2}
      "
    `);
    expect(result.current.usersResult?.data.name).toBe('Updated User 2');
    expect(products1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- itemId: products||1 -- data: {id:1, name:Product 1}
      "
    `);
  });
});
