import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';
import {
  DEFAULT_FETCH_DURATION_MS,
  DEFAULT_MUTATION_DURATION_MS,
} from './mocks/serverMock';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

test('simple mutation with revalidation and optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  void env.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started
    2s    | 1  | 🔴 <fetch-finished (value: 1)
    "
  `);
});

test('simple mutation with optimistic update', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);

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
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  void env.performClientUpdateAction(1, {
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | ⬜ >mutation-started (value: 1)
    840ms | 0  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 0  | 🔴 >fetch-started
    2s    | 0  | 🔴 <fetch-finished (value: 1)
    .     | 1  | ui-changed
    "
  `);
});

test('prevent overfetch of low priority fetches', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  // Initial data is already loaded, no fetch needed

  env.scheduleFetch('lowPriority');
  await vi.advanceTimersByTimeAsync(10);

  env.addTimelineComment(
    'All fetches started after this point should be skipped',
  );

  env.scheduleFetch('lowPriority');
  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority');
  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    10ms  | 0  | -- All fetches started after this point should be skipped
    .     | 0  | scheduled-fetch-skipped
    20ms  | 0  | scheduled-fetch-skipped
    30ms  | 0  | scheduled-fetch-skipped
    800ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('multiple mutations with revalidation in sequence', async () => {
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const sequentialGapMs =
    DEFAULT_MUTATION_DURATION_MS + DEFAULT_FETCH_DURATION_MS + 50;

  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(sequentialGapMs);

  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started
    2s    | 1  | 🔴 <fetch-finished (value: 1)
    2.05s | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2.89s | 2  | ⬛ <mutation-data-persisted (value: 2)
    3.25s | 2  | 🟠 >fetch-started
    4.05s | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);
});

test('multiple mutations with revalidation in sequence, causing concurrent updates', async () => {
  // mutations should abort in progress fetches
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First mutation
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  // Wait for the server write (mutation-finished event), but not the revalidation fetch
  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  env.addTimelineComment(
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  );

  // Second mutation starts during revalidation
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started
    1.25s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2s    | 2  | 🔴 <fetch-aborted 🚫
    2.09s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.45s | 2  | 🟠 >fetch-started
    3.25s | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);
});

test('multiple mutations with revalidation in sequence 2', async () => {
  // mutations should abort in progress fetches, stress test
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  // Initial low priority fetch
  env.scheduleFetch('lowPriority');

  // First mutation (start shortly after fetch begins)
  await vi.advanceTimersByTimeAsync(100);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // Wait for the server write (mutation-finished event) + small buffer, but not the full revalidation fetch
  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  env.addTimelineComment(
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  );

  // Second mutation (revalidation fetch from mutation 1 still in progress)
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  // Third mutation
  void env.performClientUpdateAction(3, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  // Fourth mutation
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);

  // Fifth mutation with same value
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2, 3, 4]);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    100ms | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    800ms | 1  | 🔴 <fetch-aborted 🚫
    940ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.3s  | 1  | 🟠 >fetch-started
    1.35s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2.1s  | 2  | 🟠 <fetch-aborted 🚫
    2.19s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.55s | 2  | 🟡 >fetch-started
    2.6s  | 3  | 🟫 optimistic-ui-commit
    .     | 3  | 🟫 >mutation-started (value: 3)
    3.35s | 3  | 🟡 <fetch-aborted 🚫
    3.44s | 3  | 🟫 <mutation-data-persisted (value: 3)
    3.8s  | 3  | 🟢 >fetch-started
    3.85s | 4  | 🟪 optimistic-ui-commit
    .     | 4  | 🟪 >mutation-started (value: 4)
    4.6s  | 4  | 🟢 <fetch-aborted 🚫
    4.69s | 4  | 🟪 <mutation-data-persisted (value: 4)
    5.05s | 4  | 🔵 >fetch-started
    5.1s  | 4  | 🟦 optimistic-ui-commit
    .     | 4  | 🟦 >mutation-started (value: 4)
    5.85s | 4  | 🔵 <fetch-aborted 🚫
    5.94s | 4  | 🟦 <mutation-data-persisted (value: 4)
    6.3s  | 4  | 🟣 >fetch-started
    7.1s  | 4  | 🟣 <fetch-finished (value: 4)
    "
  `);

  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(6);
});

test('multiple mutations with revalidation in sequence 3', async () => {
  // mutations should abort in progress fetches, no initial low priority fetch
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  const duringRevalidationMs = DEFAULT_MUTATION_DURATION_MS + 50;

  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  env.addTimelineComment(
    'New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.',
  );
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  void env.performClientUpdateAction(3, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(duringRevalidationMs);
  void env.performClientUpdateAction(4, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2, 3, 4]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(5);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started
    1.25s | 1  | -- New mutation starts during revalidation; scheduler aborts in-flight fetch to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    2s    | 2  | 🔴 <fetch-aborted 🚫
    2.09s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.45s | 2  | 🟠 >fetch-started
    2.5s  | 3  | 🟫 optimistic-ui-commit
    .     | 3  | 🟫 >mutation-started (value: 3)
    3.25s | 3  | 🟠 <fetch-aborted 🚫
    3.34s | 3  | 🟫 <mutation-data-persisted (value: 3)
    3.7s  | 3  | 🟡 >fetch-started
    3.75s | 4  | 🟪 optimistic-ui-commit
    .     | 4  | 🟪 >mutation-started (value: 4)
    4.5s  | 4  | 🟡 <fetch-aborted 🚫
    4.59s | 4  | 🟪 <mutation-data-persisted (value: 4)
    4.95s | 4  | 🟢 >fetch-started
    5s    | 4  | 🟦 optimistic-ui-commit
    .     | 4  | 🟦 >mutation-started (value: 4)
    5.75s | 4  | 🟢 <fetch-aborted 🚫
    5.84s | 4  | 🟦 <mutation-data-persisted (value: 4)
    6.2s  | 4  | 🔵 >fetch-started
    7s    | 4  | 🔵 <fetch-finished (value: 4)
    "
  `);
});

