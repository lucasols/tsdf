import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  Tables,
  createDefaultListQueryStore,
} from './utils/createDefaultListQueryStore';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { createRenderStore } from './utils/storeUtils';
import { useCallback } from 'react';
import { pick } from './utils/objectUtils';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

const createTestEnv = createDefaultListQueryStore;

test.concurrent(
  'useItem: isOffScreen should keep the selected data and not be affected by invalidation',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users'] },
      emulateRTU: true,
      disableInitialDataInvalidation: true,
    });

    const renders = createRenderStore({
      rejectKeys: ['queryMetadata'],
    });

    const { rerender } = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) => {
        const result = env.store.useItem('users||1', {
          isOffScreen,
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        });

        renders.add(result);
      },
      { initialProps: { isOffScreen: false } },
    );

    await sleep(100);

    renders.addMark('first update (✅)');
    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = '✅';
    });

    await sleep(200);

    renders.addMark('set disabled');
    rerender({ isOffScreen: true });

    await sleep(100);

    renders.addMark('ignored update (❌)');
    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = '❌';
    });

    await sleep(200);

    renders.addMark('enabled again');
    rerender({ isOffScreen: false });

    await sleep(200);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      status: success -- error: null -- isLoading: false -- data: {id:1, name:User 1} -- payload: users||1

      >>> first update (✅)

      status: refetching -- error: null -- isLoading: false -- data: {id:1, name:User 1} -- payload: users||1
      status: success -- error: null -- isLoading: false -- data: {id:1, name:✅} -- payload: users||1

      >>> set disabled

      status: success -- error: null -- isLoading: false -- data: {id:1, name:✅} -- payload: users||1

      >>> ignored update (❌)

      >>> enabled again

      status: success -- error: null -- isLoading: false -- data: {id:1, name:✅} -- payload: users||1
      status: refetching -- error: null -- isLoading: false -- data: {id:1, name:✅} -- payload: users||1
      status: success -- error: null -- isLoading: false -- data: {id:1, name:❌} -- payload: users||1
      "
    `);
  },
);

test.concurrent(
  'useListQuery: isOffScreen should keep the selected data and not be affected by invalidation',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users'] },
      emulateRTU: true,
      disableInitialDataInvalidation: true,
    });

    const renders = createRenderStore({
      rejectKeys: ['queryMetadata'],
    });

    const { rerender } = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) => {
        const result = env.store.useListQuery(
          { tableId: 'users' },
          {
            isOffScreen,
            returnRefetchingStatus: true,
            disableRefetchOnMount: true,
          },
        );

        renders.add(result);
      },
      { initialProps: { isOffScreen: false } },
    );

    await sleep(100);

    renders.addMark('first update (✅)');
    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = '✅';
    });

    await sleep(200);

    renders.addMark('set disabled');
    rerender({ isOffScreen: true });

    await sleep(100);

    renders.addMark('ignored update (❌)');
    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = '❌';
    });

    await sleep(200);

    renders.addMark('enabled again');
    rerender({ isOffScreen: false });

    await sleep(200);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      queryKey: {"tableId":"users"} -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false

      >>> first update (✅)

      queryKey: {"tableId":"users"} -- status: refetching -- items: [{id:1, name:User 1}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false
      queryKey: {"tableId":"users"} -- status: success -- items: [{id:1, name:✅}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false

      >>> set disabled

      queryKey: {"tableId":"users"} -- status: success -- items: [{id:1, name:✅}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false

      >>> ignored update (❌)

      >>> enabled again

      queryKey: {"tableId":"users"} -- status: success -- items: [{id:1, name:✅}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false
      queryKey: {"tableId":"users"} -- status: refetching -- items: [{id:1, name:✅}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false
      queryKey: {"tableId":"users"} -- status: success -- items: [{id:1, name:❌}, ...(4 more)] -- error: null -- hasMore: false -- isLoading: false -- payload: {tableId:users} -- isLoadingMore: false
      "
    `);
  },
);

