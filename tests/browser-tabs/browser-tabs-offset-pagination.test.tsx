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

test('list query offset pagination syncs the merged query state to an already-loaded sibling tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-offset');
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
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    1.82s | 🔴 >list-fetch-started
    2.62s | 🔴 <list-fetch-finished (value: {"count":1})
    2.63s | 🟠 >list-fetch-started
    3.43s | 🟠 <list-fetch-finished (value: {"count":1})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    1.01s | 🔴 >list-fetch-started
    1.81s | 🔴 <list-fetch-finished (value: {"count":1})
    2.62s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
    3.43s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
});
