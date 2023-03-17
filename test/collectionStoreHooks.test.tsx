import { act, cleanup, render, renderHook } from '@testing-library/react';
import { Store } from 't-state';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pick } from './utils/objectUtils';
import { sleep } from './utils/sleep';
import {
  createDefaultCollectionStore,
  createRenderStore,
  createValueStore,
  shouldNotSkip,
} from './utils/storeUtils';

const createTestEnv = createDefaultCollectionStore;

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

    expect(serverMock.fetchsCount).toBe(2);
  });

  const renders3 = createRenderStore();

  let initialFetchCount: number;

  test('invalidate all items setup', async () => {
    initialFetchCount = serverMock.fetchsCount;

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

    collectionStore.invalidateItem(() => true);

    await serverMock.waitFetchIdle();

    serverMock.undoTimeoutChange();

    expect(serverMock.fetchsCount).toBe(initialFetchCount + 2);

    unmount();
  });

  test('do not fetch more than expected with multiple components connected to the same items', () => {
    expect(serverMock.fetchsCount).toBe(initialFetchCount + 2);
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
      collectionStore.invalidateItem('1');
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

describe('useItem', () => {
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

    expect(serverMock.fetchsCount).toBe(0);
  });

  test('enable the initial fetch', async () => {
    act(() => {
      itemFetchParams.set('1');
    });

    await sleep(120);

    expect(serverMock.fetchsCount).toBe(1);

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
        collectionStore.invalidateItem(itemId);
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
  test('use deleted item', async () => {
    const { serverMock, store } = createDefaultCollectionStore({
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

    store.deleteItemState('2');
    serverMock.mutateData({ '2': null });

    await renders.waitNextRender();

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
    const { store, serverMock } = createDefaultCollectionStore({
      initialServerData: serverInitialData,
      useLoadedSnapshot: true,
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = store.useItem('1');

      renders.add(pick(selectionResult, ['status', 'isLoading', 'data']));
    });

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

test.concurrent('RTU update works', async () => {
  const env = createTestEnv({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
    useLoadedSnapshot: true,
    emulateRTU: true,
    dynamicRTUThrottleMs() {
      return 300;
    },
  });

  const renders = createRenderStore();

  env.serverMock.produceData((draft) => {
    draft['1']!.title = 'RTU Update';
  });

  await sleep(100);

  expect(env.store.store.state).toMatchSnapshotString(`
    {
      "1": {
        "data": {
          "completed": false,
          "title": "todo",
        },
        "error": null,
        "payload": "1",
        "refetchOnMount": "realtimeUpdate",
        "status": "success",
        "wasLoaded": true,
      },
      "2": {
        "data": {
          "completed": false,
          "title": "todo",
        },
        "error": null,
        "payload": "2",
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      },
    }
  `);

  renderHook(() => {
    const { data, status } = env.store.useItem('1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data });
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  env.serverMock.produceData((draft) => {
    draft['1']!.title = 'Throttle update';
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(
    env.serverMock.fetchs[1]!.time.start - env.serverMock.fetchs[0]!.time.end,
  ).toBeGreaterThanOrEqual(300);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- data: {title:todo, completed:false}
    status: refetching -- data: {title:todo, completed:false}
    status: success -- data: {title:RTU Update, completed:false}
    status: refetching -- data: {title:RTU Update, completed:false}
    status: success -- data: {title:Throttle update, completed:false}
    "
  `);
});

test.concurrent('fetch error then mount component without error', async () => {
  const env = createTestEnv({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
  });

  const renders = createRenderStore();

  env.serverMock.setFetchError('error');

  env.store.scheduleFetch('highPriority', '1');

  await env.serverMock.waitFetchIdle(200);

  expect(env.store.store.state).toMatchSnapshotString(`
      {
        "1": {
          "data": null,
          "error": {
            "message": "error",
          },
          "payload": "1",
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": false,
        },
      }
    `);

  env.serverMock.setFetchError(null);

  renderHook(() => {
    const { data, status } = env.store.useItem('1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data });
  });

  await env.serverMock.waitFetchIdle();

  expect(renders.snapshot).toMatchSnapshotString(`
      "
      status: error -- data: null
      status: loading -- data: null
      status: success -- data: {title:todo, completed:false}
      "
    `);
});

test.concurrent('initial data is invalidated on first load', async () => {
  const env = createTestEnv({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
    useLoadedSnapshot: true,
    disableInitialDataInvalidation: false,
  });

  env.serverMock.produceData((draft) => {
    draft['1']!.title = 'Update';
  });

  const renders = createRenderStore();

  renderHook(() => {
    const { data, status } = env.store.useItem('1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data });
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.snapshot).toMatchSnapshotString(`
    "
    status: success -- data: {title:todo, completed:false}
    status: refetching -- data: {title:todo, completed:false}
    status: success -- data: {title:Update, completed:false}
    "
  `);
});

test.concurrent(
  'emulate realidateOnWindowFocus behaviour for item queries',
  async () => {
    const env = createTestEnv({
      initialServerData: { '1': defaultTodo, '2': defaultTodo },
      useLoadedSnapshot: true,
      emulateRTU: true,
      disableInitialDataInvalidation: false,
    });

    function emulateWindowFocus() {
      env.store.invalidateItem(() => true, 'lowPriority');
    }

    function getItemState(itemId = '1') {
      return pick(
        env.store.getItemState(itemId) ?? undefined,
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
      env.store.useItem('1');
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
    expect(getItemState('2')).toEqual({
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
