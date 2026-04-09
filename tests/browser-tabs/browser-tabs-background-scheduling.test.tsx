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
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
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

test('document fetch timing sync suppresses redundant low-priority work after a sibling fetch settles', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-timing-sync');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  await advanceTime(100);

  expect(envB.scheduleFetch('lowPriority')).toBe('skipped');
  expect(envB.serverMock.fetchHistory).toHaveLength(0);

  await flushAllTimers();

  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | scheduled-fetch-coalesced
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 0)
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    810ms | 0  | <confirmed-snapshot-received (value: 0)
    910ms | 0  | scheduled-fetch-skipped
    "
  `);
});

test('collection background scheduling falls back to the next-ranked tab when the primary tab never starts', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-background-fallback-item');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const createEnv = (tab: 'a' | 'b' | 'c', baseCoalescingWindowMs: number) =>
    createCollectionStoreTestEnv(createCollectionItems(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      baseCoalescingWindowMs,
    });

  const envA = createEnv('a', 1_500);
  const envB = createEnv('b', 10);
  const envC = createEnv('c', 10);

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envC.apiStore.useItem('item1');
    envC.trackItemUI('item1', item.data?.value.name);
  });

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'item1',
    { name: 'Updated' },
    { triggerRTUEvent: true },
  );

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
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    20ms  | Item 1  | 👁 window-focused
    25ms  | Item 1  | 🔕 window-blurred
    30ms  | Item 1  | server-data-changed (value: {"name":"Updated"})
    .     | Item 1  | received-ws-data-change-event
    2.84s | Item 1  | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    10ms  | Item 1  | 👁 window-focused
    15ms  | Item 1  | 🔕 window-blurred
    30ms  | Item 1  | received-ws-data-change-event
    2.04s | Item 1  | 🔴 >fetch-started
    2.84s | Item 1  | 🔴 <fetch-finished (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envC.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | 👁 window-focused
    5ms   | Item 1  | 🔕 window-blurred
    30ms  | Item 1  | received-ws-data-change-event
    2.84s | Item 1  | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
});

test('collection background scheduling does not retry on sibling tabs after a remote fetch has started', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-background-no-retry');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const createEnv = (tab: 'a' | 'b' | 'c') =>
    createCollectionStoreTestEnv(createCollectionItems(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    });

  const envA = createEnv('a');
  const envB = createEnv('b');
  const envC = createEnv('c');

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envC.apiStore.useItem('item1');
    envC.trackItemUI('item1', item.data?.value.name);
  });

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setFetchDurations('item1', 2_500);

  envA.serverTable.setItem(
    'item1',
    { name: 'Updated' },
    { triggerRTUEvent: true },
  );

  await advanceTime(1_200);

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await flushAllTimers();

  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    20ms  | Item 1  | 👁 window-focused
    25ms  | Item 1  | 🔕 window-blurred
    30ms  | Item 1  | server-data-changed (value: {"name":"Updated"})
    .     | Item 1  | received-ws-data-change-event
    1.04s | Item 1  | 🔴 >fetch-started
    3.54s | Item 1  | 🔴 <fetch-finished (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    10ms  | Item 1  | 👁 window-focused
    15ms  | Item 1  | 🔕 window-blurred
    30ms  | Item 1  | received-ws-data-change-event
    3.54s | Item 1  | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envC.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | 👁 window-focused
    5ms   | Item 1  | 🔕 window-blurred
    30ms  | Item 1  | received-ws-data-change-event
    3.54s | Item 1  | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
});

test('collection fetch timing sync suppresses redundant low-priority work after a sibling fetch settles', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-batch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxBatchSize: 10,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxBatchSize: 10,
  });

  renderHook(() => {
    const item1 = envA.apiStore.useItem('item1');
    const item2 = envA.apiStore.useItem('item2');
    envA.trackItemUI('item1', item1.data?.value.name);
    envA.trackItemUI('item2', item2.data?.value.name);
  });
  renderHook(() => {
    const item1 = envB.apiStore.useItem('item1');
    const item2 = envB.apiStore.useItem('item2');
    envB.trackItemUI('item1', item1.data?.value.name);
    envB.trackItemUI('item2', item2.data?.value.name);
  });

  envA.scheduleFetch('highPriority', 'item1');
  envA.scheduleFetch('highPriority', 'item2');

  await flushAllTimers();

  expect(envB.scheduleFetch('lowPriority', 'item1')).toBe('skipped');
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1  | item2  |
    0     | Item 1 | Item 2 | [item1, item2] ui-initialized
    .     | Item 1 | Item 2 | [item1] scheduled-fetch-coalesced
    10ms  | Item 1 | Item 2 | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
    810ms | Item 1 | Item 2 | 🔴 <list-fetch-finished (value: {"count":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1  | item2  |
    0     | Item 1 | Item 2 | [item1, item2] ui-initialized
    810ms | Item 1 | Item 2 | [item1] <confirmed-snapshot-received (value: {"name":"Item 1"})
    .     | Item 1 | Item 2 | [item2] <confirmed-snapshot-received (value: {"name":"Item 2"})
    .     | Item 1 | Item 2 | [item1] scheduled-fetch-skipped
    "
  `);
});

