import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
} from '../mocks/listQueryStoreTestEnv';
import { createSharedServerMockState } from '../mocks/serverMock';
import { createSharedServerTableState } from '../mocks/serverTableMock';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createCollectionItems,
  createFocusChangeCoordinator,
  createUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

test('document background scheduling: next-ranked tab preempts the primary tab when it has a shorter coalescing window', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-background-fallback');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    baseCoalescingWindowMs: 10,
  });
  const envC = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('c'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
    baseCoalescingWindowMs: 10,
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envC.apiStore.useDocument();
    envC.trackUIChanges(doc.data?.value);
  });

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.emulateExternalRTU(9);

  await flushAllTimers();

  expect(envA.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    20ms  | 0  | 👁 window-focused
    25ms  | 0  | 🔕 window-blurred
    30ms  | 0  | server-data-changed (value: 9)
    .     | 0  | received-ws-data-change-event
    2.84s | 0  | <confirmed-snapshot-received (value: 9)
    .     | 9  | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    10ms  | 0  | 👁 window-focused
    15ms  | 0  | 🔕 window-blurred
    30ms  | 0  | received-ws-data-change-event
    2.04s | 0  | 🔴 >fetch-started
    2.84s | 0  | 🔴 <fetch-finished (value: 9)
    .     | 9  | ui-changed
    "
  `);
  expect(envC.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 👁 window-focused
    5ms   | 0  | 🔕 window-blurred
    30ms  | 0  | received-ws-data-change-event
    2.84s | 0  | <confirmed-snapshot-received (value: 9)
    .     | 9  | ui-changed
    "
  `);
});

test('document background scheduling does not retry on sibling tabs after a remote fetch has started', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-background-no-retry');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envC = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('c'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envC.apiStore.useDocument();
    envC.trackUIChanges(doc.data?.value);
  });

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.setNextFetchDurations(2_500);

  envA.emulateExternalRTU(12);

  await advanceTime(1_200);

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);

  await flushAllTimers();

  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    20ms  | 0  | 👁 window-focused
    25ms  | 0  | 🔕 window-blurred
    30ms  | 0  | server-data-changed (value: 12)
    .     | 0  | received-ws-data-change-event
    1.04s | 0  | 🔴 >fetch-started
    3.54s | 0  | 🔴 <fetch-finished (value: 12)
    .     | 12 | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    10ms  | 0  | 👁 window-focused
    15ms  | 0  | 🔕 window-blurred
    30ms  | 0  | received-ws-data-change-event
    3.54s | 0  | <confirmed-snapshot-received (value: 12)
    .     | 12 | ui-changed
    "
  `);
  expect(envC.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 👁 window-focused
    5ms   | 0  | 🔕 window-blurred
    30ms  | 0  | received-ws-data-change-event
    3.54s | 0  | <confirmed-snapshot-received (value: 12)
    .     | 12 | ui-changed
    "
  `);
});

test('document low-priority refetch-on-mount work is deduplicated when all tabs are backgrounded', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-all-background-refetch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { idleWithLocalCache: 'sameAsServer' },
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { idleWithLocalCache: 'sameAsServer' },
  });

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  renderHook(() => envA.apiStore.useDocument());
  renderHook(() => envB.apiStore.useDocument());

  await flushAllTimers();

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
});

test('document fetch timing sync suppresses redundant low-priority work after a sibling fetch settles', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-timing-sync');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(true);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });

  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  expect(envB.scheduleFetch('lowPriority')).toBe('skipped');
  expect(envB.serverMock.fetchHistory).toHaveLength(0);
});

test('collection background scheduling falls back to the next-ranked tab when the primary tab never starts', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-background-fallback-item');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (
    getWindowIsFocused: () => boolean,
    baseCoalescingWindowMs: number,
  ) =>
    createCollectionStoreTestEnv(createCollectionItems(), {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      baseCoalescingWindowMs,
    });

  const envA = createEnv(focusA.get, 1_500);
  const envB = createEnv(focusB.get, 10);
  const envC = createEnv(focusC.get, 10);

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));
  renderHook(() => envC.apiStore.useItem('item1'));

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });
  envC.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  envB.apiStore.invalidateItem('item1', 'realtimeUpdate');
  envC.apiStore.invalidateItem('item1', 'realtimeUpdate');

  await flushAllTimers();

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
  expect(countFetchHistoryEntries(envC.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
});

