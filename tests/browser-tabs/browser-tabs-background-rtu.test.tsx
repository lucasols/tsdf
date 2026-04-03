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
import { flushAllTimers } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createCollectionItems,
  createFocusChangeCoordinator,
  createUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

function createSharedUsersTableState() {
  return createSharedListQueryServerTableState(createUsersTable());
}

test('document RTU fetch in the active tab updates the background tab without a background refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-rtu');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
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

  renderHook(() =>
    envA.trackUIChanges(envA.apiStore.useDocument().data?.value),
  );
  renderHook(() =>
    envB.trackUIChanges(envB.apiStore.useDocument().data?.value),
  );

  envA.emulateExternalRTU(2);
  await flushAllTimers();

  expect(envA.store.state.data?.value).toBe(2);
  expect(envB.store.state.data?.value).toBe(2);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);

  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | server-data-changed (value: 2)
    .     | 0  | received-ws-data-change-event
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 2)
    .     | 2  | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | received-ws-data-change-event
    810ms | 0  | <confirmed-snapshot-received (value: 2)
    .     | 2  | ui-changed
    "
  `);
});

test('document RTU failures stay local to the fetching tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-rtu-error');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
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

  renderHook(() =>
    envA.trackUIChanges(envA.apiStore.useDocument().data?.value),
  );
  renderHook(() =>
    envB.trackUIChanges(envB.apiStore.useDocument().data?.value),
  );

  envA.errorInNextFetch();
  envA.emulateExternalRTU(3);
  await flushAllTimers();

  expect(envB.store.state.data?.value).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time | ui |
    0    | 0  | ui-initialized
    .    | 0  | server-data-changed (value: 3)
    .    | 0  | received-ws-data-change-event
    10ms | 0  | 🔴 >fetch-started
    .    | 0  | 🔴 <fetch-error (value: "error")
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | ui |
    0    | 0  | ui-initialized
    .    | 0  | received-ws-data-change-event
    "
  `);
});

test('document RTU does not sync across tabs using different store ids', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');

  const envA = createDocumentStoreTestEnv(0, {
    id: getNextStoreId('document-rtu-a'),
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(100, {
    id: getNextStoreId('document-rtu-b'),
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() =>
    envA.trackUIChanges(envA.apiStore.useDocument().data?.value),
  );
  renderHook(() =>
    envB.trackUIChanges(envB.apiStore.useDocument().data?.value),
  );

  envA.emulateExternalRTU(2);
  await flushAllTimers();

  expect(envA.store.state.data?.value).toBe(2);
  expect(envB.store.state.data?.value).toBe(100);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | server-data-changed (value: 2)
    .     | 0  | received-ws-data-change-event
    10ms  | 0  | 🔴 >fetch-started
    810ms | 0  | 🔴 <fetch-finished (value: 2)
    .     | 2  | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | ui  |
    0    | 100 | ui-initialized
    "
  `);
});

test('document RTU does not sync across tabs using different session keys', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-rtu-shared-store');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');

  const envA = createDocumentStoreTestEnv(0, {
    id,
    getSessionKey: () => 'account-a',
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(100, {
    id,
    getSessionKey: () => 'account-b',
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() =>
    envA.trackUIChanges(envA.apiStore.useDocument().data?.value),
  );
  renderHook(() =>
    envB.trackUIChanges(envB.apiStore.useDocument().data?.value),
  );

  envA.emulateExternalRTU(2);
  await flushAllTimers();

  expect(envA.store.state.data?.value).toBe(2);
  expect(envB.store.state.data?.value).toBe(100);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
});

test('document RTU invalidations are deduplicated when all tabs are backgrounded and the last active tab leads', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-all-background');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
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

  renderHook(() =>
    envA.trackUIChanges(envA.apiStore.useDocument().data?.value),
  );
  renderHook(() =>
    envB.trackUIChanges(envB.apiStore.useDocument().data?.value),
  );

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.emulateExternalRTU(5);
  await flushAllTimers();

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.store.state.data?.value).toBe(5);
  expect(envB.store.state.data?.value).toBe(5);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    10ms  | 0  | 👁 window-focused
    15ms  | 0  | 🔕 window-blurred
    20ms  | 0  | server-data-changed (value: 5)
    .     | 0  | received-ws-data-change-event
    1.03s | 0  | 🔴 >fetch-started
    1.83s | 0  | 🔴 <fetch-finished (value: 5)
    .     | 5  | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | 👁 window-focused
    5ms   | 0  | 🔕 window-blurred
    20ms  | 0  | received-ws-data-change-event
    1.83s | 0  | <confirmed-snapshot-received (value: 5)
    .     | 5  | ui-changed
    "
  `);
});

test('collection RTU fetch in the active tab updates the background tab without a background refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-rtu');
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
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  envA.serverTable.setItem(
    'item1',
    { name: 'Updated' },
    { triggerRTUEvent: true },
  );
  await flushAllTimers();

  expect(envA.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Updated' }`,
  );
  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Updated' }`,
  );
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | server-data-changed (value: {"name":"Updated"})
    .     | Item 1  | received-ws-data-change-event
    10ms  | Item 1  | 🔴 >fetch-started
    810ms | Item 1  | 🔴 <fetch-finished (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | received-ws-data-change-event
    810ms | Item 1  | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
});

