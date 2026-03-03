import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
  type Row,
} from '../mocks/listQueryStoreTestEnv';
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createFocusChangeCoordinator,
  createUsersTable,
  partialResourcesConfig,
  setupBrowserTabsTestLifecycle,
} from './browser-tabs-test-helpers';

setupBrowserTabsTestLifecycle();

beforeEach(() => {
  setDefaultLowPriorityThrottleMs(60_000);
});

afterEach(() => {
  setDefaultLowPriorityThrottleMs(200);
});

function getTrackedAge(value: unknown): string {
  return typeof value === 'number' ? String(value) : '-';
}

function getTrackedUserSummary(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'age' in value &&
    typeof value.name === 'string' &&
    typeof value.age === 'number'
  ) {
    return `${value.name}:${String(value.age)}`;
  }

  return '-';
}

test('list query partial-resource snapshots do not seed an untouched sibling item tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-partial-background-item');
  const tabs = createFocusChangeCoordinator(['a', 'b'], null);
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('a'),
    partialResources: partialResourcesConfig,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    bindFocusController: tabs.bind('b'),
    partialResources: partialResourcesConfig,
  });

  // Both tabs become known to the transport, but neither one keeps local state
  // for the item before tab A mounts the hook.
  await tabs.focusTab('b');
  await tabs.focusTab('a');
  await tabs.blur();

  renderHook(() => envA.apiStore.useItem('users||1', { fields: ['name'] }));

  await flushAllTimers();

  // Tab A performs the fetch, but the remote partial snapshot must not create
  // any item state in untouched tab B.
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

test('a fresh partial-resource list-query tab still performs its first fetch after a sibling tab fetched earlier', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-partial-first-fetch-after-sibling');
  const sharedServerTableState =
    createSharedListQueryServerTableState(createUsersTable());

  const envA = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: { loaded: { tables: ['users'] } },
    lowPriorityThrottleMs: 10_000,
    partialResources: partialResourcesConfig,
  });
  const envB = createListQueryStoreTestEnv(createUsersTable(), {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transportFactory,
    testScenario: 'idle',
    lowPriorityThrottleMs: 10_000,
    partialResources: partialResourcesConfig,
  });

  void envA.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    undefined,
    {
      fields: ['name'],
    },
  );
  await flushAllTimers();

  const envBQuery = renderHook(() => {
    const query = envB.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        fields: ['name'],
      },
    );

    envB.trackItemUI('users||1', query.items[0]?.name);
    return query;
  });
  await flushAllTimers();

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  const itemKey = envB.getStoreItemKeyFromRaw('users||1');

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(envBQuery.result.current).toMatchObject({
    status: 'success',
    items: [{ name: 'Alice' }, { name: 'Bob' }],
  });
  expect(envB.store.state.queries[queryKey]?.items).toEqual([
    envB.getStoreItemKeyFromRaw('users||1'),
    envB.getStoreItemKeyFromRaw('users||2'),
  ]);
  expect(envB.store.state.itemLoadedFields[itemKey]).toEqual(['name']);
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
    810ms | ⋯        | ui-initialized
    820ms | ⋯        | 🔴 >list-fetch-started
    1.62s | ⋯        | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Alice    | ui-changed
    "
  `);
});

test('list query partial-resources field metadata updates an already-loaded sibling tab', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-fields');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedListQueryServerTableState<Row>({
    users: [{ id: 1, name: 'Alice', age: 30 }],
  });

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('a'),
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('b'),
      partialResources: partialResourcesConfig,
    },
  );

  void envB.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['age'],
  });
  await flushAllTimers();

  const envBFetchCountBeforeHook = countFetchHistoryEntries(
    envB.serverTable.fetchHistory,
    'fetch',
  );
  const envBNameHook = renderHook(() => {
    const item = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetches: true,
      fields: ['name'],
    });

    envB.trackItemUI('name-hook', item.data?.name ?? '-');
    return item;
  });
  await advanceTime(0);

  expect(envBNameHook.result.current).toMatchObject({
    status: 'loading',
    data: null,
  });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    envBFetchCountBeforeHook,
  );

  // Tab A fetches a different field after the server row changes so we can
  // verify that tab B receives both the new payload and the merged metadata.
  envA.serverTable.setItem('users||1', {
    id: 1,
    name: 'Alicia',
    age: 30,
  });
  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name'],
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  // Tab B should now have the union of both fields and the updated payload from
  // tab A's fetch, without running its own second request.
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(envB.store.state.items[itemKey]).toEqual({
    age: 30,
    name: 'Alicia',
  });

  // Mounting a hook that only needs the remotely satisfied field should read
  // from the merged cache and remain a fetch-free cache hit.
  expect(envBNameHook.result.current).toMatchObject({
    status: 'success',
    data: {
      name: 'Alicia',
    },
  });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    envBFetchCountBeforeHook,
  );
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | name-hook | users||1 |
    1.01s | -         | -        | 🔴 [users||1] >fetch-started
    1.81s | -         | -        | 🔴 [users||1] <fetch-finished (value: {"age":30})
    .     | -         | -        | [name-hook] ui-initialized
    2.62s | -         | -        | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia"})
    .     | Alicia    | -        | [name-hook] ui-changed
    "
  `);
});

