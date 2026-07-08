import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TSDFDebugLogEntry } from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createFocusChangeCoordinator } from '../browser-tabs/browser-tabs-test-helpers';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

const TRANSPORT_RECONNECT_COOLDOWN_MS = 200;

// -- DocumentStore: revalidateOnWindowFocus ------------------------------------

test('document store: focus triggers lowPriority invalidation for non-realtime store', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    revalidateOnWindowFocus: true,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    10ms   | 0  | 🔴 >fetch-started
    810ms  | 0  | 🔴 <fetch-finished (value: 0)
    .      | 0  | 🔕 window-blurred
    815ms  | 0  | 👁 window-focused
    825ms  | 0  | 🟠 >fetch-started
    1.625s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('document store: focus does nothing when revalidateOnWindowFocus is not set', async () => {
  const tabs = createFocusChangeCoordinator(['a'], null);

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

test('document store: focus uses manager revalidateOnWindowFocus default', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    revalidateOnWindowFocus: true,
  });

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    storeManager,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(2);
});

test('document store: store revalidateOnWindowFocus overrides manager default', async () => {
  const tabs = createFocusChangeCoordinator(['a'], null);
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    revalidateOnWindowFocus: true,
  });

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    storeManager,
    revalidateOnWindowFocus: false,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

test('document store: focus with dynamic disable function', async () => {
  let enabled = true;
  const tabs = createFocusChangeCoordinator(['a'], null);

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    revalidateOnWindowFocus: () => enabled,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  // Disable and focus — should not trigger fetch
  enabled = false;

  const fetchesBeforeDisabled = env.serverMock.numOfStartedFetches;

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBeforeDisabled);

  // Re-enable and focus — should trigger fetch
  enabled = true;
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBeGreaterThan(
    fetchesBeforeDisabled,
  );
});

test('document store: debug logger records dynamic focus revalidation decisions', async () => {
  const debugEntries: TSDFDebugLogEntry[] = [];
  let enabled = false;
  const tabs = createFocusChangeCoordinator(['a'], null);
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    debugLogger: (entry) => {
      debugEntries.push(entry);
    },
  });

  const env = createDocumentStoreTestEnv(0, {
    id: 'debug-focus-document',
    testScenario: 'loaded',
    storeManager,
    revalidateOnWindowFocus: () => enabled,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  // A dynamic policy can temporarily suppress focus refetches; the debug log
  // should make that decision visible without requiring request tracing.
  await tabs.focusTab('a');
  await flushAllTimers();

  enabled = true;

  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(
    debugEntries
      .filter((entry) => entry.area === 'focus')
      .map((entry) => ({
        area: entry.area,
        details: entry.details,
        message: entry.message,
        operation: entry.operation,
      })),
  ).toMatchInlineSnapshot(`
    - area: 'focus'
      details:
        policy: 'dynamic'
        reason: 'dynamic-disabled'
        status: 'skipped'
        storeId: 'debug-focus-document'
        storeType: 'document'
      message: 'window focus revalidation skipped'
      operation: 'window-focus-revalidate'
    - area: 'focus'
      details:
        policy: 'dynamic'
        status: 'triggered'
        storeId: 'debug-focus-document'
        storeType: 'document'
      message: 'window focus revalidation triggered'
      operation: 'window-focus-revalidate'
  `);
});