test('collection RTU failures stay local to the fetching tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-rtu-error');
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
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  envA.serverTable.setNextFetchError('item1', 'Fetch error');
  envA.serverTable.setItem(
    'item1',
    { name: 'Updated' },
    { triggerRTUEvent: true },
  );
  await flushAllTimers();

  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 1' }`,
  );
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time | item1  |
    0    | Item 1 | ui-initialized
    .    | Item 1 | server-data-changed (value: {"name":"Updated"})
    .    | Item 1 | received-ws-data-change-event
    10ms | Item 1 | 🔴 >fetch-started
    .    | Item 1 | 🔴 <fetch-error (value: "error")
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | item1  |
    0    | Item 1 | ui-initialized
    .    | Item 1 | received-ws-data-change-event
    "
  `);
});

test('collection RTU does not sync across tabs using different store ids', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id: getNextStoreId('collection-rtu-a'),
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id: getNextStoreId('collection-rtu-b'),
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  await flushAllTimers();

  expect(envA.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Updated' }`,
  );
  expect(envB.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 1' }`,
  );
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | server-data-changed (value: {"name":"Updated"})
    10ms  | Item 1  | 🔴 >fetch-started
    810ms | Item 1  | 🔴 <fetch-finished (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | item1  |
    0    | Item 1 | ui-initialized
    .    | Item 1 | server-data-changed (value: {"name":"Updated"})
    "
  `);
});

test('collection RTU only triggers fetch in the tab that loaded the invalidated item', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-different-items');
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
    usesRealTimeUpdates: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  // Tab A only uses item1
  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  // Tab B only uses item2
  renderHook(() => {
    const item = envB.apiStore.useItem('item2');
    envB.trackItemUI('item2', item.data?.value.name);
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');

  // RTU event updates item1 — only tab A should fetch
  envA.serverTable.setItem(
    'item1',
    { name: 'Updated 1' },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  expect(envA.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Updated 1' }`,
  );
  // Tab B did not load item1, so it should remain unchanged
  expect(envB.apiStore.getItemState('item2')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 2' }`,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1     |
    0     | Item 1    | ui-initialized
    .     | Item 1    | 🔕 window-blurred
    15ms  | Item 1    | 👁 window-focused
    20ms  | Item 1    | server-data-changed (value: {"name":"Updated 1"})
    .     | Item 1    | received-ws-data-change-event
    30ms  | Item 1    | 🔴 >fetch-started
    830ms | Item 1    | 🔴 <fetch-finished (value: {"name":"Updated 1"})
    .     | Updated 1 | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item2  |
    0     | Item 2 | [item2] ui-initialized
    5ms   | Item 2 | 👁 window-focused
    10ms  | Item 2 | 🔕 window-blurred
    20ms  | Item 2 | [item1] received-ws-data-change-event
    830ms | Item 2 | [item1] <confirmed-snapshot-received (value: {"name":"Updated 1"})
    "
  `);
});

test('collection RTU only triggers fetch in both tabs for different loaded items and generic events', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-different-items');
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
    usesRealTimeUpdates: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  // Tab A only uses item1
  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  // Tab B only uses item2
  renderHook(() => {
    const item = envB.apiStore.useItem('item2');
    envB.trackItemUI('item2', item.data?.value.name);
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');

  // RTU event updates item1 — only tab A should fetch
  envA.serverTable.setItem(
    'item1',
    { name: 'Updated 1' },
    { triggerRTUEvent: 'for_all_items' },
  );

  await flushAllTimers();

  expect(envA.apiStore.getItemState('item1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Updated 1' }`,
  );
  // Tab B did not load item1, so it should remain unchanged
  expect(envB.apiStore.getItemState('item2')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 2' }`,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1     |
    0     | Item 1    | [item1] ui-initialized
    .     | Item 1    | 🔕 window-blurred
    15ms  | Item 1    | 👁 window-focused
    20ms  | Item 1    | [item1] server-data-changed (value: {"name":"Updated 1"})
    .     | Item 1    | received-ws-data-change-event
    30ms  | Item 1    | 🔴 [item1] >fetch-started
    830ms | Item 1    | 🔴 [item1] <fetch-finished (value: {"name":"Updated 1"})
    .     | Updated 1 | [item1] ui-changed
    1.83s | Updated 1 | [item2] <confirmed-snapshot-received (value: {"name":"Item 2"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item2  |
    0     | Item 2 | [item2] ui-initialized
    5ms   | Item 2 | 👁 window-focused
    10ms  | Item 2 | 🔕 window-blurred
    20ms  | Item 2 | received-ws-data-change-event
    830ms | Item 2 | [item1] <confirmed-snapshot-received (value: {"name":"Updated 1"})
    1.03s | Item 2 | 🔴 [item2] >fetch-started
    1.83s | Item 2 | 🔴 [item2] <fetch-finished (value: {"name":"Item 2"})
    "
  `);
});

test('list query RTU fetch in the active tab updates the background tab without a background refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-rtu');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedUsersTableState();

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envA.trackItemUI(`users||${item.id}`, item.name);
    }
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envB.trackItemUI(`users||${item.id}`, item.name);
    }
  });

  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );
  await flushAllTimers();

  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Zoe'
    `);
  expect(
    envB.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    .     | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | Bob      | [users||1] received-ws-data-change-event
    10ms  | Alice    | Bob      | 🔴 >list-fetch-started
    810ms | Alice    | Bob      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | Bob      | [users||1] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    .     | Alice    | Bob      | [users||1] received-ws-data-change-event
    810ms | Alice    | Bob      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Zoe      | Bob      | [users||1] ui-changed
    "
  `);
});

test('list query RTU failures stay local to the fetching tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-rtu-error');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedUsersTableState();

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envA.trackItemUI(`users||${item.id}`, item.name);
    }
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envB.trackItemUI(`users||${item.id}`, item.name);
    }
  });

  envA.serverTable.setNextListFetchError('Fetch error');
  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );
  await flushAllTimers();

  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    .     | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | Bob      | [users||1] received-ws-data-change-event
    10ms  | Alice    | Bob      | 🔴 >list-fetch-started
    810ms | Alice    | Bob      | 🔴 <list-fetch-error (value: "error")
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | users||1 | users||2 |
    0    | Alice    | Bob      | [users||1, users||2] ui-initialized
    .    | Alice    | Bob      | [users||1] received-ws-data-change-event
    "
  `);
});

