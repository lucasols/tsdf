import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
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
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, range } from '../utils/genericTestUtils';

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
  products: range(1, 3).map((id) => ({ id, name: `Product ${id}` })),
};

type StoreValue = { hello: string };

describe('document store', () => {
  test('fetches when idle (initial load)', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useDocument({ disableRefetches: true });
      renders.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: loading
      -> data: {hello:world} ⋅ status: success
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useDocument({
        disableRefetches: true,
        returnRefetchingStatus: true,
      });
      renders.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: {hello:world} ⋅ status: success
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useDocument({ disableRefetches: true });
      renders.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();
    expect(env.serverMock.numOfFinishedFetches).toBe(0);

    act(() => {
      env.setServerData({ hello: 'updated' });
      env.apiStore.invalidateData();
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: {hello:world} ⋅ status: success
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(0);
  });

  test('ensureIsLoaded bypasses disableRefetches', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useDocument({
        disableRefetches: true,
        ensureIsLoaded: true,
      });
      renders.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();

    // ensureIsLoaded forces a high-priority fetch regardless of disableRefetches
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: {hello:world} ⋅ status: loading
      -> data: {hello:world} ⋅ status: success
      "
    `);
  });

  test('retries fetch on remount after error', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    env.errorInNextFetch('Fetch error');

    const renders = createLoggerStore();

    const { unmount } = renderHook(() => {
      const result = env.apiStore.useDocument({ disableRefetches: true });
      renders.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: loading
      -> data: null ⋅ status: error
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    // Unmount and advance past the low-priority throttle window (200ms),
    // then remount — status is 'error', so disableRefetches allows the retry
    unmount();

    await advanceTime(200);

    const renders2 = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useDocument({ disableRefetches: true });
      renders2.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: error
      -> data: null ⋅ status: loading
      -> data: {hello:world} ⋅ status: success
      "
    `);
    // A retry fetch was triggered because error state allows refetch
    expect(env.serverMock.numOfFinishedFetches).toBe(2);
  });
});

