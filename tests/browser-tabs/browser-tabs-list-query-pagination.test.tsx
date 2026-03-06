import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { OffsetPaginationConfig } from '../../src/listQueryStore/types';
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

function createPaginationEnvs(options: {
  storeId: string;
  offsetPagination?: OffsetPaginationConfig;
}) {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId(options.storeId);
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
    offsetPagination: options.offsetPagination,
  });
  const envB = createListQueryStoreTestEnv(createThreeUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    defaultQuerySize: 1,
    offsetPagination: options.offsetPagination,
  });

  return { envA, envB };
}

type PaginationEnv = ReturnType<typeof createPaginationEnvs>['envA'];

function renderQueryTimeline(env: PaginationEnv): void {
  renderHook(() => {
    const query = env.apiStore.useListQuery({ tableId: 'users' });

    env.trackItemUI(
      'query-items',
      query.items.length > 0
        ? query.items.map((item) => item.name).join(', ')
        : undefined,
    );
    env.trackItemUI('query-status', query.status);
  });
}

function getQuerySummary(env: PaginationEnv) {
  const query = env.apiStore.getQueryState({ tableId: 'users' });

  if (!query) {
    return null;
  }

  return {
    hasMore: query.hasMore,
    items: query.items.map((itemKey) => env.store.state.items[itemKey]?.name),
    status: query.status,
  };
}

function getListFetchRanges(env: PaginationEnv) {
  return env.serverTable.fetchHistory.flatMap((entry) =>
    entry.type === 'list' ? [{ offset: entry.offset, limit: entry.limit }] : [],
  );
}