test('focused partial-resource item refetch updates the matching background hook without refetching a sibling field hook', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-focused-item-refetch-name');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedListQueryServerTableState<Row>({
    users: [{ id: 1, name: 'Alice', age: 30 }],
  });

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('a'),
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('b'),
      partialResources: partialResourcesConfig,
    },
  );

  const envANameHook = renderHook(() => {
    const item = envA.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name'],
    });

    envA.trackItemUI('name-hook', item.data?.name ?? '-');
    return item;
  });
  await flushAllTimers();

  const envBHooks = renderHook(() => {
    const name = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name'],
    });
    const age = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['age'],
    });

    envB.trackItemUI('name-hook', name.data?.name ?? '-');
    envB.trackItemUI('age-hook', getTrackedAge(age.data?.age));

    return { name, age };
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');

  // The focused tab seeds the name field first; the background tab then mounts
  // both hooks and only performs the extra fetch needed to satisfy age.
  expect(envANameHook.result.current).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
    },
  });
  expect(envBHooks.result.current.name).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
    },
  });
  expect(envBHooks.result.current.age).toMatchObject({
    status: 'success',
    data: {
      age: 30,
    },
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);

  const envBFetchCountBeforeFocusedRefetch = countFetchHistoryEntries(
    envB.serverTable.fetchHistory,
    'fetch',
  );
  expect(envBFetchCountBeforeFocusedRefetch).toBe(1);
  expect(envB.serverTable.fetchHistory[0]).toMatchObject({
    type: 'fetch',
    fields: ['age', 'name'],
  });

  // A focused-tab name-only refetch should update the matching background hook
  // from the incoming item snapshot without making the background tab refetch.
  envA.serverTable.setItem('users||1', {
    id: 1,
    name: 'Alicia',
    age: 30,
  });
  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name'],
  });
  await flushAllTimers();

  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch')).toBe(
    2,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    envBFetchCountBeforeFocusedRefetch,
  );
  expect(envBHooks.result.current.name).toMatchObject({
    status: 'success',
    data: {
      name: 'Alicia',
    },
  });
  expect(envBHooks.result.current.age).toMatchObject({
    status: 'success',
    data: {
      age: 30,
    },
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(envB.store.state.items[itemKey]).toEqual({
    age: 30,
    name: 'Alicia',
  });
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | age-hook | name-hook | users||1 |
    810ms | -        | -         | -        | [name-hook] ui-initialized
    .     | -        | -         | -        | [age-hook] ui-changed
    1.82s | -        | -         | -        | 🔴 [users||1] >fetch-started
    2.62s | -        | -         | -        | 🔴 [users||1] <fetch-finished (value: {"age":30,"name":"Alice"})
    .     | -        | Alice     | -        | [name-hook] ui-changed
    .     | 30       | Alice     | -        | [age-hook] ui-changed
    3.43s | 30       | Alice     | -        | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia","age":30})
    .     | 30       | Alicia    | -        | [name-hook] ui-changed
    "
  `);
});

test('list query partial-resources remote query snapshots satisfy affected field-subset hooks without refetching unaffected sibling hooks', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-field-subset-invalidation');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedListQueryServerTableState<Row>({
    users: [{ id: 1, name: 'Alice', age: 30 }],
  });

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('a'),
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('b'),
      partialResources: partialResourcesConfig,
    },
  );

  void envB.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    {
      fields: ['name', 'age'],
    },
  );
  await flushAllTimers();

  const envBListFetchCountBeforeInvalidation = countFetchHistoryEntries(
    envB.serverTable.fetchHistory,
    'list',
  );
  const envBQueries = renderHook(() => {
    const name = envB.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetches: true,
        fields: ['name'],
        loadSize: 1,
      },
    );
    const age = envB.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetches: true,
        fields: ['age'],
        loadSize: 1,
      },
    );

    envB.trackItemUI('name-query', name.items[0]?.name);
    envB.trackItemUI('age-query', getTrackedAge(age.items[0]?.age));

    return { name, age };
  });
  await advanceTime(0);

  expect(envBQueries.result.current.name).toMatchObject({
    status: 'success',
    items: [{ name: 'Alice' }],
  });
  expect(envBQueries.result.current.age).toMatchObject({
    status: 'success',
    items: [{ age: 30 }],
  });

  act(() => {
    envB.apiStore.invalidateQueryAndItems({
      queryPayload: false,
      itemPayload: 'users||1',
      type: 'highPriority',
      fields: ['age'],
    });
  });
  await advanceTime(0);

  expect(envBQueries.result.current.name).toMatchObject({
    status: 'success',
    items: [{ name: 'Alice' }],
  });
  expect(envBQueries.result.current.age).toMatchObject({
    status: 'refetching',
    items: [{ age: 30 }],
  });

  envA.serverTable.setItem('users||1', {
    id: 1,
    name: 'Alice',
    age: 31,
  });
  void envA.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    {
      fields: ['age'],
    },
  );
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    envBListFetchCountBeforeInvalidation,
  );
  expect(envBQueries.result.current.name).toMatchObject({
    status: 'success',
    items: [{ name: 'Alice' }],
  });
  expect(envBQueries.result.current.age).toMatchObject({
    status: 'success',
    items: [{ age: 31 }],
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    1.81s | -        | server-data-changed (value: {"id":1,"name":"Alice","age":31})
    1.82s | -        | 🔴 >list-fetch-started
    2.62s | -        | 🔴 <list-fetch-finished (value: {"count":1})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | age-query | name-query |
    1.01s | -         | -          | 🔴 >list-fetch-started
    1.81s | -         | -          | 🔴 <list-fetch-finished (value: {"count":1})
    .     | -         | Alice      | [name-query] ui-initialized
    .     | 30        | Alice      | [age-query] ui-changed
    2.62s | 30        | Alice      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
    .     | 31        | Alice      | [age-query] ui-changed
    "
  `);
});

