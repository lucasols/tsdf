import { compactSnapshot } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { StoreFetchError } from '../../src/utils/storeShared';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('batch coalescing basic behavior', () => {
  test('multiple items scheduled during coalescing window are batched together', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    // Schedule multiple items within the coalescing window
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');
    env.scheduleFetch('highPriority', 'item3');

    await vi.runAllTimersAsync();

    // All items should have data
    expect(env.apiStore.getItemState('item1')?.data?.value).toBe(1);
    expect(env.apiStore.getItemState('item2')?.data?.value).toBe(2);
    expect(env.apiStore.getItemState('item3')?.data?.value).toBe(3);

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2', 'item3']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
            - { itemId: 'item3', data: 3 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2","item3"]})
      850ms | -     | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });

  test('single item uses fetchFn instead of batchFetchFn', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    env.scheduleFetch('highPriority', 'item1');

    await vi.runAllTimersAsync();

    expect(env.apiStore.getItemState('item1')?.data?.value).toBe(1);

    // Single item uses fetchFn, not batch
    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - { type: 'fetch', itemId: 'item1', result: 1 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >fetch-started
      850ms | -     | 🔴 <fetch-finished (value: 1)
      "
    `);
  });

  test('items arriving at different times within window are all batched', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 100,
        useBatchFetch: true,
      },
    );

    env.scheduleFetch('highPriority', 'item1');

    await vi.advanceTimersByTimeAsync(30);
    env.scheduleFetch('highPriority', 'item2');

    await vi.advanceTimersByTimeAsync(30);
    env.scheduleFetch('highPriority', 'item3');

    await vi.runAllTimersAsync();

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2', 'item3']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
            - { itemId: 'item3', data: 3 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      100ms | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2","item3"]})
      900ms | -     | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });
});

describe('maxBatchSize behavior', () => {
  test('reaching maxBatchSize triggers immediate batch fetch', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3, item4: 4 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 100,
        useBatchFetch: true,
        maxBatchSize: 2,
      },
    );

    // Schedule 2 items (reaches maxBatchSize)
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');

    await vi.runAllTimersAsync();

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      .     | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      800ms | -     | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });

  test('items exceeding maxBatchSize go into next batch', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3, item4: 4 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 100,
        useBatchFetch: true,
        maxBatchSize: 2,
      },
    );

    // Schedule 4 items with maxBatchSize: 2
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');
    env.scheduleFetch('highPriority', 'item3');
    env.scheduleFetch('highPriority', 'item4');

    await vi.runAllTimersAsync();

    // All items should have data
    expect(env.apiStore.getItemState('item1')?.data?.value).toBe(1);
    expect(env.apiStore.getItemState('item2')?.data?.value).toBe(2);
    expect(env.apiStore.getItemState('item3')?.data?.value).toBe(3);
    expect(env.apiStore.getItemState('item4')?.data?.value).toBe(4);

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
        - type: 'list'
          itemIds: ['item3', 'item4']
          results:
            - { itemId: 'item3', data: 3 }
            - { itemId: 'item4', data: 4 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 | item3 | item4 |
      0     | -     | -     | -     | [item1] scheduled-fetch-triggered
      .     | -     | -     | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      .     | -     | -     | -     | [item3] scheduled-fetch-scheduled
      .     | -     | -     | -     | [item4] scheduled-fetch-scheduled
      800ms | -     | -     | -     | 🔴 <list-fetch-finished (value: {"count":2})
      900ms | -     | -     | -     | 🟠 >list-fetch-started (value: {"itemIds":["item3","item4"]})
      1.7s  | -     | -     | -     | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});

describe('requests during ongoing fetch', () => {
  test('requests during fetch are scheduled for after fetch completes', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    env.serverTable.setFetchDurations('item1', 500);
    env.serverTable.setFetchDurations('item2', 500);

    // First batch
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');

    // Wait for fetch to start
    await vi.advanceTimersByTimeAsync(60);

    // Schedule another item during ongoing fetch
    env.scheduleFetch('highPriority', 'item3');

    await vi.runAllTimersAsync();

    // First list fetch, then item3 as individual fetch
    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
        - { type: 'fetch', itemId: 'item3', result: 3 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 | item3 |
      0     | -     | -     | [item1] scheduled-fetch-triggered
      50ms  | -     | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      60ms  | -     | -     | [item3] scheduled-fetch-scheduled
      850ms | -     | -     | 🔴 <list-fetch-finished (value: {"count":2})
      900ms | -     | -     | 🟠 [item3] >fetch-started
      1.7s  | -     | -     | 🟠 [item3] <fetch-finished (value: 3)
      "
    `);
  });
});

