import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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

  function createStaticFocusController(isFocused: boolean) {
    return {
      getWindowIsFocused: () => isFocused,
      onWindowFocus: (handler_: () => void) => () => {},
      onWindowBlur: (handler_: () => void) => () => {},
    };
  }

  // Both envs use the same store id so they share the same browser tabs channel.
  const sharedStoreId = 'request-scheduler-cross-tab-sync';

  const tabA = createDocumentStoreTestEnv(0, {
    id: sharedStoreId,
    testScenario: 'loaded',
    browserTabsTransportFactory: sharedTransports.transportFactory,
    bindFocusController: createStaticFocusController(true),
    // Matches production: base window is non-zero.
    baseCoalescingWindowMs: 10,
    usesRealTimeUpdates: false,
  });

  const tabB = createDocumentStoreTestEnv(0, {
    id: sharedStoreId,
    testScenario: 'loaded',
    browserTabsTransportFactory: sharedTransports.transportFactory,
    bindFocusController: createStaticFocusController(false),
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

  await vi.runAllTimersAsync();

  // Tab B performed only the initial fetch; the scheduled one was dropped.
  expect(tabB.serverMock.numOfStartedFetches).toBe(1);
  expect(tabA.serverMock.numOfStartedFetches).toBe(1);
});
