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

// Items sharing a batch key share ONE RequestScheduler. Realtime update
// invalidations for different items must therefore be tracked per item —
// an item's pending realtime refetch must not be dropped because another
// item of the same batch was fetched or invalidated in the meantime.

function createLoadedBatchEnv() {
  const env = createCollectionStoreTestEnv(
    { 'api1-item1': { v: 1 }, 'api1-item2': { v: 2 }, 'api1-item3': { v: 3 } },
    {
      baseCoalescingWindowMs: 50,
      useBatchFetch: true,
      getItemsBatchKey: (payload) => {
        const prefix = payload.split('-')[0];
        if (!prefix) throw new Error(`Invalid itemId: ${payload}`);
        return prefix;
      },
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 1000,
    },
  );

  return env;
}

async function primeBatchEnv(env: ReturnType<typeof createLoadedBatchEnv>) {
  // Load the items through the shared batch scheduler so the RTU throttle
  // has a baseline fetch duration
  env.scheduleFetch('highPriority', 'api1-item1');
  env.scheduleFetch('highPriority', 'api1-item2');
  env.scheduleFetch('highPriority', 'api1-item3');
  await flushAllTimers();
  env.clearTimeline();
}

describe('realtime updates on a shared batch scheduler', () => {
  test('delayed realtime updates of multiple items in the same batch all refetch', async () => {
    const env = createLoadedBatchEnv();
    await primeBatchEnv(env);

    // Inside the throttle window, two items receive realtime invalidations —
    // both are delayed, and both must eventually refetch
    await advanceTime(100);
    env.scheduleFetch('realtimeUpdate', 'api1-item1');
    env.scheduleFetch('realtimeUpdate', 'api1-item2');

    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      850ms | -- timeline-cleared
      950ms | rt-fetch-scheduled (delay: 900ms)
      .     | rt-fetch-scheduled (delay: 900ms)
      1.85s | scheduled-rt-fetch-started
      .     | scheduled-rt-fetch-started
      1.9s  | 🟠 >list-fetch-started (value: {"itemIds":["api1-item1","api1-item2"]})
      2.7s  | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);
  });

  test('a fetch of one item does not cancel another item pending delayed realtime update', async () => {
    const env = createLoadedBatchEnv();
    await primeBatchEnv(env);

    // Item 2 has a delayed realtime refetch pending
    await advanceTime(100);
    env.scheduleFetch('realtimeUpdate', 'api1-item2');

    // A high priority fetch of item 1 starts while item 2's RTU is delayed.
    // It must not cancel item 2's pending refetch — the fetch does not
    // include item 2's data
    await advanceTime(100);
    env.scheduleFetch('highPriority', 'api1-item1');

    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      850ms | -- timeline-cleared
      950ms | rt-fetch-scheduled (delay: 900ms)
      1.05s | [api1-item1] scheduled-fetch-triggered
      1.1s  | 🟠 [api1-item1] >fetch-started
      1.85s | scheduled-rt-fetch-started
      1.9s  | 🟠 [api1-item1] <fetch-finished (value: {"v":1})
      1.95s | 🟡 [api1-item2] >fetch-started
      2.75s | 🟡 [api1-item2] <fetch-finished (value: {"v":2})
      "
    `);
  });

  test('realtime updates for multiple items arriving during an in-flight fetch all refetch after it', async () => {
    const env = createLoadedBatchEnv();
    await primeBatchEnv(env);

    // Start a fetch of item 3 (takes 800ms)
    env.scheduleFetch('highPriority', 'api1-item3');
    await advanceTime(100);

    // While the fetch is in flight, items 1 and 2 receive realtime
    // invalidations — both must be tracked, not just the last one
    env.scheduleFetch('realtimeUpdate', 'api1-item1');
    env.scheduleFetch('realtimeUpdate', 'api1-item2');

    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      850ms | -- timeline-cleared
      .     | scheduled-fetch-triggered
      900ms | 🟠 >fetch-started
      1.7s  | 🟠 <fetch-finished (value: {"v":3})
      .     | rt-fetch-scheduled (delay: 1000ms)
      .     | rt-fetch-scheduled (delay: 1000ms)
      2.7s  | scheduled-rt-fetch-started
      .     | scheduled-rt-fetch-started
      2.75s | 🟡 >list-fetch-started (value: {"itemIds":["api1-item1","api1-item2"]})
      3.55s | 🟡 <list-fetch-finished (value: {"count":2})
      "
    `);
  });
});
