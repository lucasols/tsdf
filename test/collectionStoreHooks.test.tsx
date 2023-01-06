import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { Store } from 't-state';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MultipleItemsQuery } from '../src/collectionStore';
import { sleep } from './utils/sleep';
import {
  createDefaultCollectionStore,
  createRenderStore,
  createStore,
} from './utils/storeUtils';

const defaultTodo = { title: 'todo', completed: false };

describe('useMultipleItems', () => {
  afterAll(() => {
    cleanup();
  });

  const { serverMock, collectionStore } = createDefaultCollectionStore({
    randomTimeout: true,
    initialData: { '1': defaultTodo, '2': defaultTodo },
  });
  const renders1 = createRenderStore();
  const renders2 = createRenderStore();

  const itemsToUse: MultipleItemsQuery<string, string>[] = [
    { fetchParams: '1', queryData: '1' },
    { fetchParams: '2', queryData: '2' },
  ];

  const state = new Store({
    state: { itemsToUse },
  });

  renderHook(() => {
    const selectionResult = collectionStore.useMultipleItems(
      state.useKey('itemsToUse'),
    );

    const [item1, item2] = selectionResult;

    renders1.add({
      status: item1?.result.status,
      payload: item1?.result.payload,
      data: item1?.result.data,
    });
    renders2.add({
      status: item2?.result.status,
      payload: item2?.result.payload,
      data: item2?.result.data,
    });
  });

  test('load the items', async () => {
    await sleep(120);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: loading -- payload: 1 -- data: null
      status: success -- payload: 1 -- data: {title:todo, completed:false}
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: loading -- payload: 2 -- data: null
      status: success -- payload: 2 -- data: {title:todo, completed:false}
      "
    `);

    expect(serverMock.numOfFetchs).toBe(2);
  });

  test('invalidate 1 item', async () => {
    renders1.reset();
    renders2.reset();

    act(() => {
      serverMock.mutateData({ '1': { title: 'todo', completed: true } });
      collectionStore.invalidateData('1');
    });

    await sleep(120);

    expect(renders1.renderCount()).toBeGreaterThan(0);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: {title:todo, completed:true}
      "
    `);
    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 2 -- data: {title:todo, completed:false}
      "
    `);
  });

  const renders3 = createRenderStore();

  let initialFetchCount: number;

  test('invalidate all items', async () => {
    initialFetchCount = serverMock.numOfFetchs;

    // mount a new hook to check if there are more fetchs than expected
    const { unmount } = renderHook(() => {
      const selectionResult = collectionStore.useMultipleItems(
        state.useKey('itemsToUse'),
        {
          selector(data) {
            return data?.title;
          },
        },
      );

      renders3.add({
        status: selectionResult[0]?.result.status,
        payload: selectionResult[0]?.result.payload,
        data: selectionResult[0]?.result.data,
      });
    });

    renders1.reset();
    renders2.reset();

    act(() => {
      serverMock.setTimeout((param) => {
        return param === '1' ? 20 : 40;
      });

      serverMock.mutateData({
        '1': { title: 'todo 1', completed: true },
        '2': { title: 'todo 2', completed: true },
      });

      collectionStore.invalidateData(() => true);
    });

    await sleep(120);

    serverMock.undoTimeoutChange();

    unmount();
  });

  test('do not fetch more than expected with multiple components connected to the same items', () => {
    expect(serverMock.numOfFetchs).toBe(initialFetchCount + 2);
  });

  test('refetch data after invalidations', () => {
    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: {title:todo 1, completed:true}
      "
    `);
    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 2 -- data: {title:todo, completed:false}
      status: success -- payload: 2 -- data: {title:todo 2, completed:true}
      "
    `);
  });

  test('data selector', () => {
    expect(renders3.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: todo
      status: success -- payload: 1 -- data: todo 1
      "
    `);
  });

  test('rerender when item payload changes', async () => {
    renders1.reset();
    renders2.reset();

    act(() => {
      state.setKey('itemsToUse', [
        { fetchParams: '1', queryData: '1' },
        { fetchParams: '3', queryData: '3' },
      ]);
    });

    await sleep(120);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: {title:todo 1, completed:true}
      "
    `);
    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: loading -- payload: 3 -- data: null
      status: error -- payload: 3 -- data: null
      "
    `);
  });
});

describe('useItem', async () => {
  afterAll(() => {
    cleanup();
  });

  const { serverMock, collectionStore } = createDefaultCollectionStore({
    initialData: { '1': defaultTodo, '2': defaultTodo },
  });

  const renders1 = createRenderStore();

  const itemFetchParams = createStore<string | undefined | false>(false);

  beforeAll(() => {
    renderHook(() => {
      const fetchParams = itemFetchParams.useValue();

      const selectionResult = collectionStore.useItem(fetchParams);

      renders1.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        data: selectionResult.data,
      });
    });
  });

  test('disable the initial fetch', async () => {
    await sleep(120);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- data: null
      "
    `);

    expect(serverMock.numOfFetchs).toBe(0);
  });

  test('enable the initial fetch', async () => {
    act(() => {
      itemFetchParams.set('1');
    });

    await sleep(120);

    expect(serverMock.numOfFetchs).toBe(1);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- data: null
      status: loading -- payload: 1 -- data: null
      status: success -- payload: 1 -- data: {title:todo, completed:false}
      "
    `);
  });

  test('disableRefetchOnMount', async () => {
    const numOfFetchs = serverMock.numOfFetchsFromHere();

    const comp2Renders = createRenderStore();
    const compRenders = createRenderStore();

    const Comp2 = () => {
      const data = collectionStore.useItem('2', {
        disableRefetchOnMount: true,
      });

      comp2Renders.add({ status: data.status, data: data.data });

      return <div />;
    };

    const mountComp2 = createStore(false);

    const Comp = () => {
      const data = collectionStore.useItem('2', {
        disableRefetchOnMount: true,
      });

      compRenders.add({ status: data.status, data: data.data });

      return <>{mountComp2.useValue() && <Comp2 />}</>;
    };

    render(<Comp />);

    await sleep(200);

    expect(compRenders.snapshot).toMatchInlineSnapshot(`
      "
      status: loading -- data: null
      status: success -- data: {title:todo, completed:false}
      "
    `);

    expect(numOfFetchs()).toBe(1);

    mountComp2.set(true);

    await sleep(200);

    expect(comp2Renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- data: {title:todo, completed:false}
      "
    `);

    expect(numOfFetchs()).toBe(1);
  });

  test('action with optmistic update and revalidation', async () => {
    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = collectionStore.useItem(
        itemFetchParams.useValue(),
      );

      renders.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        data: selectionResult.data,
      });
    });

    async function actionWithOptimisticUpdateAndRevalidation(
      itemId: string,
      newText: string,
    ) {
      const endMutation = collectionStore.startMutation(itemId);

      collectionStore.updateItemState('1', (draftData) => {
        draftData.title = newText;
      });

      try {
        const result = await serverMock.emulateMutation({
          '1': { title: newText, completed: false },
        });

        endMutation();

        return result;
      } catch (e) {
        endMutation();

        return false;
      } finally {
        collectionStore.invalidateData(itemId);
      }
    }

    act(() => {
      actionWithOptimisticUpdateAndRevalidation('1', 'was updated');
    });

    await sleep(150);

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: {title:todo, completed:false}
      status: success -- payload: 1 -- data: {title:was updated, completed:false}
      "
    `);
  });
});
