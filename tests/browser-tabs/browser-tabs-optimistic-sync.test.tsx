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
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  createCollectionItems,
  createFocusChangeCoordinator,
  createOptimisticSortConfig,
  createUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setDefaultLowPriorityThrottleMs(60_000); // Set a high default throttle to avoid unintended refetch on mounts

setupBrowserTabsTestLifecycle();

test('document optimistic updates propagate to another tab without a remote refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-shared');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  await advanceTime(10);

  void envA.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    duration: 1_000,
  });

  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);

  await flushAllTimers();

  expect(envB.store.state.data?.value).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    10ms  | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ >mutation-started (value: 1)
    710ms | 1  | ⬜ <mutation-data-persisted (value: 1)
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | ui |
    0    | 0  | ui-initialized
    10ms | 0  | <optimistic-snapshot-received (value: 1)
    .    | 1  | ui-changed
    "
  `);
});

test('document failed optimistic mutations revert the synced background state', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-optimistic-error');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });

  renderHook(() => {
    const doc = envA.apiStore.useDocument();
    envA.trackUIChanges(doc.data?.value);
  });
  renderHook(() => {
    const doc = envB.apiStore.useDocument();
    envB.trackUIChanges(doc.data?.value);
  });

  const mutationPromise = envA.performClientUpdateAction(1, {
    withOptimisticUpdate: true,
    error: 'Mutation failed',
  });

  await advanceTime(0);

  expect(envB.store.state.data?.value).toBe(1);

  await flushAllTimers();
  const result = await mutationPromise;

  expect(result.ok).toBe(false);
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.store.state.data?.value).toBe(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 1  | ⬜ optimistic-ui-commit
    .     | 1  | ⬜ <mutation-error (value: "Mutation failed")
    10ms  | 1  | 🔴 >fetch-started
    810ms | 1  | 🔴 <fetch-finished (value: 0)
    .     | 0  | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | ui |
    0     | 0  | ui-initialized
    .     | 0  | <optimistic-snapshot-received (value: 1)
    .     | 1  | ui-changed
    810ms | 1  | <confirmed-snapshot-received (value: 0)
    .     | 0  | ui-changed
    "
  `);
});

test('collection optimistic updates propagate across tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-shared');
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
    lowPriorityThrottleMs: 60_000,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    lowPriorityThrottleMs: 60_000,
  });

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  void envA.performClientUpdateAction(
    'item1',
    { name: 'Updated' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });

  await flushAllTimers();

  expect(envB.serverTable.numOfFinishedFetches).toBe(0);

  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1              |
    0     | Item 1             | ui-initialized
    .     | {"name":"Updated"} | ⬜ optimistic-ui-commit
    .     | {"name":"Updated"} | ⬜ >mutation-started (value: {"name":"Updated"})
    .     | Updated            | ui-changed
    700ms | Updated            | ⬜ <mutation-data-persisted (value: {"name":"Updated"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | item1   |
    0    | Item 1  | ui-initialized
    .    | Item 1  | <optimistic-snapshot-received (value: {"name":"Updated"})
    .    | Updated | ui-changed
    "
  `);
});

test('collection failed optimistic mutations revert the synced background state', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-optimistic-error');
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
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
  });

  renderHook(() => {
    const item = envA.apiStore.useItem('item1');
    envA.trackItemUI('item1', item.data?.value.name);
  });
  renderHook(() => {
    const item = envB.apiStore.useItem('item1');
    envB.trackItemUI('item1', item.data?.value.name);
  });

  const mutationPromise = envA.performClientUpdateAction(
    'item1',
    { name: 'Updated' },
    { withOptimisticUpdate: true, error: 'Mutation failed' },
  );

  await advanceTime(0);

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });

  await flushAllTimers();
  const result = await mutationPromise;

  expect(result.ok).toBe(false);
  expect(envA.serverTable.fetchHistory).toHaveLength(1);
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Item 1' },
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1              |
    0     | Item 1             | ui-initialized
    .     | {"name":"Updated"} | ⬜ optimistic-ui-commit
    .     | {"name":"Updated"} | ⬜ <mutation-error (value: "Mutation failed")
    .     | Updated            | ui-changed
    10ms  | Updated            | 🔴 >fetch-started
    810ms | Updated            | 🔴 <fetch-finished (value: {"name":"Item 1"})
    .     | Item 1             | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | Item 1  | ui-initialized
    .     | Item 1  | <optimistic-snapshot-received (value: {"name":"Updated"})
    .     | Updated | ui-changed
    810ms | Updated | <confirmed-snapshot-received (value: {"name":"Item 1"})
    .     | Item 1  | ui-changed
    "
  `);
});

test('list query optimistic sorting propagates to other tabs', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-sort');
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
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    envA.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });

  void envA.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    { withOptimisticUpdate: true, duration: 1_000 },
  );

  await advanceTime(0);

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||2'),
    envB.getStoreItemKeyFromRaw('users||1'),
  ]);

  await flushAllTimers();

  expect(envB.serverTable.fetchHistory).toHaveLength(0);

  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1              |
    0     | Alice                 | ui-initialized
    .     | {"id":1,"name":"Zoe"} | ⬜ optimistic-ui-commit
    .     | {"id":1,"name":"Zoe"} | ⬜ >mutation-started (value: {"id":1,"name":"Zoe"})
    .     | Bob                   | ui-changed
    700ms | Bob                   | ⬜ <mutation-data-persisted (value: {"id":1,"name":"Zoe"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time | users||1 |
    0    | Alice    | ui-initialized
    .    | Alice    | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .    | Bob      | ui-changed
    .    | Bob      | <optimistic-item-snapshot-received (value: {"id":1,"name":"Zoe"})
    .    | Bob      | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
});

test('list query failed optimistic mutations revert the synced background state', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-optimistic-error');
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
    const query = envA.apiStore.useListQuery({ tableId: 'users' });
    envA.trackItemUI('users||1', query.items[0]?.name);
  });
  renderHook(() => {
    const query = envB.apiStore.useListQuery({ tableId: 'users' });
    envB.trackItemUI('users||1', query.items[0]?.name);
  });

  const mutationPromise = envA.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    { withOptimisticUpdate: true, error: 'Mutation failed' },
  );

  await advanceTime(0);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  const secondItemKey = envB.getStoreItemKeyFromRaw('users||2');
  const queryKey = envB.getQueryKey({ tableId: 'users' });

  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    secondItemKey,
    itemKey,
  ]);

  await flushAllTimers();
  const result = await mutationPromise;

  expect(result.ok).toBe(false);
  expect(envB.store.state.items[itemKey]?.name).toBe('Alice');
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    itemKey,
    secondItemKey,
  ]);
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1              |
    0     | Alice                 | ui-initialized
    .     | {"id":1,"name":"Zoe"} | ⬜ optimistic-ui-commit
    .     | {"id":1,"name":"Zoe"} | ⬜ <mutation-error (value: "Mutation failed")
    .     | Bob                   | ui-changed
    10ms  | Bob                   | 🔴 >list-fetch-started
    810ms | Bob                   | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Alice                 | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    0     | Alice    | ui-initialized
    .     | Alice    | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Bob      | ui-changed
    .     | Bob      | <optimistic-item-snapshot-received (value: {"id":1,"name":"Zoe"})
    .     | Bob      | <optimistic-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    810ms | Bob      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | Alice    | ui-changed
    "
  `);
});
