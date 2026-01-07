import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

test('multiple high priority fetches within the same request base coalescing window', async () => {
  // Expected: high priority requests coalesce into a single fetch if triggered within high base request delay window.
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First high priority fetch starts coalescing window
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(3);
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(10);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    3ms   | 0  | scheduled-fetch-coalesced
    13ms  | 0  | scheduled-fetch-coalesced
    20ms  | 0  | 🔴 >fetch-started
    820ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('mixed priority fetches within the same request base coalescing window', async () => {
  // Expected: highPriority and lowPriority requests coalesce into a single fetch if triggered within base coalescing window.
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First low priority fetch triggers coalescing window
  env.scheduleFetch('lowPriority');

  // Low priority is skipped when coalescing window is active
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('lowPriority');

  // High priority gets coalesced
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('highPriority');

  // Another low priority is skipped
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    5ms   | 0  | scheduled-fetch-skipped
    10ms  | 0  | scheduled-fetch-coalesced
    15ms  | 0  | scheduled-fetch-skipped
    20ms  | 0  | 🔴 >fetch-started
    820ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('multiple low priority fetches within the same request base coalescing window', async () => {
  // Expected: low priority requests coalesce into a single fetch if triggered within base coalescing window.
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First low priority fetch triggers coalescing window
  env.scheduleFetch('lowPriority');

  // Low priority is skipped when coalescing window is active
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('lowPriority');

  // Another low priority is skipped
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('lowPriority');

  // Another low priority is skipped
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    5ms   | 0  | scheduled-fetch-skipped
    10ms  | 0  | scheduled-fetch-skipped
    15ms  | 0  | scheduled-fetch-skipped
    20ms  | 0  | 🔴 >fetch-started
    820ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('realtime update fetches mixed with other priority fetches within the same request base coalescing window', async () => {
  // Expected: realtime update fetches also coalesce into a single fetch if triggered within a base coalescing window.
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
    dynamicRealtimeThrottleMs: () => 2_000,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First low priority fetch triggers coalescing window
  env.scheduleFetch('lowPriority');

  // Trigger realtime update fetch
  await vi.advanceTimersByTimeAsync(5);
  env.scheduleFetch('realtimeUpdate');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    5ms   | 0  | scheduled-fetch-coalesced
    20ms  | 0  | 🔴 >fetch-started
    820ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('realtime updates starts coalescing window', async () => {
  // Expected: realtime update fetches start a coalescing window if triggered within a base coalescing window.
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
    dynamicRealtimeThrottleMs: () => 2_000,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Trigger realtime update fetch
  env.scheduleFetch('realtimeUpdate');

  await vi.advanceTimersByTimeAsync(5);
  // Trigger low priority fetch
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    5ms   | 0  | scheduled-fetch-coalesced
    20ms  | 0  | 🔴 >fetch-started
    820ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('delayed realtime update fetches also are coalesced', async () => {
  // Expected: delayed realtime update requests are also coalesced into a single fetch
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
    dynamicRealtimeThrottleMs: () => 2_000,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Trigger realtime update fetch
  env.scheduleFetch('realtimeUpdate');

  await vi.advanceTimersByTimeAsync(2_000);
  // Trigger a second RTU that will be delayed
  env.scheduleFetch('realtimeUpdate');

  // Trigger a medium priority fetch right before the second RTU should start
  await vi.advanceTimersByTimeAsync(819);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | scheduled-fetch-triggered
    20ms   | 0  | 🔴 >fetch-started
    820ms  | 0  | 🔴 <fetch-finished (value: 0)
    2s     | 0  | rt-fetch-scheduled
    2.819s | 0  | scheduled-fetch-triggered
    2.82s  | 0  | scheduled-rt-fetch-started
    2.839s | 0  | 🟠 >fetch-started
    3.639s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('delayed realtime update request also starts coalescing window', async () => {
  // Expected: delayed realtime update requests also start a coalescing window
  const env = createDocumentStoreTestEnv(0, {
    baseCoalescingWindowMs: 20,
    dynamicRealtimeThrottleMs: () => 2_000,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Trigger realtime update fetch
  env.scheduleFetch('realtimeUpdate');

  await vi.advanceTimersByTimeAsync(2_000);
  // Trigger a second RTU that will be delayed
  env.scheduleFetch('realtimeUpdate');

  // Trigger a medium priority fetch that should be coalesced right after the second RTU should start
  await vi.advanceTimersByTimeAsync(821);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfStartedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | scheduled-fetch-triggered
    20ms   | 0  | 🔴 >fetch-started
    820ms  | 0  | 🔴 <fetch-finished (value: 0)
    2s     | 0  | rt-fetch-scheduled
    2.82s  | 0  | scheduled-rt-fetch-started
    2.821s | 0  | scheduled-fetch-coalesced
    2.84s  | 0  | 🟠 >fetch-started
    3.64s  | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});
