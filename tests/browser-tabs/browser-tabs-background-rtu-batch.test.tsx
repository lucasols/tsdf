import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
} from '../mocks/listQueryStoreTestEnv';
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

test('collection background RTU invalidations dedupe to one batch fetch when all tabs are hidden', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-all-background-batch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
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
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxBatchSize: 10,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
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

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'item1',
    { name: 'Updated' },
    { triggerRTUEvent: true },
  );
  envA.serverTable.setItem(
    'item2',
    { name: 'Updated 2' },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  const totalBatchFetches =
    countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list') +
    countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list');

  expect(totalBatchFetches).toBe(1);
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.apiStore.getItemState('item2')?.data).toEqual({
    value: { name: 'Updated 2' },
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2     |
    0     | Item 1  | -         | [item1] ui-initialized
    .     | Item 1  | Item 2    | [item2] ui-changed
    10ms  | Item 1  | Item 2    | 👁 window-focused
    15ms  | Item 1  | Item 2    | 🔕 window-blurred
    20ms  | Item 1  | Item 2    | [item1] server-data-changed (value: {"name":"Updated"})
    .     | Item 1  | Item 2    | [item1] received-ws-data-change-event
    .     | Item 1  | Item 2    | [item2] server-data-changed (value: {"name":"Updated 2"})
    .     | Item 1  | Item 2    | [item2] received-ws-data-change-event
    1.03s | Item 1  | Item 2    | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
    1.83s | Item 1  | Item 2    | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Updated | Updated 2 | [item1, item2] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2     |
    0     | Item 1  | -         | [item1] ui-initialized
    .     | Item 1  | Item 2    | [item2] ui-changed
    .     | Item 1  | Item 2    | 👁 window-focused
    5ms   | Item 1  | Item 2    | 🔕 window-blurred
    20ms  | Item 1  | Item 2    | [item1, item2] received-ws-data-change-event
    1.83s | Item 1  | Item 2    | [item1] <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | Item 2    | [item1] ui-changed
    .     | Updated | Item 2    | [item2] <confirmed-snapshot-received (value: {"name":"Updated 2"})
    .     | Updated | Updated 2 | [item2] ui-changed
    "
  `);
});

test('collection background RTU batch fetch includes the union of invalidated items across tabs with overlapping sets', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-all-background-batch-overlap');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const items = {
    item1: { name: 'Item 1' },
    item2: { name: 'Item 2' },
    item3: { name: 'Item 3' },
  };
  const sharedServerTableState = createSharedServerTableState(items);

  const envA = createCollectionStoreTestEnv(items, {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxBatchSize: 10,
  });
  const envB = createCollectionStoreTestEnv(items, {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxBatchSize: 10,
  });

  // Tab A uses item1 and item2
  renderHook(() => {
    const item1 = envA.apiStore.useItem('item1');
    const item2 = envA.apiStore.useItem('item2');
    envA.trackItemUI('item1', item1.data?.value.name);
    envA.trackItemUI('item2', item2.data?.value.name);
  });
  // Tab B uses item1, item2, and item3 (superset of A)
  renderHook(() => {
    const item1 = envB.apiStore.useItem('item1');
    const item2 = envB.apiStore.useItem('item2');
    const item3 = envB.apiStore.useItem('item3');
    envB.trackItemUI('item1', item1.data?.value.name);
    envB.trackItemUI('item2', item2.data?.value.name);
    envB.trackItemUI('item3', item3.data?.value.name);
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'item1',
    { name: 'Updated 1' },
    { triggerRTUEvent: true },
  );
  envA.serverTable.setItem(
    'item2',
    { name: 'Updated 2' },
    { triggerRTUEvent: true },
  );
  envA.serverTable.setItem(
    'item3',
    { name: 'Updated 3' },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  const totalBatchFetches =
    countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list') +
    countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list');

  expect(totalBatchFetches).toBe(1);

  // Both tabs should receive all updated data
  expect(envA.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated 1' },
  });
  expect(envA.apiStore.getItemState('item2')?.data).toEqual({
    value: { name: 'Updated 2' },
  });
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated 1' },
  });
  expect(envB.apiStore.getItemState('item2')?.data).toEqual({
    value: { name: 'Updated 2' },
  });
  expect(envB.apiStore.getItemState('item3')?.data).toEqual({
    value: { name: 'Updated 3' },
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1     | item2     |
    0     | Item 1    | -         | [item1] ui-initialized
    .     | Item 1    | Item 2    | [item2] ui-changed
    10ms  | Item 1    | Item 2    | 👁 window-focused
    15ms  | Item 1    | Item 2    | 🔕 window-blurred
    20ms  | Item 1    | Item 2    | [item1] server-data-changed (value: {"name":"Updated 1"})
    .     | Item 1    | Item 2    | [item1] received-ws-data-change-event
    .     | Item 1    | Item 2    | [item2] server-data-changed (value: {"name":"Updated 2"})
    .     | Item 1    | Item 2    | [item2] received-ws-data-change-event
    .     | Item 1    | Item 2    | [item3] server-data-changed (value: {"name":"Updated 3"})
    .     | Item 1    | Item 2    | [item3] received-ws-data-change-event
    1.03s | Item 1    | Item 2    | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
    1.83s | Item 1    | Item 2    | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Updated 1 | Updated 2 | [item1, item2] ui-changed
    2.83s | Updated 1 | Updated 2 | [item3] <confirmed-snapshot-received (value: {"name":"Updated 3"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1     | item2     | item3     |
    0     | Item 1    | -         | -         | [item1] ui-initialized
    .     | Item 1    | Item 2    | Item 3    | [item2, item3] ui-changed
    .     | Item 1    | Item 2    | Item 3    | 👁 window-focused
    5ms   | Item 1    | Item 2    | Item 3    | 🔕 window-blurred
    20ms  | Item 1    | Item 2    | Item 3    | [item1, item2, item3] received-ws-data-change-event
    1.83s | Item 1    | Item 2    | Item 3    | [item1] <confirmed-snapshot-received (value: {"name":"Updated 1"})
    .     | Updated 1 | Item 2    | Item 3    | [item1] ui-changed
    .     | Updated 1 | Item 2    | Item 3    | [item2] <confirmed-snapshot-received (value: {"name":"Updated 2"})
    .     | Updated 1 | Updated 2 | Item 3    | [item2] ui-changed
    2.03s | Updated 1 | Updated 2 | Item 3    | 🔴 [item3] >fetch-started
    2.83s | Updated 1 | Updated 2 | Item 3    | 🔴 [item3] <fetch-finished (value: {"name":"Updated 3"})
    .     | Updated 1 | Updated 2 | Updated 3 | [item3] ui-changed
    "
  `);
});