test('document store: realtime store does NOT trigger on focus even when option is set', async () => {
  const tabs = createFocusChangeCoordinator(['a'], null);

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    revalidateOnWindowFocus: true,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

test('document store: reset() cleans up and re-registers focus listener', async () => {
  const tabs = createFocusChangeCoordinator(['a'], null);

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    revalidateOnWindowFocus: true,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  act(() => {
    env.apiStore.reset();
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBeGreaterThan(fetchesBefore);
});

// -- DocumentStore: background coalescing window -------------------------------

test('document store: a single background tab adds the background coalescing delay', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    baseCoalescingWindowMs: 20,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const initialFetches = env.serverMock.numOfStartedFetches;

  await tabs.blur();

  env.apiStore.invalidateData('highPriority');

  await advanceTime(10);
  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches);

  env.apiStore.invalidateData('highPriority');

  await advanceTime(9);
  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches);

  await advanceTime(1_000);
  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches);

  await advanceTime(2);
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches + 1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    20ms   | 0  | 🔴 >fetch-started
    820ms  | 0  | 🔴 <fetch-finished (value: 0)
    .      | 0  | 🔕 window-blurred
    3.845s | 0  | 🟠 >fetch-started
    4.645s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

// -- DocumentStore: dynamicRealtimeThrottleMs windowIsNotFocused --------------

test('document store: dynamicRealtimeThrottleMs receives correct windowIsNotFocused', async () => {
  const receivedParams: Array<{
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }> = [];

  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs(params) {
      receivedParams.push({ ...params });
      return 300;
    },
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  // First RTU to establish timing (dynamicRealtimeThrottleMs needs lastFetchDuration > 0)
  env.emulateExternalRTU(1);
  await flushAllTimers();

  // Second RTU in foreground
  env.emulateExternalRTU(2);
  await flushAllTimers();

  expect(receivedParams.some((p) => p.windowIsNotFocused === false)).toBe(true);

  // Go to background and trigger RTU
  await tabs.blur();
  env.emulateExternalRTU(3);
  await flushAllTimers();

  expect(receivedParams.some((p) => p.windowIsNotFocused === true)).toBe(true);
});

// -- Realtime stores: pending delayed RTU is re-evaluated on refocus -----------

test('document store: pending background realtime update fires promptly when the tab regains focus', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    // hidden tabs throttle realtime refetches to 2min, focused tabs to 1s
    dynamicRealtimeThrottleMs: ({ windowIsNotFocused }) =>
      windowIsNotFocused ? 120_000 : 1_000,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // first RTU fetch establishes the fetch timing the dynamic throttle needs
  env.emulateExternalRTU(1);
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(1);

  // the user backgrounds the tab and a WS change arrives right after: the
  // refetch is scheduled with the 2min background throttle
  await tabs.blur();
  env.emulateExternalRTU(2);

  // 10s pass in background: the throttle is still holding the refetch
  await advanceTime(10_000);
  expect(env.serverMock.numOfStartedFetches).toBe(1);

  // the user returns: the pending refetch must be re-evaluated with the
  // focused throttle (1s, already elapsed) and fire right away instead of
  // waiting out the remaining ~110s of the background window
  await tabs.focusTab('a');
  await advanceTime(2_000);

  expect(env.serverMock.numOfStartedFetches).toBe(2);

  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time    | ui |
    0       | 0  | ui-initialized
    .       | 0  | server-data-changed (value: 1)
    .       | 0  | received-ws-data-change-event
    10ms    | 0  | 🔴 >fetch-started
    810ms   | 0  | 🔴 <fetch-finished (value: 1)
    .       | 1  | ui-changed
    .       | 1  | 🔕 window-blurred
    815ms   | 1  | server-data-changed (value: 2)
    .       | 1  | received-ws-data-change-event
    .       | 1  | rt-fetch-scheduled (delay: 119995ms)
    10.815s | 1  | scheduled-rt-fetch-started
    .       | 1  | 👁 window-focused
    10.825s | 1  | 🟠 >fetch-started
    11.625s | 1  | 🟠 <fetch-finished (value: 2)
    .       | 2  | ui-changed
    "
  `);
});

test('document store: refocus reschedules the pending realtime update to the shorter focused delay', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    // focused throttle is 5s, so right after refocus the interval since the
    // last fetch has NOT elapsed yet — the fetch must be rescheduled, not fired
    dynamicRealtimeThrottleMs: ({ windowIsNotFocused }) =>
      windowIsNotFocused ? 120_000 : 5_000,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // establish fetch timing (fetch ends at ~810ms)
  env.emulateExternalRTU(1);
  await flushAllTimers();

  // background RTU gets the 2min throttle
  await tabs.blur();
  env.emulateExternalRTU(2);

  // refocus 2s later: 5s focused interval since last fetch end not elapsed yet
  await advanceTime(2_000);
  await tabs.focusTab('a');

  // must NOT fire immediately — the focused throttle still applies
  expect(env.serverMock.numOfStartedFetches).toBe(1);

  // ...but must fire once the focused interval completes (5s after the last
  // fetch end), not after the remaining background window
  await advanceTime(3_100);
  expect(env.serverMock.numOfStartedFetches).toBe(2);

  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | server-data-changed (value: 1)
    .      | 0  | received-ws-data-change-event
    10ms   | 0  | 🔴 >fetch-started
    810ms  | 0  | 🔴 <fetch-finished (value: 1)
    .      | 1  | ui-changed
    .      | 1  | 🔕 window-blurred
    815ms  | 1  | server-data-changed (value: 2)
    .      | 1  | received-ws-data-change-event
    .      | 1  | rt-fetch-scheduled (delay: 119995ms)
    2.815s | 1  | rt-fetch-scheduled (delay: 2995ms)
    .      | 1  | 👁 window-focused
    5.81s  | 1  | scheduled-rt-fetch-started
    5.82s  | 1  | 🟠 >fetch-started
    6.62s  | 1  | 🟠 <fetch-finished (value: 2)
    .      | 2  | ui-changed
    "
  `);
});

