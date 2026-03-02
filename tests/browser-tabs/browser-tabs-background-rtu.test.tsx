import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import {
  countFetchHistoryEntries,
  createCollectionItems,
  createFocusFlag,
  createUsersTable,
  markLastActiveTab,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';
import { flushAllTimers } from '../utils/genericTestUtils';

vi.mock('@ls-stack/browser-utils/window', () => ({
  onWindowFocus: (handler: () => void) => {
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  },
  isWindowFocused: () => !document.hidden,
}));

setupBrowserTabsTestLifecycle();

test('document RTU fetch in the active tab updates the background tab without a background refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-rtu');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => envA.apiStore.useDocument());
  renderHook(() => envB.apiStore.useDocument());

  envA.emulateExternalRTU(2, 100);
  await flushAllTimers();

  expect(envA.store.state.data?.value).toBe(2);
  expect(envB.store.state.data?.value).toBe(2);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
});

test('document RTU failures stay local to the fetching tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-rtu-error');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => envA.apiStore.useDocument());
  renderHook(() => envB.apiStore.useDocument());

  envA.errorInNextFetch();
  envA.emulateExternalRTU(3, 100);
  await flushAllTimers();

  expect(envB.store.state.data?.value).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
});

test('document RTU does not sync across tabs using different store ids', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id: getNextStoreId('document-rtu-a'),
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(100, {
    id: getNextStoreId('document-rtu-b'),
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => envA.apiStore.useDocument());
  renderHook(() => envB.apiStore.useDocument());

  envA.emulateExternalRTU(2, 100);
  await flushAllTimers();

  expect(envA.store.state.data?.value).toBe(2);
  expect(envB.store.state.data?.value).toBe(100);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
});

test('document RTU invalidations are deduplicated when all tabs are backgrounded and the last active tab leads', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-all-background');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => envA.apiStore.useDocument());
  renderHook(() => envB.apiStore.useDocument());

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  envA.setServerData(5);
  envB.setServerData(5);

  envA.apiStore.invalidateData('realtimeUpdate');
  envB.apiStore.invalidateData('realtimeUpdate');

  await flushAllTimers();

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envA.store.state.data?.value).toBe(5);
  expect(envB.store.state.data?.value).toBe(5);
});

test('collection RTU fetch in the active tab updates the background tab without a background refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-rtu');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  await flushAllTimers();

  expect(envA.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('collection RTU failures stay local to the fetching tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-rtu-error');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    dynamicRealtimeThrottleMs: () => 300,
  });

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));

  envA.serverTable.setNextFetchError('item1', 'Fetch error');
  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  await flushAllTimers();

  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Item 1' },
  });
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('collection RTU does not sync across tabs using different store ids', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id: getNextStoreId('collection-rtu-a'),
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id: getNextStoreId('collection-rtu-b'),
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  await flushAllTimers();

  expect(envA.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Updated' },
  });
  expect(envB.apiStore.getItemState('item1')?.data).toEqual({
    value: { name: 'Item 1' },
  });
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('collection background RTU invalidations dedupe to one batch fetch when all tabs are hidden', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-all-background-batch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxBatchSize: 10,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxBatchSize: 10,
  });

  renderHook(() =>
    envA.apiStore.useMultipleItems([
      { payload: 'item1' },
      { payload: 'item2' },
    ]),
  );
  renderHook(() =>
    envB.apiStore.useMultipleItems([
      { payload: 'item1' },
      { payload: 'item2' },
    ]),
  );

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });
  envA.serverTable.setItem('item2', { name: 'Updated 2' });
  envB.serverTable.setItem('item2', { name: 'Updated 2' });

  envA.apiStore.invalidateItem(['item1', 'item2'], 'realtimeUpdate');
  envB.apiStore.invalidateItem(['item1', 'item2'], 'realtimeUpdate');

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
});

test('collection background RTU invalidations dedupe to one per-item fetch when batching is disabled', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-all-background-item');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    usesRealTimeUpdates: true,
  });

  renderHook(() => envA.apiStore.useItem('item1'));
  renderHook(() => envB.apiStore.useItem('item1'));

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  envA.serverTable.setItem('item1', { name: 'Updated' });
  envB.serverTable.setItem('item1', { name: 'Updated' });

  envA.apiStore.invalidateItem('item1', 'realtimeUpdate');
  envB.apiStore.invalidateItem('item1', 'realtimeUpdate');

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
});

test('list query RTU fetch in the active tab updates the background tab without a background refetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-rtu');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));

  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });

  envA.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });
  await flushAllTimers();

  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Zoe',
  });
  expect(
    envB.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(0);
});

test('list query RTU failures stay local to the fetching tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-rtu-error');
  const focusA = createFocusFlag(true);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));

  envA.serverTable.setNextListFetchError('Fetch error');
  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });

  envA.apiStore.invalidateQueryAndItems({
    queryPayload: { tableId: 'users' },
    itemPayload: 'users||1',
    type: 'realtimeUpdate',
  });
  await flushAllTimers();

  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Alice',
  });
  expect(envB.serverTable.fetchHistory).toHaveLength(0);
});

test('list query realtime invalidations stay isolated across different store ids when every tab is backgrounded', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id: getNextStoreId('list-query-background-a'),
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id: getNextStoreId('list-query-background-b'),
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));

  await markLastActiveTab(envA, [focusA, focusB], 0);

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
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Alice',
  });
});

test('list query background RTU invalidations dedupe to one query fetch when all tabs are hidden', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-all-background');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
  });

  renderHook(() => envA.apiStore.useListQuery({ tableId: 'users' }));
  renderHook(() => envB.apiStore.useListQuery({ tableId: 'users' }));

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });

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

  await flushAllTimers();

  expect(
    envA.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(1);
  expect(
    envB.serverTable.fetchHistory.filter((entry) => entry.type === 'list'),
  ).toHaveLength(0);
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toEqual({
    id: 1,
    name: 'Zoe',
  });
});

test('list query background item RTU invalidations dedupe to one item batch fetch when batching is enabled', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-all-background-item-batch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxItemBatchSize: 10,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    usesRealTimeUpdates: true,
    useBatchFetch: true,
    getItemsBatchKey: () => 'shared',
    maxItemBatchSize: 10,
  });

  renderHook(() =>
    envA.apiStore.useMultipleItems([
      { payload: 'users||1' },
      { payload: 'users||2' },
    ]),
  );
  renderHook(() =>
    envB.apiStore.useMultipleItems([
      { payload: 'users||1' },
      { payload: 'users||2' },
    ]),
  );

  await markLastActiveTab(envA, [focusA, focusB], 1);
  await markLastActiveTab(envA, [focusA, focusB], 0);

  envA.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envB.serverTable.setItem('users||1', { id: 1, name: 'Zoe' });
  envA.serverTable.setItem('users||2', { id: 2, name: 'Yara' });
  envB.serverTable.setItem('users||2', { id: 2, name: 'Yara' });

  envA.apiStore.invalidateItem(['users||1', 'users||2'], 'realtimeUpdate');
  envB.apiStore.invalidateItem(['users||1', 'users||2'], 'realtimeUpdate');

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
});
