import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
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

function dynamicRealtimeThrottleMs({
  lastFetchDuration,
}: {
  lastFetchDuration: number;
}): number {
  if (lastFetchDuration > 300) return 300;
  return 100;
}

test('dynamically throttle realtime updates', async () => {
  // Expected: slow RTU fetch increases throttle window, causing coalescing of RTUs
  // and eventual commits for the latest updates.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const slowDuration = 300;
  const fastDuration = 200;

  // t=0: first RTU with slow fetch
  env.setNextFetchDurations(slowDuration, fastDuration, fastDuration);
  env.emulateExternalRTU(1);

  // t=320: second RTU
  await advanceTime(slowDuration + 20);
  env.addTimelineComments({ id: '🔴', action: '<fetch-finished' }, [
    'vvv throttle window (100ms) vvv',
    { comment: '^^^ throttle window ^^^', deltaMs: 100 },
  ]);
  env.emulateExternalRTU(2);

  // t=330: third RTU
  await advanceTime(10);
  env.emulateExternalRTU(3);

  // t=660: fourth RTU
  await advanceTime(330);
  env.emulateExternalRTU(4);

  await flushAllTimers();

  expect(env.uiChanges).toEqual([0, 1, 3, 4]);
  expect(env.serverMock.numOfFinishedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | server-data-changed (value: 1)
    .     | 0  | received-ws-data-change-event
    10ms  | 0  | 🔴 >fetch-started
    310ms | 0  | 🔴 <fetch-finished (value: 1)
    .     | 1  | ui-changed
    .     | 1  | -- vvv throttle window (100ms) vvv
    320ms | 1  | server-data-changed (value: 2)
    .     | 1  | received-ws-data-change-event
    330ms | 1  | server-data-changed (value: 3)
    .     | 1  | received-ws-data-change-event
    410ms | 1  | -- ^^^ throttle window ^^^
    .     | 1  | scheduled-rt-fetch-started
    420ms | 1  | 🟠 >fetch-started
    620ms | 1  | 🟠 <fetch-finished (value: 3)
    .     | 3  | ui-changed
    660ms | 3  | server-data-changed (value: 4)
    .     | 3  | received-ws-data-change-event
    720ms | 3  | scheduled-rt-fetch-started
    730ms | 3  | 🟡 >fetch-started
    930ms | 3  | 🟡 <fetch-finished (value: 4)
    .     | 4  | ui-changed
    "
  `);
});

test('dynamically throttle multiple realtime updates at same time with delay inferior to debounce 2', async () => {
  // Expected: dynamic throttle shortens for recent fetches, allowing two RTU fetches
  // while coalescing multiple RTU signals into the last update.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs({ lastFetchDuration }) {
      return lastFetchDuration < 700 ? 100 : 500;
    },
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const shortFetch = 500;
  const mediumFetch = 1000;
  env.setNextFetchDurations(shortFetch, mediumFetch, shortFetch);

  // t=0: first RTU triggers immediate fetch (no prior fetch, no throttle)
  env.emulateExternalRTU(1);

  // t=700: second RTU after throttle window → immediate start
  await advanceTime(700);
  // t=500: first fetch completes (500ms < 700ms → short 100ms throttle starts after)
  env.addTimelineComments({ id: '🔴', action: '<fetch-finished' }, [
    { comment: 'vvv 100ms throttle (500ms fetch < 700ms) vvv', deltaMs: 1 },
    { comment: '^^^ throttle ends ^^^', deltaMs: 100 },
  ]);
  env.emulateExternalRTU(2);

  // t=900: third RTU while second fetch is in flight → coalesced
  await advanceTime(200);
  env.emulateExternalRTU(3);

  await flushAllTimers();

  // t=1700: second fetch completes (1000ms >= 700ms → long 500ms throttle starts after)
  env.addTimelineComments({ id: '🟠', action: '<fetch-finished' }, [
    { comment: 'vvv 500ms throttle (1000ms fetch >= 700ms) vvv', deltaMs: 1 },
    { comment: '^^^ throttle ends, delayed fetch runs ^^^', deltaMs: 500 },
  ]);

  expect(env.uiChanges).toEqual([0, 1, 3]);
  expect(env.serverMock.numOfFinishedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | server-data-changed (value: 1)
    .      | 0  | received-ws-data-change-event
    10ms   | 0  | 🔴 >fetch-started
    510ms  | 0  | 🔴 <fetch-finished (value: 1)
    .      | 1  | ui-changed
    511ms  | 1  | -- vvv 100ms throttle (500ms fetch < 700ms) vvv
    610ms  | 1  | -- ^^^ throttle ends ^^^
    700ms  | 1  | server-data-changed (value: 2)
    .      | 1  | received-ws-data-change-event
    710ms  | 1  | 🟠 >fetch-started
    900ms  | 1  | server-data-changed (value: 3)
    .      | 1  | received-ws-data-change-event
    1.71s  | 1  | 🟠 <fetch-finished (value: 3)
    .      | 3  | ui-changed
    1.711s | 3  | -- vvv 500ms throttle (1000ms fetch >= 700ms) vvv
    2.21s  | 3  | scheduled-rt-fetch-started
    .      | 3  | -- ^^^ throttle ends, delayed fetch runs ^^^
    2.22s  | 3  | 🟡 >fetch-started
    2.72s  | 3  | 🟡 <fetch-finished (value: 3)
    "
  `);
});

