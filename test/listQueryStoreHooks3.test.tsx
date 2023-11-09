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
