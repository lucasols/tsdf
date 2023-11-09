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
      disableInitialDataInvalidation: true,
      emulateRTU: true,
    });

    const renders = createRenderStore({
      rejectKeys: ['queryMetadata'],
    });

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

test('disable then enable isOffScreen', async () => {
  const env = createTestEnv({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
    useLoadedSnapshot: true,
    emulateRTU: true,
    disableInitialDataInvalidation: true,
    lowPriorityThrottleMs: 10,
  });

  const renders = createRenderStore({
    filterKeys: ['status', 'data', 'payload'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.store.useItem('1', {
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

  expect(renders.snapshot).toMatchInlineSnapshot(`
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
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
    useLoadedSnapshot: true,
    lowPriorityThrottleMs: 10,
  });

  const filterKeys = ['status', 'data', 'payload', 'rrfs'];
  const renders1 = createRenderStore({ filterKeys });
  const renders2 = createRenderStore({ filterKeys });

  const { rerender } = renderHook(
    ({ returnRefetchingStatus }: { returnRefetchingStatus: boolean }) => {
      const result = env.store.useMultipleItems(
        ['1', '2'].map((payload) => ({
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
    initialServerData: {
      '1': defaultTodo,
      '2': defaultTodo,
      '3': defaultTodo,
      '4': defaultTodo,
      '5': defaultTodo,
    },
    useLoadedSnapshot: true,
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
    { initialProps: { items: ['1', '2'] } },
  );

  await env.serverMock.waitFetchIdle();

  expect(env.serverMock.fetchsCount).toBe(2);

  renders.addMark('add item');
  rerender({ items: ['1', '2', '3'] });

  await env.serverMock.waitFetchIdle();

  expect(env.serverMock.fetchsCount).toBe(3);

  renders.addMark('remove item');
  rerender({ items: ['2', '3'] });

  await sleep(200);

  expect(env.serverMock.fetchsCount).toBe(3);

  renders.addMark('add removed item back');

  env.serverMock.produceData((draft) => {
    draft['1']!.title = 'changed';
  });

  rerender({ items: ['2', '3', '1'] });

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