test('simple mutation that triggers a RTU', async () => {
  // Expected: mutation triggers RTU fetch after optimistic commit, committing the server state.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: ({ lastFetchDuration }) =>
      lastFetchDuration > 300 ? 300 : 100,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: schedule low priority fetch (short duration)
  env.setNextFetchDurations(20);
  env.scheduleFetch('lowPriority');

  // t=110: mutation with RTU
  await advanceTime(110);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 200,
    triggerRTU: true,
    addServerDataChangeAction: true,
  });

  await flushAllTimers();

  expect(env.serverMock.history).toEqual([0, 1]);
  expect(env.uiChanges).toEqual([0, 1]);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toContain('scheduled-rt-fetch-started');
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    30ms  | 0  | 🔴 <fetch-finished (value: 0)
    110ms | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    250ms | 1  | server-data-changed (value: 1)
    .     | 1  | ⬜ <mutation-data-persisted (value: 1)
    300ms | 1  | received-ws-data-change-event
    310ms | 1  | scheduled-rt-fetch-started
    320ms | 1  | 🟠 >fetch-started
    1.12s | 1  | 🟠 <fetch-finished (value: 1)
    "
  `);
});

test('slow mutation then external RTU while mutation RTU is running', async () => {
  // Expected: external RTU schedules another fetch while mutation RTU is in flight,
  // both fetches eventually commit in order.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: ({ lastFetchDuration }) =>
      lastFetchDuration > 1000 ? 500 : 200,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: low priority fetch to set dynamic realtime last duration (800ms default)
  env.scheduleFetch('lowPriority');

  // t=1s: mutation with RTU (1200ms duration, data persisted at 840ms = 70%)
  await advanceTime(1000);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1200,
    triggerRTU: true,
    addServerDataChangeAction: true,
  });

  // t=2.3s: external RTU arrives while mutation's RTU fetch is running
  await advanceTime(1300);
  // t=1.89s: RTU event triggers fetch scheduling (waits for mutation to complete)
  env.addTimelineComments({ id: '⬜', action: '<mutation-data-persisted' }, [
    {
      comment: 'mutation completes at 2.2s, RTU fetch can start',
      deltaMs: 360,
    },
  ]);
  env.emulateExternalRTU(2);
  env.addTimelineComments('afterLastAction', [
    'external RTU coalesced, schedules follow-up fetch',
  ]);

  await flushAllTimers();

  // t=3s: first RTU fetch finishes (800ms < 1000ms → 200ms throttle)
  env.addTimelineComments({ id: '🟠', action: '<fetch-finished' }, [
    { comment: 'vvv 200ms throttle (800ms fetch < 1000ms) vvv', deltaMs: 1 },
    { comment: '^^^ throttle ends, follow-up fetch runs ^^^', deltaMs: 200 },
  ]);

  expect(env.serverMock.history).toEqual([0, 1, 2]);
  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.serverMock.numOfFinishedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | scheduled-fetch-triggered
    10ms   | 0  | 🔴 >fetch-started
    810ms  | 0  | 🔴 <fetch-finished (value: 0)
    1s     | 1  | ⬜ optimistic-ui-commit
    .      | 1  | ⬜ >mutation-started (value: 1)
    1.84s  | 1  | server-data-changed (value: 1)
    .      | 1  | ⬜ <mutation-data-persisted (value: 1)
    1.89s  | 1  | received-ws-data-change-event
    2.2s   | 1  | scheduled-rt-fetch-started
    .      | 1  | -- mutation completes at 2.2s, RTU fetch can start
    2.21s  | 1  | 🟠 >fetch-started
    2.3s   | 1  | server-data-changed (value: 2)
    .      | 1  | received-ws-data-change-event
    .      | 1  | -- external RTU coalesced, schedules follow-up fetch
    3.01s  | 1  | 🟠 <fetch-finished (value: 2)
    .      | 2  | ui-changed
    3.011s | 2  | -- vvv 200ms throttle (800ms fetch < 1000ms) vvv
    3.21s  | 2  | scheduled-rt-fetch-started
    .      | 2  | -- ^^^ throttle ends, follow-up fetch runs ^^^
    3.22s  | 2  | 🟡 >fetch-started
    4.02s  | 2  | 🟡 <fetch-finished (value: 2)
    "
  `);
});

