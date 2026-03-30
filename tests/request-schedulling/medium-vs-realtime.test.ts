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
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { DEFAULT_FETCH_DURATION_MS } from '../mocks/serverMock';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const BASE_COALESCING_WINDOW_MS = 10;

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('medium priority vs realtime scheduling', () => {
  describe('document store', () => {
    function createDocEnv({
      mediumPriorityDelayMs,
      realtimeThrottleMs,
    }: {
      mediumPriorityDelayMs: number;
      realtimeThrottleMs: number;
    }) {
      const env = createDocumentStoreTestEnv(0, {
        testScenario: 'loaded',
        usesRealTimeUpdates: true,
        mediumPriorityDelayMs,
        dynamicRealtimeThrottleMs: () => realtimeThrottleMs,
      });

      renderHook(() => {
        env.trackUIChanges(env.apiStore.useDocument().data?.value);
      });

      return env;
    }

    async function primeThrottleWindow(env: ReturnType<typeof createDocEnv>) {
      // Complete one fetch so the RTU throttle has a baseline duration.
      // Use invalidateData to go through the hook → scheduleFetch path.
      env.apiStore.invalidateData('highPriority');
      await advanceTime(DEFAULT_FETCH_DURATION_MS + BASE_COALESCING_WINDOW_MS);
      env.clearTimeline();
    }

    test('outside RTU throttle: realtime invalidation cancels pending medium timer and fetches immediately', async () => {
      const realtimeThrottleMs = 1000;
      const mediumPriorityDelayMs = 500;

      const env = createDocEnv({ mediumPriorityDelayMs, realtimeThrottleMs });
      await primeThrottleWindow(env);

      // Move past the RTU throttle window (1000ms after last fetch completed)
      await advanceTime(realtimeThrottleMs + 100);

      // Medium priority invalidation schedules a delayed fetch (500ms delay)
      env.apiStore.invalidateData('mediumPriority');

      // Before the medium delay expires, a realtime invalidation arrives.
      // Outside the throttle window → cancels the medium timer, fetches immediately.
      await advanceTime(100);
      env.addTimelineComments('beforeNextAction', [
        'realtime invalidation arrives',
      ]);
      env.apiStore.invalidateData('realtimeUpdate');

      await flushAllTimers();

      expect(env.timelineString).toMatchInlineSnapshot(`
        "
        time  |
        810ms | -- timeline-cleared
        1.91s | medium-fetch-scheduled (delay: 500ms)
        2.02s | -- realtime invalidation arrives
        .     | medium-priority-cancelled
        .     | 🟠 >fetch-started
        2.82s | 🟠 <fetch-finished (value: 0)
        "
      `);
    });

    test('inside large RTU throttle: medium timer fires before delayed realtime', async () => {
      const realtimeThrottleMs = 2000;
      const mediumPriorityDelayMs = 300;

      const env = createDocEnv({ mediumPriorityDelayMs, realtimeThrottleMs });
      await primeThrottleWindow(env);

      // Stay inside the RTU throttle window (2000ms from last fetch at ~810ms)
      await advanceTime(500);

      // Medium priority invalidation schedules a delayed fetch (300ms)
      env.apiStore.invalidateData('mediumPriority');

      // Realtime invalidation arrives while medium is pending. Since we're inside
      // the throttle window, realtime stays delayed and the medium timer fires first.
      await advanceTime(100);
      env.addTimelineComments('beforeNextAction', [
        'realtime invalidation arrives (inside throttle window — stays delayed)',
      ]);
      env.apiStore.invalidateData('realtimeUpdate');

      await flushAllTimers();

      // The medium timer fires before the delayed realtime, so no separate
      // rt-fetch is triggered — the medium fetch handles the refetch.
      expect(env.timelineString).not.toContain('scheduled-rt-fetch-started');
      expect(env.timelineString).toMatchInlineSnapshot(`
        "
        time  |
        810ms | -- timeline-cleared
        1.31s | medium-fetch-scheduled (delay: 300ms)
        1.41s | -- realtime invalidation arrives (inside throttle window — stays delayed)
        .     | rt-fetch-scheduled (delay: 1400ms)
        1.61s | medium-priority-fetch-started
        1.62s | rt-fetch-cancelled
        .     | 🟠 >fetch-started
        2.42s | 🟠 <fetch-finished (value: 0)
        "
      `);
    });
  });

  // Collection store: same scheduler behavior verified through per-item invalidation API.
  // Only one test needed since the scheduler logic is identical — this verifies the
  // invalidation path correctly delegates to the per-item scheduler.
  test('collection: realtime item invalidation cancels pending medium timer outside throttle', async () => {
    const realtimeThrottleMs = 1000;
    const mediumPriorityDelayMs = 500;

    const env = createCollectionStoreTestEnv(
      { item1: { v: 0 } },
      {
        testScenario: 'loaded',
        usesRealTimeUpdates: true,
        mediumPriorityDelayMs,
        dynamicRealtimeThrottleMs: () => realtimeThrottleMs,
      },
    );

    renderHook(() => {
      const item = env.apiStore.useItem('item1');
      env.trackItemUI('item1', item.data?.value.v);
    });

    // Prime throttle window via invalidation → hook → scheduleFetch path
    env.apiStore.invalidateItem('item1', 'highPriority');
    await advanceTime(DEFAULT_FETCH_DURATION_MS + BASE_COALESCING_WINDOW_MS);
    env.clearTimeline();

    // Move past RTU throttle window
    await advanceTime(realtimeThrottleMs + 100);

    // Medium priority invalidation for the item
    env.apiStore.invalidateItem('item1', 'mediumPriority');

    // Realtime invalidation cancels medium and fetches immediately
    await advanceTime(100);
    env.addTimelineComments('beforeNextAction', [
      'realtime invalidation arrives — cancels medium, fetches immediately',
    ]);
    env.apiStore.invalidateItem('item1', 'realtimeUpdate');

    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item1 |
      810ms | 0     | -- timeline-cleared
      1.91s | 0     | medium-fetch-scheduled (delay: 500ms)
      2.02s | 0     | -- realtime invalidation arrives — cancels medium, fetches immediately
      .     | 0     | medium-priority-cancelled
      .     | 0     | 🟠 >fetch-started
      2.82s | 0     | 🟠 <fetch-finished (value: {"v":0})
      "
    `);
  });

  // List query store: same scheduler behavior verified through query invalidation API.
  test('list query: realtime query invalidation cancels pending medium timer outside throttle', async () => {
    const realtimeThrottleMs = 1000;
    const mediumPriorityDelayMs = 500;

    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Alice' }] },
      {
        testScenario: { loaded: { tables: ['users'] } },
        usesRealTimeUpdates: true,
        mediumPriorityDelayMs,
        dynamicRealtimeThrottleMs: () => realtimeThrottleMs,
      },
    );

    renderHook(() => {
      env.apiStore.useListQuery({ tableId: 'users' });
    });

    // Prime throttle window via query invalidation → hook → scheduleFetch path
    env.apiStore.invalidateQueryAndItems({
      queryPayload: (p) => p.tableId === 'users',
      itemPayload: false,
      type: 'highPriority',
    });
    await advanceTime(DEFAULT_FETCH_DURATION_MS + BASE_COALESCING_WINDOW_MS);
    env.clearTimeline();

    // Move past RTU throttle window
    await advanceTime(realtimeThrottleMs + 100);

    // Medium priority query invalidation
    env.apiStore.invalidateQueryAndItems({
      queryPayload: (p) => p.tableId === 'users',
      itemPayload: false,
      type: 'mediumPriority',
    });

    // Realtime query invalidation cancels the medium timer
    await advanceTime(100);
    env.addTimelineComments('beforeNextAction', [
      'realtime invalidation arrives — cancels medium, fetches immediately',
    ]);
    env.apiStore.invalidateQueryAndItems({
      queryPayload: (p) => p.tableId === 'users',
      itemPayload: false,
      type: 'realtimeUpdate',
    });

    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  |
      810ms | -- timeline-cleared
      1.91s | medium-fetch-scheduled (delay: 500ms)
      2.02s | -- realtime invalidation arrives — cancels medium, fetches immediately
      .     | medium-priority-cancelled
      .     | 🟠 >list-fetch-started
      2.82s | 🟠 <list-fetch-finished (value: {"count":1})
      "
    `);
  });
});