test('list query partial-resources full-resource list hooks refetch in one tab and update a sibling tab via query snapshots', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-full-resource-fields-star');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'b');
  const sharedServerTableState = createSharedListQueryServerTableState<Row>({
    users: [{ id: 1, name: 'Alice', age: 30 }],
  });

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('a'),
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('b'),
      partialResources: partialResourcesConfig,
    },
  );

  // Start with both tabs holding a full-resource snapshot so the later
  // invalidation exercises the query-snapshot update path, not initial loading.
  void envA.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    {
      fields: '*',
    },
  );
  await flushAllTimers();

  void envB.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    {
      fields: '*',
    },
  );
  await flushAllTimers();

  const envAListFetchCountBeforeInvalidation = countFetchHistoryEntries(
    envA.serverTable.fetchHistory,
    'list',
  );
  const envBListFetchCountBeforeInvalidation = countFetchHistoryEntries(
    envB.serverTable.fetchHistory,
    'list',
  );

  // Mount steady-state full-resource hooks on both tabs before invalidating.
  const envAQuery = renderHook(() => {
    const query = envA.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        fields: '*',
        loadSize: 1,
      },
    );

    envA.trackItemUI('users||1', getTrackedUserSummary(query.items[0]));
    return query;
  });
  const envBQuery = renderHook(() => {
    const query = envB.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        fields: '*',
        loadSize: 1,
      },
    );

    envB.trackItemUI('users||1', getTrackedUserSummary(query.items[0]));
    return query;
  });
  await advanceTime(0);

  act(() => {
    envB.serverTable.setItem('users||1', {
      id: 1,
      name: 'Alice',
      age: 31,
    });
    // Tab B performs the refetch; tab A should learn about the new full-resource
    // state only through the incoming browser-tab query snapshot.
    envB.apiStore.invalidateQueryAndItems({
      queryPayload: false,
      itemPayload: 'users||1',
      type: 'highPriority',
      fields: ['age'],
    });
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  // Tab B is the only tab that should refetch; tab A should only observe the
  // resulting browser-tab snapshot.
  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'list')).toBe(
    envAListFetchCountBeforeInvalidation,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    envBListFetchCountBeforeInvalidation + 1,
  );
  expect(envB.store.state.itemFieldInvalidationFields[itemKey]).toBeUndefined();
  expect(envAQuery.result.current).toMatchObject({
    status: 'success',
    items: [{ id: 1, name: 'Alice', age: 31 }],
  });
  expect(envBQuery.result.current).toMatchObject({
    status: 'success',
    items: [{ id: 1, name: 'Alice', age: 31 }],
  });

  // The timelines make the roles explicit: tab B fetches after invalidation,
  // and tab A only receives confirmed query snapshots.
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    1.01s | -        | 🔴 >list-fetch-started
    1.81s | -        | 🔴 <list-fetch-finished (value: {"count":1})
    2.62s | -        | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
    .     | Alice:30 | ui-initialized
    3.43s | Alice:30 | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
    .     | Alice:31 | ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    1.82s | -        | 🔴 >list-fetch-started
    2.62s | -        | 🔴 <list-fetch-finished (value: {"count":1})
    .     | Alice:30 | ui-initialized
    .     | Alice:30 | server-data-changed (value: {"id":1,"name":"Alice","age":31})
    2.63s | Alice:30 | 🟠 >list-fetch-started
    3.43s | Alice:30 | 🟠 <list-fetch-finished (value: {"count":1})
    .     | Alice:31 | ui-changed
    "
  `);
});

test('list query partial-resources remote snapshots clear satisfied local invalidation fields for affected and unaffected item hooks', async () => {
  const transportFactory = createInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId('list-query-field-invalidation');
  const tabs = createFocusChangeCoordinator(['a', 'b'], 'a');
  const sharedServerTableState = createSharedListQueryServerTableState<Row>({
    users: [{ id: 1, name: 'Alice', age: 30 }],
  });

  const envA = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('a'),
      partialResources: partialResourcesConfig,
    },
  );
  const envB = createListQueryStoreTestEnv(
    {
      users: [{ id: 1, name: 'Alice', age: 30 }],
    },
    {
      id,
      sharedServerTableState,
      browserTabsTransportFactory: transportFactory,
      bindFocusController: tabs.bind('b'),
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

  // Only the invalidated field becomes stale locally; the sibling snapshot will
  // later need to restore that field and clear the invalidation marker.
  expect(envB.store.state.itemLoadedFields[itemKey]).toEqual(['name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKey]).toEqual([
    'age',
  ]);

  // disableRefetches keeps these hooks from scheduling their own fetches so the
  // test only observes the sibling snapshot coming from tab A.
  const envBHooks = renderHook(() => {
    const name = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetches: true,
      fields: ['name'],
    });
    const age = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetches: true,
      fields: ['age'],
    });
    const full = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetches: true,
      fields: '*',
    });

    envB.trackItemUI('name-hook', name.data?.name ?? '-');
    envB.trackItemUI('age-hook', getTrackedAge(age.data?.age));
    envB.trackItemUI('full-hook', getTrackedUserSummary(full.data));

    return { name, age, full };
  });
  await advanceTime(0);

  // Before tab A refetches, unaffected hooks should stay readable and the full
  // hook should continue exposing the cached object instead of dropping to loading.
  expect(envBHooks.result.current.name).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
    },
  });
  expect(envBHooks.result.current.age).toMatchObject({
    status: 'success',
    data: {
      age: 30,
    },
  });
  expect(envBHooks.result.current.full).toMatchObject({
    status: 'success',
    data: {
      age: 30,
      name: 'Alice',
    },
  });

  envA.serverTable.setItem('users||1', {
    id: 1,
    name: 'Alice',
    age: 31,
  });
  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['age'],
  });
  await flushAllTimers();

  // The remote fetch should update tab B without any new local fetch, restore
  // the invalidated metadata, and refresh both the affected and full-resource hooks.
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKey]).toBeUndefined();
  expect(envBHooks.result.current.name).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
    },
  });
  expect(envBHooks.result.current.age).toMatchObject({
    status: 'success',
    data: {
      age: 31,
    },
  });
  expect(envBHooks.result.current.full).toMatchObject({
    status: 'success',
    data: {
      age: 31,
      name: 'Alice',
    },
  });
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | age-hook | full-hook | name-hook | users||1 |
    1.01s | -        | -         | -         | -        | 🔴 [users||1] >fetch-started
    1.81s | -        | -         | -         | -        | 🔴 [users||1] <fetch-finished (value: {"name":"Alice","age":30})
    .     | -        | -         | Alice     | -        | [name-hook] ui-initialized
    .     | 30       | -         | Alice     | -        | [age-hook] ui-changed
    .     | 30       | Alice:30  | Alice     | -        | [full-hook] ui-changed
    2.62s | 30       | Alice:30  | Alice     | -        | [users||1] <confirmed-item-snapshot-received (value: {"age":31})
    .     | 31       | Alice:30  | Alice     | -        | [age-hook] ui-changed
    .     | 31       | Alice:31  | Alice     | -        | [full-hook] ui-changed
    "
  `);
});
