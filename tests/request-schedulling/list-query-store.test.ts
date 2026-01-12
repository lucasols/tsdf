import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

const usersQueryParams: ListQueryParams = { tableId: 'users' };

describe('test helpers', () => {
  test('snapshot is equal to loaded state', async () => {
    const loaded = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: false,
    });

    loaded.forceListUpdate(usersQueryParams);

    await vi.runAllTimersAsync();

    const withUserSnapshot = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: true,
      disableRefetchOnMount: true,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(loaded.store.state).toEqual(withUserSnapshot.store.state);

    loaded.forceListUpdate({ tableId: 'products' });

    await vi.runAllTimersAsync();

    const withSnapshot = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: true,
      disableRefetchOnMount: true,
      useLoadedSnapshot: { tables: ['users', 'products'] },
    });

    expect(loaded.store.state).toEqual(withSnapshot.store.state);
  });

  test('snapshot with filter is equal to loaded state', async () => {
    const loaded = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: false,
    });

    loaded.forceListUpdate({
      tableId: 'users',
      filters: [{ op: 'gt', field: 'id', value: 2 }],
    });

    await vi.runAllTimersAsync();

    const withUserSnapshot = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: true,
      disableRefetchOnMount: true,
      useLoadedSnapshot: {
        queries: [
          { tableId: 'users', filters: [{ op: 'gt', field: 'id', value: 2 }] },
        ],
      },
    });

    expect(loaded.store.state).toEqual(withUserSnapshot.store.state);
  });
});

describe('fetch query', () => {
  test('fetch query', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: false,
    });

    expect(env.store.state).toEqual({
      items: {},
      queries: {},
      itemQueries: {},
    });

    env.scheduleFetch('lowPriority', usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'loading'
      wasLoaded: '❌'
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      hasMore: '❌'
      items: []
    `);
    expect(env.store.state.items).toEqual({});

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
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
      useLoadedSnapshot: { tables: ['users'] },
    });

    env.serverTable.updateItem('users||1', { name: 'Updated User 1' });

    env.scheduleFetch('highPriority', usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'refetching'
      refetchOnMount: '❌'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      hasMore: '❌'
      `);
    expect(env.store.state.items).toMatchInlineSnapshot(`
      "users||1: { id: 1, name: 'User 1' }
      "users||2: { id: 2, name: 'User 2' }
      "users||3: { id: 3, name: 'User 3' }
      "users||4: { id: 4, name: 'User 4' }
      "users||5: { id: 5, name: 'User 5' }
    `);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      refetchOnMount: '❌'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      hasMore: '❌'
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
      useLoadedSnapshot: { tables: ['users'] },
    });

    env.serverTable.setNextListFetchError('error');

    env.forceListUpdate(usersQueryParams);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'error' }
      status: 'error'
      refetchOnMount: '❌'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      hasMore: '❌'
      `);

    // refetch with success
    env.forceListUpdate(usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'refetching'
      refetchOnMount: '❌'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      hasMore: '❌'
      `);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      refetchOnMount: '❌'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      hasMore: '❌'
      `);
  });

  test('load list with error', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: false,
    });

    env.serverTable.setNextListFetchError('error');

    env.forceListUpdate(usersQueryParams);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'error' }
      status: 'error'
      wasLoaded: '❌'
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      hasMore: '❌'
      items: []
      `);

    // refetch with success
    env.forceListUpdate(usersQueryParams);

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'loading'
      wasLoaded: '❌'
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      hasMore: '❌'
      items: []
      `);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(usersQueryParams)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      wasLoaded: '✅'
      payload: { tableId: 'users' }
      refetchOnMount: '❌'
      hasMore: '❌'
      items: ['"users||1', '"users||2', '"users||3', '"users||4', '"users||5']
      `);
  });

  test('fetch with size', async () => {
    const query: ListQueryParams = { tableId: 'products' };

    const env = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: false,
      defaultQuerySize: 5,
    });

    env.scheduleFetch('highPriority', query, 5);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      wasLoaded: '✅'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      hasMore: '✅'
      items: ['"products||1', '"products||2', '"products||3', '"products||4', '"products||5']
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
      status: 'loadingMore'
      wasLoaded: '✅'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      hasMore: '✅'
      items: ['"products||1', '"products||2', '"products||3', '"products||4', '"products||5']
    `);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      wasLoaded: '✅'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
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
    `);
    expect(env.store.state.items).toMatchInlineSnapshot(`
      "products||1: { id: 1, name: 'Product 1' }
      "products||2: { id: 2, name: 'Product 2' }
      "products||3: { id: 3, name: 'Product 3' }
      "products||4: { id: 4, name: 'Product 4' }
      "products||5: { id: 5, name: 'Product 5' }
      "products||6: { id: 6, name: 'Product 6' }
      "products||7: { id: 7, name: 'Product 7' }
      "products||8: { id: 8, name: 'Product 8' }
      "products||9: { id: 9, name: 'Product 9' }
      "products||10: { id: 10, name: 'Product 10' }
    `);

    // refetch keep size
    env.forceListUpdate(query);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(query)).toMatchInlineSnapshot(`
      error: null
      status: 'success'
      wasLoaded: '✅'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
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
    `);
  });

  test('do not load more if the query not exists or hasMore === false', () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(env.apiStore.loadMore(usersQueryParams, 10)).toBe('skipped');
    expect(env.apiStore.loadMore({ tableId: 'not found' }, 10)).toBe('skipped');
  });

  test('multiple fetches with different payloads not cancel each other, but cancel same payload fetches', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      disableInitialInvalidation: false,
    });

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

    await vi.runAllTimersAsync();

    expect(env.serverTable.numOfFinishedFetches).toBe(3);

    env.scheduleFetch('lowPriority', { tableId: 'users' });
    env.scheduleFetch('lowPriority', { tableId: 'products' });
    env.scheduleFetch('lowPriority', { tableId: 'orders' });

    env.scheduleFetch('highPriority', { tableId: 'users' });
    env.scheduleFetch('highPriority', { tableId: 'products' });
    env.scheduleFetch('highPriority', { tableId: 'orders' });

    await vi.runAllTimersAsync();

    expect(env.serverTable.numOfFinishedFetches).toBe(6);
  });
});

