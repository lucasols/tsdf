import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  DEFAULT_FETCH_DURATION_MS,
  DEFAULT_MUTATION_DURATION_MS,
} from '../mocks/serverMock';
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

test('simple mutation with revalidation and optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // Wait for initial fetch
  await flushAllTimers();

  void env.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1]`);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1  | 🔴 >fetch-started
    2.01s | 1  | 🔴 <fetch-finished (value: 1)
    "
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('simple mutation with optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // Wait for initial fetch
  await flushAllTimers();

  void env.performClientUpdateAction(1, { withOptimisticUpdate: true });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1]`);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    "
  `);
});

test('simple mutation without optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // Wait for initial fetch
  await flushAllTimers();

  void env.performClientUpdateAction(1, { withRevalidation: true });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1]`);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | ⬜ >mutation-started (value: 1)
    840ms | 0  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 0  | 🔴 >fetch-started
    2.01s | 0  | 🔴 <fetch-finished (value: 1)
    .     | 1  | ui-changed
    "
  `);
});

test('prevent overfetch of low priority fetches', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // Initial data is already loaded, no fetch needed

  env.scheduleFetch('lowPriority');
  await advanceTime(10);

  env.addTimelineComments('afterLastAction', [
    'All fetches started after this point should be skipped',
  ]);

  env.scheduleFetch('lowPriority');
  await advanceTime(10);

  env.scheduleFetch('lowPriority');
  await advanceTime(10);

  env.scheduleFetch('lowPriority');

  await flushAllTimers();

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    .     | 0  | -- All fetches started after this point should be skipped
    .     | 0  | scheduled-fetch-skipped
    20ms  | 0  | scheduled-fetch-skipped
    30ms  | 0  | scheduled-fetch-skipped
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('multiple mutations with revalidation in sequence', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const sequentialGapMs =
    DEFAULT_MUTATION_DURATION_MS + DEFAULT_FETCH_DURATION_MS + 50;

  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(sequentialGapMs);

  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1  | 🔴 >fetch-started
    2.01s | 1  | 🔴 <fetch-finished (value: 1)
    2.05s | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2.89s | 2  | ⬛ <mutation-data-persisted (value: 2)
    3.26s | 2  | 🟠 >fetch-started
    4.06s | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);
});

test('multiple mutations with revalidation in sequence, causing concurrent updates', async () => {
  // mutations should abort in progress fetches
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // First mutation
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  // Wait for the server write (mutation-finished event), but not the revalidation fetch
  await advanceTime(duringRevalidationMs);

  env.addTimelineComments('beforeNextAction', [
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  ]);

  // Second mutation starts during revalidation
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2]`);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.serverMock.numOfStartedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1  | 🔴 >fetch-started
    1.25s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 1  | 🔴 <fetch-aborted 🚫
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2.09s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.46s | 2  | 🟠 >fetch-started
    3.26s | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);
});

test('multiple mutations with revalidation in sequence 2', async () => {
  // mutations should abort in progress fetches, stress test
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  // Initial low priority fetch
  env.scheduleFetch('lowPriority');

  // First mutation (start shortly after fetch begins)
  await advanceTime(100);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // Wait for the server write (mutation-finished event) + small buffer, but not the full revalidation fetch
  await advanceTime(duringRevalidationMs);

  env.addTimelineComments('beforeNextAction', [
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  ]);

  // Second mutation (revalidation fetch from mutation 1 still in progress)
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);

  // Third mutation
  void env.performClientUpdateAction(3, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);

  // Fourth mutation
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);

  // Fifth mutation with same value
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2, 3, 4]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    100ms | 0  | 🔴 <fetch-aborted 🚫
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    940ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.31s | 1  | 🟠 >fetch-started
    1.35s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 1  | 🟠 <fetch-aborted 🚫
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2.19s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.56s | 2  | 🟡 >fetch-started
    2.6s  | 2  | 🟡 <fetch-aborted 🚫
    .     | 3  | 🟫 optimistic-ui-commit
    .     | 3  | 🟫 >mutation-started (value: 3)
    3.44s | 3  | 🟫 <mutation-data-persisted (value: 3)
    3.81s | 3  | 🟢 >fetch-started
    3.85s | 3  | 🟢 <fetch-aborted 🚫
    .     | 4  | 🟪 optimistic-ui-commit
    .     | 4  | 🟪 >mutation-started (value: 4)
    4.69s | 4  | 🟪 <mutation-data-persisted (value: 4)
    5.06s | 4  | 🔵 >fetch-started
    5.1s  | 4  | 🔵 <fetch-aborted 🚫
    .     | 4  | 🟦 optimistic-ui-commit
    .     | 4  | 🟦 >mutation-started (value: 4)
    5.94s | 4  | 🟦 <mutation-data-persisted (value: 4)
    6.31s | 4  | 🟣 >fetch-started
    7.11s | 4  | 🟣 <fetch-finished (value: 4)
    "
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.serverMock.numOfStartedFetches).toBe(6);
});