test('high priority fetch during mutation', async () => {
  // Expected: high priority fetch triggered during mutation should be scheduled
  // to run after the mutation completes, preventing stale data commits.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // Start a mutation (without revalidation to isolate the high priority fetch behavior)
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
  });

  // Trigger high priority fetch while mutation is in progress
  await vi.advanceTimersByTimeAsync(100);
  env.addTimelineComment(
    'High priority fetch during mutation; should be scheduled after mutation completes.',
  );
  const result = env.scheduleFetch('highPriority');
  expect(result).toBe('scheduled');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    100ms | 1  | -- High priority fetch during mutation; should be scheduled after mutation completes.
    .     | 1  | scheduled-fetch-scheduled
    840ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.2s  | 1  | 🔴 >fetch-started
    2s    | 1  | 🔴 <fetch-finished (value: 1)
    "
  `);
});

test('multiple concurrent mutations with revalidation', async () => {
  // Expected: overlapping mutations schedule a single revalidation fetch that
  // skips redundant requests and commits only once with the latest data.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First mutation
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // Second mutation starts 50ms after first (while first is still running)
  await vi.advanceTimersByTimeAsync(50);
  env.addTimelineComment('Second mutation overlaps first');
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.serverHistory).toEqual([0, 1, 2]);
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
    1.25s | 2  | 🔴 >fetch-started
    2.05s | 2  | 🔴 <fetch-finished (value: 2)
    "
  `);

  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.numOfStartedFetches).toBe(1);
});

