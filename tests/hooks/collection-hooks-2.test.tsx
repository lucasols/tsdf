import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useCallback, useRef } from 'react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

type Todo = {
  title: string;
  completed: boolean;
};

const defaultTodo: Todo = { title: 'todo', completed: false };

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

test('isOffScreen should keep the selected data and not be affected by invalidation', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    },
  );

  const renders = createLoggerStore({
    rejectKeys: ['queryMetadata'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useItem('1', {
        isOffScreen,
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({
        status: result.status,
        data: result.data?.value ?? null,
        error: result.error,
        isLoading: result.isLoading,
        payload: result.payload,
      });
    },
    { initialProps: { isOffScreen: false } },
  );

  await flushAllTimers();

  renders.addMark('first update (✅)');

  act(() => {
    env.serverTable.setItem(
      '1',
      { title: '✅', completed: true },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  renders.addMark('set disabled');

  act(() => {
    rerender({ isOffScreen: true });
  });

  await flushAllTimers();

  renders.addMark('ignored update (❌)');

  act(() => {
    env.serverTable.setItem(
      '1',
      { title: '❌', completed: true },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  renders.addMark('enabled again');

  act(() => {
    rerender({ isOffScreen: false });
  });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ data: {title:todo, completed:❌}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─

    >>> first update (✅)

    ┌─
    ⋅ status: refetching
    ⋅ data: {title:todo, completed:❌}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─
    ┌─
    ⋅ status: success
    ⋅ data: {title:✅, completed:✅}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─

    >>> set disabled

    ┌─
    ⋅ status: success
    ⋅ data: {title:✅, completed:✅}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─

    >>> ignored update (❌)

    >>> enabled again

    ┌─
    ⋅ status: success
    ⋅ data: {title:✅, completed:✅}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─
    ┌─
    ⋅ status: refetching
    ⋅ data: {title:✅, completed:✅}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─
    ┌─
    ⋅ status: success
    ⋅ data: {title:❌, completed:✅}
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ payload: 1
    └─
    "
  `);
});

test('disable then enable isOffScreen', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    {
      testScenario: 'loaded',
    },
  );

  const renders = createLoggerStore({
    filterKeys: ['status', 'data', 'payload'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useItem('1', {
        isOffScreen,
        returnRefetchingStatus: true,
      });

      renders.add({
        status: result.status,
        data: result.data?.value ?? null,
        payload: result.payload,
      });
    },
    { initialProps: { isOffScreen: false } },
  );

  await flushAllTimers();

  renders.addMark('set disabled');

  act(() => {
    rerender({ isOffScreen: true });
  });

  await flushAllTimers();

  renders.addMark('enabled again');

  act(() => {
    rerender({ isOffScreen: false });
  });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1
    -> status: refetching ⋅ data: {title:todo, completed:❌} ⋅ payload: 1
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1

    >>> set disabled

    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1

    >>> enabled again

    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1
    "
  `);
  expect(env.serverTable.numOfFinishedFetches).toBe(1);
});

test('useMultipleItems should not trigger a mount refetch when some option changes', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    {
      testScenario: 'loaded',
    },
  );

  const filterKeys = ['status', 'data', 'payload', 'rrfs'];
  const renders1 = createLoggerStore({ filterKeys });
  const renders2 = createLoggerStore({ filterKeys });

  const { rerender } = renderHook(
    ({ returnRefetchingStatus }: { returnRefetchingStatus: boolean }) => {
      const result = env.apiStore.useMultipleItems(
        ['1', '2'].map((payload) => ({
          payload,
          returnRefetchingStatus,
        })),
      );

      const [item1, item2] = result;

      renders1.add({
        status: item1?.status,
        data: item1?.data?.value ?? null,
        payload: item1?.payload,
        rrfs: returnRefetchingStatus,
      });

      renders2.add({
        status: item2?.status,
        data: item2?.data?.value ?? null,
        payload: item2?.payload,
        rrfs: returnRefetchingStatus,
      });
    },
    { initialProps: { returnRefetchingStatus: false } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  act(() => {
    rerender({ returnRefetchingStatus: true });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(renders1.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1 ⋅ rrfs: ❌
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1 ⋅ rrfs: ✅
    "
  `);
  expect(renders2.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2 ⋅ rrfs: ❌
    -> status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2 ⋅ rrfs: ✅
    "
  `);
});

test('useMultipleItems should not trigger a mount refetch for unchanged items', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    {
      '1': defaultTodo,
      '2': defaultTodo,
      '3': defaultTodo,
      '4': defaultTodo,
      '5': defaultTodo,
    },
    {
      testScenario: 'loaded',
    },
  );

  const renders = createLoggerStore({
    filterKeys: ['i', 'status', 'data', 'payload'],
  });

  const { rerender } = renderHook(
    ({ items }: { items: string[] }) => {
      const result = env.apiStore.useMultipleItems(
        items.map((payload) => ({ payload })),
      );

      renders.add(
        result.map((item) => ({
          status: item.status,
          data: item.data?.value ?? null,
          payload: item.payload,
        })),
      );
    },
    { initialProps: { items: ['1', '2'] } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  renders.addMark('add item');

  act(() => {
    rerender({ items: ['1', '2', '3'] });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(3);

  renders.addMark('remove item');

  act(() => {
    rerender({ items: ['2', '3'] });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(3);

  renders.addMark('add removed item back');

  act(() => {
    env.serverTable.setItem('1', { title: 'changed', completed: false });
    rerender({ items: ['2', '3', '1'] });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(4);

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> i: 1 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1
    -> i: 2 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2

    >>> add item

    -> i: 1 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1
    -> i: 2 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2
    -> i: 3 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 3

    >>> remove item

    -> i: 1 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2
    -> i: 2 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 3

    >>> add removed item back

    -> i: 1 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2
    -> i: 2 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 3
    -> i: 3 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 1
    -> i: 1 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 2
    -> i: 2 ⋅ status: success ⋅ data: {title:todo, completed:❌} ⋅ payload: 3
    -> i: 3 ⋅ status: success ⋅ data: {title:changed, completed:❌} ⋅ payload: 1
    "
  `);
});

test('Selected value should update when selectorUsesExternalDeps is true', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    {
      testScenario: 'loaded',
    },
  );

  const renders = createLoggerStore({
    filterKeys: ['status', 'data', 'payload'],
  });

  const { rerender } = renderHook(
    ({
      externalDep,
      selectorUsesExternalDeps,
    }: {
      externalDep: string;
      selectorUsesExternalDeps: boolean;
    }) => {
      const initialExternalDepRef = useRef(externalDep);

      const selectorWithoutExternalDeps = useCallback(
        (data: { value: Todo } | null) => {
          return `${data?.value.title}/${initialExternalDepRef.current}`;
        },
        [],
      );

      const selectorWithExternalDeps = useCallback(
        (data: { value: Todo } | null) => {
          return `${data?.value.title}/${externalDep}`;
        },
        [externalDep],
      );

      const result = env.apiStore.useItem('1', {
        selector: selectorUsesExternalDeps
          ? selectorWithExternalDeps
          : selectorWithoutExternalDeps,
      });

      renders.add({
        status: result.status,
        data: result.data,
        payload: result.payload,
      });
    },
    { initialProps: { externalDep: 'ok', selectorUsesExternalDeps: false } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  renders.addMark('change external dep (selectorUsesExternalDeps: false)');

  act(() => {
    rerender({ externalDep: 'changed', selectorUsesExternalDeps: false });
  });

  await flushAllTimers();

  renders.addMark('change external dep');

  act(() => {
    rerender({ externalDep: 'changed', selectorUsesExternalDeps: true });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  renders.addMark('change external dep again');

  act(() => {
    rerender({ externalDep: 'changed again', selectorUsesExternalDeps: true });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: todo/ok ⋅ payload: 1

    >>> change external dep (selectorUsesExternalDeps: false)

    -> status: success ⋅ data: todo/ok ⋅ payload: 1

    >>> change external dep

    -> status: success ⋅ data: todo/changed ⋅ payload: 1

    >>> change external dep again

    -> status: success ⋅ data: todo/changed again ⋅ payload: 1
    "
  `);
});

test('medium priority on idle collection item skips delay', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo },
    { mediumPriorityDelayMs: 300 },
  );

  const renders = createLoggerStore();

  env.scheduleFetch('mediumPriority', '1');

  renders.addMark('mount after scheduling');

  renderHook(() => {
    const { data, status } = env.apiStore.useItem('1', {
      returnRefetchingStatus: true,
    });
    renders.add({ data: data?.value ?? null, status });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(env.serverTable.fetchHistory[0]?.startedAt).toBe(10);

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "

    >>> mount after scheduling

    -> data: null ⋅ status: loading
    -> data: {title:todo, completed:❌} ⋅ status: success
    "
  `);
});

test('medium priority on loaded collection item applies delay', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo },
    { testScenario: 'loaded', mediumPriorityDelayMs: 300 },
  );

  const renders = createLoggerStore();

  env.apiStore.invalidateItem('1', 'mediumPriority');

  renders.addMark('mount after invalidation');

  renderHook(() => {
    const { data, status } = env.apiStore.useItem('1', {
      returnRefetchingStatus: true,
    });
    renders.add({ data: data?.value ?? null, status });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(env.serverTable.fetchHistory[0]?.startedAt).toBe(300 + 10);

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "

    >>> mount after invalidation

    -> data: {title:todo, completed:❌} ⋅ status: success
    -> data: {title:todo, completed:❌} ⋅ status: refetching
    -> data: {title:todo, completed:❌} ⋅ status: success
    "
  `);
});

test('useItem with selector should not trigger a rerender', async () => {
  const env = createCollectionStoreTestEnv<Todo>(
    { '1': defaultTodo, '2': defaultTodo },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    },
  );

  const renders = createLoggerStore();

  let prevData: unknown;

  const { rerender } = renderHook(() => {
    const { data, status } = env.apiStore.useItem('1', {
      selector: () => ({}),
    });

    renders.add({ status, changed: prevData !== data });
    prevData = data;
  });

  await flushAllTimers();

  renders.addMark('Rerenders');

  rerender();
  rerender();
  rerender();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ changed: ✅

    >>> Rerenders

    -> status: success ⋅ changed: ❌
    -> status: success ⋅ changed: ❌
    -> status: success ⋅ changed: ❌
    "
  `);
});
