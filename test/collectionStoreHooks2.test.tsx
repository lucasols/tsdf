import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { sleep } from './utils/sleep';
import {
  createDefaultCollectionStore,
  createRenderStore,
} from './utils/storeUtils';

const createTestEnv = createDefaultCollectionStore;

const defaultTodo = { title: 'todo', completed: false };

test.concurrent(
  'isOffScreen should keep the selected data and not be affected by invalidation',
  async () => {
    const env = createTestEnv({
      initialServerData: { '1': defaultTodo, '2': defaultTodo },
      useLoadedSnapshot: true,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
    });

    const renders = createRenderStore();

    const { rerender } = renderHook(
      ({ isOffScreen }: { isOffScreen: boolean }) => {
        const result = env.store.useItem('1', {
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
    env.serverMock.mutateData({ 1: { title: '✅', completed: true } });

    await sleep(200);

    renders.addMark('set disabled');
    rerender({ isOffScreen: true });

    await sleep(100);

    renders.addMark('ignored update (❌)');
    env.serverMock.mutateData({ 1: { title: '❌', completed: true } });

    await sleep(200);

    renders.addMark('enabled again');
    rerender({ isOffScreen: false });

    await sleep(200);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      itemStateKey: 1 -- status: success -- data: {title:todo, completed:false} -- error: null -- isLoading: false -- payload: 1

      >>> first update (✅)

      itemStateKey: 1 -- status: refetching -- data: {title:todo, completed:false} -- error: null -- isLoading: false -- payload: 1
      itemStateKey: 1 -- status: success -- data: {title:✅, completed:true} -- error: null -- isLoading: false -- payload: 1

      >>> set disabled

      itemStateKey: 1 -- status: success -- data: {title:✅, completed:true} -- error: null -- isLoading: false -- payload: 1

      >>> ignored update (❌)

      >>> enabled again

      itemStateKey: 1 -- status: success -- data: {title:✅, completed:true} -- error: null -- isLoading: false -- payload: 1
      itemStateKey: 1 -- status: refetching -- data: {title:✅, completed:true} -- error: null -- isLoading: false -- payload: 1
      itemStateKey: 1 -- status: success -- data: {title:❌, completed:true} -- error: null -- isLoading: false -- payload: 1
      "
    `);
  },
);
