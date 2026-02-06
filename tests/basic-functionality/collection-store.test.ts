import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { DEFAULT_FETCH_DURATION_MS } from '../mocks/serverTableMock';

type TodoItem = { title: string; completed: boolean };

const defaultTodo: TodoItem = { title: 'todo', completed: false };

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('test helpers', () => {
  test('start with store initialized state', () => {
    const { store } = createCollectionStoreTestEnv(
      { '1': defaultTodo, '2': defaultTodo },
      {
      useLoadedSnapshot: true,
        disableDataInvalidation: true,
      },
    );

    expect(store.state).toMatchInlineSnapshot(`
      "1:
        data:
          value: { completed: '❌', title: 'todo' }
        error: null
        payload: '1'
        refetchOnMount: '❌'
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
  });
});

describe('fetch lifecycle', () => {
  const env = createCollectionStoreTestEnv({});

  test('fetch resource', async () => {
    env.serverTable.setItem('1', defaultTodo);

    expect(env.store.state).toMatchInlineSnapshot(`{}`);

    env.scheduleFetch('lowPriority', '1');

    await vi.advanceTimersByTimeAsync(15);

    expect(env.store.state).toMatchInlineSnapshot(
      `
        "1:
          data: null
          error: null
          payload: '1'
          refetchOnMount: '❌'
          status: 'loading'
          wasLoaded: '❌'
      `,
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_DURATION_MS);

    expect(env.store.state).toMatchInlineSnapshot(`
      "1:
        data:
          value: { completed: '❌', title: 'todo' }
        error: null
        payload: '1'
        refetchOnMount: '❌'
        status: 'success'
        wasLoaded: '✅'
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('refetch resource with new data', async () => {
    env.serverTable.setItem('1', { title: 'new title', completed: false });

    env.scheduleFetch('highPriority', '1');

    await vi.advanceTimersByTimeAsync(15);

    expect(env.store.state).toMatchInlineSnapshot(`
      "1:
        data:
          value: { completed: '❌', title: 'todo' }
        error: null
        payload: '1'
        refetchOnMount: '❌'
        status: 'refetching'
        wasLoaded: '✅'
    `);

    await vi.runAllTimersAsync();

    expect(env.store.state).toMatchInlineSnapshot(`
      "1:
        data:
          value: { completed: '❌', title: 'new title' }
        error: null
        payload: '1'
        refetchOnMount: '❌'
        status: 'success'
        wasLoaded: '✅'
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(2);
  });

  test('refetch resource with error', async () => {
    env.serverTable.setNextFetchError('1', 'error');

    env.scheduleFetch('highPriority', '1');

    await vi.runAllTimersAsync();

    expect(env.store.state).toMatchInlineSnapshot(`
      "1:
        data:
          value: { completed: '❌', title: 'new title' }
        error: { code: 500, id: 'fetch-error', message: 'error' }
        payload: '1'
        refetchOnMount: '❌'
        status: 'error'
        wasLoaded: '✅'
    `);
  });
});

test('multiple low priority fetches at same time trigger only one fetch', async () => {
  const env = createCollectionStoreTestEnv({ '1': defaultTodo });

  env.scheduleFetch('lowPriority', '1');
  env.scheduleFetch('lowPriority', '1');
  env.scheduleFetch('lowPriority', '1');
  env.scheduleFetch('lowPriority', '1');

  // Wait for coalescing window
  await vi.advanceTimersByTimeAsync(15);

  expect(env.store.state).toMatchInlineSnapshot(`
    "1:
      data: null
      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'loading'
      wasLoaded: '❌'
  `);

  await vi.runAllTimersAsync();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(env.store.state).toMatchInlineSnapshot(`
    "1:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
  `);
});

test('initialization fetch', async () => {
  const env = createCollectionStoreTestEnv({ '1': defaultTodo });

  env.scheduleFetch('lowPriority', '1');

  await vi.runAllTimersAsync();

  expect(env.store.state).toMatchInlineSnapshot(`
    "1:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
  `);
});

test('await fetch', async () => {
  const { apiStore, serverTable } = createCollectionStoreTestEnv(
    { '1': defaultTodo },
    { useLoadedSnapshot: true },
  );

  serverTable.setItem('1', { title: 'new title', completed: false });

  expect(apiStore.getItemState('1')).toMatchObject({
    data: { value: { title: 'todo', completed: false } },
  });

  const fetchPromise = apiStore.awaitFetch('1');
  await vi.runAllTimersAsync();
  const result = await fetchPromise;

  expect(result).toEqual({
    data: { value: { title: 'new title', completed: false } },
    error: null,
  });

  serverTable.setNextFetchError('1', 'error');

  const errorFetchPromise = apiStore.awaitFetch('1');
  await vi.runAllTimersAsync();
  const errorResult = await errorFetchPromise;

  expect(errorResult).toMatchInlineSnapshot(`
    data: null
    error{Error}: { message: 'error', name: 'StoreFetchError' }
  `);

  expect(serverTable.numOfFinishedFetches).toBe(2);
});

test('multiple fetches with different payloads not cancel each other, but cancel same payload fetches', async () => {
  const env = createCollectionStoreTestEnv(
    {
        '1': defaultTodo,
        '2': defaultTodo,
        '3': defaultTodo,
        '4': defaultTodo,
        '5': defaultTodo,
        '6': defaultTodo,
        '7': defaultTodo,
      },
    { useLoadedSnapshot: true },
  );

  env.scheduleFetch('lowPriority', '1');
  env.scheduleFetch('lowPriority', '2');
  env.scheduleFetch('lowPriority', '3');
  env.scheduleFetch('lowPriority', '4');
  env.scheduleFetch('lowPriority', '5');
  env.scheduleFetch('lowPriority', '6');
  env.scheduleFetch('lowPriority', '7');

  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority', '1');
  env.scheduleFetch('lowPriority', '2');
  env.scheduleFetch('lowPriority', '3');
  env.scheduleFetch('lowPriority', '4');
  env.scheduleFetch('lowPriority', '5');
  env.scheduleFetch('lowPriority', '6');
  env.scheduleFetch('lowPriority', '7');

  await vi.runAllTimersAsync();

  expect(env.serverTable.numOfFinishedFetches).toBe(7);

    const defaultState = {
    data: { value: defaultTodo },
      error: null,
      refetchOnMount: false as const,
      status: 'success' as const,
      wasLoaded: true,
    };

  expect(env.store.state).toEqual({
    '"1': { ...defaultState, payload: '1' },
    '"2': { ...defaultState, payload: '2' },
    '"3': { ...defaultState, payload: '3' },
    '"4': { ...defaultState, payload: '4' },
    '"5': { ...defaultState, payload: '5' },
    '"6': { ...defaultState, payload: '6' },
    '"7': { ...defaultState, payload: '7' },
    });
});

describe('update state functions', () => {
  const initialServerData = {
    '1': { ...defaultTodo, completed: true },
    '2': { ...defaultTodo, completed: true },
    '3': defaultTodo,
    '4': defaultTodo,
    '5': defaultTodo,
  };

  describe('updateItemState', () => {
    test('update state of one item', () => {
      const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
        useLoadedSnapshot: true,
      });

      expect(apiStore.getItemState('1')?.data).toEqual({
        value: { completed: true, title: 'todo' },
      });

      apiStore.updateItemState('1', (data) => {
        data.value.title = 'new title';
      });

      expect(apiStore.getItemState('1')?.data).toEqual({
        value: { completed: true, title: 'new title' },
      });
    });

    test('update multiple items state', () => {
      const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
        useLoadedSnapshot: true,
      });

      apiStore.updateItemState(['1', '2'], () => {
        return {
          value: {
          title: 'new title 2',
          completed: false,
          },
        };
      });

      expect(
        apiStore.getItemState(['1', '2', '3']).map((item) => {
          return { id: item.payload, ...item.data?.value };
        }),
      ).toEqual([
        { completed: false, id: '1', title: 'new title 2' },
        { completed: false, id: '2', title: 'new title 2' },
        // 3 is not updated
        { completed: false, id: '3', title: 'todo' },
      ]);
    });

    test('update multiple items state with filter fn', () => {
      const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
        useLoadedSnapshot: true,
      });

      apiStore.updateItemState(
        (_, data) => !!data?.value.completed,
        (data) => {
          data.value.completed = false;
          data.value.title = 'modified';
        },
      );

      expect(
        apiStore
          .getItemState(() => true)
          .map((item) => {
            return { id: item.payload, ...item.data?.value };
          }),
      ).toEqual([
        { completed: false, id: '1', title: 'modified' },
        { completed: false, id: '2', title: 'modified' },
        { completed: false, id: '3', title: 'todo' },
        { completed: false, id: '4', title: 'todo' },
        { completed: false, id: '5', title: 'todo' },
      ]);
    });

    test('create if not exist', () => {
      const { apiStore, store } = createCollectionStoreTestEnv(
        initialServerData,
        { useLoadedSnapshot: true },
      );

      let storeUpdates = 0;
      store.subscribe(() => {
        storeUpdates++;
      });

      apiStore.updateItemState(
        '6',
        (data) => {
          data.value.title = 'item 6';
        },
        {
          ifNothingWasUpdated: () => {
            apiStore.addItemToState('6', {
              value: {
            title: 'item 6',
            completed: false,
              },
          });
          },
        },
      );

      expect(storeUpdates).toBe(1);

      expect(apiStore.getItemState('6')).toEqual({
        data: { value: { completed: false, title: 'item 6' } },
        error: null,
        payload: '6',
        refetchOnMount: false,
        status: 'success',
        wasLoaded: true,
      });
    });

    test('create multiple if not exist', () => {
      const { store } = createTestEnv({
        initialServerData,
        useLoadedSnapshot: true,
        disableInitialDataInvalidation: true,
      });

      let storeUpdates = 0;
      store.store.subscribe(() => {
        storeUpdates++;
      });

      store.updateItemState(
        (id) => id === '?',
        (data) => {
          data.title = 'item 6';
        },
        () => {
          store.addItemToState('6', {
            title: 'item 6',
            completed: false,
          });
          store.addItemToState('7', {
            title: 'item 7',
            completed: false,
          });
        },
      );

      expect(storeUpdates).toEqual(1);

      expect(store.getItemState(['6', '7', '5'])).toEqual([
        {
          data: { completed: false, title: 'item 6' },
          error: null,
          payload: '6',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        {
          data: { completed: false, title: 'item 7' },
          error: null,
          payload: '7',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        {
          data: { completed: false, title: 'todo' },
          error: null,
          payload: '5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      ]);
    });
  });

  test('addItemToState', () => {
    const { store: collectionStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: true,
    });

    expect(collectionStore.getItemState('6')).toBeUndefined();

    collectionStore.addItemToState('6', {
      title: 'item 6',
      completed: false,
    });

    expect(collectionStore.getItemState('6')).toEqual({
      data: { completed: false, title: 'item 6' },
      error: null,
      payload: '6',
      refetchOnMount: false,
      status: 'success',
      wasLoaded: true,
    });
  });

  test('deleteItemState', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: true,
    });

    expect(store.getItemState('1')).toBeDefined();

    store.deleteItemState('1');

    expect(store.getItemState('1')).toBeNull();

    expect(store.scheduleFetch('highPriority', '1')).toBe('started');
  });
});

test('mutation a obj passed as payload does not breaks the store', () => {
  const env = createTestEnv<{ id: { id: string } }>({});

  const obj = { id: { id: '1' } };

  env.store.scheduleFetch('highPriority', obj);

  env.serverMock.waitFetchIdle();

  obj.id.id = '2';

  expect(env.store.getItemState({ id: { id: '1' } })).toMatchInlineSnapshot(`
    {
      "data": null,
      "error": null,
      "payload": {
        "id": {
          "id": "1",
        },
      },
      "refetchOnMount": false,
      "status": "loading",
      "wasLoaded": false,
    }
  `);
});

describe('an invalidation with lower priority should not override one with higher priority', () => {
  test.concurrent('not override high priority update', () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
    });

    env.store.invalidateItem('1', 'highPriority');

    env.store.invalidateItem('1', 'lowPriority');

    expect(env.store.getItemState('1')?.refetchOnMount).toEqual('highPriority');
  });

  test.concurrent('not override rtu update', () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
    });

    env.store.invalidateItem('1', 'realtimeUpdate');

    env.store.invalidateItem('1', 'lowPriority');

    expect(env.store.getItemState('1')?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test.concurrent('not override highPriority with rtu update', () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
    });

    env.store.invalidateItem('1', 'highPriority');

    env.store.invalidateItem('1', 'realtimeUpdate');

    expect(env.store.getItemState('1')?.refetchOnMount).toEqual('highPriority');
  });
});

test.concurrent('bug reproduction: await fetch with error', async () => {
  const env = createTestEnv();

  env.serverMock.setFetchError('error');

  expect(await env.store.awaitFetch('1')).toEqual({
    data: null,
    error: {
      message: 'error',
    },
  });
});
