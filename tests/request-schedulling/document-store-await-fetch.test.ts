import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('awaitFetch basic behavior', () => {
  test('returns data on successful fetch', async () => {
    const env = createDocumentStoreTestEnv(42);

    const resultPromise = env.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toEqual({
      data: { value: 42 },
      error: null,
    });

    expect(env.numOfFinishedFetches).toBe(1);
  });

  test('returns error on failed fetch', async () => {
    const env = createDocumentStoreTestEnv(42);

    env.errorInNextFetch('Network error');

    const resultPromise = env.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toEqual({
      data: null,
      error: { error: 'Network error' },
    });
  });

  test('triggers new fetch even when data exists', async () => {
    const env = createDocumentStoreTestEnv(0);

    // Initial data is already present
    expect(env.store.state.data).toEqual({ value: 0 });

    // Change server data
    env.setServerData(999);

    const resultPromise = env.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    // Should have fetched new data from server
    expect(result).toEqual({
      data: { value: 999 },
      error: null,
    });
  });
});

describe('awaitFetch coalescing behavior', () => {
  test('multiple concurrent awaitFetch calls coalesce into single fetch', async () => {
    const env = createDocumentStoreTestEnv(42);

    // Start multiple awaitFetch calls concurrently
    const promise1 = env.awaitFetch();
    const promise2 = env.awaitFetch();
    const promise3 = env.awaitFetch();

    await vi.runAllTimersAsync();

    const [result1, result2, result3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    // All should return the same data
    expect(result1).toEqual({ data: { value: 42 }, error: null });
    expect(result2).toEqual({ data: { value: 42 }, error: null });
    expect(result3).toEqual({ data: { value: 42 }, error: null });

    // Only one fetch should have been executed
    expect(env.numOfFinishedFetches).toBe(1);
  });

  test('awaitFetch during coalescing window joins the window', async () => {
    const env = createDocumentStoreTestEnv(42, {
      baseCoalescingWindowMs: 50,
    });

    // First awaitFetch starts coalescing window
    const promise1 = env.awaitFetch();

    // Wait a bit but stay within coalescing window
    await vi.advanceTimersByTimeAsync(20);

    // Second awaitFetch should join the coalescing window
    const promise2 = env.awaitFetch();

    await vi.runAllTimersAsync();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toEqual({ data: { value: 42 }, error: null });
    expect(result2).toEqual({ data: { value: 42 }, error: null });
    expect(env.numOfFinishedFetches).toBe(1);
  });

  test('awaitFetch during ongoing fetch waits for completion then schedules another', async () => {
    const env = createDocumentStoreTestEnv(42);

    // Start first awaitFetch
    const promise1 = env.awaitFetch();

    // Wait for coalescing to end and fetch to start
    await vi.advanceTimersByTimeAsync(15);

    // Second awaitFetch during ongoing fetch
    const promise2 = env.awaitFetch();

    await vi.runAllTimersAsync();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toEqual({ data: { value: 42 }, error: null });
    expect(result2).toEqual({ data: { value: 42 }, error: null });

    // Two fetches: first one completes, second one scheduled during first
    expect(env.numOfFinishedFetches).toBe(2);
  });
});

describe('awaitFetch edge cases', () => {
  test('sequential awaitFetch calls each trigger their own fetch', async () => {
    const env = createDocumentStoreTestEnv(1);

    // First awaitFetch
    const promise1 = env.awaitFetch();
    await vi.runAllTimersAsync();
    const result1 = await promise1;

    expect(result1).toEqual({ data: { value: 1 }, error: null });

    // Change server data
    env.setServerData(2);

    // Second awaitFetch - should trigger new fetch
    const promise2 = env.awaitFetch();
    await vi.runAllTimersAsync();
    const result2 = await promise2;

    expect(result2).toEqual({ data: { value: 2 }, error: null });
    expect(env.numOfFinishedFetches).toBe(2);
  });

  test('awaitFetch returns latest data after server changes during fetch', async () => {
    const env = createDocumentStoreTestEnv(1);

    // Start awaitFetch
    const fetchPromise = env.awaitFetch();

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    // Server data changes during fetch
    env.setServerData(999);

    await vi.runAllTimersAsync();

    const result = await fetchPromise;

    // Should have the data that was present when fetch completed
    expect(result).toEqual({
      data: { value: 999 },
      error: null,
    });
  });

  test('awaitFetch with immediate error', async () => {
    const env = createDocumentStoreTestEnv(42);

    env.errorInNextFetch('Immediate failure');

    const resultPromise = env.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toEqual({
      data: null,
      error: { error: 'Immediate failure' },
    });
  });

  test('awaitFetch preserves previous data on error', async () => {
    const env = createDocumentStoreTestEnv(42);

    // First successful fetch
    const result1 = env.awaitFetch();
    await vi.runAllTimersAsync();
    expect(await result1).toEqual({ data: { value: 42 }, error: null });

    // Verify data is in store
    expect(env.store.state.data).toEqual({ value: 42 });

    // Second fetch fails
    env.errorInNextFetch('Fetch failed');
    const result2 = env.awaitFetch();
    await vi.runAllTimersAsync();

    // awaitFetch returns error
    expect(await result2).toEqual({
      data: null,
      error: { error: 'Fetch failed' },
    });

    // But store still has the previous data
    expect(env.store.state.data).toEqual({ value: 42 });
    expect(env.store.state.error).toEqual({ error: 'Fetch failed' });
  });
});

describe('awaitFetch timing', () => {
  test('awaitFetch waits for coalescing window before starting fetch', async () => {
    const env = createDocumentStoreTestEnv(42, {
      baseCoalescingWindowMs: 50,
    });

    const fetchPromise = env.awaitFetch();

    // Before coalescing window ends - no fetch started yet
    await vi.advanceTimersByTimeAsync(30);
    expect(env.numOfStartedFetches).toBe(0);

    // After coalescing window ends - fetch should start
    await vi.advanceTimersByTimeAsync(25);
    expect(env.numOfStartedFetches).toBe(1);

    await vi.runAllTimersAsync();
    await fetchPromise;

    expect(env.numOfFinishedFetches).toBe(1);
  });

  test('awaitFetch resolves only after fetch completes', async () => {
    const env = createDocumentStoreTestEnv(42);
    env.setNextFetchDurations(500);

    let resolved = false;

    const fetchPromise = env.awaitFetch().then((result) => {
      resolved = true;
      return result;
    });

    // Wait for coalescing window to end and fetch to start
    await vi.advanceTimersByTimeAsync(15);
    expect(resolved).toBe(false);

    // Part way through fetch
    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);

    // Complete fetch
    await vi.runAllTimersAsync();
    await fetchPromise;
    expect(resolved).toBe(true);
  });

  test('awaitFetch with timeline tracking', async () => {
    const env = createDocumentStoreTestEnv(42);

    const fetchPromise = env.awaitFetch();

    await vi.runAllTimersAsync();
    await fetchPromise;

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | ui |
      10ms  | -  | 🔴 >fetch-started
      810ms | -  | 🔴 <fetch-finished (value: 42)
      "
    `);
  });
});