test('multiple high priority fetches', async () => {
  // Expected: high priority requests coalesce into a running fetch plus one scheduled fetch.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First high priority fetch starts immediately
  env.scheduleFetch('highPriority');

  // These are skipped (fetch already in progress, within throttle window)
  await vi.advanceTimersByTimeAsync(40);
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(50);
  env.scheduleFetch('highPriority');

  // These get scheduled (outside throttle window but fetch still in progress)
  await vi.advanceTimersByTimeAsync(60);
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(80);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    40ms  | 0  | scheduled-fetch-scheduled
    90ms  | 0  | scheduled-fetch-scheduled
    150ms | 0  | scheduled-fetch-scheduled
    230ms | 0  | scheduled-fetch-scheduled
    800ms | 0  | 🔴 <fetch-finished (value: 0)
    .     | 0  | 🟠 >fetch-started
    1.6s  | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('multiple high priority fetches within high base request delay window', async () => {
  // Expected: high priority requests coalesce into a single fetch if triggered within high base request delay window.
  const env = createDocumentStoreTestEnv(0, {
    baseRequestDelayMs: 20,
  });

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // First high priority fetch starts immediately
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(3);
  env.scheduleFetch('highPriority');

  await vi.advanceTimersByTimeAsync(10);
  env.scheduleFetch('highPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot();
});

test('throttle low priority updates', async () => {
  // Expected: low priority requests are throttled so only the first and last execute.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // t=0: first low priority fetch starts
  env.scheduleFetch('lowPriority');

  // t=100: skipped - first fetch in progress
  await vi.advanceTimersByTimeAsync(100);
  env.scheduleFetch('lowPriority');

  // t=110: skipped - first fetch in progress
  await vi.advanceTimersByTimeAsync(10);
  env.scheduleFetch('lowPriority');

  // t=120: skipped - first fetch in progress
  await vi.advanceTimersByTimeAsync(10);
  env.scheduleFetch('lowPriority');

  // Wait for first fetch to complete
  await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_DURATION_MS + 10);

  // Second fetch starts outside the throttle window from t=0
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    100ms | 0  | scheduled-fetch-skipped
    110ms | 0  | scheduled-fetch-skipped
    120ms | 0  | scheduled-fetch-skipped
    800ms | 0  | 🔴 <fetch-finished (value: 0)
    930ms | 0  | 🟠 >fetch-started-from-manual-scheduling
    1.73s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
  expect(env.numOfFinishedFetches).toBe(2);
});

test('throttle low priority after a fast fetch completes', async () => {
  // Expected: low priority throttling uses the fetch start time, even if it finishes quickly.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  env.setNextFetchDurations(50, 50);

  // t=0: first low priority fetch starts (treated as high priority when no prior fetch exists)
  env.scheduleFetch('lowPriority');

  // t=60: first fetch finished (50ms), still within the throttle window
  await vi.advanceTimersByTimeAsync(60);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('skipped');

  // t=210: outside throttle window
  await vi.advanceTimersByTimeAsync(150);
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 🔴 >fetch-started-from-manual-scheduling
    50ms  | 0  | 🔴 <fetch-finished (value: 0)
    60ms  | 0  | scheduled-fetch-skipped
    210ms | 0  | 🟠 >fetch-started-from-manual-scheduling
    260ms | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('multiple mutations with low priority fetch between', async () => {
  // Expected: low priority fetch is scheduled but coalesced with mutation revalidation,
  // resulting in a single fetch commit.
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

  // t=0: first mutation with revalidation
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // t=50: second mutation with revalidation
  await vi.advanceTimersByTimeAsync(50);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  // t=70: low priority fetch (should be skipped while mutations are in flight)
  await vi.advanceTimersByTimeAsync(20);
  const result = env.scheduleFetch('lowPriority');
  expect(result).toBe('scheduled');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.numOfFinishedFetches).toBe(1);
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
    1.25s | 2  | 🔴 >fetch-started
    2.05s | 2  | 🔴 <fetch-finished (value: 2)
    "
  `);
});

test('very slow mutation revalidation then mutation', async () => {
  // Expected: long revalidation fetch overlaps a second mutation, causing the
  // first fetch to be aborted and a fresh fetch to commit the latest value.
  // First revalidation (2000ms) > second mutation (200ms) + second revalidation (200ms)
  const env = createDocumentStoreTestEnv(0);

  renderHook(() => {
    env.trackUIChanges(env.useDocument().data?.value);
  });

  await vi.runAllTimersAsync();

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
  await vi.advanceTimersByTimeAsync(300);

  env.addTimelineComment(
    'Slow revalidation still running; scheduler aborts in-flight fetch after new mutation to prevent stale commit.',
  );

  // t=300: second mutation starts during first revalidation (which started at t=200)
  // First revalidation would finish at t=2200, but gets aborted
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    withRevalidation: true,
    duration: 200, // Second mutation + revalidation = 200 + 200 = 400ms < 2000ms first revalidation
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    140ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    200ms | 1  | 🔴 >fetch-started
    300ms | 1  | -- Slow revalidation still running; scheduler aborts in-flight fetch after new mutation to prevent stale commit.
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    440ms | 2  | ⬛ <mutation-data-persisted (value: 2)
    500ms | 2  | 🟠 >fetch-started
    700ms | 2  | 🟠 <fetch-finished (value: 2)
    2.2s  | 2  | 🔴 <fetch-aborted 🚫
    "
  `);
});

test('fetch error', async () => {
  // Expected: first fetch succeeds, second fetch errors and UI enters error state.
  const env = createDocumentStoreTestEnv(0, {
    forceInitialDataInvalidation: true,
  });

  renderHook(() => {
    const { data, error } = env.useDocument();
    env.trackUIChanges(error ? 'error' : data?.value);
  });

  // First fetch starts automatically due to forceInitialDataInvalidation
  await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_DURATION_MS + 10);

  // Mark next fetch as error (helper also mutates server data for timeline)
  env.errorInNextFetch();

  // Second fetch (will error)
  env.scheduleFetch('lowPriority');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([0, 'error']);
  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toContain('fetch-error');
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui      |
    0     | -       | 🔴 >fetch-started
    800ms | -       | 🔴 <fetch-finished (value: 0)
    .     | 0       | ui-initialized
    810ms | 0       | 🟠 >fetch-started-from-manual-scheduling
    .     | 0       | 🟠 <fetch-error (value: "error")
    .     | "error" | ui-changed
    "
  `);
});