test('slow mutation then new mutation while prev mutation RTU is running', async () => {
  // Expected: new mutation aborts in-flight RTU fetch, then schedules a new RTU fetch
  // that commits the latest mutation result.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: ({ lastFetchDuration }) =>
      lastFetchDuration > 1000 ? 500 : 200,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: low priority fetch to set dynamic realtime last duration (800ms default)
  env.scheduleFetch('lowPriority');

  // t=1s: mutation 1 with RTU (1200ms duration)
  await advanceTime(1000);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1200,
    triggerRTU: true,
  });

  // t=2.5s: mutation 2 starts while mutation 1's RTU fetch is running
  await advanceTime(1500);
  // mutation 1 completes at 2.2s, RTU fetch starts
  env.addTimelineComments({ id: '⬜', action: '<mutation-data-persisted' }, [
    { comment: 'mutation 1 completes, RTU fetch starts' },
  ]);
  env.addTimelineComments({ id: '🟠', action: '<fetch-aborted 🚫' }, [
    'mutation 2 aborts in-flight RTU fetch',
  ]);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    duration: 1200,
    triggerRTU: true,
  });

  await flushAllTimers();

  // mutation 2 completes at 3.7s, its RTU fetch runs
  env.addTimelineComments({ id: '⬛', action: '<mutation-data-persisted' }, [
    { comment: 'mutation 2 completes, new RTU fetch starts' },
  ]);

  expect(env.serverMock.history).toEqual([0, 1, 2]);
  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.serverMock.numOfStartedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    1s    | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    1.84s | 1  | ⬜ <mutation-data-persisted (value: 1)
    .     | 1  | -- mutation 1 completes, RTU fetch starts
    1.89s | 1  | received-ws-data-change-event
    2.2s  | 1  | scheduled-rt-fetch-started
    2.21s | 1  | 🟠 >fetch-started
    2.5s  | 1  | 🟠 <fetch-aborted 🚫
    .     | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    .     | 2  | -- mutation 2 aborts in-flight RTU fetch
    3.34s | 2  | ⬛ <mutation-data-persisted (value: 2)
    .     | 2  | -- mutation 2 completes, new RTU fetch starts
    3.39s | 2  | received-ws-data-change-event
    3.7s  | 2  | scheduled-rt-fetch-started
    3.71s | 2  | 🟡 >fetch-started
    4.51s | 2  | 🟡 <fetch-finished (value: 2)
    "
  `);
});

test('slow mutation then new mutation while prev mutation is running', async () => {
  // Expected: overlapping mutations each trigger RTU scheduling, but only one RTU fetch runs,
  // committing the latest data.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: ({ lastFetchDuration }) =>
      lastFetchDuration > 1000 ? 500 : 200,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: low priority fetch to set dynamic realtime last duration (800ms default)
  env.scheduleFetch('lowPriority');

  // t=1s: mutation 1 with RTU (1200ms duration)
  await advanceTime(1000);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1200,
    triggerRTU: true,
  });

  // t=1.5s: mutation 2 starts while mutation 1 is still running
  await advanceTime(500);
  env.addTimelineComments('afterLastAction', [
    'mutation 2 starts while mutation 1 running',
  ]);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: true,
    duration: 1200,
    triggerRTU: true,
  });

  await flushAllTimers();

  // Both mutations complete, RTU events coalesce, single RTU fetch runs
  env.addTimelineComments({ id: '⬜', action: '<mutation-data-persisted' }, [
    { comment: 'mutation 1 completes', deltaMs: 360 },
  ]);
  env.addTimelineComments({ id: '⬛', action: '<mutation-data-persisted' }, [
    { comment: 'mutation 2 completes, RTU fetch can start', deltaMs: 360 },
  ]);

  expect(env.serverMock.history).toEqual([0, 1, 2]);
  expect(env.uiChanges).toEqual([0, 1, 2]);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    1s    | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    .     | 1  | -- mutation 2 starts while mutation 1 running
    1.5s  | 2  | ⬛ optimistic-ui-commit
    .     | 2  | ⬛ >mutation-started (value: 2)
    1.84s | 2  | ⬜ <mutation-data-persisted (value: 1)
    1.89s | 2  | received-ws-data-change-event
    2.2s  | 2  | -- mutation 1 completes
    2.34s | 2  | ⬛ <mutation-data-persisted (value: 2)
    2.39s | 2  | received-ws-data-change-event
    2.7s  | 2  | scheduled-rt-fetch-started
    .     | 2  | -- mutation 2 completes, RTU fetch can start
    2.71s | 2  | 🟠 >fetch-started
    3.51s | 2  | 🟠 <fetch-finished (value: 2)
    "
  `);
});