test('ignore multiple load more made in sequence', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    disableInitialInvalidation: false,
    defaultQuerySize: 5,
  });

  const query: ListQueryParams = { tableId: 'products' };

  env.scheduleFetch('highPriority', query, 5);

  await vi.runAllTimersAsync();

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

  await vi.runAllTimersAsync();

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

  await vi.runAllTimersAsync();

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
    useLoadedSnapshot: { tables: ['users'] },
  });

  env.serverTable.updateItem('users||1', { name: 'Updated User 1' });

  expect(env.apiStore.getItemState('users||1')).toMatchObject({
    name: 'User 1',
  });

  const fetchPromise = env.apiStore.awaitListQueryFetch({ tableId: 'users' });

  await vi.runAllTimersAsync();

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

  await vi.runAllTimersAsync();

  const errorResult = await errorFetchPromise;

  expect(errorResult.items).toEqual([]);
  expect(errorResult.error).toBeDefined();
  expect(errorResult.error?.message).toBe('error');
  expect(errorResult.hasMore).toBe(false);

  expect(env.serverTable.numOfFinishedFetches).toEqual(2);
});

describe.concurrent('fetch item', () => {
  test.concurrent('fetch item', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
    });

    expect(
      listQueryStore.store.state.itemQueries['users||1'],
    ).toMatchInlineSnapshotString('undefined');

    listQueryStore.scheduleItemFetch('lowPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
      {
        "error": null,
        "payload": "users||1",
        "refetchOnMount": false,
        "status": "loading",
        "wasLoaded": false,
      }
    `);
    expect(listQueryStore.getItemState('users||1')).toMatchInlineSnapshotString(
      'undefined',
    );

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
      {
        "error": null,
        "payload": "users||1",
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
    expect(listQueryStore.getItemState('users||1'))
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    expect(serverMock.fetchsCount).toBe(1);
  });

  test.concurrent('await fetch item', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    expect(listQueryStore.getItemState('users||1')).toMatchObject({
      name: 'User 1',
    });

    expect(await listQueryStore.awaitItemFetch('users||1')).toEqual({
      data: { id: 1, name: 'Updated User 1' },
      error: null,
    });

    serverMock.setFetchError('error');

    expect(await listQueryStore.awaitItemFetch('users||1')).toEqual({
      data: null,
      error: { message: 'error' },
    });

    expect(serverMock.fetchsCount).toEqual(2);
  });

  test.concurrent('test helpers inital snapshot', async () => {
    const loaded = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    loaded.store.scheduleItemFetch('lowPriority', 'users||1');

    await loaded.serverMock.waitFetchIdle();

    const withStateSnapshot = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { items: ['users||1'] },
      disableInitialDataInvalidation: true,
    });

    expect(withStateSnapshot.store.store.state).toEqual(
      loaded.store.store.state,
    );
  });

  test.concurrent('test helpers inital snapshot 2', async () => {
    const loaded = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    loaded.store.scheduleItemFetch('lowPriority', 'users||1');
    loaded.store.scheduleListQueryFetch('lowPriority', {
      tableId: 'users',
    });

    await loaded.serverMock.waitFetchIdle();

    const withStateSnapshot = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'], items: ['users||1'] },
      disableInitialDataInvalidation: true,
    });

    expect(withStateSnapshot.store.store.state).toEqual(
      loaded.store.store.state,
    );
  });

  test('refetch item with updated data', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { items: ['users||1'] },
      disableInitialDataInvalidation: true,
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.getItemState('users||1'))
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);

    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "Updated User 1",
        },
      }
    `);

    expect(serverMock.fetchsCount).toBe(1);
  });

  test('refetch item with error', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { items: ['users||1'] },
    });

    serverMock.setFetchError('error');

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": true,
        }
      `);

    // refetch with success
    serverMock.setFetchError(null);

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "User 1",
        },
      }
    `);
  });

  test('load item with error', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    serverMock.setFetchError('error');

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": false,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`{}`);

    // refetch with success
    serverMock.setFetchError(null);

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "loading",
          "wasLoaded": false,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "User 1",
        },
      }
    `);
  });

  test.concurrent(
    'multiple item fetchs with different ids do not cancel each other, but cancel the ones with same id',
    async () => {
      const { serverMock, store: listQueryStore } = createTestEnv({
        initialServerData,
        disableInitialDataInvalidation: true,
      });

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('highPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      await sleep(10);

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      await serverMock.waitFetchIdle(40);

      expect(serverMock.fetchsCount).toBe(3);

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      listQueryStore.scheduleItemFetch('highPriority', 'users||1');
      listQueryStore.scheduleItemFetch('highPriority', 'users||2');
      listQueryStore.scheduleItemFetch('highPriority', 'users||3');

      await serverMock.waitFetchIdle(40);

      expect(serverMock.fetchsCount).toBe(6);
    },
  );

  test('load a item that was previously loaded by a query', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);

    expect(listQueryStore.store.state.items['users||1'])
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);
  });

  test.concurrent(
    'load item should share the lowPriority throttle context of the queries',
    async () => {
      const { store: listQueryStore } = createTestEnv({
        initialServerData,
        disableInitialDataInvalidation: true,
      });

      listQueryStore.scheduleListQueryFetch('highPriority', {
        tableId: 'users',
      });

      await sleep(50);

      const result = listQueryStore.scheduleItemFetch(
        'lowPriority',
        'users||1',
      );

      expect(result).toBe('skipped');
    },
  );
});

describe('an item invalidation with lower priority should not override one with higher priority', () => {
  const itemId = 'users||1';
  const testEnvOptions = {
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  };

  test.concurrent('not override high priority update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'highPriority',
      queryPayload: false,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'lowPriority',
      queryPayload: false,
    });

    expect(env.store.store.state.itemQueries[itemId]?.refetchOnMount).toEqual(
      'highPriority',
    );
  });

  test.concurrent('not override rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'realtimeUpdate',
      queryPayload: false,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'lowPriority',
      queryPayload: false,
    });

    expect(env.store.store.state.itemQueries[itemId]?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test.concurrent('not override highPriority with rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'highPriority',
      queryPayload: false,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'realtimeUpdate',
      queryPayload: false,
    });

    expect(env.store.store.state.itemQueries[itemId]?.refetchOnMount).toEqual(
      'highPriority',
    );
  });
});

describe('a query invalidation with lower priority should not override one with higher priority', () => {
  const queryPayload = { tableId: 'users' };
  const testEnvOptions = {
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  };

  test.concurrent('not override high priority update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: false,
      type: 'highPriority',
      queryPayload,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: false,
      type: 'lowPriority',
      queryPayload,
    });

    expect(env.store.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'highPriority',
    );
  });

  test.concurrent('not override rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'realtimeUpdate',
      itemPayload: false,
    });

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'lowPriority',
      itemPayload: false,
    });

    expect(env.store.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test.concurrent('not override highPriority with rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'highPriority',
      itemPayload: false,
    });

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'realtimeUpdate',
      itemPayload: false,
    });

    expect(env.store.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'highPriority',
    );
  });
});

test('invalidate everything does not cause a problem', () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  });

  env.store.invalidateQueryAndItems({
    queryPayload: () => true,
    itemPayload: () => true,
  });

  expect(env.store.store.state).toEqual({
    itemQueries: {
      'users||1': {
        error: null,
        payload: 'users||1',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||2': {
        error: null,
        payload: 'users||2',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||3': {
        error: null,
        payload: 'users||3',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||4': {
        error: null,
        payload: 'users||4',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||5': {
        error: null,
        payload: 'users||5',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
    },
    items: {
      'users||1': { id: 1, name: 'User 1' },
      'users||2': { id: 2, name: 'User 2' },
      'users||3': { id: 3, name: 'User 3' },
      'users||4': { id: 4, name: 'User 4' },
      'users||5': { id: 5, name: 'User 5' },
    },
    queries: {
      [`{"tableId":"users"}`]: {
        error: null,
        hasMore: false,
        items: ['users||1', 'users||2', 'users||3', 'users||4', 'users||5'],
        payload: { tableId: 'users' },
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
    },
  });
});
