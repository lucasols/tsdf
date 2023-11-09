import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  Tables,
  createDefaultListQueryStore,
} from './utils/createDefaultListQueryStore';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { createRenderStore } from './utils/storeUtils';

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
    status: success -- data: {title:todo, completed:false} -- payload: 1
    status: refetching -- data: {title:todo, completed:false} -- payload: 1
    status: success -- data: {title:todo, completed:false} -- payload: 1

    >>> set disabled

    status: success -- data: {title:todo, completed:false} -- payload: 1

    >>> enabled again

    status: success -- data: {title:todo, completed:false} -- payload: 1
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
    status: success -- data: {title:todo, completed:false} -- payload: 1
    status: refetching -- data: {title:todo, completed:false} -- payload: 1
    status: success -- data: {title:todo, completed:false} -- payload: 1

    >>> set disabled

    status: success -- data: {title:todo, completed:false} -- payload: 1

    >>> enabled again

    status: success -- data: {title:todo, completed:false} -- payload: 1
    "
  `);

  expect(env.serverMock.fetchsCount).toBe(1);
});

test('useMultipleItems should not trigger a mount refetch when some option changes', async () => {
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

  expect(renders1.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- data: {title:todo, completed:false} -- payload: 1 -- rrfs: false
    status: success -- data: {title:todo, completed:false} -- payload: 1 -- rrfs: true
    "
  `);
  expect(renders2.snapshot).toMatchInlineSnapshot(`
    "
    status: success -- data: {title:todo, completed:false} -- payload: 2 -- rrfs: false
    status: success -- data: {title:todo, completed:false} -- payload: 2 -- rrfs: true
    "
  `);
});

test('useMultipleItems should not trigger a mount refetch for unchanged items', async () => {
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

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    i: 1 -- status: success -- data: {title:todo, completed:false} -- payload: 1
    i: 2 -- status: success -- data: {title:todo, completed:false} -- payload: 2

    >>> add item

    i: 1 -- status: success -- data: {title:todo, completed:false} -- payload: 1
    i: 2 -- status: success -- data: {title:todo, completed:false} -- payload: 2
    i: 3 -- status: success -- data: {title:todo, completed:false} -- payload: 3

    >>> remove item

    i: 1 -- status: success -- data: {title:todo, completed:false} -- payload: 2
    i: 2 -- status: success -- data: {title:todo, completed:false} -- payload: 3

    >>> add removed item back

    i: 1 -- status: success -- data: {title:todo, completed:false} -- payload: 2
    i: 2 -- status: success -- data: {title:todo, completed:false} -- payload: 3
    i: 3 -- status: success -- data: {title:todo, completed:false} -- payload: 1
    i: 1 -- status: success -- data: {title:todo, completed:false} -- payload: 2
    i: 2 -- status: success -- data: {title:todo, completed:false} -- payload: 3
    i: 3 -- status: success -- data: {title:changed, completed:false} -- payload: 1
    "
  `);
});

test('useMultipleListQueries should not trigger a mount refetch when some option changes', async () => {
  throw new Error('not implemented');
});

test('useMultipleListQueries should not trigger a mount refetch for unchanged items', async () => {
  throw new Error('not implemented');
});
