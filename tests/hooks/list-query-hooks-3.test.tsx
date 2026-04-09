import {
  createLoggerStore,
  setDefaultLoggerStoreOptions,
} from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import '@testing-library/react/dont-cleanup-after-each';
import { useCallback } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';

import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick, range } from '../utils/genericTestUtils';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

beforeAll(() => {
  vi.useFakeTimers();
  setDefaultLoggerStoreOptions({ changesOnly: true });
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

afterAll(() => {
  cleanup();
});

test('useItem: isOffScreen should keep the selected data and not be affected by invalidation', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    usesRealTimeUpdates: true,
  });

  const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useItem('users||1', {
        isOffScreen,
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add(result);
    },
    { initialProps: { isOffScreen: false } },
  );

  await flushAllTimers();

  renders.addMark('first update (✅)');
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: '✅' },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  renders.addMark('set disabled');
  rerender({ isOffScreen: true });

  await flushAllTimers();

  renders.addMark('ignored update (❌)');
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: '❌' },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  renders.addMark('enabled again');
  rerender({ isOffScreen: false });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:User 1}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─

    >>> first update (✅)

    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:User 1}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: refetching
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:User 1}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:✅}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─

    >>> set disabled

    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:✅}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─

    >>> ignored update (❌)

    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:✅}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─

    >>> enabled again

    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:✅}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: refetching
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:✅}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ itemStateKey: "users||1
    ⋅ status: success
    ⋅ error: null
    ⋅ isLoading: ❌
    ⋅ data: {id:1, name:❌}
    ⋅ payload: users||1
    ⋅ pendingSync: ❌
    └─
    "
  `);
});

test('useListQuery: isOffScreen should keep the selected data and not be affected by invalidation', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    usesRealTimeUpdates: true,
  });

  const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useListQuery(
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

  await flushAllTimers();

  renders.addMark('first update (✅)');
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: '✅' },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  renders.addMark('set disabled');
  rerender({ isOffScreen: true });

  await flushAllTimers();

  renders.addMark('ignored update (❌)');
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: '❌' },
      { triggerRTUEvent: true },
    );
  });

  await flushAllTimers();

  renders.addMark('enabled again');
  rerender({ isOffScreen: false });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─

    >>> first update (✅)

    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: refetching
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: success
    ⋅ items: [{id:1, name:✅}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─

    >>> set disabled

    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: success
    ⋅ items: [{id:1, name:✅}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─

    >>> ignored update (❌)

    >>> enabled again

    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: success
    ⋅ items: [{id:1, name:✅}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: refetching
    ⋅ items: [{id:1, name:✅}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─
    ┌─
    ⋅ queryKey: {tableId:"users"}
    ⋅ status: success
    ⋅ items: [{id:1, name:❌}, …(4 more)]
    ⋅ error: null
    ⋅ hasMore: ❌
    ⋅ isDerived: ❌
    ⋅ isLoading: ❌
    ⋅ payload: {tableId:users}
    ⋅ fields: undefined
    ⋅ isLoadingMore: ❌
    ⋅ pendingSync: ❌
    └─
    "
  `);
});

test('useItem: disable then enable isOffScreen', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    usesRealTimeUpdates: true,
    lowPriorityThrottleMs: 10,
  });

  const renders = createLoggerStore({
    filterKeys: ['status', 'data', 'payload'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useItem('users||1', {
        isOffScreen,
        returnRefetchingStatus: true,
      });

      renders.add(result);
    },
    { initialProps: { isOffScreen: false } },
  );

  await flushAllTimers();

  renders.addMark('set disabled');

  rerender({ isOffScreen: true });

  await flushAllTimers();

  renders.addMark('enabled again');

  rerender({ isOffScreen: false });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1

    >>> set disabled

    -> status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1

    >>> enabled again

    -> status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1
    "
  `);

  expect(env.serverTable.numOfFinishedFetches).toBe(0);
});

test('useListQuery: disable then enable isOffScreen', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    usesRealTimeUpdates: true,
    lowPriorityThrottleMs: 10,
  });

  const renders = createLoggerStore({
    filterKeys: ['status', 'items', 'payload'],
  });

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { isOffScreen, returnRefetchingStatus: true },
      );

      renders.add(result);
    },
    { initialProps: { isOffScreen: false } },
  );

  await flushAllTimers();

  renders.addMark('set disabled');

  rerender({ isOffScreen: true });

  await flushAllTimers();

  renders.addMark('enabled again');

  rerender({ isOffScreen: false });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─

    >>> set disabled

    ┌─
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─

    >>> enabled again

    ┌─
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    "
  `);

  expect(env.serverTable.numOfFinishedFetches).toBe(0);
});