test('list query size pagination keeps sibling tabs in sync across chained loadMore calls', async () => {
  const { envA, envB } = createPaginationEnvs({
    storeId: 'list-query-size-pagination',
  });

  // Both tabs start from a real loaded first page so each later loadMore uses
  // the same local state a browser tab would have in production.
  envB.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  renderQueryTimeline(envA);
  renderQueryTimeline(envB);
  envA.clearTimeline();
  envB.clearTimeline();

  // Tab A loads the next page. Tab B must update only via the synced snapshot.
  envA.addTimelineComments('beforeNextAction', ['tab A loads page 2']);
  envB.addTimelineComments('beforeNextAction', [
    'tab B receives page 2 through browser-tab sync',
  ]);
  envA.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  // Tab B then continues pagination from the synced state instead of
  // re-requesting page 2.
  envA.addTimelineComments('beforeNextAction', [
    'tab A receives tab B pagination through browser-tab sync',
  ]);
  envB.addTimelineComments('beforeNextAction', [
    'tab B loads page 3 from the synced query state',
  ]);
  envB.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  expect({
    envA: getQuerySummary(envA),
    envB: getQuerySummary(envB),
  }).toMatchInlineSnapshot(`
    envA:
      hasMore: '❌'
      items: ['User 1', 'User 2', 'User 3']
      status: 'success'

    envB:
      hasMore: '❌'
      items: ['User 1', 'User 2', 'User 3']
      status: 'success'
  `);
  expect(getListFetchRanges(envA)).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 2, offset: 0 }
  `);
  expect(getListFetchRanges(envB)).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 3, offset: 0 }
  `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items            | query-status |
    2.62s | User 1                 | success      | -- timeline-cleared
    2.63s | User 1                 | success      | -- tab A loads page 2
    .     | User 1                 | success      | 🟠 >list-fetch-started
    .     | User 1                 | loadingMore  | [query-status] ui-changed
    3.43s | User 1                 | loadingMore  | 🟠 <list-fetch-finished (value: {"count":2})
    .     | User 1, User 2         | success      | [query-items, query-status] ui-changed
    5.24s | User 1, User 2         | success      | -- tab A receives tab B pagination through browser-tab sync
    .     | User 1, User 2         | success      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":3})
    .     | User 1, User 2, User 3 | success      | [query-items] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items            | query-status |
    2.62s | User 1                 | success      | -- timeline-cleared
    3.43s | User 1                 | success      | -- tab B receives page 2 through browser-tab sync
    .     | User 1                 | success      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | User 1, User 2         | success      | [query-items] ui-changed
    4.44s | User 1, User 2         | success      | -- tab B loads page 3 from the synced query state
    .     | User 1, User 2         | success      | 🟠 >list-fetch-started
    .     | User 1, User 2         | loadingMore  | [query-status] ui-changed
    5.24s | User 1, User 2         | loadingMore  | 🟠 <list-fetch-finished (value: {"count":3})
    .     | User 1, User 2, User 3 | success      | [query-items, query-status] ui-changed
    "
  `);
});

test('list query offset pagination keeps sibling tabs in sync across chained loadMore calls', async () => {
  const { envA, envB } = createPaginationEnvs({
    storeId: 'list-query-offset-pagination',
    offsetPagination: { maxInvalidationLimit: 10 },
  });

  // Both tabs start from a real loaded first page so each later loadMore uses
  // the same local state a browser tab would have in production.
  envB.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  envA.apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }, 1);
  await flushAllTimers();

  renderQueryTimeline(envA);
  renderQueryTimeline(envB);
  envA.clearTimeline();
  envB.clearTimeline();

  // In offset mode tab A fetches only the next slice.
  envA.addTimelineComments('beforeNextAction', ['tab A loads page 2']);
  envB.addTimelineComments('beforeNextAction', [
    'tab B receives page 2 through browser-tab sync',
  ]);
  envA.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  // Tab B must continue from offset 2 after applying the remote snapshot.
  envA.addTimelineComments('beforeNextAction', [
    'tab A receives tab B pagination through browser-tab sync',
  ]);
  envB.addTimelineComments('beforeNextAction', [
    'tab B loads page 3 from the synced query state',
  ]);
  envB.apiStore.loadMore({ tableId: 'users' }, 1);
  await flushAllTimers();

  expect({
    envA: getQuerySummary(envA),
    envB: getQuerySummary(envB),
  }).toMatchInlineSnapshot(`
    envA:
      hasMore: '❌'
      items: ['User 1', 'User 2', 'User 3']
      status: 'success'

    envB:
      hasMore: '❌'
      items: ['User 1', 'User 2', 'User 3']
      status: 'success'
  `);
  expect(getListFetchRanges(envA)).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 1, offset: 1 }
  `);
  expect(getListFetchRanges(envB)).toMatchInlineSnapshot(`
    - { limit: 1, offset: 0 }
    - { limit: 1, offset: 2 }
  `);
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items            | query-status |
    2.62s | User 1                 | success      | -- timeline-cleared
    2.63s | User 1                 | success      | -- tab A loads page 2
    .     | User 1                 | success      | 🟠 >list-fetch-started
    .     | User 1                 | loadingMore  | [query-status] ui-changed
    3.43s | User 1                 | loadingMore  | 🟠 <list-fetch-finished (value: {"count":1})
    .     | User 1, User 2         | success      | [query-items, query-status] ui-changed
    5.24s | User 1, User 2         | success      | -- tab A receives tab B pagination through browser-tab sync
    .     | User 1, User 2         | success      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":3})
    .     | User 1, User 2, User 3 | success      | [query-items] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items            | query-status |
    2.62s | User 1                 | success      | -- timeline-cleared
    3.43s | User 1                 | success      | -- tab B receives page 2 through browser-tab sync
    .     | User 1                 | success      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    .     | User 1, User 2         | success      | [query-items] ui-changed
    4.44s | User 1, User 2         | success      | -- tab B loads page 3 from the synced query state
    .     | User 1, User 2         | success      | 🟠 >list-fetch-started
    .     | User 1, User 2         | loadingMore  | [query-status] ui-changed
    5.24s | User 1, User 2         | loadingMore  | 🟠 <list-fetch-finished (value: {"count":1})
    .     | User 1, User 2, User 3 | success      | [query-items, query-status] ui-changed
    "
  `);
});
