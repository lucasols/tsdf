import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { evtmitter } from 'evtmitter';
import { useEffect, useState } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(0);
});

afterEach(() => {
    cleanup();
  vi.runOnlyPendingTimers();
});

type Todo = {
  title: string;
  completed: boolean;
};

const defaultTodo: Todo = { title: 'todo', completed: false };

describe('useMultipleItems', () => {
  test('load the items', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { forceInitialDataInvalidation: true },
    );

    const renders1 = createLoggerStore();
    const renders2 = createLoggerStore();

    renderHook(
      ({ items }) => {
        const selectionResult = env.apiStore.useMultipleItems(
          items.map((item) => ({
        payload: item,
      })),
      {
        returnRefetchingStatus: true,
      },
    );

    const [item1, item2] = selectionResult;

    renders1.add({
      status: item1?.status,
      payload: item1?.payload,
          data: item1?.data?.value ?? null,
    });
    renders2.add({
      status: item2?.status,
      payload: item2?.payload,
          data: item2?.data?.value ?? null,
    });
      },
      { initialProps: { items: ['1', '2'] } },
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 1 ⋅ data: null
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 2 ⋅ data: null
      -> status: success ⋅ payload: 2 ⋅ data: {title:todo, completed:❌}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('invalidate all items', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { useLoadedSnapshot: true },
    );

    const renders1 = createLoggerStore();
    const renders2 = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useMultipleItems(
        ['1', '2'].map((item) => ({
          payload: item,
        })),
        {
          returnRefetchingStatus: true,
        },
      );

      const [item1, item2] = selectionResult;

      renders1.add({
        status: item1?.status,
        payload: item1?.payload,
        data: item1?.data?.value ?? null,
      });
      renders2.add({
        status: item2?.status,
        payload: item2?.payload,
        data: item2?.data?.value ?? null,
      });
    });

    expect(renders1.snapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      "
    `);

    renders1.reset();
    renders2.reset();

    act(() => {
      env.serverTable.setItem('1', { title: 'todo 1', completed: true });
      env.serverTable.setItem('2', { title: 'todo 2', completed: true });
      env.apiStore.invalidateItem(() => true);
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: refetching ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo 1, completed:✅}
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 2 ⋅ data: {title:todo, completed:❌}
      -> status: refetching ⋅ payload: 2 ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ payload: 2 ⋅ data: {title:todo 2, completed:✅}
      "
    `);
  });

  test('revalidation with multiple components do not trigger multiple fetches', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { useLoadedSnapshot: true },
    );

    for (let i = 0; i < 27; i += 1) {
      renderHook(() => env.apiStore.useMultipleItems([{ payload: '1' }]));
    }

    const renders = createLoggerStore();

    renderHook(() => {
      const [item] = env.apiStore.useMultipleItems([{ payload: '1' }]);
      renders.add({
        status: item?.status,
        data: item?.data?.value ?? null,
      });
    });

    act(() => {
      env.serverTable.setItem('1', {
        title: 'was invalidated',
        completed: true,
      });
      env.apiStore.invalidateItem('1');
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ data: {title:was invalidated, completed:✅}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('data selector', () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { useLoadedSnapshot: true },
    );

    const { result } = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        selector: (data) => data?.value.title,
      }),
    );

    expect(result.current[0]?.data).toBe('todo');
    expect(result.current[1]?.data).toBe('todo');
  });

  test('rerender when item payload changes', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': { title: 'todo 1', completed: true }, '2': defaultTodo },
      { useLoadedSnapshot: true },
    );

    const renders1 = createLoggerStore();
    const renders2 = createLoggerStore();

    const { rerender } = renderHook(
      ({ items }) => {
        const selectionResult = env.apiStore.useMultipleItems(
          items.map((item) => ({
            payload: item,
          })),
          {
            returnRefetchingStatus: true,
          },
        );

        const [item1, item2] = selectionResult;

        renders1.add({
          status: item1?.status,
          payload: item1?.payload,
          data: item1?.data?.value ?? null,
        });
        renders2.add({
          status: item2?.status,
          payload: item2?.payload,
          data: item2?.data?.value ?? null,
        });
      },
      { initialProps: { items: ['1', '2'] satisfies string[] } },
    );

    renders1.reset();
    renders2.reset();

    rerender({ items: ['1', '3'] });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo 1, completed:✅}
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 3 ⋅ data: null
      -> status: error ⋅ payload: 3 ⋅ data: null
      "
    `);
  });
});

describe('useMultipleItems isolated tests', () => {
  test('invalidate 1 item', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { useLoadedSnapshot: true },
    );

    const renders1 = createLoggerStore();
    const renders2 = createLoggerStore();

      renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
          ['1', '2'].map((item) => ({
            payload: item,
          })),
          {
            returnRefetchingStatus: true,
            disableRefetchOnMount: true,
          },
        );

      renders1.add({
        status: item1?.status,
        payload: item1?.payload,
        data: item1?.data?.value ?? null,
      });
      renders2.add({
        status: item2?.status,
        payload: item2?.payload,
        data: item2?.data?.value ?? null,
      });
      });

      act(() => {
      env.serverTable.setItem('1', { title: 'todo', completed: true });
      env.apiStore.invalidateItem('1');
      });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

      expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      -> status: refetching ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:✅}
      "
    `);

      expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 2 ⋅ data: {title:todo, completed:❌}
      "
    `);
  });

  test('disableRefetchOnMount does not disable the initial fetch', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { forceInitialDataInvalidation: true },
    );

    const renders1 = createLoggerStore();
    const renders2 = createLoggerStore();

    expect(env.apiStore.store.state).toMatchInlineSnapshot(`{}`);

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        ['1', '2'].map((item) => ({
          payload: item,
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        })),
      );

      renders1.add({
        status: item1?.status,
        payload: item1?.payload,
        data: item1?.data?.value ?? null,
      });
      renders2.add({
        status: item2?.status,
        payload: item2?.payload,
        data: item2?.data?.value ?? null,
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 1 ⋅ data: null
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 2 ⋅ data: null
      -> status: success ⋅ payload: 2 ⋅ data: {title:todo, completed:❌}
      "
    `);
  });

  test('with queryMetadata', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { forceInitialDataInvalidation: true },
    );

    const renders1 = createLoggerStore();
    const renders2 = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        ['1', '2'].map((item) => ({
          payload: item,
          queryMetadata: { md: `md-${item}` },
        })),
      );

      renders1.add({
        status: item1?.status,
        payload: item1?.payload,
        data: item1?.data?.value ?? null,
        queryMetadata: item1?.queryMetadata,
      });
      renders2.add({
        status: item2?.status,
        payload: item2?.payload,
        data: item2?.data?.value ?? null,
        queryMetadata: item2?.queryMetadata,
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 1 ⋅ data: null ⋅ queryMetadata: {md:md-1}
      ┌─
      ⋅ status: success
      ⋅ payload: 1
      ⋅ data: {title:todo, completed:❌}
      ⋅ queryMetadata: {md:md-1}
      └─
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
        "
      -> status: loading ⋅ payload: 2 ⋅ data: null ⋅ queryMetadata: {md:md-2}
      ┌─
      ⋅ status: success
      ⋅ payload: 2
      ⋅ data: {title:todo, completed:❌}
      ⋅ queryMetadata: {md:md-2}
      └─
        "
      `);
  });
});

describe('useItem', () => {
  test('disable the initial fetch', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { forceInitialDataInvalidation: true },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useItem(false);

      renders.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        data: selectionResult.data?.value ?? null,
      });
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ data: null
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('enable the fetch after initial disable', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { forceInitialDataInvalidation: true },
    );

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ fetchParam }: { fetchParam: string | undefined | false }) => {
        const selectionResult = env.apiStore.useItem(fetchParam);

        renders.add({
          status: selectionResult.status,
          payload: selectionResult.payload,
          data: selectionResult.data?.value ?? null,
        });
      },
      {
        initialProps: {
          fetchParam: false satisfies string | undefined | false,
        },
      },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 3);
    });

    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ data: null
      "
    `);

    rerender({ fetchParam: '1' });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ data: null
      ⋅⋅⋅
      -> status: loading ⋅ payload: 1 ⋅ data: null
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      "
    `);
  });

  test('disableRefetchOnMount', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { forceInitialDataInvalidation: true },
    );

    const comp2Renders = createLoggerStore();
    const compRenders = createLoggerStore();

    function Comp2() {
      const data = env.apiStore.useItem('2', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      comp2Renders.add({ status: data.status, data: data.data?.value ?? null });

      return <div />;
    }

    function Comp({ showComp2 }: { showComp2: boolean }) {
      const data = env.apiStore.useItem('2');

      compRenders.add({ status: data.status, data: data.data?.value ?? null });

      return <>{showComp2 && <Comp2 />}</>;
    }

    const { rerender } = render(<Comp showComp2={false} />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(compRenders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {title:todo, completed:❌}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    rerender(<Comp showComp2 />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(comp2Renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {title:todo, completed:❌}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('action with optimistic update and revalidation', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { useLoadedSnapshot: true },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useItem('1');

      renders.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        data: selectionResult.data?.value ?? null,
        });
    });

    act(() => {
      void env.performClientUpdateAction(
        '1',
        { title: 'was updated', completed: false },
        {
          withOptimisticUpdate: true,
          withRevalidation: true,
        },
      );
    });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 1 ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ payload: 1 ⋅ data: {title:was updated, completed:❌}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });
});

describe('useItem isolated tests', () => {
  test('use deleted item', async () => {
    const { serverMock, store } = createDefaultCollectionStore({
      initialServerData: serverInitialData,
      useLoadedSnapshot: true,
      disableInitialDataInvalidation: true,
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

test.concurrent(
  'RTU update works',
  async () => {
    const env = createTestEnv({
      initialServerData: { '1': defaultTodo, '2': defaultTodo },
      useLoadedSnapshot: true,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      dynamicRTUThrottleMs() {
        return 300;
      },
    });

    const renders = createRenderStore();

    env.serverMock.produceData((draft) => {
      draft['1']!.title = 'RTU Update';
    });

    await sleep(100);

    expect(env.store.store.state).toMatchInlineSnapshotString(`
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

    expect(renders.getSnapshot({ arrays: 'all' })).toMatchInlineSnapshotString(`
    "
    status: success -- data: {title:todo, completed:false}
    status: refetching -- data: {title:todo, completed:false}
    status: success -- data: {title:RTU Update, completed:false}
    status: refetching -- data: {title:RTU Update, completed:false}
    status: success -- data: {title:Throttle update, completed:false}
    "
  `);
  },
  { retry: 2 },
);