describe('mutation handling', () => {
  test('item under mutation is excluded from batch', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2 },
      {
        forceInitialDataInvalidation: false,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    renderHook(() => {
      const item1 = env.apiStore.useItem('item1');
      const item2 = env.apiStore.useItem('item2');
      env.trackItemUI('item1', item1.data?.value);
      env.trackItemUI('item2', item2.data?.value);
    });

    await vi.runAllTimersAsync();

    // Start mutation on item1
    void env.performClientUpdateAction('item1', 100, {
      withOptimisticUpdate: true,
      withRevalidation: true,
    });

    // Try to batch fetch both items
    env.apiStore.invalidateItem('item1', 'highPriority');
    env.apiStore.invalidateItem('item2', 'highPriority');

    await vi.runAllTimersAsync();

    // item2 should have been fetched separately since item1 was under mutation
    expect(env.apiStore.getItemState('item2')?.data?.value).toBe(2);

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - { type: 'fetch', itemId: 'item2', result: 2 }
        - { type: 'fetch', itemId: 'item1', result: 100 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 | item2 |
      0     | 1     | -     | [item1] ui-initialized
      .     | 1     | 2     | [item2] ui-changed
      .     | 100   | 2     | ⬜ [item1] optimistic-ui-commit
      .     | 100   | 2     | ⬜ [item1] >mutation-started (value: 100)
      50ms  | 100   | 2     | 🔴 [item2] >fetch-started
      840ms | 100   | 2     | ⬜ [item1] <mutation-data-persisted (value: 100)
      850ms | 100   | 2     | 🔴 [item2] <fetch-finished (value: 2)
      1.25s | 100   | 2     | 🟠 [item1] >fetch-started
      2.05s | 100   | 2     | 🟠 [item1] <fetch-finished (value: 100)
      "
    `);
  });
});

describe('error handling in batch', () => {
  test('batch fetch network error: all items fail with same error', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    // Make the batch request fail entirely (network error)
    env.serverTable.setNextListFetchError('Network error');

    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');

    await vi.runAllTimersAsync();

    // Both items should have the same error
    expect(env.apiStore.getItemState('item1')?.status).toBe('error');
    expect(env.apiStore.getItemState('item1')?.error?.message).toBe(
      'Network error',
    );

    expect(env.apiStore.getItemState('item2')?.status).toBe('error');
    expect(env.apiStore.getItemState('item2')?.error?.message).toBe(
      'Network error',
    );

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      850ms | -     | 🔴 <list-fetch-error (value: "error")
      "
    `);
  });
});

describe('awaitFetch with batch', () => {
  test('awaitFetch for specific item resolves after batch completes', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    // Schedule multiple items
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');

    // Await for specific item
    const resultPromise = env.apiStore.awaitFetch('item3');

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result).toEqual({
      data: { value: 3 },
      error: null,
    });

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2', 'item3']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
            - { itemId: 'item3', data: 3 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2","item3"]})
      850ms | -     | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });

  test('awaitFetch returns error when batch fails', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    // Make the batch request fail entirely
    env.serverTable.setNextListFetchError('Network error');

    env.scheduleFetch('highPriority', 'item1');
    const resultPromise = env.apiStore.awaitFetch('item2');

    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Network error');

    // item1 should also fail with the same error
    expect(env.apiStore.getItemState('item1')?.status).toBe('error');
    expect(env.apiStore.getItemState('item1')?.error?.message).toBe(
      'Network error',
    );

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      850ms | -     | 🔴 <list-fetch-error (value: "error")
      "
    `);
  });

  test('multiple awaitFetch calls for same item coalesce', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    const promise1 = env.apiStore.awaitFetch('item1');
    const promise2 = env.apiStore.awaitFetch('item1');
    const promise3 = env.apiStore.awaitFetch('item1');

    await vi.runAllTimersAsync();

    const [result1, result2, result3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    expect(result1).toEqual({ data: { value: 1 }, error: null });
    expect(result2).toEqual({ data: { value: 1 }, error: null });
    expect(result3).toEqual({ data: { value: 1 }, error: null });

    // Only one fetch (single item, so uses fetchFn)
    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - { type: 'fetch', itemId: 'item1', result: 1 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      50ms  | -     | 🔴 >fetch-started
      850ms | -     | 🔴 <fetch-finished (value: 1)
      "
    `);
  });

  test('awaitFetch for different items resolves when batch completes', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    const promise1 = env.apiStore.awaitFetch('item1');
    const promise2 = env.apiStore.awaitFetch('item2');

    await vi.runAllTimersAsync();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toEqual({ data: { value: 1 }, error: null });
    expect(result2).toEqual({ data: { value: 2 }, error: null });

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});

