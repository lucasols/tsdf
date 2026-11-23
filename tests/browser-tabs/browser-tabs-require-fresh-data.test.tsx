import { act, renderHook } from '@testing-library/react';
import { rc_number, rc_object } from 'runcheck';
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
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';
import {
  createCollectionItems,
  createFocusChangeCoordinator,
  createUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

// Two tabs open the same screen at once, e.g. after a deploy reload or a
// browser session restore. The background tab waits longer before fetching, so
// the focused tab's fetch serves it: the background tab receives the fresh data
// from the focused tab and drops its own fetch. Its `requireFreshData` hook
// must then stop loading, as the data it shows is fresh.

test('document: a requireFreshData hook in a background tab stops loading when the focused tab fetch serves it', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('require-fresh-data-document');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(0);

  const createEnv = (tab: 'a' | 'b') =>
    createDocumentStoreTestEnv(0, {
      id,
      sharedServerState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
    });
  const envA = createEnv('a');
  const envB = createEnv('b');

  renderHook(() => envA.apiStore.useDocument({ requireFreshData: true }));
  const tabB = renderHook(() => {
    const doc = envB.apiStore.useDocument({ requireFreshData: true });
    return { status: doc.status, isLoading: doc.isLoading };
  });

  await flushAllTimers();

  // only the focused tab fetched the document
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  // the background tab shows the fresh data from the focused tab
  expect(tabB.result.current).toMatchInlineSnapshot(`
    isLoading: '❌'
    status: 'success'
  `);
});

test('document: a requireFreshData hook in a background tab whose last refresh failed stops loading when the focused tab fetch serves it', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('require-fresh-data-document-after-error');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerState = createSharedServerMockState(5);
  createLocalStoragePersistentTestStore()
    .scope(id, 'session1')
    .document.seed({ value: 1 });

  // The background tab starts with the document saved on the device, and its
  // refresh fails.
  const envB = createDocumentStoreTestEnv(5, {
    id,
    getSessionKey: () => 'session1',
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    persistentStorage: {
      adapter: 'local-sync',
      schema: rc_object({ value: rc_number }),
    },
  });
  envB.serverMock.setNextFetchError('Request failed');
  act(() => {
    envB.apiStore.scheduleFetch('highPriority');
  });
  await flushAllTimers();
  expect(envB.store.state.status).toBe('error');

  // Both tabs then open a screen that requires fresh data
  const envA = createDocumentStoreTestEnv(5, {
    id,
    getSessionKey: () => 'session1',
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
  });
  renderHook(() => envA.apiStore.useDocument({ requireFreshData: true }));
  const tabB = renderHook(() => {
    const doc = envB.apiStore.useDocument({ requireFreshData: true });
    return { status: doc.status, isLoading: doc.isLoading };
  });
  await flushAllTimers();

  // The focused tab's fetch serves the background tab, which drops its retry:
  // its hook shows the fresh data instead of loading until it remounts.
  expect(tabB.result.current).toMatchInlineSnapshot(`
    isLoading: '❌'
    status: 'success'
  `);
});

test('collection: a requireFreshData item hook in a background tab stops loading when the focused tab fetch serves it', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('require-fresh-data-collection');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const createEnv = (tab: 'a' | 'b') =>
    createCollectionStoreTestEnv(createCollectionItems(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
    });
  const envA = createEnv('a');
  const envB = createEnv('b');

  renderHook(() => envA.apiStore.useItem('item1', { requireFreshData: true }));
  const tabB = renderHook(() => {
    const item = envB.apiStore.useItem('item1', { requireFreshData: true });
    return { status: item.status, name: item.data?.value.name };
  });

  await flushAllTimers();

  // only the focused tab fetched the item
  expect(envA.serverTable.getRequestHistory('all').length).toBe(1);
  expect(envB.serverTable.getRequestHistory('all').length).toBe(0);
  // the background tab shows the fresh item from the focused tab
  expect(tabB.result.current).toMatchInlineSnapshot(`
    name: 'Item 1'
    status: 'success'
  `);
});

test('list query: requireFreshData list and item hooks in a background tab stop loading when the focused tab fetches serve them', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('require-fresh-data-list-query');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const createEnv = (tab: 'a' | 'b') =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
    });
  const envA = createEnv('a');
  const envB = createEnv('b');

  renderHook(() => {
    envA.apiStore.useListQuery(
      { tableId: 'users' },
      { requireFreshData: true },
    );
    envA.apiStore.useItem('users||1', { requireFreshData: true });
  });
  const tabB = renderHook(() => {
    const list = envB.apiStore.useListQuery(
      { tableId: 'users' },
      { requireFreshData: true },
    );
    const item = envB.apiStore.useItem('users||1', { requireFreshData: true });
    return {
      listStatus: list.status,
      listSize: list.items.length,
      itemStatus: item.status,
      itemName: item.data?.name,
    };
  });

  await flushAllTimers();

  // only the focused tab fetched the list and the item
  expect(envA.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
    - _type: 'list'
      payload:
        fields: '*'
        pos: { limit: 50, offset: 0 }
      returned_items: 2
      time: '10ms -> 810ms | duration: 800ms'
    - _type: 'item'
      payload: { itemId: 'users||1' }
      time: '10ms -> 810ms | duration: 800ms'
  `);
  expect(envB.serverTable.getRequestHistory('all').length).toBe(0);
  // the background tab shows the fresh list and item from the focused tab
  expect(tabB.result.current).toMatchInlineSnapshot(`
    itemName: 'Alice'
    itemStatus: 'success'
    listSize: 2
    listStatus: 'success'
  `);
});
