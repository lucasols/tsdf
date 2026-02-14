import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { flushAllTimers, range } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

const usersQueryParams: ListQueryParams = { tableId: 'users' };

describe('test helpers', () => {
  test('snapshot is equal to loaded state', async () => {
    const loaded = createListQueryStoreTestEnv(initialServerData);

    loaded.forceListUpdate(usersQueryParams);

    await flushAllTimers();

    const withUserSnapshot = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(loaded.store.state).toEqual(withUserSnapshot.store.state);

    loaded.forceListUpdate({ tableId: 'products' });

    await flushAllTimers();

    const withSnapshot = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });

    expect(loaded.store.state).toEqual(withSnapshot.store.state);
  });

  test('snapshot with filter is equal to loaded state', async () => {
    const loaded = createListQueryStoreTestEnv(initialServerData);

    loaded.forceListUpdate({
      tableId: 'users',
      filters: [{ op: 'gt', field: 'id', value: 2 }],
    });

    await flushAllTimers();

    const withUserSnapshot = createListQueryStoreTestEnv(initialServerData, {
      testScenario: {
        loaded: {
          queries: [
            {
              tableId: 'users',
              filters: [{ op: 'gt', field: 'id', value: 2 }],
            },
          ],
        },
      },
    });

    expect(loaded.store.state).toEqual(withUserSnapshot.store.state);
  });
});

