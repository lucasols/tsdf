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

test.concurrent(
  'multiple low priority fetchs at same time trigger only one fetch',
  async () => {
    const { serverMock, store: collectionStore } = createTestEnv();

    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '1');

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: null,
        error: null,
        payload: '1',
        refetchOnMount: false,
        status: 'loading',
        wasLoaded: false,
      },
    });

    await sleep(serverMock.fetchDuration + 5);

    expect(serverMock.fetchsCount).toEqual(1);

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: { title: 'todo', completed: false },
        error: null,
        refetchOnMount: false,
        status: 'success',
        payload: '1',
        wasLoaded: true,
      },
    });
  },
);

test.concurrent('initialization fetch', async () => {
  const { store: collectionStore } = createTestEnv();

  await waitInitializationFetch(collectionStore);

  expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
    '1': {
      data: { title: 'todo', completed: false },
      error: null,
      refetchOnMount: false,
      status: 'success',
      payload: '1',
      wasLoaded: true,
    },
  });
});

test.concurrent('await fetch', async () => {
  const { serverMock, store: collectionStore } = createTestEnv();

  await waitInitializationFetch(collectionStore);

  serverMock.mutateData({ '1': { title: 'new title', completed: false } });

  expect(collectionStore.getItemState('1')).toMatchObject({
    data: { title: 'todo', completed: false },
  });

  expect(await collectionStore.awaitFetch('1')).toEqual({
    data: { title: 'new title', completed: false },
    error: null,
  });

  serverMock.setFetchError('error');

  expect(await collectionStore.awaitFetch('1')).toEqual({
    data: null,
    error: {
      message: 'error',
    },
  });

  expect(serverMock.fetchsCount).toEqual(3);
});

test.concurrent(
  'multiple fetchs with different payloads not cancel each other, but cancel same payload fetchs',
  async () => {
    const { serverMock, store: collectionStore } = createTestEnv({
      initialServerData: {
        '1': defaultTodo,
        '2': defaultTodo,
        '3': defaultTodo,
        '4': defaultTodo,
        '5': defaultTodo,
        '6': defaultTodo,
        '7': defaultTodo,
      },
    });

    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '2');
    collectionStore.scheduleFetch('lowPriority', '3');
    collectionStore.scheduleFetch('lowPriority', '4');
    collectionStore.scheduleFetch('lowPriority', '5');
    collectionStore.scheduleFetch('lowPriority', '6');
    collectionStore.scheduleFetch('lowPriority', '7');

    await sleep(10);

    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '2');
    collectionStore.scheduleFetch('lowPriority', '3');
    collectionStore.scheduleFetch('lowPriority', '4');
    collectionStore.scheduleFetch('lowPriority', '5');
    collectionStore.scheduleFetch('lowPriority', '6');
    collectionStore.scheduleFetch('lowPriority', '7');

    await sleep(serverMock.fetchDuration + 5);

    expect(serverMock.fetchsCount).toEqual(7);

    const defaultState = {
      data: defaultTodo,
      error: null,
      refetchOnMount: false as const,
      status: 'success' as const,
      wasLoaded: true,
    };

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': { ...defaultState, payload: '1' },
      '2': { ...defaultState, payload: '2' },
      '3': { ...defaultState, payload: '3' },
      '4': { ...defaultState, payload: '4' },
      '5': { ...defaultState, payload: '5' },
      '6': { ...defaultState, payload: '6' },
      '7': { ...defaultState, payload: '7' },
    });
  },
);

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
      const { store } = createTestEnv({
        initialServerData,
        useLoadedSnapshot: true,
      });

      expect(store.getItemState('1')?.data).toEqual({
        completed: true,
        title: 'todo',
      });

      store.updateItemState('1', (data) => {
        data.title = 'new title';
      });

      expect(store.getItemState('1')?.data).toEqual({
        completed: true,
        title: 'new title',
      });
    });

    test('update multiple itens state', () => {
      const { store } = createTestEnv({
        initialServerData,
        useLoadedSnapshot: true,
      });

      store.updateItemState(['1', '2'], () => {
        return {
          title: 'new title 2',
          completed: false,
        };
      });

      expect(
        store.getItemState(['1', '2', '3']).map((item) => {
          return { id: item.payload, ...item.data };
        }),
      ).toEqual([
        { completed: false, id: '1', title: 'new title 2' },
        { completed: false, id: '2', title: 'new title 2' },
        // 3 is not updated
        { completed: false, id: '3', title: 'todo' },
      ]);
    });

    test('update multiple itens state with filter fn', () => {
      const { store } = createTestEnv({
        initialServerData,
        useLoadedSnapshot: true,
      });

      store.updateItemState(
        (_, data) => !!data?.completed,
        (data) => {
          data.completed = false;
          data.title = 'modified';
        },
      );

      expect(
        store
          .getItemState(() => true)
          .map((item) => {
            return { id: item.payload, ...item.data };
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
      const { store } = createTestEnv({
        initialServerData,
        useLoadedSnapshot: true,
      });

      let storeUpdates = 0;
      store.store.subscribe(() => {
        storeUpdates++;
      });

      store.updateItemState(
        '6',
        (data) => {
          data.title = 'item 6';
        },
        () => {
          store.addItemToState('6', {
            title: 'item 6',
            completed: false,
          });
        },
      );

      expect(storeUpdates).toEqual(1);

      expect(store.getItemState('6')).toEqual({
        data: { completed: false, title: 'item 6' },
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