test('multiple mutations with revalidation in sequence 3', async () => {
  // mutations should abort in progress fetches, no initial low priority fetch
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);
  env.addTimelineComments('beforeNextAction', [
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  ]);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);
  void env.performClientUpdateAction(3, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await advanceTime(duringRevalidationMs);
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2, 3, 4]`);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.serverMock.numOfStartedFetches).toBe(5);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1  | 🔴 >fetch-started
    1.25s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 1  | 🔴 <fetch-aborted 🚫
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2.09s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.46s | 2  | 🟠 >fetch-started
    2.5s  | 2  | 🟠 <fetch-aborted 🚫
    .     | 3  | 🟫 optimistic-ui-commit
    .     | 3  | 🟫 >mutation-started (value: 3)
    3.34s | 3  | 🟫 <mutation-data-persisted (value: 3)
    3.71s | 3  | 🟡 >fetch-started
    3.75s | 3  | 🟡 <fetch-aborted 🚫
    .     | 4  | 🟪 optimistic-ui-commit
    .     | 4  | 🟪 >mutation-started (value: 4)
    4.59s | 4  | 🟪 <mutation-data-persisted (value: 4)
    4.96s | 4  | 🟢 >fetch-started
    5s    | 4  | 🟢 <fetch-aborted 🚫
    .     | 4  | 🟦 optimistic-ui-commit
    .     | 4  | 🟦 >mutation-started (value: 4)
    5.84s | 4  | 🟦 <mutation-data-persisted (value: 4)
    6.21s | 4  | 🔵 >fetch-started
    7.01s | 4  | 🔵 <fetch-finished (value: 4)
    "
  `);
});

test('high priority fetch during mutation', async () => {
  // Expected: high priority fetch triggered during mutation should be scheduled
  // to run after the mutation completes, preventing stale data commits.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // Start a mutation (without revalidation to isolate the high priority fetch behavior)
  void env.performClientUpdateAction(1, { withOptimisticUpdate: true });

  // Trigger high priority fetch while mutation is in progress
  await advanceTime(100);
  env.addTimelineComments('beforeNextAction', [
    'High priority fetch during mutation; should be scheduled after mutation completes.',
  ]);
  const result = env.scheduleFetch('highPriority');
  expect(result).toBe('scheduled');

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1]`);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    100ms | 1  | -- High priority fetch during mutation; should be scheduled after mutation completes.
    .     | 1  | scheduled-fetch-scheduled
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1  | 🔴 >fetch-started
    2.01s | 1  | 🔴 <fetch-finished (value: 1)
    "
  `);
});

test('multiple concurrent mutations with revalidation', async () => {
  // Expected: overlapping mutations schedule a single revalidation fetch that
  // skips redundant requests and commits only once with the latest data.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // First mutation
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // Second mutation starts 50ms after first (while first is still running)
  await advanceTime(50);
  env.addTimelineComments('beforeNextAction', [
    'Second mutation overlaps first',
  ]);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2]`);
  expect(env.serverMock.history).toMatchInlineSnapshot(`[0, 1, 2]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    50ms  | 1  | -- Second mutation overlaps first
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    840ms | 2  | ⬜ <mutation-data-persisted (value: 1)
    890ms | 2  | ⬛ <mutation-data-persisted (value: 2)
    1.26s | 2  | 🔴 >fetch-started
    2.06s | 2  | 🔴 <fetch-finished (value: 2)
    "
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.serverMock.numOfStartedFetches).toBe(1);
});

