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
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
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
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

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
      await flushAllTimers();
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
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
      await flushAllTimers();
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
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
      await flushAllTimers();
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
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
      await flushAllTimers();
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
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
      await flushAllTimers();
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
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

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
      await flushAllTimers();
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
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

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
      await flushAllTimers();
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
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

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
      await flushAllTimers();
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ data: null
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('return error state for empty string payload', async () => {
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useItem('');

      renders.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        error: selectionResult.error,
        data: selectionResult.data?.value ?? null,
      });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: error
      ⋅ payload: undefined
      ⋅ error: {code:461, id:invalid-payload, message:Invalid payload}
      ⋅ data: null
      └─
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('enable the fetch after initial disable', async () => {
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

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
      await flushAllTimers();
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
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

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
      await flushAllTimers();
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
      await flushAllTimers();
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
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
      await flushAllTimers();
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
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useItem('2', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        data: selectionResult.data?.value ?? null,
      });
    });

    act(() => {
      env.apiStore.deleteItemState('2');
      env.serverTable.removeItem('2');
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 2 ⋅ data: {title:todo, completed:❌}
      -> status: deleted ⋅ payload: 2 ⋅ data: null
      "
    `);

    act(() => {
      env.scheduleFetch('highPriority', '2');
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: loading ⋅ payload: 2 ⋅ data: null
      -> status: error ⋅ payload: 2 ⋅ data: null
      "
    `);
  });

  test('use ensureIsLoaded prop', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    expect(env.apiStore.getItemState('1')).toMatchInlineSnapshot(`
      data:
        value: { completed: '❌', title: 'todo' }

      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useItem('1', {
        ensureIsLoaded: true,
      });

      renders.add({
        status: selectionResult.status,
        payload: selectionResult.payload,
        isLoading: selectionResult.isLoading,
        data: selectionResult.data?.value ?? null,
      });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 1 ⋅ isLoading: ✅ ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ payload: 1 ⋅ isLoading: ❌ ⋅ data: {title:todo, completed:❌}
      "
    `);
  });

  test('ignore refetchingStatus by default', async () => {
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': defaultTodo,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useItem('1');

      renders.add({
        status: selectionResult.status,
        isLoading: selectionResult.isLoading,
        data: selectionResult.data?.value ?? null,
      });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ data: null
      -> status: success ⋅ isLoading: ❌ ⋅ data: {title:todo, completed:❌}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ itemPayload }: { itemPayload: string | false }) => {
        const selectionResult = env.apiStore.useItem(itemPayload, {
          ensureIsLoaded: true,
        });

        renders.add({
          status: selectionResult.status,
          payload: selectionResult.payload,
          isLoading: selectionResult.isLoading,
          data: selectionResult.data?.value ?? null,
        });
      },
      { initialProps: { itemPayload: false satisfies string | false } },
    );

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ isLoading: ❌ ⋅ data: null
      "
    `);

    rerender({ itemPayload: '1' });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ payload: undefined ⋅ isLoading: ❌ ⋅ data: null
      ⋅⋅⋅
      -> status: loading ⋅ payload: 1 ⋅ isLoading: ✅ ⋅ data: {title:todo, completed:❌}
      -> status: success ⋅ payload: 1 ⋅ isLoading: ❌ ⋅ data: {title:todo, completed:❌}
      "
    `);
  });
});

test('RTU update works', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs() {
        return 300;
      },
    },
  );

  const renders = createLoggerStore();

  // Trigger RTU before hook is mounted
  env.serverTable.setItem(
    '1',
    { title: 'RTU Update', completed: false },
    { triggerRTUEvent: true },
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  expect(env.apiStore.store.state).toMatchInlineSnapshot(`
    "1:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '1'
      refetchOnMount: 'realtimeUpdate'
      status: 'success'
      wasLoaded: '✅'

    "2:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '2'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
  `);

  renderHook(() => {
    const { data, status } = env.apiStore.useItem('1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data: data?.value ?? null });
  });

  await flushAllTimers();

  // Trigger another RTU
  env.serverTable.setItem(
    '1',
    { title: 'Throttle update', completed: false },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {title:todo, completed:❌}
    -> status: refetching ⋅ data: {title:todo, completed:❌}
    -> status: success ⋅ data: {title:RTU Update, completed:❌}
    -> status: refetching ⋅ data: {title:RTU Update, completed:❌}
    -> status: success ⋅ data: {title:Throttle update, completed:❌}
    "
  `);

  const fetchHistory = env.serverTable.fetchHistory.filter(
    (f) => f.type === 'fetch',
  );

  expect(fetchHistory.length).toBeGreaterThanOrEqual(2);
});

test('fetch error then mount component without error', async () => {
  const env = createCollectionStoreTestEnv<Todo>({
    '1': defaultTodo,
    '2': defaultTodo,
  });

  const renders = createLoggerStore();

  env.serverTable.setNextFetchError('1', 'error');

  act(() => {
    env.scheduleFetch('highPriority', '1');
  });

  await flushAllTimers();

  expect(env.apiStore.getItemState('1')).toMatchObject({
    data: null,
    error: {
      message: 'error',
    },
    payload: '1',
    refetchOnMount: false,
    status: 'error',
    wasLoaded: false,
  });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });

  renderHook(() => {
    const { data, status } = env.apiStore.useItem('1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data: data?.value ?? null });
  });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: error ⋅ data: null
    -> status: loading ⋅ data: null
    -> status: success ⋅ data: {title:todo, completed:❌}
    "
  `);
});

test('initial data is invalidated on first load', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    { testScenario: { idleWithLocalCache: 'sameAsServer' } },
  );

  env.serverTable.setItem('1', { title: 'Update', completed: false });

  const renders = createLoggerStore();

  renderHook(() => {
    const { data, status } = env.apiStore.useItem('1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data: data?.value ?? null });
  });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {title:todo, completed:❌}
    -> status: refetching ⋅ data: {title:todo, completed:❌}
    -> status: success ⋅ data: {title:Update, completed:❌}
    "
  `);
});

test('emulate load resource during its mutation', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  const events = evtmitter<{ openPage: undefined }>();

  async function createItem() {
    const endMutation = env.apiStore.startMutation('3');

    events.emit('openPage');

    await env.serverTable.addItem('3', defaultTodo);

    endMutation();
  }

  function Page() {
    const { data, status, error } = env.apiStore.useItem('3');

    renders.add({
      status,
      data: data?.value ?? null,
      error,
    });

    return null;
  }

  function App() {
    const [openPage, setOpenPage] = useState(false);

    useEffect(() => {
      events.on('openPage', () => setOpenPage(true));
    }, []);

    return <div>{openPage && <Page />}</div>;
  }

  render(<App />);

  act(() => {
    void createItem();
  });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null ⋅ error: null
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ error: null
    "
  `);
});