test.concurrent('useItem: disable then enable isOffScreen', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['products', 'users'] },
    emulateRTU: true,
    disableInitialDataInvalidation: true,
    lowPriorityThrottleMs: 10,
  });

  const renders = createRenderStore({
    filterKeys: ['status', 'data', 'payload'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.store.useItem('users||1', {
        isOffScreen,
        returnRefetchingStatus: true,
      });

      renders.add(result);
    },
    { initialProps: { isOffScreen: false } },
  );

  await sleep(120);

  renders.addMark('set disabled');

  rerender({ isOffScreen: true });

  await sleep(120);

  renders.addMark('enabled again');

  rerender({ isOffScreen: false });

  await sleep(200);

  expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- data: {id:1, name:User 1} -- payload: users||1
    status: refetching -- data: {id:1, name:User 1} -- payload: users||1
    status: success -- data: {id:1, name:User 1} -- payload: users||1

    >>> set disabled

    status: success -- data: {id:1, name:User 1} -- payload: users||1

    >>> enabled again

    status: success -- data: {id:1, name:User 1} -- payload: users||1
    "
  `);

  expect(env.serverMock.fetchsCount).toBe(1);
});

test.concurrent('useListQuery: disable then enable isOffScreen', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['products', 'users'] },
    emulateRTU: true,
    disableInitialDataInvalidation: true,
    lowPriorityThrottleMs: 10,
  });

  const renders = createRenderStore({
    filterKeys: ['status', 'items', 'payload'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.store.useListQuery(
        {
          tableId: 'users',
        },
        {
          isOffScreen,
          returnRefetchingStatus: true,
        },
      );

      renders.add(result);
    },
    { initialProps: { isOffScreen: false } },
  );

  await sleep(120);

  renders.addMark('set disabled');

  rerender({ isOffScreen: true });

  await sleep(120);

  renders.addMark('enabled again');

  rerender({ isOffScreen: false });

  await sleep(200);

  expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: refetching -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}

    >>> set disabled

    status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}

    >>> enabled again

    status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    "
  `);

  expect(env.serverMock.fetchsCount).toBe(1);
});

test.concurrent(
  'useMultipleItems should not trigger a mount refetch when some option changes',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users'] },
      lowPriorityThrottleMs: 10,
    });

    const filterKeys = ['status', 'data', 'payload', 'rrfs'];
    const renders1 = createRenderStore({ filterKeys });
    const renders2 = createRenderStore({ filterKeys });

    const { rerender } = renderHook(
      ({ returnRefetchingStatus }: { returnRefetchingStatus: boolean }) => {
        const result = env.store.useMultipleItems(
          ['users||1', 'users||2'].map((payload) => ({
            payload,
            returnRefetchingStatus,
          })),
        );

        renders1.add({ ...result[0]!, rrfs: returnRefetchingStatus });
        renders2.add({ ...result[1]!, rrfs: returnRefetchingStatus });
      },
      { initialProps: { returnRefetchingStatus: false } },
    );

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(2);

    rerender({ returnRefetchingStatus: true });

    await sleep(200);

    expect(env.serverMock.fetchsCount).toBe(2);

    expect(renders1.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- data: {id:1, name:User 1} -- payload: users||1 -- rrfs: false
    status: success -- data: {id:1, name:User 1} -- payload: users||1 -- rrfs: true
    "
  `);
    expect(renders2.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- data: {id:2, name:User 2} -- payload: users||2 -- rrfs: false
    status: success -- data: {id:2, name:User 2} -- payload: users||2 -- rrfs: true
    "
  `);
  },
);