test('multiple high priority fetches', async () => {
  // Expected: high priority requests coalesce into a running fetch plus one scheduled fetch.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // First high priority fetch starts immediately
  env.scheduleFetch('highPriority');

  // These are skipped (fetch already in progress, within throttle window)
  await advanceTime(40);
  env.scheduleFetch('highPriority');

  await advanceTime(50);
  env.scheduleFetch('highPriority');

  // These get scheduled (outside throttle window but fetch still in progress)
  await advanceTime(60);
  env.scheduleFetch('highPriority');

  await advanceTime(80);
  env.scheduleFetch('highPriority');

  await flushAllTimers();

  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    40ms  | 0  | scheduled-fetch-scheduled
    90ms  | 0  | scheduled-fetch-scheduled
    150ms | 0  | scheduled-fetch-scheduled
    230ms | 0  | scheduled-fetch-scheduled
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    820ms | 0  | 🟠 >fetch-started
    1.62s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('throttle low priority updates', async () => {
  // Expected: low priority requests are throttled so only the first and last execute.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: first low priority fetch starts
  env.scheduleFetch('lowPriority');

  // t=100: skipped - first fetch in progress
  await advanceTime(100);
  env.scheduleFetch('lowPriority');

  // t=110: skipped - first fetch in progress
  await advanceTime(10);
  env.scheduleFetch('lowPriority');

  // t=120: skipped - first fetch in progress
  await advanceTime(10);
  env.scheduleFetch('lowPriority');

  // Wait for first fetch to complete
  await advanceTime(DEFAULT_FETCH_DURATION_MS + 10);

  // Second fetch starts outside the throttle window from t=0
  env.scheduleFetch('lowPriority');

  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    100ms | 0  | scheduled-fetch-skipped
    110ms | 0  | scheduled-fetch-skipped
    120ms | 0  | scheduled-fetch-skipped
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    930ms | 0  | scheduled-fetch-triggered
    940ms | 0  | 🟠 >fetch-started
    1.74s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);
});

test('throttle low priority after a fast fetch completes', async () => {
  // Expected: low priority throttling uses the fetch start time, even if it finishes quickly.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  env.setNextFetchDurations(50, 50);

  // t=0: first low priority fetch starts (treated as high priority when no prior fetch exists)
  env.scheduleFetch('lowPriority');

  // t=60: first fetch finished (50ms), still within the throttle window
  await advanceTime(60);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('skipped');

  // t=210: outside throttle window
  await advanceTime(150);
  env.scheduleFetch('lowPriority');

  await flushAllTimers();

  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    60ms  | 0  | 🔴 <fetch-finished (value: 0)
    .     | 0  | scheduled-fetch-skipped
    210ms | 0  | scheduled-fetch-triggered
    220ms | 0  | 🟠 >fetch-started
    270ms | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('multiple mutations with low priority fetch between', async () => {
  // Expected: low priority fetch is scheduled and coalesced with mutation revalidation,
  // resulting in a single fetch commit.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: first mutation with revalidation
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // t=50: second mutation with revalidation
  await advanceTime(50);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // t=70: low priority fetch (scheduled since no previous fetch = outside throttle window)
  await advanceTime(20);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('scheduled');

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2]`);
  // Mutation revalidations properly coalesce into 1 fetch
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    50ms  | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    70ms  | 2  | scheduled-fetch-scheduled
    840ms | 2  | ⬜ <mutation-data-persisted (value: 1)
    890ms | 2  | ⬛ <mutation-data-persisted (value: 2)
    1.26s | 2  | 🔴 >fetch-started
    2.06s | 2  | 🔴 <fetch-finished (value: 2)
    "
  `);
});

test('very slow mutation revalidation then mutation', async () => {
  // Expected: long revalidation fetch overlaps a second mutation, causing the
  // first fetch to be aborted and a fresh fetch to commit the latest value.
  // First revalidation (2000ms) > second mutation (200ms) + second revalidation (200ms)
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // Set fetch durations: first revalidation slow (2000ms), second revalidation fast (200ms)
  env.setNextFetchDurations(2000, 200);

  // t=0: first mutation with revalidation (short 200ms mutation)
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
    duration: 200,
  });

  // Wait for the mutation to resolve (200ms) so revalidation starts (2000ms)
  // Start second mutation while first revalidation is still in progress
  await advanceTime(300);

  env.addTimelineComments('beforeNextAction', [
    'Slow revalidation still running; scheduler aborts in-flight fetch after new mutation to prevent stale commit.',
  ]);

  // t=300: second mutation starts during first revalidation (which started at t=200)
  // First revalidation would finish at t=2200, but gets aborted
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
    duration: 200, // Second mutation + revalidation = 200 + 200 = 400ms < 2000ms first revalidation
  });

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1, 2]`);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    140ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    210ms | 1  | 🔴 >fetch-started
    300ms | 1  | -- Slow revalidation still running; scheduler aborts in-flight fetch after new mutation to prevent stale commit.
    .     | 1  | 🔴 <fetch-aborted 🚫
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    440ms | 2  | ⬛ <mutation-data-persisted (value: 2)
    510ms | 2  | 🟠 >fetch-started
    710ms | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);
});

test('fetch error', async () => {
  // Expected: first fetch succeeds, second fetch errors and UI enters error state.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'idle',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const { data, error } = env.apiStore.useDocument();
    env.trackUIChanges(error ? 'error' : data?.value);
  });

  // First fetch starts automatically with no initial state
  await advanceTime(DEFAULT_FETCH_DURATION_MS + 10);

  // Mark next fetch as error (helper also mutates server data for timeline)
  env.errorInNextFetch();

  // Second fetch (will error)
  env.scheduleFetch('lowPriority');

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 'error']`);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toContain('fetch-error');
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui      |
    10ms  | -       | 🔴 >fetch-started
    810ms | -       | 🔴 <fetch-finished (value: 0)
    .     | 0       | ui-initialized
    .     | 0       | scheduled-fetch-triggered
    820ms | 0       | 🟠 >fetch-started
    .     | 0       | 🟠 <fetch-error (value: "error")
    .     | "error" | ui-changed
    "
  `);
});

test('low priority fetch during mutation outside throttle window', async () => {
  // Expected: low priority fetch triggered during mutation should be scheduled
  // to run after the mutation completes when outside the throttle window.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // Start a mutation (without revalidation to isolate the low priority fetch behavior)
  void env.performClientUpdateAction(1, { withOptimisticUpdate: true });

  // Trigger low priority fetch while mutation is in progress (no previous fetch, so outside throttle window)
  await advanceTime(100);
  env.addTimelineComments('beforeNextAction', [
    'Low priority fetch during mutation; should be scheduled after mutation completes.',
  ]);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('scheduled');

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1]`);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    100ms | 1  | -- Low priority fetch during mutation; should be scheduled after mutation completes.
    .     | 1  | scheduled-fetch-scheduled
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1  | 🔴 >fetch-started
    2.01s | 1  | 🔴 <fetch-finished (value: 1)
    "
  `);
});

test('low priority fetch during mutation inside throttle window', async () => {
  // Expected: low priority fetch triggered during mutation should be skipped
  // when inside the throttle window from a previous fetch.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // Trigger a fast fetch first to establish the throttle window
  env.setNextFetchDurations(50);
  env.scheduleFetch('highPriority');
  await flushAllTimers();

  // Start a mutation immediately (we're at ~60ms, still inside 200ms throttle window)
  void env.performClientUpdateAction(1, { withOptimisticUpdate: true });

  // Trigger low priority fetch while mutation is in progress (within throttle window from fetch start at 10ms)
  await advanceTime(50);
  env.addTimelineComments('beforeNextAction', [
    'Low priority fetch during mutation inside throttle window; should be skipped.',
  ]);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('skipped');

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`[0, 1]`);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    60ms  | 0  | 🔴 <fetch-finished (value: 0)
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    110ms | 1  | -- Low priority fetch during mutation inside throttle window; should be skipped.
    .     | 1  | scheduled-fetch-skipped
    900ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    "
  `);
});