test('list query realtime invalidations stay isolated across different store ids when every tab is backgrounded', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id: getNextStoreId('list-query-background-a'),
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id: getNextStoreId('list-query-background-b'),
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envA.trackItemUI(`users||${item.id}`, item.name);
    }
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envB.trackItemUI(`users||${item.id}`, item.name);
    }
  });

  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });

  envA.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });

  await flushAllTimers();

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    .     | Alice    | Bob      | 👁 window-focused
    5ms   | Alice    | Bob      | 🔕 window-blurred
    10ms  | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    1.02s | Alice    | Bob      | 🔴 >list-fetch-started
    1.82s | Alice    | Bob      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | Bob      | [users||1] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | users||1 | users||2 |
    0    | Alice    | Bob      | [users||1, users||2] ui-initialized
    10ms | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    "
  `);
});

test('list query background RTU invalidations dedupe to one query fetch when all tabs are hidden', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-all-background');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState = createSharedUsersTableState();

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envA.trackItemUI(`users||${item.id}`, item.name);
    }
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envB.trackItemUI(`users||${item.id}`, item.name);
    }
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  expect(
    envA.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(1);
  expect(
    envB.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(0);
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Zoe'
    `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    10ms  | Alice    | Bob      | 👁 window-focused
    15ms  | Alice    | Bob      | 🔕 window-blurred
    20ms  | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | Bob      | [users||1] received-ws-data-change-event
    1.03s | Alice    | Bob      | 🔴 >list-fetch-started
    1.83s | Alice    | Bob      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | Bob      | [users||1] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    .     | Alice    | Bob      | 👁 window-focused
    5ms   | Alice    | Bob      | 🔕 window-blurred
    20ms  | Alice    | Bob      | [users||1] received-ws-data-change-event
    1.83s | Alice    | Bob      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Zoe      | Bob      | [users||1] ui-changed
    "
  `);
});

test('list query RTU fetch in the active tab updates the background tab that uses different query filters', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-rtu-filters');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedUsersTableState();

  const filters = [{ op: 'eq' as const, field: 'id', value: 1 }];

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { queries: [{ tableId: 'users', filters }] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    for (const item of query.items) {
      envA.trackItemUI(`users||${item.id}`, item.name);
    }
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users', filters });
    for (const item of query.items) {
      envB.trackItemUI(`users||${item.id}`, item.name);
    }
  });

  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );
  await flushAllTimers();

  expect(
    envA.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(1);
  expect(
    envB.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(1);
  expect(envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')])
    .toMatchInlineSnapshot(`
      id: 1
      name: 'Zoe'
    `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | Bob      | [users||1, users||2] ui-initialized
    .     | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | Bob      | [users||1] received-ws-data-change-event
    10ms  | Alice    | Bob      | 🔴 >list-fetch-started
    810ms | Alice    | Bob      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | Bob      | [users||1] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    .     | Alice    | received-ws-data-change-event
    1.01s | Alice    | 🔴 >list-fetch-started
    1.81s | Alice    | 🔴 <list-fetch-finished (value: {"count":1})
    .     | Zoe      | ui-changed
    "
  `);
});