test.concurrent(
  'useMultipleItems should not trigger a mount refetch for unchanged items',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users'] },
      lowPriorityThrottleMs: 10,
    });

    const renders = createRenderStore({
      filterKeys: ['i', 'status', 'data', 'payload'],
    });

    const { rerender } = renderHook(
      ({ items }: { items: string[] }) => {
        const result = env.store.useMultipleItems(
          items.map((payload) => ({ payload })),
        );

        renders.add(result);
      },
      { initialProps: { items: ['users||1', 'users||2'] } },
    );

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(2);

    renders.addMark('add item');
    rerender({ items: ['users||1', 'users||2', 'users||3'] });

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(3);

    renders.addMark('remove item');
    rerender({ items: ['users||2', 'users||3'] });

    await sleep(200);

    expect(env.serverMock.fetchsCount).toBe(3);

    renders.addMark('add removed item back');

    env.serverMock.produceData((draft) => {
      draft.users![0]!.name = 'changed';
    });

    rerender({ items: ['users||2', 'users||3', 'users||1'] });

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(4);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    i: 1 -- status: success -- data: {id:1, name:User 1} -- payload: users||1
    i: 2 -- status: success -- data: {id:2, name:User 2} -- payload: users||2

    >>> add item

    i: 1 -- status: success -- data: {id:1, name:User 1} -- payload: users||1
    i: 2 -- status: success -- data: {id:2, name:User 2} -- payload: users||2
    i: 3 -- status: success -- data: {id:3, name:User 3} -- payload: users||3

    >>> remove item

    i: 1 -- status: success -- data: {id:2, name:User 2} -- payload: users||2
    i: 2 -- status: success -- data: {id:3, name:User 3} -- payload: users||3

    >>> add removed item back

    i: 1 -- status: success -- data: {id:2, name:User 2} -- payload: users||2
    i: 2 -- status: success -- data: {id:3, name:User 3} -- payload: users||3
    i: 3 -- status: success -- data: {id:1, name:User 1} -- payload: users||1
    i: 1 -- status: success -- data: {id:2, name:User 2} -- payload: users||2
    i: 2 -- status: success -- data: {id:3, name:User 3} -- payload: users||3
    i: 3 -- status: success -- data: {id:1, name:changed} -- payload: users||1
    "
  `);
  },
);

test.concurrent(
  'useMultipleListQueries should not trigger a mount refetch when some option changes',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users'] },
      lowPriorityThrottleMs: 10,
    });

    const filterKeys = ['i', 'status', 'items', 'payload', 'rrfs'];

    const renders = createRenderStore({ filterKeys });

    const { rerender } = renderHook(
      ({ returnRefetchingStatus }: { returnRefetchingStatus: boolean }) => {
        const result = env.store.useMultipleListQueries(
          [{ tableId: 'users' }, { tableId: 'products' }].map((payload) => ({
            payload,
            returnRefetchingStatus,
          })),
        );

        renders.add(
          result.map((r) => ({ ...r, rrfs: returnRefetchingStatus })),
        );
      },
      { initialProps: { returnRefetchingStatus: false } },
    );

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(2);

    rerender({ returnRefetchingStatus: true });

    await sleep(200);

    expect(env.serverMock.fetchsCount).toBe(2);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users} -- rrfs: false
    i: 2 -- status: success -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products} -- rrfs: false
    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users} -- rrfs: true
    i: 2 -- status: success -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products} -- rrfs: true
    "
  `);
  },
);

