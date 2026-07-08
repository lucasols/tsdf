import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

// Items sharing a batch key share ONE RequestScheduler. Medium priority
// invalidations for different items must therefore be tracked per item —
// a burst of invalidations (e.g. realtime events invalidating every mounted
// record of a table) must refetch every item, not just the last one.

const serverData = {
  table1: [
    { id: 1, name: 'Item 1' },
    { id: 2, name: 'Item 2' },
    { id: 3, name: 'Item 3' },
  ],
};

function getTableFromItemId(itemId: string): string {
  const tableId = itemId.split('||')[0];
  if (!tableId) throw new Error(`Invalid itemId: ${itemId}`);
  return tableId;
}

function createLoadedListEnv() {
  const env = createListQueryStoreTestEnv(serverData, {
    baseCoalescingWindowMs: 50,
    useBatchFetch: true,
    getItemsBatchKey: (payload) => getTableFromItemId(payload),
    mediumPriorityDelayMs: 300,
  });

  return env;
}

async function primeListEnv(env: ReturnType<typeof createLoadedListEnv>) {
  // Load the items through the shared batch scheduler so medium priority
  // uses the delayed path instead of being promoted to high priority
  env.scheduleItemFetch('highPriority', 'table1||1');
  env.scheduleItemFetch('highPriority', 'table1||2');
  env.scheduleItemFetch('highPriority', 'table1||3');

  await flushAllTimers();

  env.serverTable.clearFetchHistory();
  env.clearTimeline();
}

describe('list query: medium priority on a shared batch scheduler', () => {
  test('medium priority invalidations of multiple items in the same batch all refetch', async () => {
    const env = createLoadedListEnv();
    await primeListEnv(env);

    // A burst of medium priority invalidations for different items of the
    // same batch, all within the delay window
    env.scheduleItemFetch('mediumPriority', 'table1||1');
    env.scheduleItemFetch('mediumPriority', 'table1||2');
    env.scheduleItemFetch('mediumPriority', 'table1||3');

    await flushAllTimers();

    // Every invalidated item must be refetched — none may be dropped because
    // another item's invalidation reused the same scheduler
    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          itemIds: ['table1||1', 'table1||2', 'table1||3']
          pos: { offset: 0 }
        returned_items: 3
        time: '1.2s -> 2s | duration: 800ms'
    `);
  });

  test('rescheduling the same item resets its timer without dropping other items', async () => {
    const env = createLoadedListEnv();
    await primeListEnv(env);

    env.scheduleItemFetch('mediumPriority', 'table1||1');
    env.scheduleItemFetch('mediumPriority', 'table1||2');

    // Re-invalidate item 1 within the delay window: its timer resets, but
    // item 2 keeps its original timer
    await advanceTime(200);
    env.scheduleItemFetch('mediumPriority', 'table1||1');

    await flushAllTimers();

    // Item 2 fires at +300ms, item 1 at +500ms; item 2's fetch is in-flight
    // when item 1's timer fires, so item 1 is fetched right after it finishes
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'table1||2' }
        time: '1.2s -> 2s | duration: 800ms'
      - _type: 'item'
        payload: { itemId: 'table1||1' }
        time: '2.05s -> 2.85s | duration: 800ms'
    `);
  });

  test('a fetch of one item does not cancel another item pending medium priority fetch', async () => {
    const env = createLoadedListEnv();
    await primeListEnv(env);

    // Item 2 has a pending medium priority refetch
    env.scheduleItemFetch('mediumPriority', 'table1||2');

    // A high priority fetch of item 1 starts before item 2's delay expires.
    // It must only cancel item 1's pending work — item 2 was not refreshed
    // by it, so its medium priority refetch must survive
    await advanceTime(100);
    env.scheduleItemFetch('highPriority', 'table1||1');

    await flushAllTimers();

    // Both items end up fetched: item 1 immediately, item 2 after its delay
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'table1||1' }
        time: '1s -> 1.8s | duration: 800ms'
      - _type: 'item'
        payload: { itemId: 'table1||2' }
        time: '1.85s -> 2.65s | duration: 800ms'
    `);
  });
});

describe('collection: medium priority on a shared batch scheduler', () => {
  test('medium priority invalidations of multiple items in the same batch all refetch', async () => {
    const env = createCollectionStoreTestEnv(
      { 'api1-item1': { v: 1 }, 'api1-item2': { v: 2 } },
      {
        baseCoalescingWindowMs: 50,
        useBatchFetch: true,
        getItemsBatchKey: (payload) => {
          const prefix = payload.split('-')[0];
          if (!prefix) throw new Error(`Invalid itemId: ${payload}`);
          return prefix;
        },
        mediumPriorityDelayMs: 300,
      },
    );

    // Load both items through the shared batch scheduler
    env.scheduleFetch('highPriority', 'api1-item1');
    env.scheduleFetch('highPriority', 'api1-item2');
    await flushAllTimers();
    env.clearTimeline();

    // Both items invalidated at medium priority within the delay window
    env.scheduleFetch('mediumPriority', 'api1-item1');
    env.scheduleFetch('mediumPriority', 'api1-item2');

    await flushAllTimers();

    // Both items must be refetched in the delayed batch
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      850ms | -- timeline-cleared
      .     | medium-fetch-scheduled (delay: 300ms)
      .     | medium-fetch-scheduled (delay: 300ms)
      1.15s | medium-priority-fetch-started
      .     | medium-priority-fetch-started
      1.2s  | 🟠 >list-fetch-started (value: {"itemIds":["api1-item1","api1-item2"]})
      2s    | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});