test('rtu mutations without optimistic updates', async () => {
  // Expected: no optimistic UI commits, RTU fetches drive UI updates after server change.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: ({ lastFetchDuration }) =>
      lastFetchDuration > 1000 ? 500 : 200,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: low priority fetch (800ms default)
  env.scheduleFetch('lowPriority');

  // t=1s: mutation 1 without optimistic update, with RTU (1200ms duration)
  await advanceTime(1000);
  void env.performClientUpdateAction(1, {
    withOptimisticUpdate: false,
    duration: 1200,
    triggerRTU: true,
  });

  // t=2.5s: mutation 2 starts while mutation 1's RTU fetch is running
  await advanceTime(1500);
  // mutation 1 completes at 2.2s, RTU fetch starts
  env.addTimelineComments({ id: '⬜', action: '>mutation-started' }, [
    'no optimistic update, UI stays at 0',
  ]);
  env.addTimelineComments({ id: '⬜', action: '<mutation-data-persisted' }, [
    { comment: 'mutation 1 completes, RTU fetch starts' },
  ]);
  env.addTimelineComments({ id: '🟠', action: '<fetch-aborted 🚫' }, [
    'mutation 2 aborts in-flight RTU fetch',
  ]);
  void env.performClientUpdateAction(2, {
    withOptimisticUpdate: false,
    duration: 1200,
    triggerRTU: true,
  });

  await flushAllTimers();

  // mutation 2 completes at 3.7s, its RTU fetch runs and finally updates UI
  env.addTimelineComments({ id: '⬛', action: '<mutation-data-persisted' }, [
    { comment: 'mutation 2 completes, RTU fetch updates UI' },
  ]);

  expect(env.serverMock.history).toEqual([0, 1, 2]);
  expect(env.uiChanges).toEqual([0, 2]);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);
  expect(env.serverMock.numOfStartedFetches).toBe(3);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    1s    | 0  | ⬜ >mutation-started (value: 1)
    .     | 0  | -- no optimistic update, UI stays at 0
    1.84s | 0  | ⬜ <mutation-data-persisted (value: 1)
    .     | 0  | -- mutation 1 completes, RTU fetch starts
    1.89s | 0  | received-ws-data-change-event
    2.2s  | 0  | scheduled-rt-fetch-started
    2.21s | 0  | 🟠 >fetch-started
    2.5s  | 0  | 🟠 <fetch-aborted 🚫
    .     | 0  | ⬛ >mutation-started (value: 2)
    .     | 0  | -- mutation 2 aborts in-flight RTU fetch
    3.34s | 0  | ⬛ <mutation-data-persisted (value: 2)
    .     | 0  | -- mutation 2 completes, RTU fetch updates UI
    3.39s | 0  | received-ws-data-change-event
    3.7s  | 0  | scheduled-rt-fetch-started
    3.71s | 0  | 🟡 >fetch-started
    4.51s | 0  | 🟡 <fetch-finished (value: 2)
    .     | 2  | ui-changed
    "
  `);
});

test('schedule rtu updates then schedule a fetch right before the rtu starts', async () => {
  // Expected: low priority fetch starts before RTU fetch, so RTU is skipped and
  // the low priority fetch commits the server state.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs() {
      return 500;
    },
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: low priority fetch (800ms default)
  env.scheduleFetch('lowPriority');

  // t=1s: external RTU schedules fetch after 500ms throttle (would start at 1.5s)
  await advanceTime(1000);
  env.emulateExternalRTU(1);
  env.addTimelineComments('afterLastAction', [
    'RTU received, fetch scheduled for 1.5s',
    { comment: 'vvv 500ms RTU throttle vvv', deltaMs: 1 },
  ]);

  // t=1.3s: low priority fetch scheduled before RTU throttle ends
  await advanceTime(300);
  env.addTimelineComments('afterLastAction', [
    'low priority fetch preempts RTU fetch',
  ]);
  env.scheduleFetch('lowPriority');

  await flushAllTimers();

  // RTU fetch is skipped because low priority fetch already handles it
  env.addTimelineComments({ id: '🟠', action: '<fetch-finished' }, [
    {
      comment: '^^^ RTU fetch coalesced (low priority already fetching) ^^^',
      deltaMs: -600,
    },
  ]);

  expect(env.serverMock.history).toEqual([0, 1]);
  expect(env.uiChanges).toEqual([0, 1]);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | scheduled-fetch-triggered
    10ms   | 0  | 🔴 >fetch-started
    810ms  | 0  | 🔴 <fetch-finished (value: 0)
    1s     | 0  | server-data-changed (value: 1)
    .      | 0  | received-ws-data-change-event
    .      | 0  | -- RTU received, fetch scheduled for 1.5s
    1.001s | 0  | -- vvv 500ms RTU throttle vvv
    .      | 0  | -- low priority fetch preempts RTU fetch
    1.3s   | 0  | scheduled-fetch-triggered
    1.31s  | 0  | scheduled-rt-fetch-started
    .      | 0  | 🟠 >fetch-started
    1.51s  | 0  | -- ^^^ RTU fetch coalesced (low priority already fetching) ^^^
    2.11s  | 0  | 🟠 <fetch-finished (value: 1)
    .      | 1  | ui-changed
    "
  `);
});