test('useMultipleItems should not trigger a mount refetch when some option changes', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    lowPriorityThrottleMs: 10,
  });

  const filterKeys = ['status', 'data', 'payload', 'rrfs'];
  const renders1 = createLoggerStore({ filterKeys });
  const renders2 = createLoggerStore({ filterKeys });

  const { rerender } = renderHook(
    ({ returnRefetchingStatus }: { returnRefetchingStatus: boolean }) => {
      const result = env.apiStore.useMultipleItems(
        ['users||1', 'users||2'].map((payload) => ({
          payload,
          returnRefetchingStatus,
        })),
      );

      renders1.add({ ...result[0]!, rrfs: returnRefetchingStatus });
      renders2.add({ ...result[1]!, rrfs: returnRefetchingStatus });
    },
    { initialProps: { returnRefetchingStatus: false } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  rerender({ returnRefetchingStatus: true });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(renders1.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1 ⋅ rrfs: ❌
    -> status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1 ⋅ rrfs: ✅
    "
  `);
  expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {id:2, name:User 2} ⋅ payload: users||2 ⋅ rrfs: ❌
    -> status: success ⋅ data: {id:2, name:User 2} ⋅ payload: users||2 ⋅ rrfs: ✅
    "
  `);
});

test('useMultipleItems should not trigger a mount refetch for unchanged items', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    lowPriorityThrottleMs: 10,
  });

  const renders = createLoggerStore({
    filterKeys: ['i', 'status', 'data', 'payload'],
    dedupeKey: 'i',
  });

  const { rerender } = renderHook(
    ({ items }: { items: string[] }) => {
      const result = env.apiStore.useMultipleItems(
        items.map((payload) => ({ payload })),
      );

      renders.add(result);
    },
    { initialProps: { items: ['users||1', 'users||2'] } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  renders.addMark('add item');
  rerender({ items: ['users||1', 'users||2', 'users||3'] });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(3);

  renders.addMark('remove item');
  rerender({ items: ['users||2', 'users||3'] });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(3);

  renders.addMark('add removed item back');

  env.serverTable.updateItem('users||1', { name: 'changed' });

  rerender({ items: ['users||2', 'users||3', 'users||1'] });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(4);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> i: 1 ⋅ status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1
    -> i: 2 ⋅ status: success ⋅ data: {id:2, name:User 2} ⋅ payload: users||2

    >>> add item

    -> i: 1 ⋅ status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1
    -> i: 2 ⋅ status: success ⋅ data: {id:2, name:User 2} ⋅ payload: users||2
    -> i: 3 ⋅ status: success ⋅ data: {id:3, name:User 3} ⋅ payload: users||3

    >>> remove item

    -> i: 1 ⋅ status: success ⋅ data: {id:2, name:User 2} ⋅ payload: users||2
    -> i: 2 ⋅ status: success ⋅ data: {id:3, name:User 3} ⋅ payload: users||3

    >>> add removed item back

    -> i: 1 ⋅ status: success ⋅ data: {id:2, name:User 2} ⋅ payload: users||2
    -> i: 2 ⋅ status: success ⋅ data: {id:3, name:User 3} ⋅ payload: users||3
    -> i: 3 ⋅ status: success ⋅ data: {id:1, name:User 1} ⋅ payload: users||1
    -> i: 3 ⋅ status: success ⋅ data: {id:1, name:changed} ⋅ payload: users||1
    "
  `);
});

test('useMultipleListQueries should not trigger a mount refetch when some option changes', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users'] } },
    lowPriorityThrottleMs: 10,
  });

  const filterKeys = ['i', 'status', 'items', 'payload', 'rrfs'];

  const renders = createLoggerStore({ filterKeys, dedupeKey: 'i' });

  const { rerender } = renderHook(
    ({ returnRefetchingStatus }: { returnRefetchingStatus: boolean }) => {
      const result = env.apiStore.useMultipleListQueries(
        [{ tableId: 'users' }, { tableId: 'products' }].map((payload) => ({
          payload,
          returnRefetchingStatus,
        })),
      );

      renders.add(result.map((r) => ({ ...r, rrfs: returnRefetchingStatus })));
    },
    { initialProps: { returnRefetchingStatus: false } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  rerender({ returnRefetchingStatus: true });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ i: 1
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    ⋅ rrfs: ❌
    └─
    ┌─
    ⋅ i: 2
    ⋅ status: success
    ⋅ items: [{id:1, name:Product 1}, …(49 more)]
    ⋅ payload: {tableId:products}
    ⋅ rrfs: ❌
    └─
    ┌─
    ⋅ i: 1
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    ⋅ rrfs: ✅
    └─
    ┌─
    ⋅ i: 2
    ⋅ status: success
    ⋅ items: [{id:1, name:Product 1}, …(49 more)]
    ⋅ payload: {tableId:products}
    ⋅ rrfs: ✅
    └─
    "
  `);
});