test('document store: refocus does not change the pending realtime update when the throttle ignores focus', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    // same throttle focused or not: refocusing must not move the fire time
    dynamicRealtimeThrottleMs: () => 2_000,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  // establish fetch timing (fetch ends at ~810ms)
  env.emulateExternalRTU(1);
  await flushAllTimers();

  // RTU while blurred is delayed until 2s after the last fetch end (~2.81s)
  await tabs.blur();
  env.emulateExternalRTU(2);

  await advanceTime(500);
  await tabs.focusTab('a');

  // refocus must not promote the fetch: the throttle is focus-independent
  await advanceTime(1_000);
  expect(env.serverMock.numOfStartedFetches).toBe(1);

  // the fetch fires at the originally scheduled time
  await advanceTime(600);
  expect(env.serverMock.numOfStartedFetches).toBe(2);

  await flushAllTimers();

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   | ui |
    0      | 0  | ui-initialized
    .      | 0  | server-data-changed (value: 1)
    .      | 0  | received-ws-data-change-event
    10ms   | 0  | 🔴 >fetch-started
    810ms  | 0  | 🔴 <fetch-finished (value: 1)
    .      | 1  | ui-changed
    .      | 1  | 🔕 window-blurred
    815ms  | 1  | server-data-changed (value: 2)
    .      | 1  | received-ws-data-change-event
    .      | 1  | rt-fetch-scheduled (delay: 1995ms)
    1.315s | 1  | 👁 window-focused
    2.81s  | 1  | scheduled-rt-fetch-started
    2.82s  | 1  | 🟠 >fetch-started
    3.62s  | 1  | 🟠 <fetch-finished (value: 2)
    .      | 2  | ui-changed
    "
  `);
});

test('collection store: pending background realtime update fires promptly when the tab regains focus', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' } },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: ({ windowIsNotFocused }) =>
        windowIsNotFocused ? 120_000 : 1_000,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useItem('1'));

  // first RTU fetch establishes the fetch timing the dynamic throttle needs
  act(() => {
    env.serverTable.setItem(
      '1',
      { name: 'Alice v2' },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  // background RTU is delayed by the 2min background throttle
  await tabs.blur();
  act(() => {
    env.serverTable.setItem(
      '1',
      { name: 'Alice v3' },
      { triggerRTUEvent: true },
    );
  });

  await advanceTime(10_000);
  expect(env.serverTable.getRequestHistory('item')).toHaveLength(0);

  // refocus: the pending refetch is re-evaluated with the focused throttle
  // (already elapsed) and fires right away
  await tabs.focusTab('a');
  await advanceTime(2_000);

  expect(env.serverTable.getRequestHistory('item')).toHaveLength(1);

  // the UI ends up with the value from the background change
  expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Alice v3' }`,
  );
});

test('list query store: pending background realtime update fires promptly when the tab regains focus', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createListQueryStoreTestEnv(
    {
      users: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    },
    {
      testScenario: { loaded: { tables: ['users'] } },
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: ({ windowIsNotFocused }) =>
        windowIsNotFocused ? 120_000 : 1_000,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));

  // first RTU fetch establishes the fetch timing the dynamic throttle needs
  act(() => {
    env.serverTable.setItem(
      'users||1',
      { id: 1, name: 'Alice v2' },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  // background RTU is delayed by the 2min background throttle
  await tabs.blur();
  act(() => {
    env.serverTable.setItem(
      'users||2',
      { id: 2, name: 'Bob v2' },
      { triggerRTUEvent: true },
    );
  });

  await advanceTime(10_000);
  expect(env.serverTable.getRequestHistory('list')).toHaveLength(0);

  // refocus: the pending list refetch is re-evaluated with the focused
  // throttle (already elapsed) and fires right away
  await tabs.focusTab('a');
  await advanceTime(2_000);

  expect(env.serverTable.getRequestHistory('list')).toHaveLength(1);

  // the refetched list reflects the change that arrived in background
  expect(env.apiStore.getItemState('users||2')).toMatchInlineSnapshot(`
    id: 2
    name: 'Bob v2'
  `);
});

// -- CollectionStore: revalidateOnWindowFocus ----------------------------------

test('collection store: focus triggers lowPriority invalidation for all items', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      revalidateOnWindowFocus: true,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
    - duration: 800
      itemId: '1'
      result: { name: 'Alice' }
      startedAt: 825
      type: 'fetch'
    - duration: 800
      itemId: '2'
      result: { name: 'Bob' }
      startedAt: 825
      type: 'fetch'
  `);
});

test('collection store: focus with dynamic disable function', async () => {
  let enabled = true;
  const tabs = createFocusChangeCoordinator(['a'], null);

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      revalidateOnWindowFocus: () => enabled,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  enabled = false;
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(0);

  enabled = true;
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  const fetchedItemIds: string[] = [];
  for (const entry of env.serverTable.fetchHistory) {
    if (entry.type === 'fetch') {
      fetchedItemIds.push(entry.itemId);
    }
  }

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['1', '2']
  `);
});

