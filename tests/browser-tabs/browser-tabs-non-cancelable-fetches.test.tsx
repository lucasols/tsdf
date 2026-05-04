import { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'vitest';
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
  createUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
});

test('document first fetches are not canceled by an earlier sibling background fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-first-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    baseCoalescingWindowMs: 10,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority');
  envB.scheduleFetch('highPriority');

  await advanceTime(2_020);

  expect(envA.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);

  await advanceTime(500);
  await flushAllTimers();

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);
});

test('document awaitFetch stays local even when a sibling background fetch starts first', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-await-fetch-background');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerState = createSharedServerMockState(0);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: 'loaded',
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    baseCoalescingWindowMs: 10,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  const promiseA = envA.apiStore.awaitFetch();
  const promiseB = envB.apiStore.awaitFetch();

  await advanceTime(2_020);

  expect(envA.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);

  await flushAllTimers();

  expect((await promiseA).error).toBeNull();
  expect((await promiseB).error).toBeNull();
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);
});

test('document awaitFetch resolves from a confirmed sibling snapshot when its queued fetch is satisfied', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-await-fetch-snapshot');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerState = createSharedServerMockState(7);

  const envA = createDocumentStoreTestEnv(7, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    baseCoalescingWindowMs: 20,
  });
  const envB = createDocumentStoreTestEnv(7, {
    id,
    sharedServerState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    baseCoalescingWindowMs: 1_500,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  const promiseB = envB.apiStore.awaitFetch();
  envA.scheduleFetch('highPriority');

  await advanceTime(2_100);

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  await expect(promiseB).resolves.toMatchInlineSnapshot(`
    data: { value: 7 }
    error: null
  `);
});

test('document confirmed snapshots satisfy lower-ranked pending background fetches', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-background-ranks');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerState = createSharedServerMockState(0);

  const createEnv = (tab: 'a' | 'b' | 'c') =>
    createDocumentStoreTestEnv(0, {
      id,
      sharedServerState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
      baseCoalescingWindowMs: 20,
    });

  const envA = createEnv('a');
  const envB = createEnv('b');
  const envC = createEnv('c');

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority');
  envB.scheduleFetch('highPriority');
  envC.scheduleFetch('highPriority');

  await advanceTime(1_021);
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);

  // Tab A's confirmed snapshot should satisfy the lower-ranked queued fetches.
  await advanceTime(1_000);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);
});

test('collection first fetches are not canceled by an earlier sibling background fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-first-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState = createSharedServerTableState(
    createCollectionItems(),
  );

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    baseCoalescingWindowMs: 10,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority', 'item1');
  envB.scheduleFetch('highPriority', 'item1');

  await advanceTime(2_020);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await advanceTime(500);
  await flushAllTimers();

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('collection awaitFetch stays local even when a sibling background fetch starts first', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-await-fetch');
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
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: 'loaded',
    baseCoalescingWindowMs: 10,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  const promiseA = envA.apiStore.awaitFetch('item1');
  const promiseB = envB.apiStore.awaitFetch('item1');

  await advanceTime(2_020);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await flushAllTimers();

  expect((await promiseA).error).toBeNull();
  expect((await promiseB).error).toBeNull();
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('collection confirmed snapshots satisfy lower-ranked pending background fetches', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-background-ranks');
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
      baseCoalescingWindowMs: 20,
    });

  const envA = createEnv('a');
  const envB = createEnv('b');
  const envC = createEnv('c');

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority', 'item1');
  envB.scheduleFetch('highPriority', 'item1');
  envC.scheduleFetch('highPriority', 'item1');

  await advanceTime(1_021);
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  // Tab A's confirmed snapshot should satisfy the lower-ranked queued fetches.
  await advanceTime(1_000);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);
});

test('collection confirmed null snapshots satisfy queued first fetches', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-null-snapshot');
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
    useBatchFetch: true,
    baseCoalescingWindowMs: 20,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    useBatchFetch: true,
    baseCoalescingWindowMs: 1_500,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  expect(envB.scheduleFetch('highPriority', 'item1')).toBe('triggered');
  act(() => {
    envA.apiStore.deleteItemState('item1');
  });

  await advanceTime(3_000);

  expect(envB.serverTable.numOfStartedFetches).toBe(0);
});

test('list query first fetches are not canceled by an earlier sibling background fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-first-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    baseCoalescingWindowMs: 10,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  envB.scheduleFetch('highPriority', { tableId: 'users' });

  await advanceTime(2_020);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await advanceTime(500);
  await flushAllTimers();

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('list query awaitListQueryFetch stays local even when a sibling background fetch starts first', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-await-fetch');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    testScenario: { loaded: { tables: ['users'] } },
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    testScenario: { loaded: { tables: ['users'] } },
    baseCoalescingWindowMs: 10,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  const promiseA = envA.apiStore.awaitListQueryFetch({ tableId: 'users' });
  const promiseB = envB.apiStore.awaitListQueryFetch({ tableId: 'users' });

  await advanceTime(2_020);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await flushAllTimers();

  expect((await promiseA).error).toBeNull();
  expect((await promiseB).error).toBeNull();
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('list query confirmed snapshots satisfy lower-ranked pending background fetches', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-background-ranks');
  const tabs = createFocusChangeCoordinator(['a', 'b', 'c'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const createEnv = (tab: 'a' | 'b' | 'c') =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind(tab),
      baseCoalescingWindowMs: 20,
    });

  const envA = createEnv('a');
  const envB = createEnv('b');
  const envC = createEnv('c');

  await tabs.focusTab('c');
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  envB.scheduleFetch('highPriority', { tableId: 'users' });
  envC.scheduleFetch('highPriority', { tableId: 'users' });

  await advanceTime(1_021);
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  // Tab A's confirmed snapshot should satisfy the lower-ranked queued fetches.
  await advanceTime(1_000);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);
});

test('list-only query confirmed snapshots satisfy queued first fetches', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-list-only-snapshot');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    disableFetchItemFn: true,
    baseCoalescingWindowMs: 20,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    disableFetchItemFn: true,
    baseCoalescingWindowMs: 1_500,
  });

  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  envB.scheduleFetch('highPriority', { tableId: 'users' });

  await advanceTime(2_000);

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
});
