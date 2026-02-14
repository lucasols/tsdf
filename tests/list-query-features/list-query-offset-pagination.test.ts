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
import { flushAllTimers, range } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('offset pagination - basic loadMore', () => {
  const serverData = {
    products: range(1, 20).map((id) => ({ id, name: `Product ${id}` })),
  };

  test('loadMore fetches only the new page (not all items from the start)', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    // Initial fetch: offset 0, limit 5
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    const queryAfterInitial = env.apiStore.getQueryState({
      tableId: 'products',
    });
    expect(queryAfterInitial?.items).toMatchInlineSnapshot(
      `['"products||1', '"products||2', '"products||3', '"products||4', '"products||5']`,
    );
    expect(queryAfterInitial?.hasMore).toBe(true);

    // loadMore: should fetch offset 5, limit 5 (only new page)
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    const queryAfterLoadMore = env.apiStore.getQueryState({
      tableId: 'products',
    });
    expect(queryAfterLoadMore?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
      - '"products||8'
      - '"products||9'
      - '"products||10'
    `);
    expect(queryAfterLoadMore?.hasMore).toBe(true);

    // Verify server received offset-based requests
    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches).toMatchInlineSnapshot(`
      - limit: 5
        offset: 0
        results:
          - data: { id: 1, name: 'Product 1' }
            itemId: 'products||1'
          - data: { id: 2, name: 'Product 2' }
            itemId: 'products||2'
          - data: { id: 3, name: 'Product 3' }
            itemId: 'products||3'
          - data: { id: 4, name: 'Product 4' }
            itemId: 'products||4'
          - data: { id: 5, name: 'Product 5' }
            itemId: 'products||5'
        type: 'list'
      - limit: 5
        offset: 5
        results:
          - data: { id: 6, name: 'Product 6' }
            itemId: 'products||6'
          - data: { id: 7, name: 'Product 7' }
            itemId: 'products||7'
          - data: { id: 8, name: 'Product 8' }
            itemId: 'products||8'
          - data: { id: 9, name: 'Product 9' }
            itemId: 'products||9'
          - data: { id: 10, name: 'Product 10' }
            itemId: 'products||10'
        type: 'list'
    `);
  });

  test('loadMore appends items without duplicates', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 3,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      3,
    );
    await flushAllTimers();

    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    expect(query).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('loadMore is skipped when hasMore is false', async () => {
    const smallServerData = {
      products: range(1, 3).map((id) => ({ id, name: `Product ${id}` })),
    };

    const env = createListQueryStoreTestEnv(smallServerData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    // Load all 3 items (less than defaultQuerySize, so hasMore = false)
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    const queryBefore = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryBefore?.hasMore).toBe(false);
    expect(queryBefore?.items).toMatchInlineSnapshot(
      `['"products||1', '"products||2', '"products||3']`,
    );

    // Reset history to verify no new fetch is made
    env.serverTable.fetchHistory.length = 0;

    // loadMore should be skipped since hasMore is false
    const result = env.apiStore.loadMore({ tableId: 'products' });
    expect(result).toBe('skipped');

    await flushAllTimers();

    // No fetch should have been made
    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches).toMatchInlineSnapshot('[]');

    // Items unchanged
    const queryAfter = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryAfter?.items).toMatchInlineSnapshot(
      `['"products||1', '"products||2', '"products||3']`,
    );
  });

  test('loadMore deduplicates items that shifted between pages', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    // Load first page: items 1-5
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    // Simulate 3 items inserted at the top of the list between page loads.
    // Reconstruct the server data so 3 new items appear first, shifting
    // existing items right by 3 positions.
    const existingEntries = env.serverTable
      .entries()
      .filter(([id]) => id.startsWith('products||'));
    for (const [id] of existingEntries) {
      env.serverTable.removeItem(id);
    }
    // New items at positions 0, 1, 2
    env.serverTable.setItem('products||21', { id: 21, name: 'New 21' });
    env.serverTable.setItem('products||22', { id: 22, name: 'New 22' });
    env.serverTable.setItem('products||23', { id: 23, name: 'New 23' });
    // Original items now start at position 3
    for (const [id, data] of existingEntries) {
      env.serverTable.setItem(id, data);
    }
    // Server order: [21, 22, 23, 1, 2, 3, 4, 5, 6, 7, ...]
    // loadMore (offset 5, limit 5) → positions 5-9 = items 3, 4, 5, 6, 7
    // Items 3, 4, 5 overlap with page 1

    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    // 5 from page 1 + 2 new unique (6, 7) — items 3, 4, 5 deduplicated
    expect(query?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
    `);
  });

  test('loadMore shows loadingMore status', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    env.apiStore.loadMore({ tableId: 'products' });

    // Wait for coalescing window
    await vi.advanceTimersByTimeAsync(15);

    const queryDuring = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryDuring?.status).toBe('loadingMore');

    await flushAllTimers();

    const queryAfter = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryAfter).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });
});