describe('fetch query', () => {
  test('fetch query', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    expect(env.store.state).toEqual({
      items: {},
      queries: {},
      itemQueries: {},
      itemLoadedFields: {},
      itemFieldInvalidationFields: {},
    });

    env.scheduleFetch('lowPriority', usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: []
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'loading'
      wasLoaded: '❌'
    `);
    expect(env.store.state.items).toEqual({});

    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(`
      "users||1: { id: 1, name: 'User 1' }
      "users||2: { id: 2, name: 'User 2' }
      "users||3: { id: 3, name: 'User 3' }
      "users||4: { id: 4, name: 'User 4' }
      "users||5: { id: 5, name: 'User 5' }
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('refetch list with updated data', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    env.serverTable.updateItem('users||1', { name: 'Updated User 1' });

    env.scheduleFetch('highPriority', usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'refetching'
      wasLoaded: '✅'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(`
      "users||1: { id: 1, name: 'User 1' }
      "users||2: { id: 2, name: 'User 2' }
      "users||3: { id: 3, name: 'User 3' }
      "users||4: { id: 4, name: 'User 4' }
      "users||5: { id: 5, name: 'User 5' }
    `);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(env.store.state.items).toMatchInlineSnapshot(`
      "users||1: { id: 1, name: 'Updated User 1' }
      "users||2: { id: 2, name: 'User 2' }
      "users||3: { id: 3, name: 'User 3' }
      "users||4: { id: 4, name: 'User 4' }
      "users||5: { id: 5, name: 'User 5' }
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('refetch list with error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    env.serverTable.setNextListFetchError('error');

    env.forceListUpdate(usersQueryParams);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'error' }
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'error'
      wasLoaded: '✅'
    `);

    // refetch with success
    env.forceListUpdate(usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'refetching'
      wasLoaded: '✅'
    `);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('load list with error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    env.serverTable.setNextListFetchError('error');

    env.forceListUpdate(usersQueryParams);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'error' }
      hasMore: '❌'
      items: []
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'error'
      wasLoaded: '❌'
    `);

    // refetch with success
    env.forceListUpdate(usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: []
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'loading'
      wasLoaded: '❌'
    `);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('fetch with size', async () => {
    const query: ListQueryParams = { tableId: 'products' };

    const env = createListQueryStoreTestEnv(initialServerData, {
      defaultQuerySize: 5,
    });

    env.scheduleFetch('highPriority', query, 5);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items: ['"products||1', '"products||2', '"products||3', '"products||4', '"products||5']
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(`
      "products||1: { id: 1, name: 'Product 1' }
      "products||2: { id: 2, name: 'Product 2' }
      "products||3: { id: 3, name: 'Product 3' }
      "products||4: { id: 4, name: 'Product 4' }
      "products||5: { id: 5, name: 'Product 5' }
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    // load more
    env.apiStore.loadMore(query);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items: ['"products||1', '"products||2', '"products||3', '"products||4', '"products||5']
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'loadingMore'
      wasLoaded: '✅'
    `);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(`
      "products||1: { id: 1, name: 'Product 1' }
      "products||10: { id: 10, name: 'Product 10' }
      "products||2: { id: 2, name: 'Product 2' }
      "products||3: { id: 3, name: 'Product 3' }
      "products||4: { id: 4, name: 'Product 4' }
      "products||5: { id: 5, name: 'Product 5' }
      "products||6: { id: 6, name: 'Product 6' }
      "products||7: { id: 7, name: 'Product 7' }
      "products||8: { id: 8, name: 'Product 8' }
      "products||9: { id: 9, name: 'Product 9' }
    `);

    // refetch keep size
    env.forceListUpdate(query);

    await flushAllTimers();

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('do not load more if the query not exists or hasMore === false', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    expect(env.apiStore.loadMore(usersQueryParams, 10)).toBe('skipped');
    expect(env.apiStore.loadMore({ tableId: 'not found' }, 10)).toBe('skipped');
  });

  test('multiple fetches with different payloads not cancel each other, but cancel same payload fetches', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    env.scheduleFetch('lowPriority', { tableId: 'users' });
    env.scheduleFetch('lowPriority', { tableId: 'products' });
    env.scheduleFetch('lowPriority', { tableId: 'orders' });

    env.scheduleFetch('lowPriority', { tableId: 'users' });
    env.scheduleFetch('highPriority', { tableId: 'products' });
    env.scheduleFetch('lowPriority', { tableId: 'orders' });

    await vi.advanceTimersByTimeAsync(10);

    env.scheduleFetch('lowPriority', { tableId: 'users' });
    env.scheduleFetch('lowPriority', { tableId: 'products' });
    env.scheduleFetch('lowPriority', { tableId: 'orders' });

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(3);

    env.scheduleFetch('lowPriority', { tableId: 'users' });
    env.scheduleFetch('lowPriority', { tableId: 'products' });
    env.scheduleFetch('lowPriority', { tableId: 'orders' });

    env.scheduleFetch('highPriority', { tableId: 'users' });
    env.scheduleFetch('highPriority', { tableId: 'products' });
    env.scheduleFetch('highPriority', { tableId: 'orders' });

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(6);
  });
});

test('ignore multiple load more made in sequence', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    defaultQuerySize: 5,
  });

  const query: ListQueryParams = { tableId: 'products' };

  env.scheduleFetch('highPriority', query, 5);

  await flushAllTimers();

  expect(env.apiStore.getQueryState(query)?.items).toMatchInlineSnapshot(
    `['"products||1', '"products||2', '"products||3', '"products||4', '"products||5']`,
  );

  expect(env.apiStore.loadMore(query)).toBe('triggered');
  expect(env.apiStore.loadMore(query)).toBe('coalesced');
  expect(env.apiStore.loadMore(query)).toBe('coalesced');
  expect(env.apiStore.loadMore(query)).toBe('coalesced');

  await vi.advanceTimersByTimeAsync(15);

  expect(env.apiStore.loadMore(query)).toBe('skipped');
  expect(env.apiStore.loadMore(query)).toBe('skipped');

  await flushAllTimers();

  expect(env.apiStore.getQueryState(query)?.items).toMatchInlineSnapshot(`
    - '"products||1'
    - '"products||2'
    - '"products||3'
    - '"products||4'
    - '"products||5'
    - '"products||6'
    - '"products||7'
    - '"products||8'
    - '"products||9'
    - '"products||10'
  `);

  expect(env.apiStore.loadMore(query)).toBe('triggered');
  expect(env.apiStore.loadMore(query)).toBe('coalesced');

  await flushAllTimers();

  expect(env.apiStore.getQueryState(query)?.items).toMatchInlineSnapshot(`
    - '"products||1'
    - '"products||2'
    - '"products||3'
    - '"products||4'
    - '"products||5'
    - '"products||6'
    - '"products||7'
    - '"products||8'
    - '"products||9'
    - '"products||10'
    - '"products||11'
    - '"products||12'
    - '"products||13'
    - '"products||14'
    - '"products||15'
  `);
});

test('await fetch', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });

  env.serverTable.updateItem('users||1', { name: 'Updated User 1' });

  expect(env.apiStore.getItemState('users||1')).toMatchObject({
    name: 'User 1',
  });

  const fetchPromise = env.apiStore.awaitListQueryFetch({ tableId: 'users' });

  await flushAllTimers();

  const fetchResult = await fetchPromise;

  expect(fetchResult).toEqual({
    items: [
      { itemPayload: 'users||1', data: { id: 1, name: 'Updated User 1' } },
      { itemPayload: 'users||2', data: { id: 2, name: 'User 2' } },
      { itemPayload: 'users||3', data: { id: 3, name: 'User 3' } },
      { itemPayload: 'users||4', data: { id: 4, name: 'User 4' } },
      { itemPayload: 'users||5', data: { id: 5, name: 'User 5' } },
    ],
    error: null,
    hasMore: false,
  });

  env.serverTable.setNextListFetchError('error');

  const errorFetchPromise = env.apiStore.awaitListQueryFetch(
    { tableId: 'users' },
    { size: 2 },
  );

  await flushAllTimers();

  const errorResult = await errorFetchPromise;

  expect(errorResult.items).toEqual([]);
  expect(errorResult.error).toBeDefined();
  expect(errorResult.error?.message).toBe('error');
  expect(errorResult.hasMore).toBe(false);

  expect(env.serverTable.numOfFinishedFetches).toEqual(2);
});

describe('fetch item', () => {
  test('fetch item', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(
      `undefined`,
    );

    env.scheduleItemFetch('lowPriority', 'users||1');

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'loading'
      wasLoaded: '❌'
    `);
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(
      `undefined`,
    );

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('await fetch item', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    env.serverTable.updateItem('users||1', { name: 'Updated User 1' });

    expect(env.apiStore.getItemState('users||1')).toMatchObject({
      name: 'User 1',
    });

    const fetchPromise = env.apiStore.awaitItemFetch('users||1');

    await flushAllTimers();

    const fetchResult = await fetchPromise;

    expect(fetchResult).toEqual({
      data: { id: 1, name: 'Updated User 1' },
      error: null,
    });

    env.serverTable.setNextFetchError('users||1', 'error');

    const errorFetchPromise = env.apiStore.awaitItemFetch('users||1');

    await flushAllTimers();

    const errorResult = await errorFetchPromise;

    expect(errorResult).toMatchObject({
      data: null,
      error: { message: 'error' },
    });

    expect(env.serverTable.numOfFinishedFetches).toEqual(2);
  });

  test('test helpers initial snapshot', async () => {
    const loaded = createListQueryStoreTestEnv(initialServerData);

    loaded.scheduleItemFetch('lowPriority', 'users||1');

    await flushAllTimers();

    const withStateSnapshot = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { items: ['users||1'] } },
    });

    expect(withStateSnapshot.store.state).toEqual(loaded.store.state);
  });

  test('test helpers initial snapshot 2', async () => {
    const loaded = createListQueryStoreTestEnv(initialServerData);

    loaded.scheduleItemFetch('lowPriority', 'users||1');
    loaded.scheduleFetch('lowPriority', { tableId: 'users' });

    await flushAllTimers();

    const withStateSnapshot = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'], items: ['users||1'] } },
    });

    expect(withStateSnapshot.store.state).toEqual(loaded.store.state);
  });

  test('refetch item with updated data', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { items: ['users||1'] } },
    });

    env.serverTable.updateItem('users||1', { name: 'Updated User 1' });

    env.scheduleItemFetch('highPriority', 'users||1');

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'refetching'
      wasLoaded: '✅'
    `);
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(env.store.state.items).toMatchInlineSnapshot(
      `"users||1: { id: 1, name: 'Updated User 1' }`,
    );

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('refetch item with error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { items: ['users||1'] } },
    });

    env.serverTable.setNextFetchError('users||1', 'error');

    env.scheduleItemFetch('highPriority', 'users||1');

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'error' }
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'error'
      wasLoaded: '✅'
    `);

    // refetch with success
    env.scheduleItemFetch('highPriority', 'users||1');

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'refetching'
      wasLoaded: '✅'
    `);

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(
      `"users||1: { id: 1, name: 'User 1' }`,
    );
  });

  test('load item with error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    env.serverTable.setNextFetchError('users||1', 'error');

    env.scheduleItemFetch('highPriority', 'users||1');

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'error' }
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'error'
      wasLoaded: '❌'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(`{}`);

    // refetch with success
    env.scheduleItemFetch('highPriority', 'users||1');

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'loading'
      wasLoaded: '❌'
    `);

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(
      `"users||1: { id: 1, name: 'User 1' }`,
    );
  });

  test('multiple item fetches with different ids do not cancel each other, but cancel the ones with same id', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    env.scheduleItemFetch('lowPriority', 'users||1');
    env.scheduleItemFetch('lowPriority', 'users||2');
    env.scheduleItemFetch('lowPriority', 'users||3');

    env.scheduleItemFetch('lowPriority', 'users||1');
    env.scheduleItemFetch('highPriority', 'users||2');
    env.scheduleItemFetch('lowPriority', 'users||3');

    await vi.advanceTimersByTimeAsync(10);

    env.scheduleItemFetch('lowPriority', 'users||1');
    env.scheduleItemFetch('lowPriority', 'users||2');
    env.scheduleItemFetch('lowPriority', 'users||3');

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(3);

    env.scheduleItemFetch('lowPriority', 'users||1');
    env.scheduleItemFetch('lowPriority', 'users||2');
    env.scheduleItemFetch('lowPriority', 'users||3');

    env.scheduleItemFetch('highPriority', 'users||1');
    env.scheduleItemFetch('highPriority', 'users||2');
    env.scheduleItemFetch('highPriority', 'users||3');

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(6);
  });

  test('load a item that was previously loaded by a query', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users'] } },
    });

    env.scheduleItemFetch('highPriority', 'users||1');

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'refetching'
      wasLoaded: '✅'
    `);

    await flushAllTimers();

    expect(env.getItemQueryState('users||1')).toMatchInlineSnapshot(`
      error: null
      payload: 'users||1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(
      `
        id: 1
        name: 'User 1'
      `,
    );
  });

  test('load item should share the lowPriority throttle context of the queries', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      lowPriorityThrottleMs: 1000, // Must be > fetch duration (800ms default)
    });

    env.scheduleFetch('highPriority', { tableId: 'users' });

    // Wait for fetch to complete
    await flushAllTimers();

    // After list fetch completes, a lowPriority item fetch is triggered
    // because query and item schedulers have separate timing contexts
    const result = env.scheduleItemFetch('lowPriority', 'users||1');

    // The item scheduler has its own throttle context
    expect(result).toBe('skipped');
  });

  test('load item should share lowPriority throttle with queries when batch fetch is enabled', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      lowPriorityThrottleMs: 1000, // Must be > fetch duration (800ms default)
      useBatchFetch: true,
    });

    env.scheduleFetch('highPriority', { tableId: 'users' });

    await flushAllTimers();

    const result = env.scheduleItemFetch('lowPriority', 'users||1');

    expect(result).toBe('skipped');
  });

  test('load item should share lowPriority throttle with grouped batch schedulers', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      lowPriorityThrottleMs: 1000, // Must be > fetch duration (800ms default)
      useBatchFetch: true,
      getItemsBatchKey: (payload) => payload.split('||')[0] ?? '__default__',
    });

    env.scheduleFetch('highPriority', { tableId: 'users' });

    await flushAllTimers();

    const result = env.scheduleItemFetch('lowPriority', 'users||1');

    expect(result).toBe('skipped');
  });
});