test('mutation that triggers multiple rtu updates', async () => {
  // Expected: burst of RTU fetch requests is coalesced into a single scheduled RTU fetch.
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs() {
      return 500;
    },
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  // t=0: low priority fetch (800ms default)
  env.scheduleFetch('lowPriority');

  // t=1s: mutation (1200ms duration, data persisted at 840ms = 70%)
  await advanceTime(1000);
  void env.performClientUpdateAction(1, {
    duration: 1200,
    addServerDataChangeAction: true,
  });

  // t=1.9s: burst of RTU requests after server data changed simulating multiple external RTU events (at 1.84s)
  await advanceTime(900);
  env.addTimelineComments('afterLastAction', [
    'burst of 6 RTU requests after data change',
  ]);
  env.scheduleFetch('realtimeUpdate');
  env.scheduleFetch('realtimeUpdate');
  env.scheduleFetch('realtimeUpdate');
  env.scheduleFetch('realtimeUpdate');
  env.scheduleFetch('realtimeUpdate');
  env.scheduleFetch('realtimeUpdate');

  await flushAllTimers();

  // All RTU requests coalesce into single fetch after mutation completes
  env.addTimelineComments({ id: '⬜', action: '<mutation-data-persisted' }, [
    { comment: 'mutation completes at 2.2s', deltaMs: 360 },
  ]);
  env.addTimelineComments({ id: '🟠', action: '<fetch-finished' }, [
    {
      comment: 'single RTU fetch runs (coalesced from 6 requests)',
      deltaMs: -300,
    },
  ]);

  expect(env.uiChanges).toEqual([0, 1]);
  expect(env.serverMock.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-triggered
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    1s    | 0  | ⬜ >mutation-started (value: 1)
    1.84s | 0  | server-data-changed (value: 1)
    .     | 0  | ⬜ <mutation-data-persisted (value: 1)
    .     | 0  | -- burst of 6 RTU requests after data change
    1.9s  | 0  | rt-fetch-scheduled
    .     | 0  | rt-fetch-scheduled
    .     | 0  | rt-fetch-scheduled
    .     | 0  | rt-fetch-scheduled
    .     | 0  | rt-fetch-scheduled
    .     | 0  | rt-fetch-scheduled
    2.2s  | 0  | scheduled-rt-fetch-started
    .     | 0  | -- mutation completes at 2.2s
    2.21s | 0  | 🟠 >fetch-started
    2.71s | 0  | -- single RTU fetch runs (coalesced from 6 requests)
    3.01s | 0  | 🟠 <fetch-finished (value: 1)
    .     | 1  | ui-changed
    "
  `);
});
