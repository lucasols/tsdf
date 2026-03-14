import { act, cleanup, renderHook } from '@testing-library/react';
import { useCallback } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { TSFDUseCollectionItemReturn } from '../../src/collectionStore/collectionStore';
import type { TSFDUseListItemReturn } from '../../src/listQueryStore/types';
import type { CollectionTestItem } from '../mocks/collectionStoreTestEnv';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, range } from '../utils/genericTestUtils';

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

type Todo = { title: string; completed: boolean };

const defaultTodo: Todo = { title: 'todo', completed: false };

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 5).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 5).map((id) => ({ id, name: `Order ${id}` })),
};

type StoreValue = { hello: string };

describe('document hook memoization', () => {
  test('useDocument keeps plain data stable across rerenders and same-data refetches', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: StoreValue | null | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { data } = env.apiStore.useDocument();

      renders += 1;
      dataChanges.push(prevData !== (data?.value ?? null));
      prevData = data?.value ?? null;

      return data?.value ?? null;
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(dataChanges).toEqual([true, false, false, false]);

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.setServerData({ hello: 'world' });
      env.apiStore.invalidateData();
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeInvalidation);
    expect(hook.result.current).toBe(prevData);
  });

  test('useDocument keeps selector results stable when selector identity is memoized', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: { label: string | null } | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: { value: StoreValue } | null) => ({
          label: data?.value.hello ?? null,
        }),
        [],
      );
      const { data } = env.apiStore.useDocument({ selector });

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.setServerData({ hello: 'world' });
      env.apiStore.invalidateData();
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true, false, false, false]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });
});

describe('collection hook memoization', () => {
  test('useItem keeps plain data stable across rerenders and unrelated item updates', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: Todo | null | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { data } = env.apiStore.useItem('1');

      renders += 1;
      dataChanges.push(prevData !== (data?.value ?? null));
      prevData = data?.value ?? null;

      return data?.value ?? null;
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(dataChanges).toEqual([true, false, false, false]);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('2', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('2');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevData);
  });

  test('useItem keeps selector results stable when selector identity is memoized', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: { label: string | null } | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: CollectionTestItem<Todo> | null) => ({
          label: data?.value.title ?? null,
        }),
        [],
      );
      const { data } = env.apiStore.useItem('1', { selector });

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('3', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('3');
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true, false, false, false]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleItems keeps plain entries and outer array stable across rerenders and unrelated updates', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const queries = [{ payload: '1' }, { payload: '2' }] as const;

    let renders = 0;
    let prevResult:
      | readonly TSFDUseCollectionItemReturn<
          CollectionTestItem<Todo> | null,
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: Todo | null | undefined;
    let prevSecondData: Todo | null | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      const result = env.apiStore.useMultipleItems([...queries]);

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== (result[0]?.data?.value ?? null),
        second: prevSecondData !== (result[1]?.data?.value ?? null),
      });
      prevResult = result;
      prevFirstData = result[0]?.data?.value ?? null;
      prevSecondData = result[1]?.data?.value ?? null;

      return result;
    });

    await flushAllTimers();

    expect(changes).toEqual([{ result: true, first: true, second: true }]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(changes).toEqual([
      { result: true, first: true, second: true },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
    ]);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('3', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('3');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevResult);
  });

  test('useMultipleItems keeps selector results stable when selector identity is memoized', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevResult:
      | readonly TSFDUseCollectionItemReturn<
          { label: string | null },
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: { label: string | null } | undefined;
    let prevSecondData: { label: string | null } | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: CollectionTestItem<Todo> | null) => ({
          label: data?.value.title ?? null,
        }),
        [],
      );
      const result = env.apiStore.useMultipleItems(
        [{ payload: '1' }, { payload: '2' }],
        { selector },
      );

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== result[0]?.data,
        second: prevSecondData !== result[1]?.data,
      });
      prevResult = result;
      prevFirstData = result[0]?.data;
      prevSecondData = result[1]?.data;

      return result;
    });

    await flushAllTimers();

    expect(changes).toEqual([{ result: true, first: true, second: true }]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('3', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('3');
    });

    await flushAllTimers();

    expect(changes).toEqual([
      { result: true, first: true, second: true },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
    ]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });
});

