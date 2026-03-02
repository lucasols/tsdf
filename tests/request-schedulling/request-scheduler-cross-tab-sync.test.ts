import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RequestScheduler } from '../../src/requestScheduler';
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
  const startedBatches: string[][] = [];

  const scheduler = new RequestScheduler<null>({
    fetchFn: async (requests, { signal }) => {
      startedBatches.push(requests.map(({ requestId }) => requestId));

      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, 100);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId);
            resolve();
          },
          { once: true },
        );
      });

      return new Map(
        requests.map(({ requestId }) => [requestId, true] as const),
      );
    },
    lowPriorityThrottleMs: 10_000,
    getCoalescingWindowMs: () => 10,
    usesRealTimeUpdates: false,
  });

  expect(scheduler.scheduleFetch('doc', 'highPriority', null)).toBe(
    'triggered',
  );

  await vi.advanceTimersByTimeAsync(15);

  expect(startedBatches).toEqual([['doc']]);

  expect(scheduler.scheduleFetch('doc', 'highPriority', null)).toBe(
    'scheduled',
  );

  await vi.advanceTimersByTimeAsync(5);
  scheduler.syncExternalFetchStart(['doc'], Date.now());

  await vi.runAllTimersAsync();

  expect(startedBatches).toEqual([['doc']]);
  expect(scheduler.hasPendingFetch).toBe(false);
});
