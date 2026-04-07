import { act, renderHook } from '@testing-library/react';
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
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

const serverData = {
  table1: [
    { id: 1, name: 'Item 1' },
    { id: 2, name: 'Item 2' },
    { id: 3, name: 'Item 3' },
    { id: 4, name: 'Item 4' },
  ],
};

describe('batch coalescing basic behavior', () => {
  test('multiple items scheduled during coalescing window are batched together', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table1||3');

    await flushAllTimers();

    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);
    expect(env.apiStore.getItemState('table1||2')).toMatchInlineSnapshot(`
      id: 2
      name: 'Item 2'
    `);
    expect(env.apiStore.getItemState('table1||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Item 3'
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2', 'table1||3']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2","table1||3"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });

  test('single item uses fetchItemFn instead of batchFetchItemFn', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');

    await flushAllTimers();

    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);

    // Single item uses fetchFn, not batch
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - duration: 800
        itemId: 'table1||1'
        result: { id: 1, name: 'Item 1' }
        startedAt: 50
        type: 'fetch'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >fetch-started
      850ms | 🔴 <fetch-finished (value: {"id":1,"name":"Item 1"})
      "
    `);
  });

  test('items arriving at different times within window are all batched', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 100,
      useBatchFetch: true,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');

    await vi.advanceTimersByTimeAsync(30);
    env.scheduleItemFetch('highPriority', 'table1||2');

    await vi.advanceTimersByTimeAsync(30);
    env.scheduleItemFetch('highPriority', 'table1||3');

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2', 'table1||3']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        startedAt: 100
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      100ms | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2","table1||3"]})
      900ms | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });
});

describe('maxItemBatchSize behavior', () => {
  test('reaching maxItemBatchSize triggers immediate batch fetch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 100,
      useBatchFetch: true,
      maxItemBatchSize: 2,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        startedAt: 0
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      .     | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      800ms | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });

  test('items exceeding maxItemBatchSize go into next batch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 100,
      useBatchFetch: true,
      maxItemBatchSize: 2,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table1||3');
    env.scheduleItemFetch('highPriority', 'table1||4');

    await flushAllTimers();

    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);
    expect(env.apiStore.getItemState('table1||2')).toMatchInlineSnapshot(`
      id: 2
      name: 'Item 2'
    `);
    expect(env.apiStore.getItemState('table1||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Item 3'
    `);
    expect(env.apiStore.getItemState('table1||4')).toMatchInlineSnapshot(`
      id: 4
      name: 'Item 4'
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        startedAt: 0
        type: 'list'
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||3', 'table1||4']
        offset: 0
        results:
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
        startedAt: 900
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | [table1||1] scheduled-fetch-triggered
      .     | [table1||3, table1||4] scheduled-fetch-scheduled
      .     | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      800ms | 🔴 <list-fetch-finished (value: {"count":2})
      900ms | 🟠 >list-fetch-started (value: {"itemIds":["table1||3","table1||4"]})
      1.7s  | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});

describe('requests during ongoing fetch', () => {
  test('requests during fetch are scheduled for after fetch completes', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    env.serverTable.setFetchDurations('table1||1', 500);
    env.serverTable.setFetchDurations('table1||2', 500);

    // First batch
    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');

    // Wait for fetch to start
    await vi.advanceTimersByTimeAsync(60);

    // Schedule another item during ongoing fetch
    env.scheduleItemFetch('highPriority', 'table1||3');

    await flushAllTimers();

    // First list fetch, then table1||3 as individual fetch
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        startedAt: 50
        type: 'list'
      - duration: 800
        itemId: 'table1||3'
        result: { id: 3, name: 'Item 3' }
        startedAt: 900
        type: 'fetch'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | [table1||1] scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      60ms  | [table1||3] scheduled-fetch-scheduled
      850ms | 🔴 <list-fetch-finished (value: {"count":2})
      900ms | 🟠 [table1||3] >fetch-started
      1.7s  | 🟠 [table1||3] <fetch-finished (value: {"id":3,"name":"Item 3"})
      "
    `);
  });
});

