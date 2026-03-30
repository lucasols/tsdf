import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  createInMemoryBrowserTabsTransportFactory,
  createInspectableInMemoryBrowserTabsTransportFactory,
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
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createCollectionItems,
  createFocusChangeCoordinator,
  createOptimisticSortConfig,
  createUsersTable,
  getMessageKinds,
  getNonStatusMessages,
  getPublisherTabIds,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
});

test('collection snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-audit');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });

  void envA.performClientUpdateAction(
    'item1',
    { name: 'Updated' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await flushAllTimers();

  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).not.toContain('stale-marker');
});

test('collection resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-reset');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.reset();
  await advanceTime(0);

  expect(envA.store.state).toEqual({});
  expect(envA.apiStore.getItemState('item1')).toBeUndefined();
  expect(envB.apiStore.getItemState('item1')).toMatchObject({
    data: { value: { name: 'Item 1' } },
    status: 'success',
    refetchOnMount: false,
  });
});

test('a fresh collection tab reuses the sibling snapshot without a first local fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-snapshot-before-first-subscribe');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
    useBatchFetch: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
    useBatchFetch: true,
  });

  envA.serverTable.setItem('item1', { name: 'Updated' });

  envA.scheduleFetch('highPriority', 'item1');
  await flushAllTimers();

  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(envB.apiStore.getItemState('item1')).toMatchObject({
    data: { value: { name: 'Updated' } },
    status: 'success',
  });
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    810ms | -       | <confirmed-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-initialized
    "
  `);
});

test('confirmed collection snapshots do not overwrite a local in-flight mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-conflict');
  const sharedServerTableState = createSharedServerTableState({
    item1: { name: 'Initial' },
  });

  const envA = createCollectionStoreTestEnv(
    { item1: { name: 'Initial' } },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );
  const envB = createCollectionStoreTestEnv(
    { item1: { name: 'Initial' } },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );

  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  void envB.performClientUpdateAction(
    'item1',
    { name: 'Local' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );
  await advanceTime(0);
  await advanceTime(1);

  envA.apiStore.updateItemState('item1', (draft) => {
    draft.value = { name: 'Remote' };
  });
  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')).toMatchObject({
    data: { value: { name: 'Local' } },
    refetchOnMount: false,
  });

  await flushAllTimers();

  expect(envB.apiStore.getItemState('item1')).toMatchObject({
    data: { value: { name: 'Local' } },
    refetchOnMount: false,
  });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1            |
    0     | Initial          | ui-initialized
    .     | {"name":"Local"} | ⬜ optimistic-ui-commit
    .     | {"name":"Local"} | ⬜ >mutation-started (value: {"name":"Local"})
    .     | Local            | ui-changed
    700ms | Local            | ⬜ <mutation-data-persisted (value: {"name":"Local"})
    "
  `);
});

test('document snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-audit');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });

  void envA.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  await flushAllTimers();

  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages).toHaveLength(1);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).not.toContain('stale-marker');
});

test('document resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-reset');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });

  envA.apiStore.reset();
  await advanceTime(0);

  expect(envA.store.state).toMatchObject({
    data: null,
    status: 'idle',
    refetchOnMount: 'lowPriority',
  });
  expect(envB.store.state).toMatchObject({
    data: { value: 0 },
    status: 'success',
    refetchOnMount: false,
  });
});

test('a fresh document tab still performs its first fetch after a sibling tab fetched earlier', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-first-fetch-after-sibling');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
  });

  envA.setServerData(7);

  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });
  await flushAllTimers();

  expect(envB.serverMock.fetchHistory).toHaveLength(1);
  expect(envB.store.state).toMatchObject({
    data: { value: 7 },
    status: 'success',
  });
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    810ms | -  | <confirmed-snapshot-received (value: 7)
    820ms | -  | 🔴 >fetch-started
    1.62s | -  | 🔴 <fetch-finished (value: 7)
    .     | 7  | ui-initialized
    "
  `);
});

test('confirmed document snapshots do not overwrite a local in-flight mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-conflict');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
  });

  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  void envB.performClientUpdateAction(10, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });
  await advanceTime(0);
  await advanceTime(1);

  envA.setServerData(20);
  envA.setNextFetchDurations(100);
  envA.scheduleFetch('highPriority');
  await advanceTime(200);

  expect(envB.store.state.data?.value).toBe(10);

  await flushAllTimers();

  expect(envB.store.state.data?.value).toBe(10);
  expect(envB.serverMock.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | <optimistic-snapshot-received (value: 10)
    1ms   | server-data-changed (value: 20)
    .     | scheduled-fetch-triggered
    11ms  | 🔴 >fetch-started
    111ms | 🔴 <fetch-finished (value: 20)
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 10 | ⬜ optimistic-ui-commit
    .     | 10 | ⬜ >mutation-started (value: 10)
    700ms | 10 | ⬜ <mutation-data-persisted (value: 10)
    "
  `);
});