test.concurrent('fetch error then mount component without error', async () => {
  const env = createTestEnv({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
  });

  const renders = createRenderStore();

  env.serverMock.setFetchError('error');

  env.store.scheduleFetch('highPriority', '1');

  await env.serverMock.waitFetchIdle(200);

  expect(env.store.store.state).toMatchInlineSnapshotString(`
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

  expect(renders.snapshot).toMatchInlineSnapshotString(`
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

  expect(renders.snapshot).toMatchInlineSnapshotString(`
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

test.concurrent('emulate load resource during its mutation', async () => {
  const env = createTestEnv({
    initialServerData: { '1': defaultTodo, '2': defaultTodo },
    useLoadedSnapshot: true,
    emulateRTU: true,
    disableInitialDataInvalidation: false,
  });

  const renders = createRenderStore();

  const events = evtmitter<{ openPage: undefined }>();

  async function createItem() {
    const end = env.store.startMutation('3');

    events.emit('openPage');

    await env.serverMock.emulateMutation((draft) => {
      draft['3'] = defaultTodo;
    });

    end();
  }

  const Page = () => {
    const { data, status, error } = env.store.useItem('3');

    renders.add({ status, data, error });

    return null;
  };

  const App = () => {
    const [openPage, setOpenPage] = useState(false);

    useEffect(() => {
      events.on('openPage', () => setOpenPage(true));
    }, []);

    return <div>{openPage && <Page />}</div>;
  };

  render(<App />);

  createItem();

  await sleep(1000);

  expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: loading -- data: null -- error: null
    status: success -- data: {title:todo, completed:false} -- error: null
    "
  `);
});