describe('priority handling in batch', () => {
  test('items scheduled consecutively are batched together', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    // Use high priority to avoid low priority throttling
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');
    env.scheduleFetch('highPriority', 'item3');

    await vi.runAllTimersAsync();

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2', 'item3']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
            - { itemId: 'item3', data: 3 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2","item3"]})
      850ms | -     | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });

  test('mixed priorities are batched together', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2, item3: 3 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    env.scheduleFetch('lowPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');
    env.scheduleFetch('realtimeUpdate', 'item3');

    await vi.runAllTimersAsync();

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2', 'item3']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
            - { itemId: 'item3', data: 3 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      50ms  | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2","item3"]})
      850ms | -     | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });
});

describe('batch with UI hooks', () => {
  test('UI updates correctly after batch fetch completes via explicit scheduling', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2 },
      { baseCoalescingWindowMs: 50, useBatchFetch: true },
    );

    renderHook(() => {
      const item1 = env.apiStore.useItem('item1');
      const item2 = env.apiStore.useItem('item2');
      env.trackItemUI('item1', item1.data?.value);
      env.trackItemUI('item2', item2.data?.value);
    });

    // Items have initial data, now invalidate them to trigger batch fetch
    env.apiStore.invalidateItem('item1', 'highPriority');
    env.apiStore.invalidateItem('item2', 'highPriority');

    await vi.runAllTimersAsync();

    // UI should still show the values
    expect(env.apiStore.getItemState('item1')?.data?.value).toBe(1);
    expect(env.apiStore.getItemState('item2')?.data?.value).toBe(2);

    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 | item2 |
      0     | 1     | -     | [item1] ui-initialized
      .     | 1     | 2     | [item2] ui-changed
      50ms  | 1     | 2     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      850ms | 1     | 2     | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});

describe('duplicate item requests in batch', () => {
  test('same item scheduled multiple times appears once in batch', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item1');

    await vi.runAllTimersAsync();

    // Single item, so uses fetchFn not batchFetchFn
    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - { type: 'fetch', itemId: 'item1', result: 1 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      0     | -     | scheduled-fetch-triggered
      .     | -     | scheduled-fetch-coalesced
      .     | -     | scheduled-fetch-coalesced
      50ms  | -     | 🔴 >fetch-started
      850ms | -     | 🔴 <fetch-finished (value: 1)
      "
    `);
  });

  test('multiple items with duplicates are deduplicated in batch', async () => {
    const env = createCollectionStoreTestEnv(
      { item1: 1, item2: 2 },
      {
        forceInitialDataInvalidation: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');

    await vi.runAllTimersAsync();

    // Should have exactly 2 items in batch (deduplicated)
    expect(compactSnapshot(env.serverTable.fetchHistory))
      .toMatchInlineSnapshot(`
        "
        - type: 'list'
          itemIds: ['item1', 'item2']
          results:
            - { itemId: 'item1', data: 1 }
            - { itemId: 'item2', data: 2 }
        "
      `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 | item2 |
      0     | -     | -     | [item1] scheduled-fetch-triggered
      .     | -     | -     | [item1] scheduled-fetch-coalesced
      .     | -     | -     | [item2] scheduled-fetch-coalesced
      50ms  | -     | -     | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
      850ms | -     | -     | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});
