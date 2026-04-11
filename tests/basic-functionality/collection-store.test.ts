import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createCollectionStore } from '../../src/collectionStore/collectionStore';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { DEFAULT_FETCH_DURATION_MS } from '../mocks/serverTableMock';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';

const CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS = 60 * 60 * 1000;

type TodoItem = { title: string; completed: boolean };

const defaultTodo: TodoItem = { title: 'todo', completed: false };

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('test helpers', () => {
  test('start with store initialized state', () => {
    const { store } = createCollectionStoreTestEnv(
      { '1': defaultTodo, '2': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
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
  const env = createCollectionStoreTestEnv(
    {},
    { __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true },
  );

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

    await flushAllTimers();

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

    await flushAllTimers();

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

  await flushAllTimers();

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

  await flushAllTimers();

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

test('maxItems evicts the least recently used inactive item from memory', async () => {
  const env = createCollectionStoreTestEnv(
    {
      '1': { title: 'first', completed: false },
      '2': { title: 'second', completed: false },
      '3': { title: 'third', completed: false },
    },
    { maxItems: 2 },
  );

  env.scheduleFetch('highPriority', '1');
  await flushAllTimers();
  env.scheduleFetch('highPriority', '2');
  await flushAllTimers();
  env.scheduleFetch('highPriority', '3');
  await flushAllTimers();

  expect(env.apiStore.getItemState('1')).toBeUndefined();
  expect(env.apiStore.getItemState('2')?.data?.value.title).toBe('second');
  expect(env.apiStore.getItemState('3')?.data?.value.title).toBe('third');
  expect(env.store.state['1']).toBeUndefined();
  expect(Object.keys(env.store.state).sort()).toMatchInlineSnapshot(
    `['"2', '"3']`,
  );
});

test('maxItems throttles repeated cache-limit evictions after the first overflow', async () => {
  const env = createCollectionStoreTestEnv(
    {
      '1': { title: 'first', completed: false },
      '2': { title: 'second', completed: false },
      '3': { title: 'third', completed: false },
    },
    { maxItems: 1 },
  );

  env.apiStore.addItemToState('1', {
    value: { title: 'first', completed: false },
  });
  await flushAllTimers();

  env.apiStore.addItemToState('2', {
    value: { title: 'second', completed: false },
  });
  await flushAllTimers();

  expect(env.apiStore.getItemState('1')).toBeUndefined();
  expect(env.apiStore.getItemState('2')?.data?.value.title).toBe('second');

  env.apiStore.addItemToState('3', {
    value: { title: 'third', completed: false },
  });

  await advanceTime(CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS - 1);
  expect(env.apiStore.getItemState('2')?.data?.value.title).toBe('second');
  expect(env.apiStore.getItemState('3')?.data?.value.title).toBe('third');
  expect(env.apiStore.getItemState('1')).toBeUndefined();
  expect(env.apiStore.getItemState('2')?.data?.value.title).toBe('second');

  await advanceTime(1);
  await flushAllTimers();

  expect(env.apiStore.getItemState('2')).toBeUndefined();
  expect(env.apiStore.getItemState('3')?.data?.value.title).toBe('third');
});

test('onStateCleanup is called when cache-limit eviction removes items from memory', async () => {
  const cleanupCalls: unknown[] = [];
  const env = createCollectionStoreTestEnv(
    {
      '1': { title: 'first', completed: false },
      '2': { title: 'second', completed: false },
      '3': { title: 'third', completed: false },
    },
    {
      maxItems: 2,
      onStateCleanup: (cleanup) => {
        cleanupCalls.push(cleanup);
      },
    },
  );

  env.scheduleFetch('highPriority', '1');
  await flushAllTimers();
  env.scheduleFetch('highPriority', '2');
  await flushAllTimers();
  env.scheduleFetch('highPriority', '3');
  await flushAllTimers();

  expect(cleanupCalls).toMatchInlineSnapshot(`
    - itemKeys: ['"1']
      payloads: ['1']
      reason: 'cacheLimitEviction'
  `);
});

test('await fetch', async () => {
  const { apiStore, serverTable } = createCollectionStoreTestEnv(
    { '1': defaultTodo },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  serverTable.setItem('1', { title: 'new title', completed: false });

  expect(pick(apiStore.getItemState('1'), ['data'])).toMatchInlineSnapshot(`
    data:
      value: { completed: '❌', title: 'todo' }
  `);

  const fetchPromise = apiStore.awaitFetch('1');
  await flushAllTimers();
  const result = await fetchPromise;

  expect(result).toMatchInlineSnapshot(`
    data:
      value: { completed: '❌', title: 'new title' }

    error: null
  `);

  serverTable.setNextFetchError('1', 'error');

  const errorFetchPromise = apiStore.awaitFetch('1');
  await flushAllTimers();
  const errorResult = await errorFetchPromise;

  expect(errorResult).toMatchInlineSnapshot(`
    data: null
    error{Error}:
      message: 'error'
      name: 'StoreFetchError'
      code: 500
      id: 'fetch-error'
      type: 'fetch'
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
    { testScenario: 'loaded', usesRealTimeUpdates: true },
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

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(7);

  expect(env.store.state).toMatchInlineSnapshot(`
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

    "3:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '3'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'

    "4:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '4'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'

    "5:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '5'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'

    "6:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '6'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'

    "7:
      data:
        value: { completed: '❌', title: 'todo' }
      error: null
      payload: '7'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
  `);
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
        testScenario: 'loaded',
        usesRealTimeUpdates: true,
      });

      expect(apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
        `value: { completed: '✅', title: 'todo' }`,
      );

      apiStore.updateItemState('1', (data) => {
        data.value.title = 'new title';
      });

      expect(apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
        `value: { completed: '✅', title: 'new title' }`,
      );
    });

    test('update multiple items state', () => {
      const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
        testScenario: 'loaded',
        usesRealTimeUpdates: true,
      });

      apiStore.updateItemState(['1', '2'], () => {
        return { value: { title: 'new title 2', completed: false } };
      });

      expect(
        apiStore.getItemState(['1', '2', '3']).map((item) => {
          return { id: item.payload, ...item.data?.value };
        }),
      ).toMatchInlineSnapshot(`
        - { completed: '❌', id: '1', title: 'new title 2' }
        - { completed: '❌', id: '2', title: 'new title 2' }
        - { completed: '❌', id: '3', title: 'todo' }
      `);
    });

    test('update multiple items state with filter fn', () => {
      const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
        testScenario: 'loaded',
        usesRealTimeUpdates: true,
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
      ).toMatchInlineSnapshot(`
        - { completed: '❌', id: '1', title: 'modified' }
        - { completed: '❌', id: '2', title: 'modified' }
        - { completed: '❌', id: '3', title: 'todo' }
        - { completed: '❌', id: '4', title: 'todo' }
        - { completed: '❌', id: '5', title: 'todo' }
      `);
    });

    test('create if not exist', () => {
      const { apiStore, store } = createCollectionStoreTestEnv(
        initialServerData,
        { testScenario: 'loaded', usesRealTimeUpdates: true },
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
              value: { title: 'item 6', completed: false },
            });
          },
        },
      );

      expect(storeUpdates).toBe(1);

      expect(apiStore.getItemState('6')).toMatchInlineSnapshot(`
        data:
          value: { completed: '❌', title: 'item 6' }

        error: null
        payload: '6'
        refetchOnMount: '❌'
        status: 'success'
        wasLoaded: '✅'
      `);
    });

    test('create multiple if not exist', () => {
      const { apiStore, store } = createCollectionStoreTestEnv(
        initialServerData,
        { testScenario: 'loaded', usesRealTimeUpdates: true },
      );

      let storeUpdates = 0;
      store.subscribe(() => {
        storeUpdates++;
      });

      apiStore.updateItemState(
        (id) => id === '?',
        (data) => {
          data.value.title = 'item 6';
        },
        {
          ifNothingWasUpdated: () => {
            apiStore.addItemToState('6', {
              value: { title: 'item 6', completed: false },
            });
            apiStore.addItemToState('7', {
              value: { title: 'item 7', completed: false },
            });
          },
        },
      );

      expect(storeUpdates).toBe(1);

      expect(apiStore.getItemState(['6', '7', '5'])).toMatchInlineSnapshot(`
        - data:
            value: { completed: '❌', title: 'item 6' }
          error: null
          payload: '6'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        - data:
            value: { completed: '❌', title: 'item 7' }
          error: null
          payload: '7'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
        - data:
            value: { completed: '❌', title: 'todo' }
          error: null
          payload: '5'
          refetchOnMount: '❌'
          status: 'success'
          wasLoaded: '✅'
      `);
    });
  });

  test('addItemToState', () => {
    const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    });

    expect(apiStore.getItemState('6')).toBeUndefined();

    apiStore.addItemToState('6', {
      value: { title: 'item 6', completed: false },
    });

    expect(apiStore.getItemState('6')).toMatchInlineSnapshot(`
      data:
        value: { completed: '❌', title: 'item 6' }

      error: null
      payload: '6'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('deleteItemState', () => {
    const { apiStore } = createCollectionStoreTestEnv(initialServerData, {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    });

    expect(apiStore.getItemState('1')).toBeDefined();

    apiStore.deleteItemState('1');

    expect(apiStore.getItemState('1')).toBeNull();
  });
});

test('mutating a obj passed as payload does not break the store', async () => {
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
  });
  const collectionStore = createCollectionStore<
    { value: TodoItem },
    { id: { id: string } }
  >({
    id: 'test-payload-mutation',
    storeManager,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    fetchFn: () => {
      return Promise.resolve({ value: defaultTodo });
    },
  });

  const obj = { id: { id: '1' } };

  collectionStore.scheduleFetch('highPriority', obj);

  await flushAllTimers();

  obj.id.id = '2';

  expect(collectionStore.getItemState({ id: { id: '1' } }))
    .toMatchInlineSnapshot(`
      data:
        value: { completed: '❌', title: 'todo' }

      error: null
      payload:
        id: { id: '1' }

      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
});

describe('an invalidation with lower priority should not override one with higher priority', () => {
  test('not override high priority update', () => {
    const { apiStore } = createCollectionStoreTestEnv(
      { '1': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    apiStore.invalidateItem('1', 'highPriority');

    apiStore.invalidateItem('1', 'lowPriority');

    expect(apiStore.getItemState('1')?.refetchOnMount).toBe('highPriority');
  });

  test('not override rtu update', () => {
    const { apiStore } = createCollectionStoreTestEnv(
      { '1': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    apiStore.invalidateItem('1', 'realtimeUpdate');

    apiStore.invalidateItem('1', 'lowPriority');

    expect(apiStore.getItemState('1')?.refetchOnMount).toBe('realtimeUpdate');
  });

  test('not override highPriority with rtu update', () => {
    const { apiStore } = createCollectionStoreTestEnv(
      { '1': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    apiStore.invalidateItem('1', 'highPriority');

    apiStore.invalidateItem('1', 'realtimeUpdate');

    expect(apiStore.getItemState('1')?.refetchOnMount).toBe('highPriority');
  });
});

test('bug reproduction: await fetch with error', async () => {
  const env = createCollectionStoreTestEnv(
    { '1': defaultTodo },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  env.serverTable.setNextFetchError('1', 'error');

  const fetchPromise = env.apiStore.awaitFetch('1');
  await flushAllTimers();
  const result = await fetchPromise;

  expect(result.data).toBeNull();
  expect(result.error).toBeDefined();
  expect(result.error?.message).toBe('error');
});
