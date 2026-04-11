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
  ],
  table2: [
    { id: 10, name: 'Item 10' },
    { id: 20, name: 'Item 20' },
  ],
};

function getTableFromItemId(itemId: string): string {
  const tableId = itemId.split('||')[0];
  if (!tableId) throw new Error(`Invalid itemId: ${itemId}`);
  return tableId;
}

describe('batch key grouping', () => {
  test('items with same batch key are batched together', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      getItemsBatchKey: (payload) => getTableFromItemId(payload),
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

    // All items with same batch key should be in one batch
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'table1'
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
  });

  test('items with different batch keys go to separate batches', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      getItemsBatchKey: (payload) => getTableFromItemId(payload),
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table2||10');
    env.scheduleItemFetch('highPriority', 'table2||20');

    await flushAllTimers();

    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);
    expect(env.apiStore.getItemState('table2||10')).toMatchInlineSnapshot(`
      id: 10
      name: 'Item 10'
    `);

    // Items should be split into two separate batch fetches by table
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'table1'
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
      - batchKey: 'table2'
        duration: 800
        itemIds: ['table2||10', 'table2||20']
        offset: 0
        results:
          - data: { id: 10, name: 'Item 10' }
            itemId: 'table2||10'
          - data: { id: 20, name: 'Item 20' }
            itemId: 'table2||20'
        startedAt: 50
        type: 'list'
    `);
  });

  test('false batch key falls back to individual fetchItemFn', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      getItemsBatchKey: (payload) => {
        // table2 items should not be batched
        if (payload.startsWith('table2||')) return false;
        return getTableFromItemId(payload);
      },
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table2||10');

    await flushAllTimers();

    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);
    expect(env.apiStore.getItemState('table2||10')).toMatchInlineSnapshot(`
      id: 10
      name: 'Item 10'
    `);

    // table1 items batched, table2||10 individual fetch
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'table1'
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
        itemId: 'table2||10'
        result: { id: 10, name: 'Item 10' }
        startedAt: 50
        type: 'fetch'
    `);
  });

  test('mixed: some items batched by key, some individual', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      getItemsBatchKey: (payload) => {
        // table2 items fall back to individual fetch
        if (payload.startsWith('table2||')) return false;
        return getTableFromItemId(payload);
      },
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table2||10');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table2||20');

    await flushAllTimers();

    expect(env.apiStore.getItemState('table1||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Item 1'
    `);
    expect(env.apiStore.getItemState('table1||2')).toMatchInlineSnapshot(`
      id: 2
      name: 'Item 2'
    `);
    expect(env.apiStore.getItemState('table2||10')).toMatchInlineSnapshot(`
      id: 10
      name: 'Item 10'
    `);
    expect(env.apiStore.getItemState('table2||20')).toMatchInlineSnapshot(`
      id: 20
      name: 'Item 20'
    `);

    // table1 items batched together, table2 items fetched individually
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'table1'
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
        itemId: 'table2||10'
        result: { id: 10, name: 'Item 10' }
        startedAt: 50
        type: 'fetch'
      - duration: 800
        itemId: 'table2||20'
        result: { id: 20, name: 'Item 20' }
        startedAt: 50
        type: 'fetch'
    `);
  });

  test('backward compat: no getItemsBatchKey + useBatchFetch → all items batched', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      // No getItemsBatchKey provided
    });

    env.scheduleItemFetch('highPriority', 'table1||1');
    env.scheduleItemFetch('highPriority', 'table1||2');
    env.scheduleItemFetch('highPriority', 'table2||10');

    await flushAllTimers();

    // All items should go into a single batch (default key)
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: '__default__'
        duration: 800
        itemIds: ['table1||1', 'table1||2', 'table2||10']
        offset: 0
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 10, name: 'Item 10' }
            itemId: 'table2||10'
        startedAt: 50
        type: 'list'
    `);
  });

  test('single item in a batch key group uses fetchItemFn', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      getItemsBatchKey: (payload) => getTableFromItemId(payload),
    });

    env.scheduleItemFetch('highPriority', 'table1||1');

    await flushAllTimers();

    // Single item uses fetchItemFn, not batchFetchItemFn
    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - duration: 800
        itemId: 'table1||1'
        result: { id: 1, name: 'Item 1' }
        startedAt: 50
        type: 'fetch'
    `);
  });
});