test('collection background scheduling does not retry on sibling tabs after a remote fetch has started', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-background-no-retry');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (getWindowIsFocused: () => boolean) =>
    createCollectionStoreTestEnv(createCollectionItems(), {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    });

  const envA = createEnv(focusA.get);
  const envB = createEnv(focusB.get);
  const envC = createEnv(focusC.get);

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));
  renderHook(() => envC.apiStore.useItem('item1'));

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.serverTable.setFetchDurations('item1', 2_500);
  envB.serverTable.setFetchDurations('item1', 25);
  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });
  envC.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  envB.apiStore.invalidateItem('item1', 'realtimeUpdate');
  envC.apiStore.invalidateItem('item1', 'realtimeUpdate');

  await advanceTime(1_200);

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await flushAllTimers();

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envC.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);
});

test('collection low-priority refetch-on-mount work is deduplicated when all tabs are backgrounded', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-refetch-on-mount');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { idleWithLocalCache: 'sameAsServer' },
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { idleWithLocalCache: 'sameAsServer' },
  });

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));

  await flushAllTimers();

  const totalFetches =
    countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch') +
    countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch');
  expect(totalFetches).toBe(1);
});

test('collection fetch timing sync suppresses redundant low-priority work after a sibling fetch settles', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-batch');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(true);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxBatchSize: 10,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxBatchSize: 10,
  });

  envA.scheduleFetch('highPriority', 'item1');
  envA.scheduleFetch('highPriority', 'item2');

  await flushAllTimers();

  expect(envB.scheduleFetch('lowPriority', 'item1')).toBe('skipped');
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('list query background scheduling falls back to the next-ranked tab when the primary tab never starts', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-background-fallback');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (
    getWindowIsFocused: () => boolean,
    baseCoalescingWindowMs: number,
  ) =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      testScenario: { loaded: { tables: ['users'] } },
      usesRealTimeUpdates: true,
      baseCoalescingWindowMs,
    });

  const envA = createEnv(focusA.get, 1_500);
  const envB = createEnv(focusB.get, 10);
  const envC = createEnv(focusC.get, 10);

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envC.apiStore.useListQuery({ tableId: 'users' }));

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envC.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });

  envA.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });
  envB.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });
  envC.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });

  await flushAllTimers();

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(countFetchHistoryEntries(envC.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
});

test('list query background scheduling does not retry on sibling tabs after a remote fetch has started', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-background-no-retry');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (getWindowIsFocused: () => boolean) =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      testScenario: { loaded: { tables: ['users'] } },
      usesRealTimeUpdates: true,
    });

  const envA = createEnv(focusA.get);
  const envB = createEnv(focusB.get);
  const envC = createEnv(focusC.get);

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envC.apiStore.useListQuery({ tableId: 'users' }));

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.serverTable.addListFetchStartDelay(2_500);
  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envC.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });

  envA.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });
  envB.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });
  envC.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });

  await advanceTime(1_200);

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envC.serverTable.fetchHistory, 'list')).toBe(
    0,
  );

  await flushAllTimers();

  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Zoe',
  });
  expect(
    envC.store.state.items[envC.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Zoe',
  });
  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envC.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
});

test('list query low-priority refetch-on-mount work is deduplicated when all tabs are backgrounded', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-refetch-on-mount');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { idleWithLocalCache: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { idleWithLocalCache: { tables: ['users'] } },
  });

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));

  await flushAllTimers();

  const totalFetches =
    countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list') +
    countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list');
  expect(totalFetches).toBe(1);
});

test('list query fetch timing sync suppresses redundant low-priority work after a sibling fetch settles', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-timing-sync');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(true);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  expect(envB.scheduleFetch('lowPriority', { tableId: 'users' })).toBe(
    'skipped',
  );
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('list query first item fetch stays local after a sibling batch item fetch for the same batch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-item-batch-first-fetch');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(true);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxItemBatchSize: 10,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { items: ['users||1'] } },
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxItemBatchSize: 10,
  });

  envA.apiStore.scheduleItemFetch('highPriority', ['users||1', 'users||2']);
  await flushAllTimers();

  const untouchedItemKey = envB.getStoreItemKeyFromRaw('users||2');
  expect(envB.store.state.itemQueries[untouchedItemKey]).toBeUndefined();
  expect(envB.store.state.items[untouchedItemKey]).toBeUndefined();
  expect(envB.serverTable.fetchHistory).toHaveLength(0);

  renderHook(() => envB.apiStore.useItem('users||2'));
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
  expect(envB.store.state.itemQueries[untouchedItemKey]).toMatchObject({
    status: 'success',
    refetchOnMount: false,
  });
  expect(envB.store.state.items[untouchedItemKey]).toEqual({
    id: 2,
    name: 'Bob',
  });
});
