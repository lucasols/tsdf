import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { StoreFetchError } from '../../src/storeShared';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('awaitFetch basic behavior', () => {
  test('returns data on successful fetch', async () => {
    const env = createDocumentStoreTestEnv(42, {
      forceInitialDataInvalidation: true,
    });

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
    const env = createDocumentStoreTestEnv(42, {
      forceInitialDataInvalidation: true,
    });

    env.errorInNextFetch('Network error');

    const resultPromise = env.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Network error');
    expect(result.error?.type).toBe('fetch');
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

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      10ms  | 🔴 >fetch-started
      810ms | 🔴 <fetch-finished (value: 42)
      "
    `);
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

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      50ms  | 🔴 >fetch-started
      850ms | 🔴 <fetch-finished (value: 42)
      "
    `);
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

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      10ms  | 🔴 >fetch-started
      810ms | 🔴 <fetch-finished (value: 42)
      820ms | 🟠 >fetch-started
      1.62s | 🟠 <fetch-finished (value: 42)
      "
    `);
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

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Immediate failure');
    expect(result.error?.type).toBe('fetch');
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
    const errorResult = await result2;
    expect(errorResult.data).toBeNull();
    expect(errorResult.error).toBeInstanceOf(StoreFetchError);
    expect(errorResult.error?.message).toBe('Fetch failed');
    expect(errorResult.error?.type).toBe('fetch');

    // But store still has the previous data
    expect(env.store.state.data).toEqual({ value: 42 });
    expect(env.store.state.error).toEqual({
      code: 500,
      id: 'fetch-error',
      message: 'Fetch failed',
    });
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

  test('three awaitFetch calls triggered outside each coalescing window coalesce during ongoing fetch', async () => {
    const env = createDocumentStoreTestEnv(1, {
      baseCoalescingWindowMs: 50,
    });

    // First awaitFetch - starts first coalescing window
    const promise1 = env.awaitFetch();

    // Wait for first coalescing window to end + a few ms
    await vi.advanceTimersByTimeAsync(55);
    expect(env.numOfStartedFetches).toBe(1);

    // Second awaitFetch - outside first coalescing window
    env.setServerData(2);
    const promise2 = env.awaitFetch();

    // Wait for second coalescing window to end + a few ms
    await vi.advanceTimersByTimeAsync(55);
    expect(env.numOfStartedFetches).toBe(1); // First fetch still in progress

    // Third awaitFetch - outside second coalescing window
    env.setServerData(3);
    const promise3 = env.awaitFetch();

    // Wait for third coalescing window to end + a few ms
    await vi.advanceTimersByTimeAsync(55);

    // Now let all fetches complete
    await vi.runAllTimersAsync();

    const [result1, result2, result3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    // All return the final data since server data changed before fetches completed
    expect(result1).toEqual({ data: { value: 3 }, error: null });
    expect(result2).toEqual({ data: { value: 3 }, error: null });
    expect(result3).toEqual({ data: { value: 3 }, error: null });

    // Two fetches: first one, then second+third coalesced during ongoing fetch
    expect(env.numOfFinishedFetches).toBe(2);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      50ms  | 🔴 >fetch-started
      55ms  | server-data-changed (value: 2)
      110ms | server-data-changed (value: 3)
      850ms | 🔴 <fetch-finished (value: 3)
      900ms | 🟠 >fetch-started
      1.7s  | 🟠 <fetch-finished (value: 3)
      "
    `);
  });
});

describe('awaitFetch timeout', () => {
  test('awaitFetch times out after default 30 seconds', async () => {
    const env = createDocumentStoreTestEnv(42);
    // Set a very long fetch duration
    env.setNextFetchDurations(60_000);

    const resultPromise = env.awaitFetch();

    // Advance past the default 30 second timeout
    await vi.advanceTimersByTimeAsync(30_001);

    const result = await resultPromise;

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Timeout');
    expect(result.error?.type).toBe('timeout');
    expect(result.error?.code).toBe(408);
  });

  test('awaitFetch times out after custom timeout', async () => {
    const env = createDocumentStoreTestEnv(42);
    // Set a fetch duration longer than custom timeout
    env.setNextFetchDurations(10_000);

    const resultPromise = env.awaitFetch({ timeoutMs: 5_000 });

    // Advance past the custom 5 second timeout
    await vi.advanceTimersByTimeAsync(5_001);

    const result = await resultPromise;

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Timeout');
    expect(result.error?.type).toBe('timeout');
  });

  test('awaitFetch completes before timeout returns data', async () => {
    const env = createDocumentStoreTestEnv(42);
    env.setNextFetchDurations(100);

    const resultPromise = env.awaitFetch({ timeoutMs: 5_000 });

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    // Should succeed since fetch completed before timeout
    expect(result).toEqual({
      data: { value: 42 },
      error: null,
    });
  });

  test('awaitFetch with zero timeout times out immediately', async () => {
    const env = createDocumentStoreTestEnv(42);

    const resultPromise = env.awaitFetch({ timeoutMs: 0 });

    // Even with 0 timeout, we need to advance timers to let the Promise.race resolve
    await vi.advanceTimersByTimeAsync(1);

    const result = await resultPromise;

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Timeout');
    expect(result.error?.type).toBe('timeout');
  });

  test('multiple awaitFetch calls with different timeouts', async () => {
    const env = createDocumentStoreTestEnv(42);
    env.setNextFetchDurations(3_000);

    // First call with short timeout - should timeout
    const promise1 = env.awaitFetch({ timeoutMs: 1_000 });

    // Second call with long timeout - should succeed
    const promise2 = env.awaitFetch({ timeoutMs: 10_000 });

    // Advance past first timeout but before fetch completes
    await vi.advanceTimersByTimeAsync(1_001);
    const result1 = await promise1;
    expect(result1.data).toBeNull();
    expect(result1.error).toBeInstanceOf(StoreFetchError);
    expect(result1.error?.message).toBe('Timeout');
    expect(result1.error?.type).toBe('timeout');

    // Complete the fetch
    await vi.runAllTimersAsync();
    const result2 = await promise2;
    expect(result2).toEqual({ data: { value: 42 }, error: null });
  });
});