describe('an item invalidation with lower priority should not override one with higher priority', () => {
  const rawItemId = 'users||1';
  const testEnvOptions = {
    testScenario: { loaded: { tables: ['users'] } },
  };

  test('not override high priority update', () => {
    const env = createListQueryStoreTestEnv(initialServerData, testEnvOptions);
    const storeItemKey = env.getStoreItemKeyFromRaw(rawItemId);

    env.apiStore.invalidateQueryAndItems({
      itemPayload: rawItemId,
      type: 'highPriority',
      queryPayload: false,
    });

    env.apiStore.invalidateQueryAndItems({
      itemPayload: rawItemId,
      type: 'lowPriority',
      queryPayload: false,
    });

    expect(env.store.state.itemQueries[storeItemKey]?.refetchOnMount).toEqual(
      'highPriority',
    );
  });

  test('not override rtu update', () => {
    const env = createListQueryStoreTestEnv(initialServerData, testEnvOptions);
    const storeItemKey = env.getStoreItemKeyFromRaw(rawItemId);

    env.apiStore.invalidateQueryAndItems({
      itemPayload: rawItemId,
      type: 'realtimeUpdate',
      queryPayload: false,
    });

    env.apiStore.invalidateQueryAndItems({
      itemPayload: rawItemId,
      type: 'lowPriority',
      queryPayload: false,
    });

    expect(env.store.state.itemQueries[storeItemKey]?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test('not override highPriority with rtu update', () => {
    const env = createListQueryStoreTestEnv(initialServerData, testEnvOptions);
    const storeItemKey = env.getStoreItemKeyFromRaw(rawItemId);

    env.apiStore.invalidateQueryAndItems({
      itemPayload: rawItemId,
      type: 'highPriority',
      queryPayload: false,
    });

    env.apiStore.invalidateQueryAndItems({
      itemPayload: rawItemId,
      type: 'realtimeUpdate',
      queryPayload: false,
    });

    expect(env.store.state.itemQueries[storeItemKey]?.refetchOnMount).toEqual(
      'highPriority',
    );
  });
});

describe('a query invalidation with lower priority should not override one with higher priority', () => {
  const queryPayload: ListQueryParams = { tableId: 'users' };
  const testEnvOptions = {
    testScenario: { loaded: { tables: ['users'] } },
  };

  test('not override high priority update', () => {
    const env = createListQueryStoreTestEnv(initialServerData, testEnvOptions);

    env.apiStore.invalidateQueryAndItems({
      itemPayload: false,
      type: 'highPriority',
      queryPayload,
    });

    env.apiStore.invalidateQueryAndItems({
      itemPayload: false,
      type: 'lowPriority',
      queryPayload,
    });

    expect(env.apiStore.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'highPriority',
    );
  });

  test('not override rtu update', () => {
    const env = createListQueryStoreTestEnv(initialServerData, testEnvOptions);

    env.apiStore.invalidateQueryAndItems({
      queryPayload,
      type: 'realtimeUpdate',
      itemPayload: false,
    });

    env.apiStore.invalidateQueryAndItems({
      queryPayload,
      type: 'lowPriority',
      itemPayload: false,
    });

    expect(env.apiStore.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test('not override highPriority with rtu update', () => {
    const env = createListQueryStoreTestEnv(initialServerData, testEnvOptions);

    env.apiStore.invalidateQueryAndItems({
      queryPayload,
      type: 'highPriority',
      itemPayload: false,
    });

    env.apiStore.invalidateQueryAndItems({
      queryPayload,
      type: 'realtimeUpdate',
      itemPayload: false,
    });

    expect(env.apiStore.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'highPriority',
    );
  });
});

test('invalidate everything does not cause a problem', () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
  });

  env.apiStore.invalidateQueryAndItems({
    queryPayload: () => true,
    itemPayload: () => true,
  });

  // Store keys have a leading quote from getCompositeKey
  const k1 = env.getStoreItemKeyFromRaw('users||1');
  const k2 = env.getStoreItemKeyFromRaw('users||2');
  const k3 = env.getStoreItemKeyFromRaw('users||3');
  const k4 = env.getStoreItemKeyFromRaw('users||4');
  const k5 = env.getStoreItemKeyFromRaw('users||5');
  const queryKey = env.getQueryKey({ tableId: 'users' });

  expect(env.store.state).toEqual({
    itemQueries: {
      [k1]: {
        error: null,
        payload: 'users||1',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      [k2]: {
        error: null,
        payload: 'users||2',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      [k3]: {
        error: null,
        payload: 'users||3',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      [k4]: {
        error: null,
        payload: 'users||4',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      [k5]: {
        error: null,
        payload: 'users||5',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
    },
    items: {
      [k1]: { id: 1, name: 'User 1' },
      [k2]: { id: 2, name: 'User 2' },
      [k3]: { id: 3, name: 'User 3' },
      [k4]: { id: 4, name: 'User 4' },
      [k5]: { id: 5, name: 'User 5' },
    },
    queries: {
      [queryKey]: {
        error: null,
        hasMore: false,
        items: [k1, k2, k3, k4, k5],
        payload: { tableId: 'users' },
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
    },
    itemLoadedFields: {},
    itemFieldInvalidationFields: {},
  });
});