describe('mutation handling', () => {
  test('item under mutation is excluded from batch', async () => {
    const env = createListQueryStoreTestEnv(
      {
        table1: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
        ],
      },
      {
        testScenario: {
          loaded: { tables: ['table1'], items: ['table1||1', 'table1||2'] },
        },
        usesRealTimeUpdates: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    renderHook(() => {
      const item1 = env.apiStore.useItem('table1||1');
      const item2 = env.apiStore.useItem('table1||2');
      env.trackItemUI('table1||1', item1.data);
      env.trackItemUI('table1||2', item2.data);
    });

    await flushAllTimers();

    // Start mutation on table1||1
    act(() => {
      void env.performClientItemUpdateAction(
        'table1||1',
        { id: 1, name: 'Updated' },
        { withOptimisticUpdate: true, withRevalidation: true },
      );
    });

    // Try to batch fetch both items
    act(() => {
      env.apiStore.invalidateItem('table1||1', 'highPriority');
      env.apiStore.invalidateItem('table1||2', 'highPriority');
    });

    await flushAllTimers();

    // item2 should have been fetched separately since item1 was under mutation
    expect(env.apiStore.getItemState('table1||2')).toMatchInlineSnapshot(`
      id: 2
      name: 'Item 2'
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - duration: 800
        itemId: 'table1||2'
        result: { id: 2, name: 'Item 2' }
        startedAt: 50
        type: 'fetch'
      - duration: 800
        itemId: 'table1||1'
        result: { id: 1, name: 'Updated' }
        startedAt: 1250
        type: 'fetch'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | table1||1                 | table1||2                |
      0     | {"id":1,"name":"Item 1"}  | {"id":2,"name":"Item 2"} | [table1||1, table1||2] ui-initialized
      .     | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | ⬜ [table1||1] optimistic-ui-commit
      .     | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | ⬜ [table1||1] >mutation-started (value: {"id":1,"name":"Updated"})
      .     | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | [table1||1] ui-changed
      50ms  | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | 🔴 [table1||2] >fetch-started
      840ms | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | ⬜ [table1||1] <mutation-data-persisted (value: {"id":1,"name":"Updated"})
      850ms | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | 🔴 [table1||2] <fetch-finished (value: {"id":2,"name":"Item 2"})
      1.25s | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | 🟠 [table1||1] >fetch-started
      2.05s | {"id":1,"name":"Updated"} | {"id":2,"name":"Item 2"} | 🟠 [table1||1] <fetch-finished (value: {"id":1,"name":"Updated"})
      "
    `);
  });
});

describe('error handling in batch', () => {
  test('batch fetch network error: all items fail with same error', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    // Make the batch request fail entirely (network error)
    env.serverTable.setNextListFetchError('Network error');

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');

    await flushAllTimers();

    // Both items should have the same error
    expect(env.getItemQueryState('table1||1')?.status).toBe('error');
    expect(env.getItemQueryState('table1||1')?.error?.message).toBe(
      'Network error',
    );

    expect(env.getItemQueryState('table1||2')?.status).toBe('error');
    expect(env.getItemQueryState('table1||2')?.error?.message).toBe(
      'Network error',
    );

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      850ms | 🔴 <list-fetch-error (value: "error")
      "
    `);
  });
});

describe('awaitItemFetch with batch', () => {
  test('awaitItemFetch for specific item resolves after batch completes', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    // Schedule multiple items
    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');

    // Await for specific item
    const resultPromise = env.apiStore.awaitItemFetch('table1||3');

    await flushAllTimers();

    const result = await resultPromise;

    expect(result).toMatchInlineSnapshot(`
      data: { id: 3, name: 'Item 3' }
      error: null
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2', 'table1||3']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2","table1||3"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });

  test('awaitItemFetch returns error when batch fails', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    // Make the batch request fail entirely
    env.serverTable.setNextListFetchError('Network error');

    env.scheduleItemFetch('highPriority', 'table1||1');
    const resultPromise = env.apiStore.awaitItemFetch('table1||2');

    await flushAllTimers();

    const result = await resultPromise;

    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(StoreFetchError);
    expect(result.error?.message).toBe('Network error');

    // table1||1 should also fail with the same error
    expect(env.getItemQueryState('table1||1')?.status).toBe('error');
    expect(env.getItemQueryState('table1||1')?.error?.message).toBe(
      'Network error',
    );

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      850ms | 🔴 <list-fetch-error (value: "error")
      "
    `);
  });

  test('multiple awaitItemFetch calls for same item coalesce', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    const promise1 = env.apiStore.awaitItemFetch('table1||1');
    const promise2 = env.apiStore.awaitItemFetch('table1||1');
    const promise3 = env.apiStore.awaitItemFetch('table1||1');

    await flushAllTimers();

    const [result1, result2, result3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    expect(result1).toMatchInlineSnapshot(`
      data: { id: 1, name: 'Item 1' }
      error: null
    `);
    expect(result2).toMatchInlineSnapshot(`
      data: { id: 1, name: 'Item 1' }
      error: null
    `);
    expect(result3).toMatchInlineSnapshot(`
      data: { id: 1, name: 'Item 1' }
      error: null
    `);

    // Only one fetch (single item, so uses fetchFn)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - duration: 800
        itemId: 'table1||1'
        result: { id: 1, name: 'Item 1' }
        startedAt: 50
        type: 'fetch'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      50ms  | 🔴 >fetch-started
      850ms | 🔴 <fetch-finished (value: {"id":1,"name":"Item 1"})
      "
    `);
  });

  test('awaitItemFetch for different items resolves when batch completes', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    const promise1 = env.apiStore.awaitItemFetch('table1||1');
    const promise2 = env.apiStore.awaitItemFetch('table1||2');

    await flushAllTimers();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1).toMatchInlineSnapshot(`
      data: { id: 1, name: 'Item 1' }
      error: null
    `);
    expect(result2).toMatchInlineSnapshot(`
      data: { id: 2, name: 'Item 2' }
      error: null
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});

describe('priority handling in batch', () => {
  test('items scheduled consecutively are batched together', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table1||3');

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2', 'table1||3']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2","table1||3"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });

  test('mixed priorities are batched together', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      usesRealTimeUpdates: true,
    });

    env.scheduleItemFetch('lowPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('realtimeUpdate', 'table1||3');

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2', 'table1||3']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2","table1||3"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);
  });
});

describe('batch with UI hooks', () => {
  test('UI updates correctly after batch fetch completes via explicit scheduling', async () => {
    const env = createListQueryStoreTestEnv(
      {
        table1: [
          { id: 1, name: 'Item 1' },
          { id: 2, name: 'Item 2' },
        ],
      },
      {
        testScenario: {
          loaded: { tables: ['table1'], items: ['table1||1', 'table1||2'] },
        },
        usesRealTimeUpdates: true,
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
      },
    );

    renderHook(() => {
      const item1 = env.apiStore.useItem('table1||1');
      const item2 = env.apiStore.useItem('table1||2');
      env.trackItemUI('table1||1', item1.data);
      env.trackItemUI('table1||2', item2.data);
    });

    // Items have initial data, now invalidate them to trigger batch fetch
    act(() => {
      env.apiStore.invalidateItem('table1||1', 'highPriority');
      env.apiStore.invalidateItem('table1||2', 'highPriority');
    });

    await flushAllTimers();

    // UI should still show the values
    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);
    expect(env.apiStore.getItemState('table1||2')).toMatchInlineSnapshot(`
      id: 2
      name: 'Item 2'
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | table1||1                | table1||2                |
      0     | {"id":1,"name":"Item 1"} | {"id":2,"name":"Item 2"} | [table1||1, table1||2] ui-initialized
      50ms  | {"id":1,"name":"Item 1"} | {"id":2,"name":"Item 2"} | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      850ms | {"id":1,"name":"Item 1"} | {"id":2,"name":"Item 2"} | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});

describe('duplicate item requests in batch', () => {
  test('same item scheduled multiple times appears once in batch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||1');

    await flushAllTimers();

    // Single item, so uses fetchFn not batchFetchFn
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - duration: 800
        itemId: 'table1||1'
        result: { id: 1, name: 'Item 1' }
        startedAt: 50
        type: 'fetch'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | scheduled-fetch-triggered
      .     | scheduled-fetch-coalesced
      .     | scheduled-fetch-coalesced
      50ms  | 🔴 >fetch-started
      850ms | 🔴 <fetch-finished (value: {"id":1,"name":"Item 1"})
      "
    `);
  });

  test('multiple items with duplicates are deduplicated in batch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');

    await flushAllTimers();

    // Should have exactly 2 items in batch (deduplicated)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        startedAt: 50
        type: 'list'
    `);

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      0     | [table1||1] scheduled-fetch-triggered
      .     | [table1||1, table1||2] scheduled-fetch-coalesced
      50ms  | 🔴 >list-fetch-started (value: {"itemIds":["table1||1","table1||2"]})
      850ms | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});