// -- ListQueryStore: revalidateOnWindowFocus -----------------------------------

test('list query store: focus triggers lowPriority invalidation for queries and items', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    revalidateOnWindowFocus: true,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));

  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  const listFetch = env.serverTable.fetchHistory.find(
    (entry) => entry.type === 'list',
  );

  expect(listFetch).toMatchInlineSnapshot(`
    duration: 800
    limit: 50
    offset: 0
    results:
      - data: { id: 1, name: 'Alice' }
        itemId: 'users||1'
      - data: { id: 2, name: 'Bob' }
        itemId: 'users||2'
    startedAt: 825
    type: 'list'
  `);

  const fetchedItemIds: string[] = [];
  for (const entry of env.serverTable.fetchHistory) {
    if (entry.type === 'fetch') {
      fetchedItemIds.push(entry.itemId);
    }
  }

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['users||1', 'users||2']
  `);
});

// -- DocumentStore: onTransportReconnect ----------------------------------------

test('document store: onTransportReconnect while focused triggers immediate realtimeUpdate invalidation', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

test('document store: focused reconnect burst runs immediately once and schedules one trailing fetch', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    transportReconnectCooldownMs: TRANSPORT_RECONNECT_COOLDOWN_MS,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(20);

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(TRANSPORT_RECONNECT_COOLDOWN_MS - 1);

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  await advanceTime(1);
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 2);

  await advanceTime(TRANSPORT_RECONNECT_COOLDOWN_MS + 1);

  const fetchesBeforeCooldownExpiryReconnect =
    env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(
    fetchesBeforeCooldownExpiryReconnect + 1,
  );

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time   |
    110ms  | 🔴 >fetch-started
    910ms  | 🔴 <fetch-finished (value: 0)
    .      | rt-fetch-scheduled (delay: 300ms)
    1.21s  | scheduled-rt-fetch-started
    1.22s  | 🟠 >fetch-started
    2.02s  | 🟠 <fetch-finished (value: 0)
    2.221s | rt-fetch-scheduled (delay: 99ms)
    2.32s  | scheduled-rt-fetch-started
    2.33s  | 🟡 >fetch-started
    3.13s  | 🟡 <fetch-finished (value: 0)
    "
  `);
});

test('document store: immediate reconnect after cooldown clears older trailing timer', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');
  const reconnectCooldownMs = 2_000;

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    transportReconnectCooldownMs: reconnectCooldownMs,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  await advanceTime(reconnectCooldownMs - 10 - 810);

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(20);

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 2);

  await advanceTime(reconnectCooldownMs);
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 2);
});

test('document store: onTransportReconnect while unfocused defers invalidation to next focus', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  await tabs.blur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  // No fetch while unfocused
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);

  await tabs.focusTab('a');
  await flushAllTimers();

  // Fetch triggered on focus
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  await advanceTime(1_200);
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  // No extra fetch on later focus events
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

test('document store: multiple onTransportReconnect calls while unfocused are coalesced', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  await tabs.blur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);

  await tabs.focusTab('a');
  await flushAllTimers();

  // Only one invalidation despite 3 calls
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

test('document store: reconnect trailing flush waits for focus and fires once', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    transportReconnectCooldownMs: TRANSPORT_RECONNECT_COOLDOWN_MS,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(20);

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await tabs.blur();
  await advanceTime(TRANSPORT_RECONNECT_COOLDOWN_MS);
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 2);
});

