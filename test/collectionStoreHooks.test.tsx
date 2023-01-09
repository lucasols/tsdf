import { act, cleanup, render, renderHook } from '@testing-library/react';
import { Store } from 't-state';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pick } from './utils/objectUtils';
import { sleep } from './utils/sleep';
import {
  createDefaultCollectionStore,
  createDefaultDocumentStore,
  createRenderStore,
  createValueStore,
} from './utils/storeUtils';

const defaultTodo = { title: 'todo', completed: false };

describe('useMultipleItems', () => {
  afterAll(() => {
    cleanup();
  });

  const { serverMock, store: collectionStore } = createDefaultCollectionStore({
    randomTimeout: true,
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
  });
  const renders1 = createRenderStore();
  const renders2 = createRenderStore();

  const itemsToUse = ['1', '2'];

  const state = new Store({
    state: { itemsToUse },
  });

  renderHook(() => {
    const selectionResult = collectionStore.useMultipleItems(
      state.useKey('itemsToUse'),
      { returnRefetchingStatus: true },
    );

    const [item1, item2] = selectionResult;

    renders1.add({
      status: item1?.status,
      payload: item1?.payload,
      data: item1?.data,
    });
    renders2.add({
      status: item2?.status,
      payload: item2?.payload,
      data: item2?.data,
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

      renders3.add(pick(selectionResult[0], ['status', 'payload', 'data']));
    });

    renders1.reset();
    renders2.reset();

    serverMock.setFetchDuration((param) => {
      return param === '1' ? 20 : 40;
    });

    serverMock.mutateData({
      '1': { title: 'todo 1', completed: true },
      '2': { title: 'todo 2', completed: true },
    });

    collectionStore.invalidateData(() => true);

    await serverMock.waitFetchIdle();

    serverMock.undoTimeoutChange();

    unmount();
  });

  test('do not fetch more than expected with multiple components connected to the same items', () => {
    expect(serverMock.numOfFetchs).toBe(initialFetchCount + 2);
  });

  test('refetch data after invalidations', () => {
    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: refetching -- payload: 1 -- data: {title:todo, completed:false}
      status: success -- payload: 1 -- data: {title:todo 1, completed:true}
      "
    `);
    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: refetching -- payload: 2 -- data: {title:todo, completed:false}
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
      state.setKey('itemsToUse', ['1', '3']);
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

describe('useMultipleItems isolated tests', () => {
  test('invalidate 1 item', async () => {
    const { store: collectionStore, serverMock } = createDefaultCollectionStore(
      {
        initialServerData: serverInitialData,
        useLoadedSnapshot: true,
      },
    );

    const renders1 = createRenderStore();
    const renders2 = createRenderStore();

    renderHook(() => {
      const [item1, item2] = collectionStore.useMultipleItems(['1', '2'], {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders1.add(pick(item1, ['status', 'payload', 'data']));
      renders2.add(pick(item2, ['status', 'payload', 'data']));
    });

    act(() => {
      serverMock.mutateData({ '1': { title: 'todo', completed: true } });
      collectionStore.invalidateData('1');
    });

    await serverMock.waitFetchIdle();

    expect(renders1.renderCount()).toBeGreaterThan(0);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 1 -- data: {title:todo, completed:false}
      status: refetching -- payload: 1 -- data: {title:todo, completed:false}
      status: success -- payload: 1 -- data: {title:todo, completed:true}
      "
    `);
    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 2 -- data: {title:todo, completed:false}
      "
    `);
  });
});

describe('useItem', async () => {
  afterAll(() => {
    cleanup();
  });

  const { serverMock, store: collectionStore } = createDefaultCollectionStore({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
  });

  const renders1 = createRenderStore();

  const itemFetchParams = createValueStore<string | undefined | false>(false);

  beforeAll(() => {
    renderHook(() => {
      const fetchParams = itemFetchParams.useValue();

      const selectionResult = collectionStore.useItem(fetchParams);

      renders1.add(pick(selectionResult, ['status', 'payload', 'data']));
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
      ---
      status: loading -- payload: 1 -- data: null
      status: success -- payload: 1 -- data: {title:todo, completed:false}
      "
    `);
  });

  test('disableRefetchOnMount', async () => {
    // FIXLATER: fix this test
    const numOfFetchs = serverMock.numOfFetchsFromHere();

    const comp2Renders = createRenderStore();
    const compRenders = createRenderStore();

    const Comp2 = () => {
      const data = collectionStore.useItem('2', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      comp2Renders.add({ status: data.status, data: data.data });

      return <div />;
    };

    const mountComp2 = createValueStore(false);

    const Comp = () => {
      const data = collectionStore.useItem('2');

      compRenders.add({ status: data.status, data: data.data });

      return <>{mountComp2.useValue() && <Comp2 />}</>;
    };

    render(<Comp />);

    // wait the throttle time
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

      renders.add(pick(selectionResult, ['status', 'payload', 'data']));
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

const serverInitialData = { '1': defaultTodo, '2': defaultTodo };

describe('useItem isolated tests', () => {
  test.only('use deleted item', async () => {
    const { serverMock, store, shouldNotSkip } = createDefaultCollectionStore({
      initialServerData: serverInitialData,
      useLoadedSnapshot: true,
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = store.useItem('2', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add(pick(selectionResult, ['status', 'payload', 'data']));
    });

    act(() => {
      store.deleteItemState('2');
      serverMock.mutateData({ '2': null });
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 2 -- data: {title:todo, completed:false}
      status: deleted -- payload: 2 -- data: null
      "
    `);

    shouldNotSkip(store.scheduleFetch('highPriority', '2'));

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- payload: 2 -- data: {title:todo, completed:false}
      status: deleted -- payload: 2 -- data: null
      ---
      status: loading -- payload: 2 -- data: null
      status: error -- payload: 2 -- data: null
      "
    `);
  });

  test('use ensureIsLoaded prop', async () => {
    const { store: collectionStore, serverMock } = createDefaultCollectionStore(
      {
        initialServerData: serverInitialData,
        useLoadedSnapshot: true,
      },
    );

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = collectionStore.useItem('1', {
        ensureIsLoaded: true,
      });

      renders.add(
        pick(selectionResult, ['status', 'payload', 'isLoading', 'data'], {
          isLoading: 'L',
        }),
      );
    });

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: loading -- payload: 1 -- L: true -- data: {title:todo, completed:false}
      status: success -- payload: 1 -- L: false -- data: {title:todo, completed:false}
      "
    `);
  });

  test('ignore refetchingStatus by default', async () => {
    const { store: collectionStore, serverMock } = createDefaultCollectionStore(
      {
        initialServerData: serverInitialData,
        useLoadedSnapshot: true,
      },
    );

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = collectionStore.useItem('1', {
        ensureIsLoaded: true,
      });

      renders.add(
        pick(selectionResult, ['status', 'isLoading', 'data'], {
          isLoading: 'L',
        }),
      );
    });

    expect(collectionStore.scheduleFetch('highPriority', '1')).toBe('started');

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- isLoading: false -- data: {title:todo, completed:false}
      "
    `);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const { store: collectionStore, serverMock } = createDefaultCollectionStore(
      {
        initialServerData: serverInitialData,
        useLoadedSnapshot: true,
      },
    );

    const renders = createRenderStore();

    const loadItem = createValueStore<string | false>(false);

    renderHook(() => {
      const selectionResult = collectionStore.useItem(loadItem.useValue(), {
        ensureIsLoaded: true,
      });

      renders.add(
        pick(selectionResult, ['status', 'payload', 'isLoading', 'data'], {
          isLoading: 'L',
        }),
      );
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- L: false -- data: null
      "
    `);

    // enable loading
    loadItem.set('1');

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- payload: undefined -- L: false -- data: null
      ---
      status: loading -- payload: 1 -- L: true -- data: {title:todo, completed:false}
      status: success -- payload: 1 -- L: false -- data: {title:todo, completed:false}
      "
    `);
  });
});
