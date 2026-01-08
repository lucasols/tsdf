import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('basic fetch lifecycle', () => {
  test('idle -> loading -> success state transitions', async () => {
    const env = createDocumentStoreTestEnv(42, {
      forceInitialDataInvalidation: true,
    });

    // Initial state should be idle
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": null,
        "error": null,
        "refetchOnMount": false,
        "status": "idle",
      }
    `);

    // Trigger fetch
    env.scheduleFetch('lowPriority');

    // Wait for coalescing window to expire and fetch to start
    await vi.advanceTimersByTimeAsync(15);

    // Should transition to loading
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": null,
        "error": null,
        "refetchOnMount": false,
        "status": "loading",
      }
    `);

    // Wait for fetch to complete
    await vi.runAllTimersAsync();

    // Should transition to success
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "success",
      }
    `);
  });

  test('refetch with existing data shows refetching status and returns new data', async () => {
    const env = createDocumentStoreTestEnv(42);

    // Initial state - has data from getInitialData (serverInitialData = 42)
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "success",
      }
    `);

    // Change server data before refetch
    env.setServerData(100);

    // Trigger refetch
    env.scheduleFetch('highPriority');

    // Wait for coalescing window to expire and fetch to start
    await vi.advanceTimersByTimeAsync(15);

    // Should show refetching status (previous data preserved during fetch)
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "refetching",
      }
    `);

    // Wait for fetch to complete
    await vi.runAllTimersAsync();

    // Should transition to success with new data
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 100,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "success",
      }
    `);
  });

  test('error during refetch preserves existing data', async () => {
    const env = createDocumentStoreTestEnv(42);

    // First do a successful refetch to get new data
    env.setServerData(100);
    env.scheduleFetch('highPriority');
    await vi.runAllTimersAsync();

    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 100,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "success",
      }
    `);

    // Set next fetch to fail
    env.errorInNextFetch('Network error');

    // Trigger refetch
    env.scheduleFetch('highPriority');

    // Wait for fetch to complete
    await vi.runAllTimersAsync();

    // Should have error but preserve previous data
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 100,
        },
        "error": {
          "code": 500,
          "id": "fetch-error",
          "message": "Network error",
        },
        "refetchOnMount": false,
        "status": "error",
      }
    `);
  });
});

describe('getInitialData option', () => {
  test('store starts with initialized data', () => {
    const env = createDocumentStoreTestEnv(42);

    // Should start with initial data and success status
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "success",
      }
    `);
  });

  test('initial data triggers refetch on mount when invalidation enabled', async () => {
    const env = createDocumentStoreTestEnv(42, {
      forceInitialDataInvalidation: true,
    });

    // Should start with no data and idle status
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": null,
        "error": null,
        "refetchOnMount": false,
        "status": "idle",
      }
    `);

    // Trigger a fetch (simulating what useDocument would do on mount)
    env.scheduleFetch('lowPriority');

    await vi.runAllTimersAsync();

    expect(env.numOfFinishedFetches).toBe(1);

    // Should now have server data
    expect(env.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
        "refetchOnMount": false,
        "status": "success",
      }
    `);
  });
});

describe('invalidateData priority', () => {
  test('lower priority invalidation should not override higher priority', () => {
    const env = createDocumentStoreTestEnv(42);

    env.apiStore.invalidateData('highPriority');
    expect(env.store.state.refetchOnMount).toBe('highPriority');

    env.apiStore.invalidateData('lowPriority');
    // Should still be highPriority since lowPriority has lower precedence
    expect(env.store.state.refetchOnMount).toBe('highPriority');
  });

  test('realtimeUpdate invalidation should not be overridden by lowPriority', () => {
    const env = createDocumentStoreTestEnv(42);

    env.apiStore.invalidateData('realtimeUpdate');
    expect(env.store.state.refetchOnMount).toBe('realtimeUpdate');

    env.apiStore.invalidateData('lowPriority');
    // Should still be realtimeUpdate
    expect(env.store.state.refetchOnMount).toBe('realtimeUpdate');
  });

  test('highPriority invalidation should not be overridden by realtimeUpdate', () => {
    const env = createDocumentStoreTestEnv(42);

    env.apiStore.invalidateData('highPriority');
    expect(env.store.state.refetchOnMount).toBe('highPriority');

    env.apiStore.invalidateData('realtimeUpdate');
    // Should still be highPriority since it has higher precedence than realtimeUpdate
    expect(env.store.state.refetchOnMount).toBe('highPriority');
  });

  test('higher priority can override lower priority invalidation', () => {
    const env = createDocumentStoreTestEnv(42);

    env.apiStore.invalidateData('lowPriority');
    expect(env.store.state.refetchOnMount).toBe('lowPriority');

    env.apiStore.invalidateData('highPriority');
    // Should now be highPriority
    expect(env.store.state.refetchOnMount).toBe('highPriority');
  });
});