test('useMultipleListQueries should not trigger a mount refetch for unchanged items', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['products', 'users', 'orders'] } },
    lowPriorityThrottleMs: 10,
  });

  const renders = createLoggerStore({
    filterKeys: ['i', 'status', 'items', 'payload'],
    dedupeKey: 'i',
  });

  const { rerender } = renderHook(
    ({ items }: { items: string[] }) => {
      const result = env.apiStore.useMultipleListQueries(
        items.map((payload) => ({ payload: { tableId: payload } })),
      );

      renders.add(result);
    },
    { initialProps: { items: ['users', 'products'] } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  renders.addMark('add item');
  rerender({ items: ['users', 'products', 'orders'] });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(3);

  renders.addMark('remove item');
  rerender({ items: ['users', 'orders'] });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(3);

  renders.addMark('add removed item back');

  env.serverTable.updateItem('products||1', { name: 'changed' });

  rerender({ items: ['users', 'orders', 'products'] });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(4);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ i: 1
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ i: 2
    ⋅ status: success
    ⋅ items: [{id:1, name:Product 1}, …(49 more)]
    ⋅ payload: {tableId:products}
    └─

    >>> add item

    ┌─
    ⋅ i: 1
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ i: 2
    ⋅ status: success
    ⋅ items: [{id:1, name:Product 1}, …(49 more)]
    ⋅ payload: {tableId:products}
    └─
    ┌─
    ⋅ i: 3
    ⋅ status: success
    ⋅ items: [{id:1, name:Order 1}, …(49 more)]
    ⋅ payload: {tableId:orders}
    └─

    >>> remove item

    ┌─
    ⋅ i: 1
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ i: 2
    ⋅ status: success
    ⋅ items: [{id:1, name:Order 1}, …(49 more)]
    ⋅ payload: {tableId:orders}
    └─

    >>> add removed item back

    ┌─
    ⋅ i: 1
    ⋅ status: success
    ⋅ items: [{id:1, name:User 1}, …(4 more)]
    ⋅ payload: {tableId:users}
    └─
    ┌─
    ⋅ i: 2
    ⋅ status: success
    ⋅ items: [{id:1, name:Order 1}, …(49 more)]
    ⋅ payload: {tableId:orders}
    └─
    ┌─
    ⋅ i: 3
    ⋅ status: success
    ⋅ items: [{id:1, name:Product 1}, …(49 more)]
    ⋅ payload: {tableId:products}
    └─
    ┌─
    ⋅ i: 3
    ⋅ status: success
    ⋅ items: [{id:1, name:changed}, …(49 more)]
    ⋅ payload: {tableId:products}
    └─
    "
  `);
});

test('Selected value should update when external dep changes (default selectorUsesExternalDeps)', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });

  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ externalDep }: { externalDep: string }) => {
      const selector = useCallback(
        (data: Tables[string][number] | null) => {
          return `${data?.id}/${externalDep}`;
        },
        [externalDep],
      );

      const result = env.apiStore.useItem('users||1', { selector });

      const queryResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { itemSelector: selector },
      );

      renders.add({
        useItem: pick(result, ['status', 'data', 'payload']),
        useListQuery: pick(queryResult, ['status', 'items', 'payload']),
      });
    },
    { initialProps: { externalDep: 'ok' } },
  );

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  renders.addMark('change external dep');
  rerender({ externalDep: 'changed' });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  renders.addMark('change external dep again');
  rerender({ externalDep: 'changed again' });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ useItem: {status:success, data:1/ok, payload:users||1}
    ⋅ useListQuery: {status:success, items:[1/ok, 2/ok, 3/ok, 4/ok, 5/ok], payload:{tableId:users}}
    └─

    >>> change external dep

    ┌─
    ⋅ useItem: {status:success, data:1/changed, payload:users||1}
    ⋅ useListQuery: {status:success, items:[1/changed, 2/changed, 3/changed, 4/changed, 5/changed], payload:{tableId:users}}
    └─

    >>> change external dep again

    ┌─
    ⋅ useItem: {status:success, data:1/changed again, payload:users||1}
    ⋅ useListQuery: {status:success, items:[1/changed again, 2/changed again, 3/changed again, 4/changed again, 5/changed again], payload:{tableId:users}}
    └─
    "
  `);
});

