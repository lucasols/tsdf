import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createFocusChangeCoordinator } from '../browser-tabs/browser-tabs-test-helpers';
import { createInspectableInMemoryBrowserTabsTransportFactory } from '../mocks/browserTabsTestUtils';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('scheduled known requests are dropped after a sibling fetch starts later', async () => {
  const sharedTransports =
    createInspectableInMemoryBrowserTabsTransportFactory();

  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');

  // Both envs use the same store id so they share the same browser tabs channel.
  const sharedStoreId = 'request-scheduler-cross-tab-sync';

  const tabA = createDocumentStoreTestEnv(0, {
    id: sharedStoreId,
    testScenario: 'loaded',
    browserTabsTransportFactory: sharedTransports.transportFactory,
    bindFocusController: tabs.bind('a'),
    // Matches production: base window is non-zero.
    baseCoalescingWindowMs: 10,
    usesRealTimeUpdates: false,
  });

  const tabB = createDocumentStoreTestEnv(0, {
    id: sharedStoreId,
    testScenario: 'loaded',
    browserTabsTransportFactory: sharedTransports.transportFactory,
    bindFocusController: tabs.bind('b'),
    // Matches production: base window is non-zero.
    baseCoalescingWindowMs: 10,
    usesRealTimeUpdates: false,
  });

  // Let both tabs exchange initial status messages so browser-tabs priority state is stable.
  await vi.advanceTimersByTimeAsync(0);

  // Tab B starts a fetch.
  expect(tabB.scheduleFetch('highPriority')).toBe('triggered');
  // Background tabs get a delayed coalescing window (base + 1s).
  // Only advance enough to start the fetch, not finish it.
  await vi.advanceTimersByTimeAsync(1_011);
  expect(tabB.serverMock.numOfStartedFetches).toBe(1);

  // While tab B is fetching, schedule another fetch (this becomes a scheduled request).
  await vi.advanceTimersByTimeAsync(1);
  expect(tabB.scheduleFetch('highPriority')).toBe('scheduled');

  // Later, tab A starts a sibling fetch. This publishes a cross-tab "fetch-start" message
  // that makes tab B drop its scheduled request as "superseded".
  await vi.advanceTimersByTimeAsync(1);
  expect(tabA.scheduleFetch('highPriority')).toBe('triggered');
  // Focused tab coalesces on the base window.
  await vi.advanceTimersByTimeAsync(11);

  // Deliver cross-tab transport messages (scheduled with setTimeout(0)).
  await vi.advanceTimersByTimeAsync(0);

  await vi.runAllTimersAsync();

  // Tab B performed only the initial fetch; the scheduled one was dropped.
  expect(tabB.serverMock.numOfStartedFetches).toBe(1);
  expect(tabA.serverMock.numOfStartedFetches).toBe(1);

  expect(tabA.timelineString).toMatchInlineSnapshot(`
    "
    time   |
    1.013s | scheduled-fetch-triggered
    1.023s | 🔴 >fetch-started
    1.81s  | <confirmed-snapshot-received (value: 0)
    1.823s | 🔴 <fetch-finished (value: 0)
    "
  `);
  expect(tabB.timelineString).toMatchInlineSnapshot(`
    "
    time   |
    0      | scheduled-fetch-triggered
    1.01s  | 🔴 >fetch-started
    1.012s | scheduled-fetch-scheduled
    1.81s  | 🔴 <fetch-finished (value: 0)
    1.823s | <confirmed-snapshot-received (value: 0)
    "
  `);
});
