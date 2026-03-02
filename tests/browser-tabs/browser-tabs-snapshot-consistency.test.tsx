import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createInspectableInMemoryBrowserTabsTransportFactory,
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import {
  countFetchHistoryEntries,
  createCollectionItems,
  createFocusFlag,
  createOptimisticSortConfig,
  createThreeUsersTable,
  createUsersTable,
  getMessageKinds,
  getNonStatusMessages,
  getPublisherTabIds,
  markLastActiveTab,
  partialResourcesConfig,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

vi.mock('@ls-stack/browser-utils/window', () => ({
  onWindowFocus: (handler: () => void) => {
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  },
  isWindowFocused: () => !document.hidden,
}));

setupBrowserTabsTestLifecycle();

test('collection snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-audit');

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });

  void envA.performClientUpdateAction(
    'item1',
    { name: 'Updated' },
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
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

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
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

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
    useBatchFetch: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
    useBatchFetch: true,
  });

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });

  envA.scheduleFetch('highPriority', 'item1');
  await flushAllTimers();

  renderHook(() => envB.apiStore.useItem('item1'));
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    0,
  );
  expect(envB.apiStore.getItemState('item1')).toMatchObject({
    data: { value: { name: 'Updated' } },
    status: 'success',
  });
});

test('confirmed collection snapshots do not overwrite a local in-flight mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-conflict');

  const envA = createCollectionStoreTestEnv(
    { item1: { name: 'Initial' } },
    {
      id,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );
  const envB = createCollectionStoreTestEnv(
    { item1: { name: 'Initial' } },
    {
      id,
      browserTabsTransportFactory: transportFactory,
      testScenario: 'loaded',
    },
  );

  void envB.performClientUpdateAction(
    'item1',
    { name: 'Local' },
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
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
});

test('document snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-audit');

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transport.transportFactory,
    testScenario: 'loaded',
  });
  createDocumentStoreTestEnv(0, {
    id,
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

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
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

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
  });

  envA.setServerData(7);
  envB.setServerData(7);

  envA.scheduleFetch('highPriority');
  await flushAllTimers();

  renderHook(() => envB.apiStore.useDocument());
  await flushAllTimers();

  expect(envB.serverMock.fetchHistory).toHaveLength(1);
  expect(envB.store.state).toMatchObject({
    data: { value: 7 },
    status: 'success',
  });
});

test('confirmed document snapshots do not overwrite a local in-flight mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-conflict');

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'loaded',
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
});

test('list query snapshots do not re-broadcast after remote application', async () => {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-audit');

  const createEnv = () =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
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
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
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

test('list query partial-resource snapshots do not seed an untouched sibling item tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-partial-background-item');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    partialResources: partialResourcesConfig,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    partialResources: partialResourcesConfig,
  });

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  renderHook(() => envA.apiStore.useItem('users||1', { fields: ['name'] }));

  await flushAllTimers();

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
  expect(envA.serverTable.fetchHistory[0]).toMatchObject({
    type: 'fetch',
    fields: ['name'],
  });
  expect(
    envB.store.state.itemLoadedFields[envB.getStoreItemKeyFromRaw('users||1')],
  ).toBeUndefined();
  expect(
    envB.store.state.itemQueries[envB.getStoreItemKeyFromRaw('users||1')],
  ).toBeUndefined();
});

test('list query partial-resources field metadata updates an already-loaded sibling tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-fields');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused: focusA.get,
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused: focusB.get,
      partialResources: partialResourcesConfig,
    },
  );

  void envB.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['age'],
  });
  await flushAllTimers();

  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name'],
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);

  renderHook(() =>
    envB.apiStore.useItem('users||1', {
      fields: ['name'],
    }),
  );
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
});

test('list query partial-resources remote snapshots clear satisfied local invalidation fields', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-field-invalidation');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused: focusA.get,
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused: focusB.get,
      partialResources: partialResourcesConfig,
    },
  );

  void envB.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name', 'age'],
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);

  envB.apiStore.invalidateQueryAndItems({
    queryPayload: false,
    itemPayload: 'users||1',
    type: 'highPriority',
    fields: ['age'],
  });
  await advanceTime(0);

  expect(envB.store.state.itemLoadedFields[itemKey]).toEqual(['name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKey]).toEqual([
    'age',
  ]);

  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['age'],
  });
  await flushAllTimers();

  expect(envB.serverTable.fetchHistory).toHaveLength(1);
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKey]).toBeUndefined();
});

test('list query offset pagination syncs the merged query state to an already-loaded sibling tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-offset');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    defaultQuerySize: 1,
    offsetPagination: { maxInvalidationLimit: 10 },
  });
  const envB = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    defaultQuerySize: 1,
    offsetPagination: { maxInvalidationLimit: 10 },
  });

  envB.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();
  void envA.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||1'),
    envB.getStoreItemKeyFromRaw('users||2'),
  ]);
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
});

test('list query resets stay local to the tab that triggered them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-reset');

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
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

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
  });

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' });
  await flushAllTimers();

  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));
  await flushAllTimers();

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||1'),
    envB.getStoreItemKeyFromRaw('users||2'),
  ]);
});

test('confirmed list query snapshots do not overwrite a local in-flight mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-conflict');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    optimisticListUpdates: createOptimisticSortConfig(),
  });

  void envB.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
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
});

test('confirmed sibling item fetches do not overwrite a local optimistic list item mutation', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-stale-item-fetch');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
  });

  void envB.performClientItemUpdateAction(
    'users||1',
    { name: 'Zoe' },
    {
      withOptimisticUpdate: true,
      duration: 1_000,
    },
  );
  await advanceTime(0);

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');

  envA.apiStore.scheduleItemFetch('highPriority', 'users||1');
  await advanceTime(900);

  expect(envA.serverTable.fetchHistory).toMatchObject([
    {
      type: 'fetch',
      itemId: 'users||1',
    },
  ]);
  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');

  await flushAllTimers();

  expect(envB.store.state.items[itemKey]?.name).toBe('Zoe');
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    0,
  );
});