test('document store: onTransportReconnect is no-op when usesRealTimeUpdates is false', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

test('document store: reset() cleans up pending onTransportReconnect listener and timer', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    transportReconnectCooldownMs: TRANSPORT_RECONNECT_COOLDOWN_MS,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(20);

  await tabs.blur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  act(() => {
    env.apiStore.reset();
  });

  await advanceTime(TRANSPORT_RECONNECT_COOLDOWN_MS);
  await tabs.focusTab('a');
  await flushAllTimers();

  // The leading reconnect may already have started, but reset must prevent any
  // additional trailing/background reconnect fetches.
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

test('document store: dispose() cleans up focus listeners and reconnect timers', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    revalidateOnWindowFocus: true,
    dynamicRealtimeThrottleMs: () => 300,
    transportReconnectCooldownMs: TRANSPORT_RECONNECT_COOLDOWN_MS,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(20);
  await tabs.blur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  act(() => {
    env.apiStore.dispose();
  });

  await advanceTime(TRANSPORT_RECONNECT_COOLDOWN_MS);
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

// -- CollectionStore: onTransportReconnect ------------------------------------

test('collection store: onTransportReconnect while focused invalidates all items', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  const fetchedItemIds = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['1', '2']
  `);
});

test('collection store: focused reconnect burst runs one immediate and one trailing invalidation', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');
  const reconnectCooldownMs = 2_000;

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
      transportReconnectCooldownMs: reconnectCooldownMs,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(
    env.serverTable.fetchHistory.filter((entry) => entry.type === 'fetch'),
  ).toHaveLength(2);

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await advanceTime(reconnectCooldownMs - 1);

  expect(
    env.serverTable.fetchHistory.filter((entry) => entry.type === 'fetch'),
  ).toHaveLength(2);

  await advanceTime(1);
  await flushAllTimers();

  expect(
    env.serverTable.fetchHistory.filter((entry) => entry.type === 'fetch'),
  ).toHaveLength(4);
});

test('collection store: onTransportReconnect while unfocused defers and coalesces', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
      bindFocusController: tabs.bind('a'),
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  await tabs.blur();

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  // No fetches while unfocused
  expect(
    env.serverTable.fetchHistory.filter((e) => e.type === 'fetch'),
  ).toHaveLength(0);

  await tabs.focusTab('a');
  await flushAllTimers();

  const fetchedItemIds = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['1', '2']
  `);

  await advanceTime(1_200);
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  const fetchedItemIdsAfterSecondFocus = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIdsAfterSecondFocus).toMatchInlineSnapshot(`
    ['1', '2']
  `);
});

// -- ListQueryStore: onTransportReconnect -------------------------------------

test('list query store: onTransportReconnect while focused invalidates queries and items', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  const hasListFetch = env.serverTable.fetchHistory.some(
    (entry) => entry.type === 'list',
  );
  expect(hasListFetch).toBe(true);

  const fetchedItemIds = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['users||1', 'users||2']
  `);
});

test('list query store: onTransportReconnect while unfocused defers and coalesces', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');

  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  await tabs.blur();

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  // No fetches while unfocused
  expect(env.serverTable.fetchHistory).toHaveLength(0);

  await tabs.focusTab('a');
  await flushAllTimers();

  const hasListFetch = env.serverTable.fetchHistory.some(
    (entry) => entry.type === 'list',
  );
  expect(hasListFetch).toBe(true);

  const fetchedItemIds = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['users||1', 'users||2']
  `);

  await advanceTime(1_200);
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  const fetchedItemIdsAfterSecondFocus = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIdsAfterSecondFocus).toMatchInlineSnapshot(`
    ['users||1', 'users||2']
  `);
});

test('list query store: reconnect trailing flush waits for focus and invalidates once', async () => {
  const tabs = createFocusChangeCoordinator(['a'], 'a');
  const reconnectCooldownMs = 2_000;

  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    transportReconnectCooldownMs: reconnectCooldownMs,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(3);

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await tabs.blur();
  await advanceTime(reconnectCooldownMs);
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(3);

  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(6);
});

test('list query store: focus with dynamic disable function', async () => {
  let enabled = true;
  const tabs = createFocusChangeCoordinator(['a'], null);

  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    revalidateOnWindowFocus: () => enabled,
    bindFocusController: tabs.bind('a'),
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));

  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  enabled = false;
  await tabs.focusTab('a');
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(0);

  enabled = true;
  await tabs.blur();
  await tabs.focusTab('a');
  await flushAllTimers();

  const hasListFetch = env.serverTable.fetchHistory.some(
    (entry) => entry.type === 'list',
  );
  expect(hasListFetch).toBe(true);

  const fetchedItemIds: string[] = [];
  for (const entry of env.serverTable.fetchHistory) {
    if (entry.type === 'fetch') {
      fetchedItemIds.push(entry.itemId);
    }
  }

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['users||1', 'users||2']
  `);
});