describe('collection store', () => {
  test('fetches when item not loaded', async () => {
    const env = createCollectionStoreTestEnv<Todo>({ '1': defaultTodo });

    const renders = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem('1', { disableRefetches: true });
      renders.add({ status: item.status, data: item.data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {title:todo, completed:❌}
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem('1', {
        disableRefetches: true,
        returnRefetchingStatus: true,
      });
      renders.add({ status: item.status, data: item.data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {title:todo, completed:❌}
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem('1', {
        disableRefetches: true,
        returnRefetchingStatus: true,
      });
      renders.add({ status: item.status, data: item.data?.value ?? null });
    });

    await flushAllTimers();
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      env.serverTable.setItem('1', { title: 'todo', completed: true });
      env.apiStore.invalidateItem('1');
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {title:todo, completed:❌}
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('retries fetch on remount after error', async () => {
    const env = createCollectionStoreTestEnv<Todo>({ '1': defaultTodo });

    env.serverTable.setNextFetchError('1', 'Fetch error');

    const renders = createLoggerStore();

    const { unmount } = renderHook(() => {
      const item = env.apiStore.useItem('1', { disableRefetches: true });
      renders.add({ status: item.status, data: item.data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: error ⋅ data: null
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    // Unmount and advance past the low-priority throttle window (200ms),
    // then remount — wasLoaded is still false after error,
    // so disableRefetches allows the retry
    unmount();

    await advanceTime(200);

    const renders2 = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem('1', { disableRefetches: true });
      renders2.add({ status: item.status, data: item.data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: error ⋅ data: null
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {title:todo, completed:❌}
      "
    `);
    // A retry fetch was triggered because wasLoaded stayed false on error
    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });
});

describe('collection store - useMultipleItems', () => {
  test('fetches when items not loaded', async () => {
    const env = createCollectionStoreTestEnv<Todo>({
      '1': defaultTodo,
      '2': { title: 'todo 2', completed: true },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        [{ payload: '1' }, { payload: '2' }],
        { disableRefetches: true },
      );
      renders.add({
        item1Status: item1?.status,
        item1Data: item1?.data?.value ?? null,
        item2Status: item2?.status,
        item2Data: item2?.data?.value ?? null,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> item1Status: loading ⋅ item1Data: null ⋅ item2Status: loading ⋅ item2Data: null
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {title:todo, completed:❌}
      ⋅ item2Status: loading
      ⋅ item2Data: null
      └─
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {title:todo, completed:❌}
      ⋅ item2Status: success
      ⋅ item2Data: {title:todo 2, completed:✅}
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': { title: 'todo 2', completed: true } },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        [{ payload: '1' }, { payload: '2' }],
        { disableRefetches: true, returnRefetchingStatus: true },
      );
      renders.add({
        item1Status: item1?.status,
        item1Data: item1?.data?.value ?? null,
        item2Status: item2?.status,
        item2Data: item2?.data?.value ?? null,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {title:todo, completed:❌}
      ⋅ item2Status: success
      ⋅ item2Data: {title:todo 2, completed:✅}
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': { title: 'todo 2', completed: true } },
      { testScenario: 'loaded' },
    );

    const renders = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        [{ payload: '1' }, { payload: '2' }],
        { disableRefetches: true },
      );
      renders.add({
        item1Status: item1?.status,
        item1Data: item1?.data?.value ?? null,
        item2Status: item2?.status,
        item2Data: item2?.data?.value ?? null,
      });
    });

    await flushAllTimers();
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      env.serverTable.setItem('1', { title: 'updated', completed: true });
      env.apiStore.invalidateItem('1');
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {title:todo, completed:❌}
      ⋅ item2Status: success
      ⋅ item2Data: {title:todo 2, completed:✅}
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('list query store - queries', () => {
  test('fetches when query not loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const renders = createLoggerStore();

    renderHook(() => {
      const query = env.apiStore.useListQuery(
        { tableId: 'users' },
        { disableRefetches: true },
      );
      renders.add({ status: query.status, itemCount: query.items.length });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ itemCount: 0
      -> status: success ⋅ itemCount: 5
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const query = env.apiStore.useListQuery(
        { tableId: 'users' },
        { disableRefetches: true, returnRefetchingStatus: true },
      );
      renders.add({ status: query.status, itemCount: query.items.length });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ itemCount: 5
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const query = env.apiStore.useListQuery(
        { tableId: 'users' },
        { disableRefetches: true, returnRefetchingStatus: true },
      );
      renders.add({ status: query.status, itemCount: query.items.length });
    });

    await flushAllTimers();
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: false,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ itemCount: 5
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('list query store - useMultipleListQueries', () => {
  test('fetches when queries not loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const renders = createLoggerStore();

    renderHook(() => {
      const [query1, query2] = env.apiStore.useMultipleListQueries(
        [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        { disableRefetches: true },
      );
      renders.add({
        usersStatus: query1?.status,
        usersCount: query1?.items.length,
        productsStatus: query2?.status,
        productsCount: query2?.items.length,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ usersStatus: loading
      ⋅ usersCount: 0
      ⋅ productsStatus: loading
      ⋅ productsCount: 0
      └─
      ┌─
      ⋅ usersStatus: success
      ⋅ usersCount: 5
      ⋅ productsStatus: loading
      ⋅ productsCount: 0
      └─
      ┌─
      ⋅ usersStatus: success
      ⋅ usersCount: 5
      ⋅ productsStatus: success
      ⋅ productsCount: 3
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const [query1, query2] = env.apiStore.useMultipleListQueries(
        [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        { disableRefetches: true, returnRefetchingStatus: true },
      );
      renders.add({
        usersStatus: query1?.status,
        usersCount: query1?.items.length,
        productsStatus: query2?.status,
        productsCount: query2?.items.length,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ usersStatus: success
      ⋅ usersCount: 5
      ⋅ productsStatus: success
      ⋅ productsCount: 3
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const [query1, query2] = env.apiStore.useMultipleListQueries(
        [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        { disableRefetches: true },
      );
      renders.add({
        usersStatus: query1?.status,
        usersCount: query1?.items.length,
        productsStatus: query2?.status,
        productsCount: query2?.items.length,
      });
    });

    await flushAllTimers();
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: { tableId: 'users' },
        itemPayload: false,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ usersStatus: success
      ⋅ usersCount: 5
      ⋅ productsStatus: success
      ⋅ productsCount: 3
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('list query store - items', () => {
  test('fetches when item not loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const itemKey = env.getItemKey('users', 1);

    const renders = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem(itemKey, { disableRefetches: true });
      renders.add({ status: item.status, data: item.data });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    const itemKey = env.getItemKey('users', 1);

    const renders = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem(itemKey, {
        disableRefetches: true,
        returnRefetchingStatus: true,
      });
      renders.add({ status: item.status, data: item.data });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    const itemKey = env.getItemKey('users', 1);

    const renders = createLoggerStore();

    renderHook(() => {
      const item = env.apiStore.useItem(itemKey, {
        disableRefetches: true,
        returnRefetchingStatus: true,
      });
      renders.add({ status: item.status, data: item.data });
    });

    await flushAllTimers();
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      env.apiStore.invalidateItem(itemKey);
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('list query store - useMultipleItems', () => {
  test('fetches when items not loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const itemKey1 = env.getItemKey('users', 1);
    const itemKey2 = env.getItemKey('users', 2);

    const renders = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        [{ payload: itemKey1 }, { payload: itemKey2 }],
        { disableRefetches: true },
      );
      renders.add({
        item1Status: item1?.status,
        item1Data: item1?.data,
        item2Status: item2?.status,
        item2Data: item2?.data,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> item1Status: loading ⋅ item1Data: null ⋅ item2Status: loading ⋅ item2Data: null
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {id:1, name:User 1}
      ⋅ item2Status: loading
      ⋅ item2Data: null
      └─
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {id:1, name:User 1}
      ⋅ item2Status: success
      ⋅ item2Data: {id:2, name:User 2}
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('skips refetch on mount when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    const itemKey1 = env.getItemKey('users', 1);
    const itemKey2 = env.getItemKey('users', 2);

    const renders = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        [{ payload: itemKey1 }, { payload: itemKey2 }],
        { disableRefetches: true, returnRefetchingStatus: true },
      );
      renders.add({
        item1Status: item1?.status,
        item1Data: item1?.data,
        item2Status: item2?.status,
        item2Data: item2?.data,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {id:1, name:User 1}
      ⋅ item2Status: success
      ⋅ item2Data: {id:2, name:User 2}
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('skips invalidation when already loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    const itemKey1 = env.getItemKey('users', 1);
    const itemKey2 = env.getItemKey('users', 2);

    const renders = createLoggerStore();

    renderHook(() => {
      const [item1, item2] = env.apiStore.useMultipleItems(
        [{ payload: itemKey1 }, { payload: itemKey2 }],
        { disableRefetches: true },
      );
      renders.add({
        item1Status: item1?.status,
        item1Data: item1?.data,
        item2Status: item2?.status,
        item2Data: item2?.data,
      });
    });

    await flushAllTimers();
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    act(() => {
      env.apiStore.invalidateItem(itemKey1);
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ item1Status: success
      ⋅ item1Data: {id:1, name:User 1}
      ⋅ item2Status: success
      ⋅ item2Data: {id:2, name:User 2}
      └─
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});