test('list query snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-audit');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const createEnv = () =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transport.transportFactory,
      testScenario: { loaded: { tables: ['users'] } },
      optimisticListUpdates: createOptimisticSortConfig(),
    });

  const envA = createEnv();
  createEnv();
  createEnv();

  void envA.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await flushAllTimers();

  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).toEqual(
    expect.arrayContaining(['list-item-snapshot', 'list-query-snapshot']),
  );
  expect(getMessageKinds(messages)).not.toContain('stale-marker');
});

test('list query resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-reset');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });

  envA.apiStore.reset();
  await advanceTime(0);

  expect(envA.store.state).toEqual({
    items: {},
    queries: {},
    itemQueries: {},
    itemLoadedFields: {},
    itemFieldInvalidationFields: {},
  });

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||1'),
    envB.getStoreItemKeyFromRaw('users||2'),
  ]);
});

test('a fresh list-query tab still performs its first fetch after a sibling tab fetched earlier', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-first-fetch-after-sibling');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
  });

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });
  await flushAllTimers();

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||1'),
    envB.getStoreItemKeyFromRaw('users||2'),
  ]);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    10ms  | 🔴 >list-fetch-started
    810ms | 🔴 <list-fetch-finished (value: {"count":2})
    1.62s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    810ms | ···      | ui-initialized
    820ms | ···      | 🔴 >list-fetch-started
    1.62s | ···      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Alice    | ui-changed
    "
  `);
});

test('confirmed list query snapshots do not overwrite a local in-flight mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-conflict');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });

  renderHook(() => {
    const item = envB.apiStore.useItem('users||1');
    envB.trackItemUI('users||1', item.data?.name);
  });

  void envB.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );
  await advanceTime(0);
  await advanceTime(1);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  const secondItemKey = envB.getStoreItemKeyFromRaw('users||2');
  const queryKey = envB.getQueryKey({ tableId: 'users' });

  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    secondItemKey,
    itemKey,
  ]);

  envA.serverTable.setItem('users||1', { id: 1, name: 'Aaron' });
  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' });
  await advanceTime(900);

  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    secondItemKey,
    itemKey,
  ]);

  await flushAllTimers();

  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    secondItemKey,
    itemKey,
  ]);
  expect(envB.store.state.itemQueries[itemKey]?.refetchOnMount).toBe(false);
  expect(envB.store.state.queries[queryKey]?.refetchOnMount).toBe(false);
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | <optimistic-item-snapshot-received (value: {"id":1,"name":"Zoe"})
    .     | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    1ms   | server-data-changed (value: {"id":1,"name":"Aaron"})
    11ms  | 🔴 >list-fetch-started
    811ms | 🔴 <list-fetch-finished (value: {"count":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1              |
    0     | Alice                 | ui-initialized
    .     | {"id":1,"name":"Zoe"} | ⬜ optimistic-ui-commit
    .     | {"id":1,"name":"Zoe"} | ⬜ >mutation-started (value: {"id":1,"name":"Zoe"})
    .     | Zoe                   | ui-changed
    700ms | Zoe                   | ⬜ <mutation-data-persisted (value: {"id":1,"name":"Zoe"})
    "
  `);
});

test('confirmed sibling item fetches do not overwrite a local optimistic list item mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-stale-item-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
  });

  renderHook(() => {
    const item = envB.apiStore.useItem('users||1');
    envB.trackItemUI('users||1', item.data?.name);
  });

  void envB.performClientItemUpdateAction(
    'users||1',
    { name: 'Jane' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );
  await advanceTime(0);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(envB.store.state.items[itemKey]?.name).toBe('Jane');

  envA.apiStore.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(900);

  expect(envA.serverTable.fetchHistory).toMatchObject([
    { type: 'fetch', itemId: 'users||1' },
  ]);
  expect(envB.store.state.items[itemKey]?.name).toBe('Jane');

  await flushAllTimers();

  expect(envB.store.state.items[itemKey]?.name).toBe('Jane');
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | <optimistic-item-snapshot-received (value: {"id":1,"name":"Jane"})
    .     | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    10ms  | 🔴 >fetch-started
    810ms | 🔴 <fetch-finished (value: {"id":1,"name":"Jane"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1               |
    0     | Alice                  | ui-initialized
    .     | {"id":1,"name":"Jane"} | ⬜ optimistic-ui-commit
    .     | {"id":1,"name":"Jane"} | ⬜ >mutation-started (value: {"id":1,"name":"Jane"})
    .     | Jane                   | ui-changed
    700ms | Jane                   | ⬜ <mutation-data-persisted (value: {"id":1,"name":"Jane"})
    "
  `);
});
