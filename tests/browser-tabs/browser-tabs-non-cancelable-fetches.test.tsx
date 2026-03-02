import { expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import {
  createCollectionItems,
  createFocusFlag,
  createUsersTable,
  markLastActiveTab,
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

test('document first fetches are not canceled by an earlier sibling background fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-first-fetch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    baseCoalescingWindowMs: 10,
  });

  envA.scheduleFetch('highPriority');
  envB.scheduleFetch('highPriority');

  await advanceTime(20);

  expect(envA.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);

  await advanceTime(1_500);
  await flushAllTimers();

  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);
});

test('document awaitFetch stays local even when a sibling background fetch starts first', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-await-fetch-background');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createDocumentStoreTestEnv(0, {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    baseCoalescingWindowMs: 10,
  });

  const promiseA = envA.apiStore.awaitFetch();
  const promiseB = envB.apiStore.awaitFetch();

  await advanceTime(20);

  expect(envA.serverMock.numOfStartedFetches).toBe(0);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);

  await flushAllTimers();

  expect((await promiseA).error).toBeNull();
  expect((await promiseB).error).toBeNull();
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);
});

test('document background tabs add one second per rank to the coalescing window', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('document-background-ranks');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (getWindowIsFocused: () => boolean) =>
    createDocumentStoreTestEnv(0, {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      baseCoalescingWindowMs: 20,
    });

  const envA = createEnv(focusA.get);
  const envB = createEnv(focusB.get);
  const envC = createEnv(focusC.get);

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.scheduleFetch('highPriority');
  envB.scheduleFetch('highPriority');
  envC.scheduleFetch('highPriority');

  await advanceTime(21);
  expect(envA.serverMock.numOfStartedFetches).toBe(1);
  expect(envB.serverMock.numOfStartedFetches).toBe(0);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envB.serverMock.numOfStartedFetches).toBe(1);
  expect(envC.serverMock.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envC.serverMock.numOfStartedFetches).toBe(1);
});

test('collection first fetches are not canceled by an earlier sibling background fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-first-fetch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    baseCoalescingWindowMs: 10,
  });

  envA.scheduleFetch('highPriority', 'item1');
  envB.scheduleFetch('highPriority', 'item1');

  await advanceTime(20);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await advanceTime(1_500);
  await flushAllTimers();

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('collection awaitFetch stays local even when a sibling background fetch starts first', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-await-fetch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: 'loaded',
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createCollectionStoreTestEnv(createCollectionItems(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: 'loaded',
    baseCoalescingWindowMs: 10,
  });

  const promiseA = envA.apiStore.awaitFetch('item1');
  const promiseB = envB.apiStore.awaitFetch('item1');

  await advanceTime(20);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await flushAllTimers();

  expect((await promiseA).error).toBeNull();
  expect((await promiseB).error).toBeNull();
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('collection background tabs add one second per rank to the coalescing window', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('collection-background-ranks');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (getWindowIsFocused: () => boolean) =>
    createCollectionStoreTestEnv(createCollectionItems(), {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      baseCoalescingWindowMs: 20,
    });

  const envA = createEnv(focusA.get);
  const envB = createEnv(focusB.get);
  const envC = createEnv(focusC.get);

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.scheduleFetch('highPriority', 'item1');
  envB.scheduleFetch('highPriority', 'item1');
  envC.scheduleFetch('highPriority', 'item1');

  await advanceTime(21);
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envC.serverTable.numOfStartedFetches).toBe(1);
});

test('list query first fetches are not canceled by an earlier sibling background fetch', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-first-fetch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    baseCoalescingWindowMs: 10,
  });

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  envB.scheduleFetch('highPriority', { tableId: 'users' });

  await advanceTime(20);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await advanceTime(1_500);
  await flushAllTimers();

  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('list query awaitListQueryFetch stays local even when a sibling background fetch starts first', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-await-fetch');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusA.get,
    testScenario: { loaded: { tables: ['users'] } },
    baseCoalescingWindowMs: 1_500,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    browserTabsTransportFactory: transportFactory,
    getWindowIsFocused: focusB.get,
    testScenario: { loaded: { tables: ['users'] } },
    baseCoalescingWindowMs: 10,
  });

  const promiseA = envA.apiStore.awaitListQueryFetch({ tableId: 'users' });
  const promiseB = envB.apiStore.awaitListQueryFetch({ tableId: 'users' });

  await advanceTime(20);

  expect(envA.serverTable.numOfStartedFetches).toBe(0);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);

  await flushAllTimers();

  expect((await promiseA).error).toBeNull();
  expect((await promiseB).error).toBeNull();
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
});

test('list query background tabs add one second per rank to the coalescing window', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-background-ranks');
  const focusA = createFocusFlag(false);
  const focusB = createFocusFlag(false);
  const focusC = createFocusFlag(false);

  const createEnv = (getWindowIsFocused: () => boolean) =>
    createListQueryStoreTestEnv(createUsersTable(), {
      id,
      browserTabsTransportFactory: transportFactory,
      getWindowIsFocused,
      baseCoalescingWindowMs: 20,
    });

  const envA = createEnv(focusA.get);
  const envB = createEnv(focusB.get);
  const envC = createEnv(focusC.get);

  await markLastActiveTab(envA, [focusA, focusB, focusC], 2);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 1);
  await markLastActiveTab(envA, [focusA, focusB, focusC], 0);

  envA.scheduleFetch('highPriority', { tableId: 'users' });
  envB.scheduleFetch('highPriority', { tableId: 'users' });
  envC.scheduleFetch('highPriority', { tableId: 'users' });

  await advanceTime(21);
  expect(envA.serverTable.numOfStartedFetches).toBe(1);
  expect(envB.serverTable.numOfStartedFetches).toBe(0);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envB.serverTable.numOfStartedFetches).toBe(1);
  expect(envC.serverTable.numOfStartedFetches).toBe(0);

  await advanceTime(1_000);
  expect(envC.serverTable.numOfStartedFetches).toBe(1);
});