test('useItem with selector should not trigger a rerender', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users', 'products'] } },
    usesRealTimeUpdates: true,
  });

  const renders = createLoggerStore();

  let prevData: unknown;

  const { rerender } = renderHook(() => {
    const { data, status } = env.apiStore.useItem('users||1', {
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

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ changed: ✅

    >>> Rerenders

    -> status: success ⋅ changed: ❌
    "
  `);
});

test('useListQuery with selector should not trigger a rerender', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users', 'products'] } },
    usesRealTimeUpdates: true,
  });

  const renders = createLoggerStore();

  let prevData: unknown;

  const { rerender } = renderHook(() => {
    const { items, status } = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: () => ({}) },
    );

    renders.add({ status, changed: prevData !== items });
    prevData = items;
  });

  await flushAllTimers();

  renders.addMark('Rerenders');

  rerender();
  rerender();
  rerender();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ changed: ✅

    >>> Rerenders

    -> status: success ⋅ changed: ❌
    "
  `);
});

test('medium priority on idle list query skips delay', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    mediumPriorityDelayMs: 300,
  });

  const renders = createLoggerStore();

  env.scheduleFetch('mediumPriority', { tableId: 'users' });

  renders.addMark('mount after scheduling');

  renderHook(() => {
    const { items, status } = env.apiStore.useListQuery(
      { tableId: 'users' },
      { returnRefetchingStatus: true },
    );
    renders.add({ itemCount: items.length, status });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(env.serverTable.fetchHistory[0]?.startedAt).toBe(10);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> mount after scheduling

    -> itemCount: 0 ⋅ status: loading
    -> itemCount: 5 ⋅ status: success
    "
  `);
});

test('medium priority on loaded list query applies delay', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
    mediumPriorityDelayMs: 300,
  });

  const renders = createLoggerStore();

  env.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: false,
    type: 'mediumPriority',
  });

  renders.addMark('mount after invalidation');

  renderHook(() => {
    const { items, status } = env.apiStore.useListQuery(
      { tableId: 'users' },
      { returnRefetchingStatus: true },
    );
    renders.add({ itemCount: items.length, status });
  });

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(env.serverTable.fetchHistory[0]?.startedAt).toBe(300 + 10);

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "

    >>> mount after invalidation

    -> itemCount: 5 ⋅ status: success
    -> itemCount: 5 ⋅ status: refetching
    -> itemCount: 5 ⋅ status: success
    "
  `);
});