test('list query background scheduling falls back to the next-ranked tab when the primary tab never starts', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-background-fallback');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const createEnv = (tab: 'a' | 'b' | 'c', baseCoalescingWindowMs: number) =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
      testScenario: { loaded: { tables: ['users'] } },
      usesRealTimeUpdates: true,
      baseCoalescingWindowMs,
    });

  const envA = createEnv('a', 1_500);
  const envB = createEnv('b', 10);
  const envC = createEnv('c', 10);

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    envA.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envC.apiStore.useListQuery({ tableId: 'users' });
    envC.trackItemUI('users||1', query.items[0]?.name);
  });

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );

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
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    20ms  | Alice    | 👁 window-focused
    25ms  | Alice    | 🔕 window-blurred
    30ms  | Alice    | server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | received-ws-data-change-event
    2.84s | Alice    | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Zoe      | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    10ms  | Alice    | 👁 window-focused
    15ms  | Alice    | 🔕 window-blurred
    30ms  | Alice    | received-ws-data-change-event
    2.04s | Alice    | 🔴 >list-fetch-started
    2.84s | Alice    | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | ui-changed
    "
  `);
  expect(envC.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    .     | Alice    | 👁 window-focused
    5ms   | Alice    | 🔕 window-blurred
    30ms  | Alice    | received-ws-data-change-event
    2.84s | Alice    | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Zoe      | ui-changed
    "
  `);
});

test('list query background scheduling does not retry on sibling tabs after a remote fetch has started', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-background-no-retry');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const createEnv = (tab: 'a' | 'b' | 'c') =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
      testScenario: { loaded: { tables: ['users'] } },
      usesRealTimeUpdates: true,
    });

  const envA = createEnv('a');
  const envB = createEnv('b');
  const envC = createEnv('c');

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    envA.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envC.apiStore.useListQuery({ tableId: 'users' });
    envC.trackItemUI('users||1', query.items[0]?.name);
  });

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.addListFetchStartDelay(2_500);

  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );

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

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envC.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    20ms  | Alice    | 👁 window-focused
    25ms  | Alice    | 🔕 window-blurred
    30ms  | Alice    | server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | received-ws-data-change-event
    1.04s | Alice    | 🔴 >list-fetch-started
    4.34s | Alice    | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    10ms  | Alice    | 👁 window-focused
    15ms  | Alice    | 🔕 window-blurred
    30ms  | Alice    | received-ws-data-change-event
    4.34s | Alice    | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Zoe      | ui-changed
    "
  `);
  expect(envC.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    .     | Alice    | 👁 window-focused
    5ms   | Alice    | 🔕 window-blurred
    30ms  | Alice    | received-ws-data-change-event
    4.34s | Alice    | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Zoe      | ui-changed
    "
  `);
});

test('list query fetch timing sync suppresses redundant low-priority work after a sibling fetch settles', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-timing-sync');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    envA.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  await advanceTime(100);

  expect(envB.scheduleFetch('lowPriority', { tableId: 'users' })).toBe(
    'skipped',
  );
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    .     | Alice    | scheduled-fetch-coalesced
    10ms  | Alice    | 🔴 >list-fetch-started
    810ms | Alice    | 🔴 <list-fetch-finished (value: {"count":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    810ms | Alice    | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    910ms | Alice    | scheduled-fetch-skipped
    "
  `);
});

test('list query first item fetch stays local after a sibling batch item fetch for the same batch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-item-batch-first-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    lowPriorityThrottleMs: 10_000,
    maxItemBatchSize: 10,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
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

  renderHook(() => {
    const item = envB.apiStore.useItem('users||2');
    envB.trackItemUI('users||2', item.data?.name);
  });
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
  expect(
    pick(envB.store.state.itemQueries[untouchedItemKey], [
      'status',
      'refetchOnMount',
    ]),
  ).toMatchInlineSnapshot(`
    refetchOnMount: '❌'
    status: 'success'
  `);
  expect(envB.store.state.items[untouchedItemKey]).toMatchInlineSnapshot(`
    id: 2
    name: 'Bob'
  `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    1.01s | 🔴 >list-fetch-started (value: {"itemIds":["users||1","users||2"]})
    1.81s | 🔴 <list-fetch-finished (value: {"count":2})
    3.62s | <confirmed-item-snapshot-received (value: {"id":2,"name":"Bob"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||2 |
    1.81s | -        | [users||1] <confirmed-item-snapshot-received (value: {"id":1,"name":"Alice"})
    .     | ···      | [users||2] ui-initialized
    2.82s | ···      | 🔴 [users||2] >fetch-started
    3.62s | ···      | 🔴 [users||2] <fetch-finished (value: {"id":2,"name":"Bob"})
    .     | Bob      | [users||2] ui-changed
    "
  `);
});
