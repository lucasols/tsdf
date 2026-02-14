import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
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
    { id: 5, name: 'Item 5' },
    { id: 6, name: 'Item 6' },
  ],
};

describe('query size coalescing', () => {
  test('same query key with different sizes → max size is used in fetch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
    });

    // Schedule same query with size 2
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 2);
    // Schedule same query with size 5 (larger)
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 5);

    await flushAllTimers();

    // The fetch should have used size 5 (the max)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 5
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
        type: 'list'
    `);
  });

  test('smaller size scheduled after larger size does not shrink the fetch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
    });

    // Schedule with large size first
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 5);
    // Then schedule with small size
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 2);

    await flushAllTimers();

    // The fetch should still use size 5 (the max)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 5
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
        type: 'list'
    `);
  });

  test('loadMore + load coalesce for same key → becomes loadMore with max size', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 3,
    });

    // Do initial fetch to load 3 items with hasMore: true
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);
    await flushAllTimers();

    const queryAfterInitial = env.apiStore.getQueryState({
      tableId: 'table1',
    });
    expect(queryAfterInitial?.items.length).toBe(3);
    expect(queryAfterInitial?.hasMore).toBe(true);

    // loadMore adds defaultQuerySize (3) more → total size = 3 + 3 = 6
    env.apiStore.loadMore({ tableId: 'table1' });
    // Then a regular load with size 3 → querySize = max(3 items, 3) = 3
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);

    // Advance past coalescing window to start the second fetch
    await vi.advanceTimersByTimeAsync(60);

    // 'loadMore' type wins over 'load' in coalescePayload → status is 'loadingMore'
    const queryDuringFetch = env.apiStore.getQueryState({ tableId: 'table1' });
    expect(queryDuringFetch?.status).toBe('loadingMore');

    await flushAllTimers();

    // Second fetch should use size 6 (max of loadMore's 6, load's 3)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 3
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        type: 'list'
      - limit: 6
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
          - data: { id: 6, name: 'Item 6' }
            itemId: 'table1||6'
        type: 'list'
    `);

    const queryAfterCoalesced = env.apiStore.getQueryState({
      tableId: 'table1',
    });
    // 'load' type wins → status was 'refetching' (not 'loadingMore')
    expect(queryAfterCoalesced?.status).toBe('success');
    expect(queryAfterCoalesced?.hasMore).toBe(false);
    expect(queryAfterCoalesced?.items.length).toBe(6);
  });

  test('staggered arrivals with different sizes within coalescing window → max size is used', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 100,
      defaultQuerySize: 2,
    });

    // Three requests at staggered times within the 100ms coalescing window
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 2);

    await vi.advanceTimersByTimeAsync(30);
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 4);

    await vi.advanceTimersByTimeAsync(30);
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);

    await flushAllTimers();

    // The fetch should use size 4 (the max of 2, 4, 3)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 4
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
        type: 'list'
    `);

    expect(env.serverTable.fetchHistory.length).toBe(1);
  });

  test('default query size interacts correctly with explicit size', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 3,
    });

    // Schedule without explicit size → uses defaultQuerySize (3)
    env.scheduleFetch('highPriority', { tableId: 'table1' });
    // Schedule with explicit size 5
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 5);

    await flushAllTimers();

    // The fetch should use size 5 (max of default 3, explicit 5)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 5
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
        type: 'list'
    `);

    expect(env.serverTable.fetchHistory.length).toBe(1);
  });

  test('two identical sizes still work correctly', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 3,
    });

    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 3
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        type: 'list'
    `);

    // Only one fetch was made (coalesced)
    expect(env.serverTable.fetchHistory.length).toBe(1);
  });
});

describe('size coalescing in scheduledRequests during active fetch (Call Site 2)', () => {
  test('requests during ongoing fetch coalesce sizes in scheduledRequests', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
    });

    // 1. Schedule query with size 3 → starts coalescing window
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);

    // 2. Advance past coalescing window → fetch starts
    await vi.advanceTimersByTimeAsync(60);

    // Fetch is now in progress
    expect(env.serverTable.numOfStartedFetches).toBe(1);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    // 3. While fetch is in progress, schedule same query with size 5 → goes to scheduledRequests
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 5);

    // 4. Schedule same query again with size 2 → coalesces in scheduledRequests via Call Site 2
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 2);

    // 5. Let fetch complete and scheduled requests flush
    await flushAllTimers();

    // Assert: fetchHistory has 2 entries, second with limit: 5 (max of 5, 2)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 3
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
        type: 'list'
      - limit: 5
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
        type: 'list'
    `);
  });

  test('multiple requests during ongoing fetch coalesce to max size then flush', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
    });

    // 1. Schedule query with size 2 → starts coalescing window
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 2);

    // 2. Advance past coalescing window → fetch starts
    await vi.advanceTimersByTimeAsync(60);

    expect(env.serverTable.numOfStartedFetches).toBe(1);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);

    // 3. While fetch is in progress, schedule 3 requests with different sizes
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 3);
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 6);
    env.scheduleFetch('highPriority', { tableId: 'table1' }, 4);

    // 4. Let fetch complete and scheduled requests flush
    await flushAllTimers();

    // First fetch used limit 2, second fetch uses limit 6 (max of 3, 6, 4)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 2
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        type: 'list'
      - limit: 6
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
          - data: { id: 6, name: 'Item 6' }
            itemId: 'table1||6'
        type: 'list'
    `);

    expect(env.serverTable.fetchHistory.length).toBe(2);
  });
});