test.concurrent(
  'useMultipleListQueries should not trigger a mount refetch for unchanged items',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['products', 'users', 'orders'] },
      lowPriorityThrottleMs: 10,
    });

    const renders = createRenderStore({
      filterKeys: ['i', 'status', 'items', 'payload'],
    });

    const { rerender } = renderHook(
      ({ items }: { items: string[] }) => {
        const result = env.store.useMultipleListQueries(
          items.map((payload) => ({
            payload: { tableId: payload },
          })),
        );

        renders.add(result);
      },
      { initialProps: { items: ['users', 'products'] } },
    );

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(2);

    renders.addMark('add item');
    rerender({ items: ['users', 'products', 'orders'] });

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(3);

    renders.addMark('remove item');
    rerender({ items: ['users', 'orders'] });

    await sleep(200);

    expect(env.serverMock.fetchsCount).toBe(3);

    renders.addMark('add removed item back');

    env.serverMock.produceData((draft) => {
      draft.products![0]!.name = 'changed';
    });

    rerender({ items: ['users', 'orders', 'products'] });

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(4);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    i: 2 -- status: success -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products}

    >>> add item

    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    i: 2 -- status: success -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products}
    i: 3 -- status: success -- items: [{id:1, name:Order 1}, ...(49 more)] -- payload: {tableId:orders}

    >>> remove item

    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    i: 2 -- status: success -- items: [{id:1, name:Order 1}, ...(49 more)] -- payload: {tableId:orders}

    >>> add removed item back

    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    i: 2 -- status: success -- items: [{id:1, name:Order 1}, ...(49 more)] -- payload: {tableId:orders}
    i: 3 -- status: success -- items: [{id:1, name:Product 1}, ...(49 more)] -- payload: {tableId:products}
    i: 1 -- status: success -- items: [{id:1, name:User 1}, ...(4 more)] -- payload: {tableId:users}
    i: 2 -- status: success -- items: [{id:1, name:Order 1}, ...(49 more)] -- payload: {tableId:orders}
    i: 3 -- status: success -- items: [{id:1, name:changed}, ...(49 more)] -- payload: {tableId:products}
    "
  `);
  },
);

test.concurrent.only(
  'Selected value should update when selectorUsesExternalDeps is true',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    const renders = createRenderStore();

    const { rerender } = renderHook(
      ({
        externalDep,
        selectorUsesExternalDeps,
      }: {
        externalDep: string;
        selectorUsesExternalDeps: boolean;
      }) => {
        const selector = useCallback(
          (data: Tables[string][number] | null) => {
            return `${data?.id}/${externalDep}`;
          },
          [externalDep],
        );

        const result = env.store.useItem('users||1', {
          selector,
          selectorUsesExternalDeps,
        });

        const queryResult = env.store.useListQuery(
          { tableId: 'users' },
          {
            itemSelector: selector,
            selectorUsesExternalDeps,
          },
        );

        renders.add({
          useItem: pick(result, ['status', 'data', 'payload']),
          useListQuery: pick(queryResult, ['status', 'items', 'payload']),
        });
      },
      { initialProps: { externalDep: 'ok', selectorUsesExternalDeps: false } },
    );

    await env.serverMock.waitFetchIdle();

    expect(env.serverMock.fetchsCount).toBe(2);

    renders.addMark('change external dep (selectorUsesExternalDeps: false)');
    rerender({ externalDep: 'changed', selectorUsesExternalDeps: false });

    await sleep(200);

    renders.addMark('change external dep');
    rerender({ externalDep: 'changed', selectorUsesExternalDeps: true });

    await sleep(200);

    expect(env.serverMock.fetchsCount).toBe(2);

    renders.addMark('change external dep again');
    rerender({ externalDep: 'changed again', selectorUsesExternalDeps: true });

    expect(env.serverMock.fetchsCount).toBe(2);

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      useItem: {status:success, data:1/ok, payload:users||1} -- useListQuery: {status:success, items:[1/ok, 2/ok, 3/ok, 4/ok, 5/ok], payload:{tableId:users}}

      >>> change external dep (selectorUsesExternalDeps: false)

      useItem: {status:success, data:1/ok, payload:users||1} -- useListQuery: {status:success, items:[1/ok, 2/ok, 3/ok, 4/ok, 5/ok], payload:{tableId:users}}

      >>> change external dep

      useItem: {status:success, data:1/changed, payload:users||1} -- useListQuery: {status:success, items:[1/changed, 2/changed, 3/changed, 4/changed, 5/changed], payload:{tableId:users}}

      >>> change external dep again

      useItem: {status:success, data:1/changed again, payload:users||1} -- useListQuery: {status:success, items:[1/changed again, 2/changed again, 3/changed again, 4/changed again, 5/changed again], payload:{tableId:users}}
      "
    `);
  },
);
