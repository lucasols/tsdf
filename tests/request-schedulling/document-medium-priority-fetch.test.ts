import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';

import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

test('medium priority fetch runs after delay when no other fetch occurs', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.scheduleFetch('mediumPriority');

  await vi.runAllTimersAsync();

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 300ms)
    300ms | 0  | medium-priority-fetch-started
    310ms | 0  | 🔴 >fetch-started
    1.11s | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority fetch is cancelled when high priority fetch starts', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.scheduleFetch('mediumPriority');

  await vi.advanceTimersByTimeAsync(100);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 300ms)
    100ms | 0  | scheduled-fetch-triggered
    110ms | 0  | medium-priority-cancelled
    .     | 0  | 🔴 >fetch-started
    910ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority fetch is cancelled when low priority fetch starts', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.scheduleFetch('mediumPriority');

  await vi.advanceTimersByTimeAsync(100);
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 300ms)
    100ms | 0  | scheduled-fetch-triggered
    110ms | 0  | medium-priority-cancelled
    .     | 0  | 🔴 >fetch-started
    910ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority is NOT cancelled by mutation - schedules when delay expires during mutation', async () => {
  // Medium priority should only be cancelled by other fetches, not by mutations
  // When the delay expires during a mutation, it should schedule itself like high priority
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.scheduleFetch('mediumPriority');

  await vi.advanceTimersByTimeAsync(100);
  void env.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  // One fetch: medium priority schedules during mutation, then revalidation coalesces with it
  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 300ms)
    100ms | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    300ms | 1  | medium-priority-fetch-started
    940ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.31s | 1  | 🔴 >fetch-started
    2.11s | 1  | 🔴 <fetch-finished (value: 1)
    "
  `);
});

test('multiple medium priority calls reset the timer', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First medium priority at t=0
  env.scheduleFetch('mediumPriority');

  // Second medium priority at t=200, should reset the timer
  await vi.advanceTimersByTimeAsync(200);
  env.scheduleFetch('mediumPriority');

  await vi.runAllTimersAsync();

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  // Fetch should start at t=500 (200 + 300ms delay)
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 300ms)
    200ms | 0  | medium-fetch-scheduled (delay: 300ms)
    500ms | 0  | medium-priority-fetch-started
    510ms | 0  | 🔴 >fetch-started
    1.31s | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority during in-progress fetch schedules when delay expires', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Start a high priority fetch first
  env.scheduleFetch('highPriority');

  // Wait for fetch to start
  await vi.advanceTimersByTimeAsync(15);

  // Medium priority during fetch still uses delay mechanism (returns medium-scheduled)
  const result = env.scheduleFetch('mediumPriority');

  expect(result).toBe('medium-scheduled');

  await vi.runAllTimersAsync();

  // 2 fetches - medium priority delay expired during first fetch, scheduled for later
  // (no fetch STARTED after medium priority was scheduled, so it wasn't cancelled)
  expect(env.serverMock.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    15ms  | 0  | medium-fetch-scheduled (delay: 300ms)
    315ms | 0  | medium-priority-fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    820ms | 0  | 🟠 >fetch-started
    1.62s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority with long delay runs normally after in-progress fetch completes', async () => {
  // When medium priority has a delay longer than the in-progress fetch duration,
  // it should run normally via coalescing (not via scheduled state)
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 1000,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Start a high priority fetch first (will take ~800ms)
  env.scheduleFetch('highPriority');

  // Wait for fetch to start
  await vi.advanceTimersByTimeAsync(15);

  // Medium priority with 1000ms delay - will expire at t=1015, after first fetch completes at ~810ms
  const result = env.scheduleFetch('mediumPriority');

  expect(result).toBe('medium-scheduled');

  await vi.runAllTimersAsync();

  // 2 fetches - medium priority delay expired after first fetch completed,
  // so it ran via normal coalescing path (not scheduled state)
  expect(env.serverMock.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | scheduled-fetch-triggered
    10ms   | 0  | 🔴 >fetch-started
    15ms   | 0  | medium-fetch-scheduled (delay: 1000ms)
    810ms  | 0  | 🔴 <fetch-finished (value: 0)
    1.015s | 0  | medium-priority-fetch-started
    1.025s | 0  | 🟠 >fetch-started
    1.825s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority uses coalescing window after delay expires', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
    baseCoalescingWindowMs: 50,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.scheduleFetch('mediumPriority');

  // Wait for medium priority delay to expire (300ms)
  // and add a high priority during the coalescing window
  await vi.advanceTimersByTimeAsync(320);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  // Should result in single fetch due to coalescing
  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 300ms)
    300ms | 0  | medium-priority-fetch-started
    320ms | 0  | scheduled-fetch-coalesced
    350ms | 0  | 🔴 >fetch-started
    1.15s | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('custom delay per call overrides global delay', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Use custom delay of 500ms instead of global 300ms
  env.scheduleFetch('mediumPriority', { mediumPriorityDelayMs: 500 });

  await vi.runAllTimersAsync();

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  // Fetch should start at t=500 (custom delay)
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | medium-fetch-scheduled (delay: 500ms)
    500ms | 0  | medium-priority-fetch-started
    510ms | 0  | 🔴 >fetch-started
    1.31s | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('medium priority during coalescing window is cancelled when fetch starts', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    mediumPriorityDelayMs: 300,
    baseCoalescingWindowMs: 50,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Start a high priority fetch to trigger coalescing window
  env.scheduleFetch('highPriority');

  // Medium priority during coalescing window uses delay mechanism (returns medium-scheduled)
  await vi.advanceTimersByTimeAsync(10);
  const result = env.scheduleFetch('mediumPriority');

  expect(result).toBe('medium-scheduled');

  await vi.runAllTimersAsync();

  // Only 1 fetch - medium priority was cancelled when coalescing window fetch started
  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | medium-fetch-scheduled (delay: 300ms)
    50ms  | 0  | medium-priority-cancelled
    .     | 0  | 🔴 >fetch-started
    850ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});