test('maxItems keeps active list-query hooks and their items in memory', async () => {
  const env = createListQueryStoreTestEnv(
    {
      users: range(1, 3).map((id) => ({ id, name: `User ${id}` })),
      orders: range(1, 3).map((id) => ({ id, name: `Order ${id}` })),
    },
    { maxItems: 1 },
  );

  env.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  const usersQuery = { tableId: 'users' } as const;
  renderHook(() =>
    env.apiStore.useListQuery(usersQuery, {
      disableRefetchOnMount: true,
      returnRefetchingStatus: true,
    }),
  );

  await flushAllTimers();

  env.scheduleFetch('highPriority', { tableId: 'orders' });
  await flushAllTimers();

  expect(env.apiStore.getQueryState({ tableId: 'users' })?.items).toHaveLength(
    3,
  );
  expect(env.apiStore.getQueryState({ tableId: 'orders' })).toBeUndefined();
  expect(pick(env.apiStore.getItemState('users||1'), ['id', 'name']))
    .toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);
});

test('maxItems keeps active standalone useItem entries when their source query is evicted', async () => {
  const env = createListQueryStoreTestEnv(
    {
      users: range(1, 3).map((id) => ({ id, name: `User ${id}` })),
      orders: range(1, 3).map((id) => ({ id, name: `Order ${id}` })),
    },
    { maxItems: 1 },
  );

  env.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  const hook = renderHook(() => env.apiStore.useItem('users||1'));
  await flushAllTimers();

  env.scheduleFetch('highPriority', { tableId: 'orders' });
  await flushAllTimers();

  expect(pick(hook.result.current.data, ['id', 'name'])).toMatchInlineSnapshot(`
    id: 1
    name: 'User 1'
  `);
  expect(env.apiStore.getQueryState({ tableId: 'users' })).toBeUndefined();
  expect(pick(env.apiStore.getItemState('users||1'), ['id', 'name']))
    .toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);
  expect(env.apiStore.getItemState('users||2')).toBeUndefined();
});

test('maxItems keeps a mounted list item protected after delete and refetch', async () => {
  const env = createListQueryStoreTestEnv(
    { users: range(1, 2).map((id) => ({ id, name: `User ${id}` })) },
    { maxItems: 1 },
  );

  env.scheduleItemFetch('highPriority', 'users||1');
  await flushAllTimers();

  renderHook(() =>
    env.apiStore.useItem('users||1', {
      disableRefetchOnMount: true,
      returnRefetchingStatus: true,
    }),
  );

  await flushAllTimers();

  act(() => {
    env.apiStore.deleteItemState('users||1');
  });
  await flushAllTimers();

  env.scheduleItemFetch('highPriority', 'users||1');
  await flushAllTimers();
  env.scheduleItemFetch('highPriority', 'users||2');
  await flushAllTimers();

  expect(pick(env.apiStore.getItemState('users||1'), ['id', 'name']))
    .toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);
  expect(env.apiStore.getItemState('users||2')).toBeUndefined();
});

test('maxItems keeps the item matched by useFindItem when inactive queries are evicted', async () => {
  const env = createListQueryStoreTestEnv(
    {
      users: range(1, 3).map((id) => ({ id, name: `User ${id}` })),
      orders: range(1, 3).map((id) => ({ id, name: `Order ${id}` })),
    },
    { maxItems: 1 },
  );

  const hook = renderHook(
    ({ keepUsersQuery }: { keepUsersQuery: boolean }) => {
      env.apiStore.useListQuery(keepUsersQuery ? { tableId: 'users' } : false, {
        returnRefetchingStatus: true,
      });

      return env.apiStore.useFindItem((item) => item.name === 'User 1');
    },
    { initialProps: { keepUsersQuery: true } },
  );
  await flushAllTimers();

  hook.rerender({ keepUsersQuery: false });
  await flushAllTimers();

  env.scheduleFetch('highPriority', { tableId: 'orders' });
  await flushAllTimers();

  expect(pick(hook.result.current, ['id', 'name'])).toMatchInlineSnapshot(`
    id: 1
    name: 'User 1'
  `);
  expect(pick(env.apiStore.getItemState('users||1'), ['id', 'name']))
    .toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);
  expect(env.apiStore.getItemState('users||2')).toBeUndefined();
});