test('collection background RTU invalidations dedupe to one per-item fetch when batching is disabled', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-all-background-item');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
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

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'item1',
    { name: 'Updated' },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  const totalItemFetches =
    countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch') +
    countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch');

  expect(totalItemFetches).toBe(1);
  expect(envA.serverTable.fetchHistory).toHaveLength(1);
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    10ms  | Item 1  | 👁 window-focused
    15ms  | Item 1  | 🔕 window-blurred
    20ms  | Item 1  | server-data-changed (value: {"name":"Updated"})
    .     | Item 1  | received-ws-data-change-event
    1.03s | Item 1  | 🔴 >fetch-started
    1.83s | Item 1  | 🔴 <fetch-finished (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | 👁 window-focused
    5ms   | Item 1  | 🔕 window-blurred
    20ms  | Item 1  | received-ws-data-change-event
    1.83s | Item 1  | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    "
  `);
});

test('list query background item RTU invalidations dedupe to one item batch fetch when batching is enabled', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-all-background-item-batch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState = createSharedUsersTableState();

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxItemBatchSize: 10,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxItemBatchSize: 10,
  });

  renderHook(() => {
    const items = envA.apiStore.useMultipleItems([
      { payload: 'users||1' },
      { payload: 'users||2' },
    ]);
    envA.trackItemUI('users||1', items[0]?.data?.name);
    envA.trackItemUI('users||2', items[1]?.data?.name);
  });
  renderHook(() => {
    const items = envB.apiStore.useMultipleItems([
      { payload: 'users||1' },
      { payload: 'users||2' },
    ]);
    envB.trackItemUI('users||1', items[0]?.data?.name);
    envB.trackItemUI('users||2', items[1]?.data?.name);
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.serverTable.setItem(
    'users||1',
    { id: 1, name: 'Zoe' },
    { triggerRTUEvent: true },
  );
  envA.serverTable.setItem(
    'users||2',
    { id: 2, name: 'Yara' },
    { triggerRTUEvent: true },
  );

  await flushAllTimers();

  const totalBatchFetches =
    countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list') +
    countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list');

  expect(totalBatchFetches).toBe(1);
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Zoe',
  });
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||2')],
  ).toEqual({
    id: 2,
    name: 'Yara',
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | -        | [users||1] ui-initialized
    .     | Alice    | Bob      | [users||2] ui-changed
    10ms  | Alice    | Bob      | 👁 window-focused
    15ms  | Alice    | Bob      | 🔕 window-blurred
    20ms  | Alice    | Bob      | [users||1] server-data-changed (value: {"id":1,"name":"Zoe"})
    .     | Alice    | Bob      | [users||1] received-ws-data-change-event
    .     | Alice    | Bob      | [users||2] server-data-changed (value: {"id":2,"name":"Yara"})
    .     | Alice    | Bob      | [users||2] received-ws-data-change-event
    1.03s | Alice    | Bob      | 🔴 >list-fetch-started (value: {"itemIds":["users||1","users||2"]})
    1.83s | Alice    | Bob      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Zoe      | Yara     | [users||1, users||2] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 | users||2 |
    0     | Alice    | -        | [users||1] ui-initialized
    .     | Alice    | Bob      | [users||2] ui-changed
    .     | Alice    | Bob      | 👁 window-focused
    5ms   | Alice    | Bob      | 🔕 window-blurred
    20ms  | Alice    | Bob      | [users||1, users||2] received-ws-data-change-event
    1.83s | Alice    | Bob      | [users||1] <confirmed-item-snapshot-received (value: {"id":1,"name":"Zoe"})
    .     | Zoe      | Bob      | [users||1] ui-changed
    .     | Zoe      | Bob      | [users||2] <confirmed-item-snapshot-received (value: {"id":2,"name":"Yara"})
    .     | Zoe      | Yara     | [users||2] ui-changed
    "
  `);
});
