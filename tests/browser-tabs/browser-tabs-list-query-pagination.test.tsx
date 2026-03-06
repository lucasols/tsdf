import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
} from '../mocks/listQueryStoreTestEnv';
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createFocusChangeCoordinator,
  createThreeUsersTable,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
});

test('list query size pagination keeps sibling tabs in sync across chained loadMore calls', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-size-pagination');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedListQueryServerTableState(
    createThreeUsersTable(),
  );

  const envA = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    defaultQuerySize: 1,
  });
  const envB = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    defaultQuerySize: 1,
  });

  envB.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();
  envA.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  const queryKeyA = envA.getQueryKey({ tableId: 'users' });
  const queryKeyB = envB.getQueryKey({ tableId: 'users' });

  expect(envA.store.state.queries[queryKeyA]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
  expect(envB.store.state.queries[queryKeyB]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );

  envB.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  expect(envA.store.state.queries[queryKeyA]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2', '"users||3']`,
  );
  expect(envB.store.state.queries[queryKeyB]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2', '"users||3']`,
  );
  expect(envA.store.state.queries[queryKeyA]?.hasMore).toBe(false);
  expect(envB.store.state.queries[queryKeyB]?.hasMore).toBe(false);
  expect(
    envA.serverTable.fetchHistory.flatMap((entry) =>
      entry.type === 'list'
        ? [{ offset: entry.offset, limit: entry.limit }]
        : [],
    ),
  ).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 2, offset: 0 }
  `);
  expect(
    envB.serverTable.fetchHistory.flatMap((entry) =>
      entry.type === 'list'
        ? [{ offset: entry.offset, limit: entry.limit }]
        : [],
    ),
  ).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 3, offset: 0 }
  `);
});

test('list query offset pagination keeps sibling tabs in sync across chained loadMore calls', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-offset-pagination');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedListQueryServerTableState(
    createThreeUsersTable(),
  );

  const envA = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    defaultQuerySize: 1,
    offsetPagination: { maxInvalidationLimit: 10 },
  });
  const envB = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    defaultQuerySize: 1,
    offsetPagination: { maxInvalidationLimit: 10 },
  });

  envB.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();
  envA.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  const queryKeyA = envA.getQueryKey({ tableId: 'users' });
  const queryKeyB = envB.getQueryKey({ tableId: 'users' });

  expect(envA.store.state.queries[queryKeyA]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
  expect(envB.store.state.queries[queryKeyB]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2']`,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );

  envB.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  expect(envA.store.state.queries[queryKeyA]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2', '"users||3']`,
  );
  expect(envB.store.state.queries[queryKeyB]?.items).toMatchInlineSnapshot(
    `['"users||1', '"users||2', '"users||3']`,
  );
  expect(envA.store.state.queries[queryKeyA]?.hasMore).toBe(false);
  expect(envB.store.state.queries[queryKeyB]?.hasMore).toBe(false);
  expect(
    envA.serverTable.fetchHistory.flatMap((entry) =>
      entry.type === 'list'
        ? [{ offset: entry.offset, limit: entry.limit }]
        : [],
    ),
  ).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 1, offset: 1 }
  `);
  expect(
    envB.serverTable.fetchHistory.flatMap((entry) =>
      entry.type === 'list'
        ? [{ offset: entry.offset, limit: entry.limit }]
        : [],
    ),
  ).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 1, offset: 2 }
  `);
});
