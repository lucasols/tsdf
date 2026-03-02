import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

vi.mock('@ls-stack/browser-utils/window', () => ({
  onWindowFocus: (handler: () => void) => {
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  },
  isWindowFocused: () => !document.hidden,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  Object.defineProperty(document, 'hidden', {
    value: false,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

// -- DocumentStore: revalidateOnWindowFocus ------------------------------------

test('document store: focus triggers lowPriority invalidation for non-realtime store', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    revalidateOnWindowFocus: true,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    .     | 0  | window-focused
    820ms | 0  | 🟠 >fetch-started
    1.62s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

test('document store: focus does nothing when revalidateOnWindowFocus is not set', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

test('document store: focus with dynamic disable function', async () => {
  let enabled = true;

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    revalidateOnWindowFocus: () => enabled,
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  // Disable and focus — should not trigger fetch
  enabled = false;

  const fetchesBeforeDisabled = env.serverMock.numOfStartedFetches;

  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBeforeDisabled);

  // Re-enable and focus — should trigger fetch
  enabled = true;
  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBeGreaterThan(
    fetchesBeforeDisabled,
  );
});

test('document store: realtime store does NOT trigger on focus even when option is set', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    revalidateOnWindowFocus: true,
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

test('document store: reset() cleans up and re-registers focus listener', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    revalidateOnWindowFocus: true,
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  act(() => {
    env.apiStore.reset();
  });

  renderHook(() => env.apiStore.useDocument().data?.value);

  await flushAllTimers();

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBeGreaterThan(fetchesBefore);
});

// -- DocumentStore: background coalescing window -------------------------------

test('document store: a single background tab keeps the base coalescing window', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    baseCoalescingWindowMs: 20,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await flushAllTimers();

  const initialFetches = env.serverMock.numOfStartedFetches;

  env.simulateWindowBlur();

  env.apiStore.invalidateData('highPriority');

  await advanceTime(10);
  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches);

  env.apiStore.invalidateData('highPriority');

  await advanceTime(9);
  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches);

  await advanceTime(2);
  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(initialFetches + 1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    20ms  | 0  | 🔴 >fetch-started
    820ms | 0  | 🔴 <fetch-finished (value: 0)
    .     | 0  | window-blurred
    840ms | 0  | 🟠 >fetch-started
    1.64s | 0  | 🟠 <fetch-finished (value: 0)
    "
  `);
});

// -- DocumentStore: dynamicRealtimeThrottleMs windowIsNotFocused --------------

test('document store: dynamicRealtimeThrottleMs receives correct windowIsNotFocused', async () => {
  const receivedParams: Array<{
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }> = [];

  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs(params) {
      receivedParams.push({ ...params });
      return 300;
    },
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
  env.simulateWindowBlur();
  env.emulateExternalRTU(3);
  await flushAllTimers();

  expect(receivedParams.some((p) => p.windowIsNotFocused === true)).toBe(true);
});

// -- CollectionStore: revalidateOnWindowFocus ----------------------------------

test('collection store: focus triggers lowPriority invalidation for all items', async () => {
  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      revalidateOnWindowFocus: true,
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
    - duration: 800
      itemId: '1'
      result: { name: 'Alice' }
      startedAt: 820
      type: 'fetch'
    - duration: 800
      itemId: '2'
      result: { name: 'Bob' }
      startedAt: 820
      type: 'fetch'
  `);
});

test('collection store: focus with dynamic disable function', async () => {
  let enabled = true;

  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      revalidateOnWindowFocus: () => enabled,
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  enabled = false;
  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(0);

  enabled = true;
  env.simulateWindowFocus();
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
  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    revalidateOnWindowFocus: true,
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));

  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  env.simulateWindowFocus();
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
    startedAt: 820
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
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
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

test('document store: onTransportReconnect while unfocused defers invalidation to next focus', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  env.simulateWindowBlur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  // No fetch while unfocused
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);

  env.simulateWindowFocus();
  await flushAllTimers();

  // Fetch triggered on focus
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);

  await advanceTime(1_200);
  env.simulateWindowBlur();
  env.simulateWindowFocus();
  await flushAllTimers();

  // No extra fetch on later focus events
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

test('document store: multiple onTransportReconnect calls while unfocused are coalesced', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  env.simulateWindowBlur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);

  env.simulateWindowFocus();
  await flushAllTimers();

  // Only one invalidation despite 3 calls
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore + 1);
});

test('document store: onTransportReconnect is no-op when usesRealTimeUpdates is false', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
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

test('document store: reset() cleans up pending onTransportReconnect listener', async () => {
  const env = createDocumentStoreTestEnv(0, {
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => {
    env.trackUIChanges(env.apiStore.useDocument().data?.value);
  });

  await advanceTime(100);

  const fetchesBefore = env.serverMock.numOfStartedFetches;

  env.simulateWindowBlur();

  act(() => {
    env.apiStore.onTransportReconnect();
  });

  act(() => {
    env.apiStore.reset();
  });

  env.simulateWindowFocus();
  await flushAllTimers();

  // No stale fetch after reset
  expect(env.serverMock.numOfStartedFetches).toBe(fetchesBefore);
});

// -- CollectionStore: onTransportReconnect ------------------------------------

test('collection store: onTransportReconnect while focused invalidates all items', async () => {
  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
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

test('collection store: onTransportReconnect while unfocused defers and coalesces', async () => {
  const env = createCollectionStoreTestEnv(
    { '1': { name: 'Alice' }, '2': { name: 'Bob' } },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs: () => 300,
    },
  );

  renderHook(() => env.apiStore.useItem('1'));
  renderHook(() => env.apiStore.useItem('2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  env.simulateWindowBlur();

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  // No fetches while unfocused
  expect(
    env.serverTable.fetchHistory.filter((e) => e.type === 'fetch'),
  ).toHaveLength(0);

  env.simulateWindowFocus();
  await flushAllTimers();

  const fetchedItemIds = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIds).toMatchInlineSnapshot(`
    ['1', '2']
  `);

  await advanceTime(1_200);
  env.simulateWindowBlur();
  env.simulateWindowFocus();
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
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  env.simulateWindowBlur();

  act(() => {
    env.apiStore.onTransportReconnect();
    env.apiStore.onTransportReconnect();
  });

  await flushAllTimers();

  // No fetches while unfocused
  expect(env.serverTable.fetchHistory).toHaveLength(0);

  env.simulateWindowFocus();
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
  env.simulateWindowBlur();
  env.simulateWindowFocus();
  await flushAllTimers();

  const fetchedItemIdsAfterSecondFocus = env.serverTable.fetchHistory
    .filter((e) => e.type === 'fetch')
    .map((e) => e.itemId);

  expect(fetchedItemIdsAfterSecondFocus).toMatchInlineSnapshot(`
    ['users||1', 'users||2']
  `);
});

test('list query store: focus with dynamic disable function', async () => {
  let enabled = true;

  const initialData = {
    users: [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ],
  };

  const env = createListQueryStoreTestEnv(initialData, {
    testScenario: { loaded: { tables: ['users'] } },
    revalidateOnWindowFocus: () => enabled,
  });

  renderHook(() => env.apiStore.useListQuery({ tableId: 'users' }));

  renderHook(() => env.apiStore.useItem('users||1'));
  renderHook(() => env.apiStore.useItem('users||2'));

  await flushAllTimers();

  env.serverTable.fetchHistory.length = 0;

  enabled = false;
  env.simulateWindowFocus();
  await flushAllTimers();

  expect(env.serverTable.fetchHistory).toHaveLength(0);

  enabled = true;
  env.simulateWindowFocus();
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
