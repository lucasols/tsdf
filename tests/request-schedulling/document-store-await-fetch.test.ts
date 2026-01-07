import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDocumentStore } from '../../src/documentStore';
import { createServerMock } from '../mocks/serverMock';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('awaitFetch basic behavior', () => {
  test('returns data on successful fetch', async () => {
    const serverMock = createServerMock<number>(42);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    const resultPromise = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);
  });

  test('returns error on failed fetch', async () => {
    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          await vi.advanceTimersByTimeAsync(100);
          throw new Error('Network error');
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    const resultPromise = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      {
        "data": null,
        "error": {
          "e": "Network error",
        },
      }
    `);
  });

  test('triggers new fetch even when data exists', async () => {
    const serverMock = createServerMock<number>(100);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          const value = await serverMock.fetch();
          return { value };
        },
        getInitialData: () => ({ value: 0 }),
        disableInitialDataInvalidation: true,
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    // Initial data is already present
    expect(documentStore.store.state.data).toMatchInlineSnapshot(`
      {
        "value": 0,
      }
    `);

    // Change server data
    serverMock.setData(999);

    const resultPromise = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    // Should have fetched new data from server
    expect(result).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 999,
        },
        "error": null,
      }
    `);
  });
});

describe('awaitFetch coalescing behavior', () => {
  test('multiple concurrent awaitFetch calls coalesce into single fetch', async () => {
    let fetchCount = 0;
    const serverMock = createServerMock<number>(42);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          fetchCount++;
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    // Start multiple awaitFetch calls concurrently
    const promise1 = documentStore.awaitFetch();
    const promise2 = documentStore.awaitFetch();
    const promise3 = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const [result1, result2, result3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    // All should return the same data
    expect(result1).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);
    expect(result2).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);
    expect(result3).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);

    // Only one fetch should have been executed
    expect(fetchCount).toBe(1);
  });

  test('awaitFetch during coalescing window joins the window', async () => {
    let fetchCount = 0;
    const serverMock = createServerMock<number>(42);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          fetchCount++;
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 50,
      },
    );

    // First awaitFetch starts coalescing window
    const promise1 = documentStore.awaitFetch();

    // Wait a bit but stay within coalescing window
    await vi.advanceTimersByTimeAsync(20);

    // Second awaitFetch should join the coalescing window
    const promise2 = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);
    expect(result2).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);
    expect(fetchCount).toBe(1);
  });

  test('awaitFetch during ongoing fetch waits for completion', async () => {
    let fetchCount = 0;
    const serverMock = createServerMock<number>(42);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          fetchCount++;
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    // Start first awaitFetch
    const promise1 = documentStore.awaitFetch();

    // Wait for coalescing to end and fetch to start
    await vi.advanceTimersByTimeAsync(15);

    // Second awaitFetch during ongoing fetch
    const promise2 = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);
    expect(result2).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);

    // Two fetches: first one completes, second one scheduled during first
    expect(fetchCount).toBe(2);
  });
});

describe('awaitFetch edge cases', () => {
  test('sequential awaitFetch calls each trigger their own fetch', async () => {
    let fetchCount = 0;
    const serverMock = createServerMock<number>(1);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          fetchCount++;
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    // First awaitFetch
    const promise1 = documentStore.awaitFetch();
    await vi.runAllTimersAsync();
    const result1 = await promise1;

    expect(result1).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 1,
        },
        "error": null,
      }
    `);

    // Change server data
    serverMock.setData(2);

    // Second awaitFetch - should trigger new fetch
    const promise2 = documentStore.awaitFetch();
    await vi.runAllTimersAsync();
    const result2 = await promise2;

    expect(result2).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 2,
        },
        "error": null,
      }
    `);
    expect(fetchCount).toBe(2);
  });

  test('awaitFetch returns latest data after multiple changes', async () => {
    const serverMock = createServerMock<number>(1);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    // Start awaitFetch
    const fetchPromise = documentStore.awaitFetch();

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    // Server data changes during fetch
    serverMock.setData(999);

    await vi.runAllTimersAsync();

    const result = await fetchPromise;

    // Should have the data that was present when fetch completed
    // (serverMock.fetch() returns whatever is set at fetch time)
    expect(result).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 999,
        },
        "error": null,
      }
    `);
  });

  test('awaitFetch with immediate error', async () => {
    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: () => {
          throw new Error('Immediate failure');
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    const resultPromise = documentStore.awaitFetch();

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      {
        "data": null,
        "error": {
          "e": "Immediate failure",
        },
      }
    `);
  });

  test('awaitFetch preserves previous data on error', async () => {
    let shouldFail = false;
    const serverMock = createServerMock<number>(42);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          if (shouldFail) {
            throw new Error('Fetch failed');
          }
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    // First successful fetch
    const result1 = documentStore.awaitFetch();
    await vi.runAllTimersAsync();
    expect(await result1).toMatchInlineSnapshot(`
      {
        "data": {
          "value": 42,
        },
        "error": null,
      }
    `);

    // Verify data is in store
    expect(documentStore.store.state.data).toMatchInlineSnapshot(`
      {
        "value": 42,
      }
    `);

    // Second fetch fails
    shouldFail = true;
    const result2 = documentStore.awaitFetch();
    await vi.runAllTimersAsync();

    // awaitFetch returns error
    expect(await result2).toMatchInlineSnapshot(`
      {
        "data": null,
        "error": {
          "e": "Fetch failed",
        },
      }
    `);

    // But store still has the previous data
    expect(documentStore.store.state.data).toMatchInlineSnapshot(`
      {
        "value": 42,
      }
    `);
    expect(documentStore.store.state.error).toMatchInlineSnapshot(`
      {
        "e": "Fetch failed",
      }
    `);
  });
});

describe('awaitFetch timing', () => {
  test('awaitFetch waits for coalescing window before starting fetch', async () => {
    const events: string[] = [];
    const serverMock = createServerMock<number>(42);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          events.push('fetch-start');
          const value = await serverMock.fetch();
          events.push('fetch-end');
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 50,
      },
    );

    const fetchPromise = documentStore.awaitFetch();
    events.push('awaitFetch-called');

    // Before coalescing window ends
    await vi.advanceTimersByTimeAsync(30);
    expect(events).toMatchInlineSnapshot(`
      [
        "awaitFetch-called",
      ]
    `);

    // After coalescing window ends
    await vi.advanceTimersByTimeAsync(25);
    expect(events).toContain('fetch-start');

    await vi.runAllTimersAsync();
    await fetchPromise;

    expect(events).toMatchInlineSnapshot(`
      [
        "awaitFetch-called",
        "fetch-start",
        "fetch-end",
      ]
    `);
  });

  test('awaitFetch resolves only after fetch completes', async () => {
    let resolved = false;
    const serverMock = createServerMock<number>(42);
    serverMock.setFetchDurations(500);

    const documentStore = createDocumentStore<{ value: number }, { e: string }>(
      {
        fetchFn: async () => {
          const value = await serverMock.fetch();
          return { value };
        },
        errorNormalizer: (e) => ({ e: e.message }),
        lowPriorityThrottleMs: 200,
        baseCoalescingWindowMs: 10,
      },
    );

    const fetchPromise = documentStore.awaitFetch().then((result) => {
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
});