describe('offset pagination - chunked invalidation', () => {
  const serverData = {
    products: range(1, 30).map((id) => ({ id, name: `Product ${id}` })),
  };

  test('invalidation splits into multiple requests when totalLoaded > maxInvalidationLimit', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 5 },
    });

    // Load initial 5 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    // Load more to have 10 items total
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    // Load more to have 15 items total
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    const queryBefore = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryBefore?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
      - '"products||8'
      - '"products||9'
      - '"products||10'
      - '"products||11'
      - '"products||12'
      - '"products||13'
      - '"products||14'
      - '"products||15'
    `);

    // Reset history to track only invalidation fetches
    env.serverTable.fetchHistory.length = 0;

    // Trigger invalidation (scheduleListQueryFetch with highPriority on already loaded query)
    // This should refetch all 15 items but split into chunks of 5
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });

    await flushAllTimers();

    // Should have 3 chunk requests (15 / 5 = 3) with correct offset/limit
    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 5, offset: 0 }
        - { limit: 5, offset: 5 }
        - { limit: 5, offset: 10 }
      `);

    const queryAfter = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryAfter).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
        - '"products||11'
        - '"products||12'
        - '"products||13'
        - '"products||14'
        - '"products||15'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('invalidation does NOT chunk when totalLoaded <= maxInvalidationLimit', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 10 },
    });

    // Load initial 5 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    env.serverTable.fetchHistory.length = 0;

    // Trigger invalidation - 5 items, maxInvalidationLimit = 10
    // Should be a single request
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });
    await flushAllTimers();

    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 5, offset: 0 }
      `);
  });

  test('invalidation does NOT chunk when totalLoaded equals maxInvalidationLimit', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 5 },
    });

    // Load exactly 5 items (== maxInvalidationLimit)
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    env.serverTable.fetchHistory.length = 0;

    // Trigger invalidation — 5 items, maxInvalidationLimit = 5
    // Condition is `limit > max` (strictly greater), so 5 == 5 should NOT chunk
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });
    await flushAllTimers();

    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 5, offset: 0 }
      `);
  });

  test('chunked invalidation handles remainder chunk correctly', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 4,
      offsetPagination: { maxInvalidationLimit: 5 },
    });

    // Load 12 items (3 loadMores of 4)
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      4,
    );
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    expect(env.apiStore.getQueryState({ tableId: 'products' })?.items)
      .toMatchInlineSnapshot(`
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
        - '"products||11'
        - '"products||12'
      `);

    env.serverTable.fetchHistory.length = 0;

    // Trigger invalidation — 12 items / maxInvalidationLimit 5
    // Should produce 3 chunks: {0,5}, {5,5}, {10,2}
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });
    await flushAllTimers();

    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 5, offset: 0 }
        - { limit: 5, offset: 5 }
        - { limit: 2, offset: 10 }
      `);

    const queryAfter = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryAfter).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
        - '"products||11'
        - '"products||12'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('chunks are fetched in parallel', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 5 },
    });

    // Load 15 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    expect(env.apiStore.getQueryState({ tableId: 'products' })?.items)
      .toMatchInlineSnapshot(`
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
        - '"products||11'
        - '"products||12'
        - '"products||13'
        - '"products||14'
        - '"products||15'
      `);

    // Store fetch counts before invalidation
    const startedBefore = env.serverTable.numOfStartedFetches;
    const finishedBefore = env.serverTable.numOfFinishedFetches;

    // Trigger chunked invalidation (15 items / maxInvalidationLimit 5 = 3 chunks)
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });

    // Advance past coalescing window to start the fetch
    await vi.advanceTimersByTimeAsync(15);

    // All 3 chunks should have started in parallel (none finished yet)
    expect(env.serverTable.numOfStartedFetches - startedBefore).toBe(3);
    expect(env.serverTable.numOfFinishedFetches - finishedBefore).toBe(0);

    await flushAllTimers();

    // All 3 chunks should be complete
    expect(env.serverTable.numOfFinishedFetches - finishedBefore).toBe(3);
  });

  test('chunked invalidation preserves deterministic item ordering', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 5 },
    });

    // Load 15 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    // Trigger chunked invalidation
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });
    await flushAllTimers();

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    expect(query?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
      - '"products||8'
      - '"products||9'
      - '"products||10'
      - '"products||11'
      - '"products||12'
      - '"products||13'
      - '"products||14'
      - '"products||15'
    `);
  });

  test('chunk error causes full query error', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 5 },
    });

    // Load 10 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    expect(env.apiStore.getQueryState({ tableId: 'products' })?.items)
      .toMatchInlineSnapshot(`
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      `);

    // Set error for next list fetch (will affect one of the chunks)
    env.serverTable.setNextListFetchError('chunk error');

    // Trigger invalidation - should split into 2 chunks, one will fail
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });
    await flushAllTimers();

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    expect(query).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'chunk error' }
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'error'
      wasLoaded: '✅'
    `);
  });
});

describe('offset pagination - coalescing', () => {
  const serverData = {
    products: range(1, 20).map((id) => ({ id, name: `Product ${id}` })),
  };

  test('loadMore wins over load when coalesced', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
      baseCoalescingWindowMs: 50,
    });

    // Load initial 5 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    // Reset history to track only coalesced fetch
    env.serverTable.fetchHistory.length = 0;

    // Trigger loadMore and load in same coalescing window
    env.apiStore.loadMore({ tableId: 'products' });
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );

    await vi.advanceTimersByTimeAsync(60);

    // 'loadMore' wins → status should be 'loadingMore' (not 'refetching')
    const queryDuring = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryDuring?.status).toBe('loadingMore');

    await flushAllTimers();

    const queryAfter = env.apiStore.getQueryState({ tableId: 'products' });
    expect(queryAfter?.status).toBe('success');
    // Merged request should cover the combined range and fetch all 10 items
    expect(queryAfter?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
      - '"products||8'
      - '"products||9'
      - '"products||10'
    `);

    // Verify a single coalesced fetch was made with the merged offset/limit
    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 10, offset: 0 }
      `);
  });

  test('coalesced offset ranges merge correctly', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
      baseCoalescingWindowMs: 50,
    });

    // Load initial 5 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    // Reset history to track only the coalesced fetch
    env.serverTable.fetchHistory.length = 0;

    // Multiple loadMores within coalescing window
    // loadMore(..., 3) → offset 5, limit 3
    // loadMore(..., 5) → offset 5, limit 5
    // Merged result should be offset 5, limit 5 (max of the two limits)
    env.apiStore.loadMore({ tableId: 'products' }, 3);
    env.apiStore.loadMore({ tableId: 'products' }, 5);

    await flushAllTimers();

    // Verify the coalesced fetch used the merged (larger) limit
    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 5, offset: 5 }
      `);

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    expect(query?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
      - '"products||8'
      - '"products||9'
      - '"products||10'
    `);
  });

  test('coalesced merge uses larger limit regardless of order', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
      baseCoalescingWindowMs: 50,
    });

    // Load initial 5 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    env.serverTable.fetchHistory.length = 0;

    // Reverse order: larger limit first, smaller second
    // loadMore(..., 5) → offset 5, limit 5
    // loadMore(..., 3) → offset 5, limit 3
    // Merge should still use limit 5 (not 3 from last-write-wins)
    env.apiStore.loadMore({ tableId: 'products' }, 5);
    env.apiStore.loadMore({ tableId: 'products' }, 3);

    await flushAllTimers();

    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 5, offset: 5 }
      `);

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    expect(query?.items).toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"products||4'
      - '"products||5'
      - '"products||6'
      - '"products||7'
      - '"products||8'
      - '"products||9'
      - '"products||10'
    `);
  });
});

describe('offset pagination - refetch after loadMore keeps size', () => {
  const serverData = {
    products: range(1, 20).map((id) => ({ id, name: `Product ${id}` })),
  };

  test('refetch after loadMore refetches the full loaded size', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    // Load 5 items
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'products' },
      5,
    );
    await flushAllTimers();

    // Load 5 more
    env.apiStore.loadMore({ tableId: 'products' });
    await flushAllTimers();

    expect(env.apiStore.getQueryState({ tableId: 'products' })?.items)
      .toMatchInlineSnapshot(`
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      `);

    env.serverTable.fetchHistory.length = 0;

    // Refetch should request all 10 items (offset: 0, limit: 10)
    env.apiStore.scheduleListQueryFetch('highPriority', {
      tableId: 'products',
    });
    await flushAllTimers();

    const query = env.apiStore.getQueryState({ tableId: 'products' });
    expect(query).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - '"products||1'
        - '"products||2'
        - '"products||3'
        - '"products||4'
        - '"products||5'
        - '"products||6'
        - '"products||7'
        - '"products||8'
        - '"products||9'
        - '"products||10'
      payload: { tableId: 'products' }
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Should be a single request since 10 <= maxInvalidationLimit (100)
    const listFetches = env.serverTable.fetchHistory.filter(
      (h) => h.type === 'list',
    );
    expect(listFetches.map(({ offset, limit }) => ({ offset, limit })))
      .toMatchInlineSnapshot(`
        - { limit: 10, offset: 0 }
      `);
  });
});

describe('offset pagination - awaitListQueryFetch', () => {
  const serverData = {
    products: range(1, 20).map((id) => ({ id, name: `Product ${id}` })),
  };

  test('awaitListQueryFetch returns items and hasMore correctly', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    const fetchPromise = env.apiStore.awaitListQueryFetch(
      { tableId: 'products' },
      { size: 5 },
    );

    await flushAllTimers();

    const result = await fetchPromise;

    expect(result).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items:
        - data: { id: 1, name: 'Product 1' }
          itemPayload: 'products||1'
        - data: { id: 2, name: 'Product 2' }
          itemPayload: 'products||2'
        - data: { id: 3, name: 'Product 3' }
          itemPayload: 'products||3'
        - data: { id: 4, name: 'Product 4' }
          itemPayload: 'products||4'
        - data: { id: 5, name: 'Product 5' }
          itemPayload: 'products||5'
    `);
  });

  test('awaitListQueryFetch returns hasMore false when all items fetched', async () => {
    const smallServerData = {
      products: range(1, 3).map((id) => ({ id, name: `Product ${id}` })),
    };

    const env = createListQueryStoreTestEnv(smallServerData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    const fetchPromise = env.apiStore.awaitListQueryFetch(
      { tableId: 'products' },
      { size: 5 },
    );

    await flushAllTimers();

    const result = await fetchPromise;

    expect(result).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items:
        - data: { id: 1, name: 'Product 1' }
          itemPayload: 'products||1'
        - data: { id: 2, name: 'Product 2' }
          itemPayload: 'products||2'
        - data: { id: 3, name: 'Product 3' }
          itemPayload: 'products||3'
    `);
  });

  test('awaitListQueryFetch returns error on fetch failure', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    env.serverTable.setNextListFetchError('network failure');

    const fetchPromise = env.apiStore.awaitListQueryFetch(
      { tableId: 'products' },
      { size: 5 },
    );

    await flushAllTimers();

    const result = await fetchPromise;

    expect(result).toMatchInlineSnapshot(`
      error{Error}: { message: 'network failure', name: 'StoreFetchError' }
      hasMore: '❌'
      items: []
    `);
  });
});