describe('list-query hook memoization', () => {
  test('useItem keeps plain data stable across rerenders and unrelated item updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevData: { id: number; name: string } | null | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { data } = env.apiStore.useItem('users||1');

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(dataChanges).toEqual([true, false, false, false]);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('users||2', { id: 2, name: 'Changed User 2' });
      env.apiStore.invalidateItem('users||2');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevData);
  });

  test('useItem keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevData: { label: string | null } | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: { id: number; name: string } | null) => ({
          label: data?.name ?? null,
        }),
        [],
      );
      const { data } = env.apiStore.useItem('users||1', { selector });

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('users||3', { id: 3, name: 'Changed User 3' });
      env.apiStore.invalidateItem('users||3');
    });

    await flushAllTimers();

    expect(dataChanges).toEqual([true, false, false, false]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleItems keeps plain entries and outer array stable across rerenders and unrelated updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly TSFDUseListItemReturn<
          { id: number; name: string } | null,
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: { id: number; name: string } | null | undefined;
    let prevSecondData: { id: number; name: string } | null | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      const result = env.apiStore.useMultipleItems([
        { payload: 'users||1' },
        { payload: 'users||2' },
      ]);

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== result[0]?.data,
        second: prevSecondData !== result[1]?.data,
      });
      prevResult = result;
      prevFirstData = result[0]?.data;
      prevSecondData = result[1]?.data;

      return result;
    });

    await flushAllTimers();

    expect(changes).toEqual([{ result: true, first: true, second: true }]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(changes).toEqual([
      { result: true, first: true, second: true },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
    ]);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('users||3', { id: 3, name: 'Changed User 3' });
      env.apiStore.invalidateItem('users||3');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevResult);
  });

  test('useMultipleItems keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly TSFDUseListItemReturn<
          { label: string | null },
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: { label: string | null } | undefined;
    let prevSecondData: { label: string | null } | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: { id: number; name: string } | null) => ({
          label: data?.name ?? null,
        }),
        [],
      );
      const result = env.apiStore.useMultipleItems<{ label: string | null }>(
        [{ payload: 'users||1' }, { payload: 'users||2' }],
        { selector },
      );

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== result[0]?.data,
        second: prevSecondData !== result[1]?.data,
      });
      prevResult = result;
      prevFirstData = result[0]?.data;
      prevSecondData = result[1]?.data;

      return result;
    });

    await flushAllTimers();

    expect(changes).toEqual([{ result: true, first: true, second: true }]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('users||3', { id: 3, name: 'Changed User 3' });
      env.apiStore.invalidateItem('users||3');
    });

    await flushAllTimers();

    expect(changes).toEqual([
      { result: true, first: true, second: true },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
      { result: false, first: false, second: false },
    ]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useListQuery keeps plain items stable across rerenders and unrelated query updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevItems: ReadonlyArray<{ id: number; name: string }> | undefined;
    const itemsChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { items } = env.apiStore.useListQuery({ tableId: 'users' });

      renders += 1;
      itemsChanges.push(prevItems !== items);
      prevItems = items;

      return items;
    });

    await flushAllTimers();

    expect(itemsChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(itemsChanges).toEqual([true, false, false, false]);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('products||1', {
        id: 1,
        name: 'Changed Product 1',
      });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'products' },
      });
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevItems);
  });

  test('useListQuery keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevItems: ReadonlyArray<{ label: string }> | undefined;
    const itemsChanges: boolean[] = [];

    const hook = renderHook(() => {
      const itemSelector = useCallback(
        (data: { id: number; name: string }) => ({ label: data.name }),
        [],
      );
      const { items } = env.apiStore.useListQuery(
        { tableId: 'users' },
        { itemSelector },
      );

      renders += 1;
      itemsChanges.push(prevItems !== items);
      prevItems = items;

      return items;
    });

    await flushAllTimers();

    expect(itemsChanges).toEqual([true]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('products||1', {
        id: 1,
        name: 'Changed Product 1',
      });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'products' },
      });
    });

    await flushAllTimers();

    expect(itemsChanges).toEqual([true, false, false, false]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleListQueries keeps plain results stable across rerenders and unrelated query updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly ReturnType<
          typeof env.apiStore.useMultipleListQueries
        >[number][]
      | undefined;
    let prevUsersItems: ReadonlyArray<{ id: number; name: string }> | undefined;
    let prevProductsItems:
      | ReadonlyArray<{ id: number; name: string }>
      | undefined;
    const changes: Array<{
      result: boolean;
      users: boolean;
      products: boolean;
    }> = [];

    const hook = renderHook(() => {
      const result = env.apiStore.useMultipleListQueries([
        { payload: { tableId: 'users' } },
        { payload: { tableId: 'products' } },
      ]);

      renders += 1;
      changes.push({
        result: prevResult !== result,
        users: prevUsersItems !== result[0]?.items,
        products: prevProductsItems !== result[1]?.items,
      });
      prevResult = result;
      prevUsersItems = result[0]?.items;
      prevProductsItems = result[1]?.items;

      return result;
    });

    await flushAllTimers();

    expect(changes).toEqual([{ result: true, users: true, products: true }]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(changes).toEqual([
      { result: true, users: true, products: true },
      { result: false, users: false, products: false },
      { result: false, users: false, products: false },
      { result: false, users: false, products: false },
    ]);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('orders||1', { id: 1, name: 'Changed Order 1' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'orders' },
      });
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevResult);
  });

  test('useMultipleListQueries keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly ReturnType<
          typeof env.apiStore.useMultipleListQueries
        >[number][]
      | undefined;
    let prevUsersItems: ReadonlyArray<{ label: string }> | undefined;
    let prevProductsItems: ReadonlyArray<{ label: string }> | undefined;
    const changes: Array<{
      result: boolean;
      users: boolean;
      products: boolean;
    }> = [];

    const hook = renderHook(() => {
      const itemSelector = useCallback(
        (data: { id: number; name: string }) => ({ label: data.name }),
        [],
      );
      const result = env.apiStore.useMultipleListQueries<{ label: string }>(
        [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        { itemSelector },
      );

      renders += 1;
      changes.push({
        result: prevResult !== result,
        users: prevUsersItems !== result[0]?.items,
        products: prevProductsItems !== result[1]?.items,
      });
      prevResult = result;
      prevUsersItems = result[0]?.items;
      prevProductsItems = result[1]?.items;

      return result;
    });

    await flushAllTimers();

    expect(changes).toEqual([{ result: true, users: true, products: true }]);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('orders||1', { id: 1, name: 'Changed Order 1' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'orders' },
      });
    });

    await flushAllTimers();

    expect(changes).toEqual([
      { result: true, users: true, products: true },
      { result: false, users: false, products: false },
      { result: false, users: false, products: false },
      { result: false, users: false, products: false },
    ]);
    expect(renders).toBe(rendersBeforeInvalidation);
  });
});
