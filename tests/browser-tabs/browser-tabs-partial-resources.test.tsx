import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createInspectableInMemoryBrowserTabsTransportFactory,
  getNextStoreId,
} from '../mocks/browserTabsTestUtils';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
  type ListQueryStoreTestScenario,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { setDefaultLowPriorityThrottleMs } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  countFetchHistoryEntries,
  createFocusChangeCoordinator,
  createUsersTable,
  getMessageKinds,
  getNonStatusMessages,
  getPublisherTabIds,
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

function getTrackedAge(value: unknown): string | undefined {
  return typeof value === 'number' ? String(value) : undefined;
}

function getTrackedUserSummary(value: unknown): string | undefined {
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

  return undefined;
}

function getTrackedErrorMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return value.message;
  }

  return undefined;
}

type EnvOverrides = {
  testScenario?: ListQueryStoreTestScenario;
  lowPriorityThrottleMs?: number;
  usesRealTimeUpdates?: boolean;
};

function createEnvs({
  storeId,
  data,
  focusedTab,
  usesRealTimeUpdates,
  lowPriorityThrottleMs,
  envA: envAOverrides,
  envB: envBOverrides,
}: {
  storeId: string;
  data: Tables<Row>;
  focusedTab: 'a' | 'b' | null;
  usesRealTimeUpdates?: boolean;
  lowPriorityThrottleMs?: number;
  envA?: EnvOverrides;
  envB?: EnvOverrides;
}) {
  const transport = createInspectableInMemoryBrowserTabsTransportFactory();
  const id = getNextStoreId(storeId);
  const tabs = createFocusChangeCoordinator(['a', 'b'], focusedTab);
  const sharedServerTableState =
    createSharedListQueryServerTableState<Row>(data);

  const envA = createListQueryStoreTestEnv(data, {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    bindFocusController: tabs.bind('a'),
    partialResources: partialResourcesConfig,
    usesRealTimeUpdates:
      envAOverrides?.usesRealTimeUpdates ?? usesRealTimeUpdates,
    lowPriorityThrottleMs:
      envAOverrides?.lowPriorityThrottleMs ?? lowPriorityThrottleMs,
    testScenario: envAOverrides?.testScenario,
  });
  const envB = createListQueryStoreTestEnv(data, {
    id,
    sharedServerTableState,
    browserTabsTransportFactory: transport.transportFactory,
    bindFocusController: tabs.bind('b'),
    partialResources: partialResourcesConfig,
    usesRealTimeUpdates:
      envBOverrides?.usesRealTimeUpdates ?? usesRealTimeUpdates,
    lowPriorityThrottleMs:
      envBOverrides?.lowPriorityThrottleMs ?? lowPriorityThrottleMs,
    testScenario: envBOverrides?.testScenario,
  });

  return { envA, envB, tabs, transport, sharedServerTableState };
}

test('list query partial-resource snapshots do not seed an untouched sibling item tab', async () => {
  const { envA, envB, tabs, transport } = createEnvs({
    storeId: 'list-query-partial-background-item',
    data: createUsersTable(),
    focusedTab: null,
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
  const envAFetchEntries = envA.serverTable.fetchHistory.filter(
    (e) => e.type === 'fetch',
  );
  expect(envAFetchEntries[0]).toMatchObject({
    fields: ['name'],
  });
  const messages = getNonStatusMessages(transport.getMessages());
  expect(messages.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messages).size).toBe(1);
  expect(getMessageKinds(messages)).toEqual(
    expect.arrayContaining(['list-item-snapshot']),
  );
  expect(
    envB.store.state.items[envB.getStoreItemKeyFromRaw('users||1')],
  ).toBeUndefined();
  expect(
    envB.store.state.itemLoadedFields[envB.getStoreItemKeyFromRaw('users||1')],
  ).toBeUndefined();
  expect(
    envB.store.state.itemQueries[envB.getStoreItemKeyFromRaw('users||1')],
  ).toBeUndefined();
});

test('a fresh partial-resource list-query tab still performs its first fetch after a sibling tab fetched earlier', async () => {
  const { envA, envB, transport } = createEnvs({
    storeId: 'list-query-partial-first-fetch-after-sibling',
    data: createUsersTable(),
    focusedTab: null,
    lowPriorityThrottleMs: 10_000,
    envA: { testScenario: { loaded: { tables: ['users'] } } },
    envB: { testScenario: 'idle' },
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

  const queryKey = envB.getQueryKey({ tableId: 'users' });
  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  const messagesAfterSiblingFetch = getNonStatusMessages(
    transport.getMessages(),
  );
  expect(messagesAfterSiblingFetch.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messagesAfterSiblingFetch).size).toBe(1);
  expect(getMessageKinds(messagesAfterSiblingFetch)).toEqual(
    expect.arrayContaining(['list-query-snapshot']),
  );
  expect(envB.store.state.queries[queryKey]).toBeUndefined();
  expect(envB.store.state.items[itemKey]).toBeUndefined();

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
    1.01s | 🔴 >list-fetch-started
    1.81s | 🔴 <list-fetch-finished (value: {"count":2})
    3.62s | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | users||1 |
    1.81s | ···      | ui-initialized
    2.82s | ···      | 🔴 >list-fetch-started
    3.62s | ···      | 🔴 <list-fetch-finished (value: {"count":2})
    .     | Alice    | ui-changed
    "
  `);
});

test('list query partial-resources field metadata updates an already-loaded sibling tab', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-fields',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

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

    envB.trackItemUI('name-hook', item.data?.name);
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
    time  | name-hook |
    1.01s | -         | 🔴 [users||1] >fetch-started
    1.81s | -         | 🔴 [users||1] <fetch-finished (value: {"age":30})
    .     | ···       | [name-hook] ui-initialized
    2.62s | ···       | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia"})
    .     | Alicia    | [name-hook] ui-changed
    "
  `);
});

test('focused partial-resource item refetch updates the matching background hook without refetching a sibling field hook', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-focused-item-refetch-name',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

  const envANameHook = renderHook(() => {
    const item = envA.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name'],
    });

    envA.trackItemUI('name-hook', item.data?.name);
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

    envB.trackItemUI('name-hook', name.data?.name);
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
  const envBFetchEntries = envB.serverTable.fetchHistory.filter(
    (e) => e.type === 'fetch',
  );
  expect(envBFetchEntries[0]).toMatchObject({
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
    time  | age-hook | name-hook |
    810ms | ···      | ···       | [name-hook, age-hook] ui-initialized
    1.82s | ···      | ···       | 🔴 [users||1] >fetch-started
    2.62s | ···      | ···       | 🔴 [users||1] <fetch-finished (value: {"age":30,"name":"Alice"})
    .     | 30       | Alice     | [name-hook, age-hook] ui-changed
    3.43s | 30       | Alice     | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia","age":30})
    .     | 30       | Alicia    | [name-hook] ui-changed
    "
  `);
});

test('focused RTU item refetch lets a background tab reuse snapshot fields and refetch only its extra field', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-focused-item-rtu-extra-field',
    data: { users: [{ id: 1, name: 'Alice', age: 30, city: 'London' }] },
    focusedTab: 'a',
    usesRealTimeUpdates: true,
  });

  // Tab A loads the overlapping fields first so tab B can later reuse the
  // incoming snapshot for name/age and fetch only its extra city field.
  const envAHook = renderHook(() => {
    const item = envA.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name', 'age'],
    });

    envA.trackItemUI('name-age-hook', getTrackedUserSummary(item.data));
    return item;
  });
  await flushAllTimers();

  const envBHooks = renderHook(() => {
    const nameAge = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name', 'age'],
    });
    const city = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['city'],
    });

    envB.trackItemUI('name-age-hook', getTrackedUserSummary(nameAge.data));
    envB.trackItemUI(
      'city-hook',
      typeof city.data?.city === 'string' ? city.data.city : null,
    );

    return { nameAge, city };
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(envAHook.result.current).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
      age: 30,
    },
  });
  expect(envBHooks.result.current.nameAge).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
      age: 30,
    },
  });
  expect(envBHooks.result.current.city).toMatchObject({
    status: 'success',
    data: {
      city: 'London',
    },
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'city', 'name']);

  const envAFetchCountBeforeRTU = countFetchHistoryEntries(
    envA.serverTable.fetchHistory,
    'fetch',
  );
  const envBFetchCountBeforeRTU = countFetchHistoryEntries(
    envB.serverTable.fetchHistory,
    'fetch',
  );
  expect(envAFetchCountBeforeRTU).toBe(1);
  expect(envBFetchCountBeforeRTU).toBe(1);

  envA.clearTimeline();
  envB.clearTimeline();

  // A real-time update changes all fields. The focused tab should refetch the
  // overlapping name/age fields, while the background tab only refetches city.
  act(() => {
    envA.serverTable.setItem(
      'users||1',
      {
        id: 1,
        name: 'Alicia',
        age: 31,
        city: 'Lisbon',
      },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  const envAFetchEntries = envA.serverTable.fetchHistory.filter(
    (entry) => entry.type === 'fetch',
  );
  const envBFetchEntries = envB.serverTable.fetchHistory.filter(
    (entry) => entry.type === 'fetch',
  );
  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch')).toBe(
    envAFetchCountBeforeRTU + 1,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    envBFetchCountBeforeRTU + 1,
  );
  expect(envAFetchEntries.at(-1)).toMatchObject({
    fields: ['age', 'name'],
  });
  expect(envBFetchEntries.at(-1)).toMatchObject({
    fields: ['city'],
  });
  expect(envAHook.result.current).toMatchObject({
    status: 'success',
    data: {
      name: 'Alicia',
      age: 31,
    },
  });
  expect(envBHooks.result.current.nameAge).toMatchObject({
    status: 'success',
    data: {
      name: 'Alicia',
      age: 31,
    },
  });
  expect(envBHooks.result.current.city).toMatchObject({
    status: 'success',
    data: {
      city: 'Lisbon',
    },
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'city', 'name']);
  expect(envB.store.state.items[itemKey]).toEqual({
    age: 31,
    city: 'Lisbon',
    name: 'Alicia',
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | name-age-hook |
    2.62s | Alice:30      | -- timeline-cleared
    .     | Alice:30      | [users||1] server-data-changed (value: {"id":1,"name":"Alicia","age":31,"city":"Lisbon"})
    .     | Alice:30      | [users||1] received-ws-data-change-event
    .     | ···           | [name-age-hook] ui-changed
    2.63s | ···           | 🟠 [users||1] >fetch-started
    3.43s | ···           | 🟠 [users||1] <fetch-finished (value: {"age":31,"name":"Alicia"})
    .     | Alicia:31     | [name-age-hook] ui-changed
    5.24s | Alicia:31     | [users||1] <confirmed-item-snapshot-received (value: {"age":31,"city":"Lisbon","name":"Alicia"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | city-hook | name-age-hook |
    2.62s | London    | Alice:30      | -- timeline-cleared
    .     | London    | Alice:30      | [users||1] received-ws-data-change-event
    .     | ···       | ···           | [name-age-hook, city-hook] ui-changed
    3.43s | ···       | ···           | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia","age":31,"city":"London"})
    .     | ···       | Alicia:31     | [name-age-hook] ui-changed
    4.44s | ···       | Alicia:31     | 🟠 [users||1] >fetch-started
    5.24s | ···       | Alicia:31     | 🟠 [users||1] <fetch-finished (value: {"city":"Lisbon"})
    .     | Lisbon    | Alicia:31     | [city-hook] ui-changed
    "
  `);
});

test('focused RTU item refetch lets a background tab reuse snapshot fields and refetch only its extra field 2', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-focused-item-rtu-extra-field',
    data: { users: [{ id: 1, name: 'Alice', age: 30, city: 'London' }] },
    focusedTab: 'a',
    usesRealTimeUpdates: true,
  });

  // Tab A loads the overlapping fields first so tab B can later reuse the
  // incoming snapshot for name/age and fetch only its extra city field.
  const envAHook = renderHook(() => {
    const item = envA.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name', 'age'],
    });

    return envA.trackItemUI(
      'name-age',
      item.data ? `${item.data.name}:${item.data.age}` : null,
    );
  });
  await flushAllTimers();

  const envBHooks = renderHook(() => {
    const item = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      fields: ['name', 'age', 'city'],
    });

    return envB.trackItemUI(
      'name-age-city',
      item.data ? `${item.data.name}:${item.data.age}:${item.data.city}` : null,
    );
  });
  await flushAllTimers();

  expect(envAHook.result.current).toBe('Alice:30');
  expect(envBHooks.result.current).toBe('Alice:30:London');

  const envAFetchCountBeforeRTU = countFetchHistoryEntries(
    envA.serverTable.fetchHistory,
    'fetch',
  );
  const envBFetchCountBeforeRTU = countFetchHistoryEntries(
    envB.serverTable.fetchHistory,
    'fetch',
  );
  expect(envAFetchCountBeforeRTU).toBe(1);
  expect(envBFetchCountBeforeRTU).toBe(1);

  envA.clearTimeline();
  envB.clearTimeline();

  // A real-time update changes all fields. The focused tab should refetch the
  // overlapping name/age fields, while the background tab only refetches city.
  act(() => {
    envA.serverTable.setItem(
      'users||1',
      {
        id: 1,
        name: 'Alicia',
        age: 31,
        city: 'Lisbon',
      },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  const envAFetchEntries = envA.serverTable.fetchHistory.filter(
    (entry) => entry.type === 'fetch',
  );
  const envBFetchEntries = envB.serverTable.fetchHistory.filter(
    (entry) => entry.type === 'fetch',
  );
  expect(countFetchHistoryEntries(envA.serverTable.fetchHistory, 'fetch')).toBe(
    envAFetchCountBeforeRTU + 1,
  );
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    envBFetchCountBeforeRTU + 1,
  );
  expect(envAFetchEntries.at(-1)).toMatchObject({
    fields: ['age', 'name'],
  });
  expect(envBFetchEntries.at(-1)).toMatchObject({
    fields: ['city'],
  });
  expect(envAHook.result.current).toBe('Alicia:31');
  expect(envBHooks.result.current).toBe('Alicia:31:Lisbon');

  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | name-age  |
    2.62s | Alice:30  | -- timeline-cleared
    .     | Alice:30  | [users||1] server-data-changed (value: {"id":1,"name":"Alicia","age":31,"city":"Lisbon"})
    .     | Alice:30  | [users||1] received-ws-data-change-event
    .     | ···       | [name-age] ui-changed
    2.63s | ···       | 🟠 [users||1] >fetch-started
    3.43s | ···       | 🟠 [users||1] <fetch-finished (value: {"age":31,"name":"Alicia"})
    .     | Alicia:31 | [name-age] ui-changed
    5.24s | Alicia:31 | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia","age":31,"city":"Lisbon"})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | name-age-city    |
    2.62s | Alice:30:London  | -- timeline-cleared
    .     | Alice:30:London  | [users||1] received-ws-data-change-event
    .     | ···              | [name-age-city] ui-changed
    3.43s | ···              | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia","age":31,"city":"London"})
    4.44s | ···              | 🟠 [users||1] >fetch-started
    5.24s | ···              | 🟠 [users||1] <fetch-finished (value: {"city":"Lisbon"})
    .     | Alicia:31:Lisbon | [name-age-city] ui-changed
    "
  `);
});

test('focused RTU list refetch lets makes a background tab correctly invalidate the list with extra fields', async () => {
  const { envA: focusedTab, envB: backgroundTab } = createEnvs({
    storeId: 'list-query-focused-item-rtu-extra-field',
    data: {
      users: [
        { id: 1, name: 'Alice', age: 30, city: 'London' },
        { id: 2, name: 'Bob', age: 25, city: 'Paris' },
      ],
    },
    focusedTab: 'a',
    usesRealTimeUpdates: true,
  });

  renderHook(() => {
    const list = focusedTab.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        fields: ['name', 'age'],
        loadSize: 2,
      },
    );

    focusedTab.trackItemUI(
      'first-item',
      list.items[0] && `${list.items[0].name}:${list.items[0].age}`,
    );
    focusedTab.trackItemUI(
      'second-item',
      list.items[1] && `${list.items[1].name}:${list.items[1].age}`,
    );
  });
  await flushAllTimers();

  renderHook(() => {
    const list = backgroundTab.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        fields: ['name', 'age', 'city'],
        loadSize: 2,
      },
    );

    backgroundTab.trackItemUI(
      'first-item',
      list.items[0] &&
        `${list.items[0].name}:${list.items[0].age}:${list.items[0].city}`,
    );
    backgroundTab.trackItemUI(
      'second-item',
      list.items[1] &&
        `${list.items[1].name}:${list.items[1].age}:${list.items[1].city}`,
    );
  });
  await flushAllTimers();

  focusedTab.clearTimeline();
  backgroundTab.clearTimeline();

  act(() => {
    focusedTab.serverTable.setItem(
      'users||1',
      {
        id: 1,
        name: 'Alicia',
        age: 31,
        city: 'Lisbon',
      },
      { triggerRTUEvent: true },
    );
  });
  await flushAllTimers();

  expect(focusedTab.timelineString).toMatchInlineSnapshot(`
    "
    time  | first-item | second-item |
    2.62s | Alice:30   | Bob:25      | -- timeline-cleared
    .     | Alice:30   | Bob:25      | [users||1] server-data-changed (value: {"id":1,"name":"Alicia","age":31,"city":"Lisbon"})
    .     | Alice:30   | Bob:25      | [users||1] received-ws-data-change-event
    .     | ···        | ···         | [first-item, second-item] ui-changed
    2.63s | ···        | ···         | 🟠 >list-fetch-started
    3.43s | ···        | ···         | 🟠 <list-fetch-finished (value: {"count":2})
    .     | Alicia:31  | Bob:25      | [first-item, second-item] ui-changed
    5.24s | Alicia:31  | Bob:25      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    "
  `);
  expect(backgroundTab.timelineString).toMatchInlineSnapshot(`
    "
    time  | first-item       | second-item  |
    2.62s | Alice:30:London  | Bob:25:Paris | -- timeline-cleared
    .     | Alice:30:London  | Bob:25:Paris | [users||1] received-ws-data-change-event
    .     | ···              | ···          | [first-item, second-item] ui-changed
    3.43s | ···              | ···          | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":2})
    4.44s | ···              | ···          | 🟠 >list-fetch-started
    5.24s | ···              | ···          | 🟠 <list-fetch-finished (value: {"count":2})
    .     | Alicia:31:Lisbon | Bob:25:Paris | [first-item, second-item] ui-changed
    "
  `);
  expect(backgroundTab.serverTable.getRequestMadeHistory('list'))
    .toMatchInlineSnapshot(`
      - payload:
          fields: ['name', 'age', 'city']
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '1.82s -> 2.62s | duration: 800ms'
      - payload:
          fields: ['name', 'age', 'city']
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '4.44s -> 5.24s | duration: 800ms'
    `);
});

test('list query partial-resources remote query snapshots satisfy affected field-subset hooks without refetching unaffected sibling hooks', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-field-subset-invalidation',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

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
    time  |
    1.81s | server-data-changed (value: {"id":1,"name":"Alice","age":31})
    1.82s | 🔴 >list-fetch-started
    2.62s | 🔴 <list-fetch-finished (value: {"count":1})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | age-query | name-query |
    1.01s | -         | -          | 🔴 >list-fetch-started
    1.81s | -         | -          | 🔴 <list-fetch-finished (value: {"count":1})
    .     | 30        | Alice      | [name-query, age-query] ui-initialized
    2.62s | 30        | Alice      | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
    .     | 31        | Alice      | [age-query] ui-changed
    "
  `);
});

test('list query partial-resources full-resource list hooks refetch in one tab and update a sibling tab via query snapshots', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-full-resource-fields-star',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'b',
  });

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
  const { envA, envB } = createEnvs({
    storeId: 'list-query-field-invalidation',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

  void envB.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name', 'age'],
  });
  await flushAllTimers();

  const itemKey = envB.getStoreItemKeyFromRaw('users||1');
  expect(
    [...(envB.store.state.itemLoadedFields[itemKey] ?? [])].sort(),
  ).toEqual(['age', 'name']);

  act(() => {
    envB.apiStore.invalidateQueryAndItems({
      queryPayload: false,
      itemPayload: 'users||1',
      type: 'highPriority',
      fields: ['age'],
    });
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

    envB.trackItemUI('name-hook', name.data?.name);
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
    time  | age-hook | full-hook | name-hook |
    1.01s | -        | -         | -         | 🔴 [users||1] >fetch-started
    1.81s | -        | -         | -         | 🔴 [users||1] <fetch-finished (value: {"name":"Alice","age":30})
    .     | 30       | Alice:30  | Alice     | [name-hook, age-hook, full-hook] ui-initialized
    2.62s | 30       | Alice:30  | Alice     | [users||1] <confirmed-item-snapshot-received (value: {"age":31})
    .     | 31       | Alice:31  | Alice     | [age-hook, full-hook] ui-changed
    "
  `);
});

// review below this
test('a sibling partial snapshot for one field does not clear a local invalidation for a different field', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-partial-cross-field-invalidation',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

  // Both tabs load name+age.
  void envB.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name', 'age'],
  });
  await flushAllTimers();

  const itemKeyB = envB.getStoreItemKeyFromRaw('users||1');
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

    envB.trackItemUI('name-hook', name.data?.name);
    envB.trackItemUI('age-hook', getTrackedAge(age.data?.age));

    return { name, age };
  });
  await advanceTime(0);

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
    [...(envB.store.state.itemLoadedFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['age', 'name']);

  // Tab B invalidates both fields, but disableRefetches keeps the hooks pinned to
  // their cached values until sibling snapshots arrive.
  act(() => {
    envB.apiStore.invalidateQueryAndItems({
      queryPayload: false,
      itemPayload: 'users||1',
      type: 'highPriority',
      fields: ['name', 'age'],
    });
  });
  await advanceTime(0);

  expect(envB.store.state.itemLoadedFields[itemKeyB]).toEqual([]);
  expect(
    [...(envB.store.state.itemFieldInvalidationFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['age', 'name']);
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

  // Tab A refetches only 'name'. The incoming snapshot should clear the name
  // invalidation on tab B, update only the matching hook, and leave the age
  // invalidation in place.
  envA.serverTable.setItem('users||1', {
    id: 1,
    name: 'Alicia',
    age: 31,
  });
  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name'],
  });
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
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
  expect(envB.store.state.itemLoadedFields[itemKeyB]).toEqual(['name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKeyB]).toEqual([
    'age',
  ]);
  expect(envB.store.state.items[itemKeyB]).toEqual({
    age: 30,
    name: 'Alicia',
  });

  // A second fetch from tab A for 'age' clears the remaining invalidation and
  // updates the remaining stale hook.
  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['age'],
  });
  await flushAllTimers();

  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
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
      age: 31,
    },
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(
    envB.store.state.itemFieldInvalidationFields[itemKeyB],
  ).toBeUndefined();
  expect(envB.store.state.items[itemKeyB]).toEqual({
    age: 31,
    name: 'Alicia',
  });
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    1.81s | server-data-changed (value: {"id":1,"name":"Alicia","age":31})
    1.82s | 🔴 >fetch-started
    2.62s | 🔴 <fetch-finished (value: {"name":"Alicia"})
    2.63s | 🟠 >fetch-started
    3.43s | 🟠 <fetch-finished (value: {"age":31})
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | age-hook | name-hook |
    1.01s | -        | -         | 🔴 [users||1] >fetch-started
    1.81s | -        | -         | 🔴 [users||1] <fetch-finished (value: {"name":"Alice","age":30})
    .     | 30       | Alice     | [name-hook, age-hook] ui-initialized
    2.62s | 30       | Alice     | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia"})
    .     | 30       | Alicia    | [name-hook] ui-changed
    3.43s | 30       | Alicia    | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alicia","age":31})
    .     | 31       | Alicia    | [age-hook] ui-changed
    "
  `);
});

test('failed partial-resource list query fetch does not broadcast stale metadata to sibling tab', async () => {
  const { envA, envB, transport } = createEnvs({
    storeId: 'list-query-partial-list-fetch-error',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

  void envA.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    {
      fields: ['name', 'age'],
    },
  );
  await flushAllTimers();
  void envB.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    {
      fields: ['name', 'age'],
    },
  );
  await flushAllTimers();

  const itemKeyB = envB.getStoreItemKeyFromRaw('users||1');
  expect(
    [...(envB.store.state.itemLoadedFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['age', 'name']);

  envB.apiStore.invalidateQueryAndItems({
    queryPayload: false,
    itemPayload: 'users||1',
    type: 'highPriority',
    fields: ['age'],
  });
  await advanceTime(0);

  expect(envB.store.state.itemLoadedFields[itemKeyB]).toEqual(['name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKeyB]).toEqual([
    'age',
  ]);

  const envAQuery = renderHook(() => {
    const query = envA.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetches: true,
        fields: ['name', 'age'],
        loadSize: 1,
      },
    );

    envA.trackItemUI('query', getTrackedUserSummary(query.items[0]));
    envA.trackItemUI('query-status', query.status);
    envA.trackItemUI('query-error', getTrackedErrorMessage(query.error));

    return query;
  });
  const envBQuery = renderHook(() => {
    const query = envB.apiStore.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetches: true,
        fields: ['name', 'age'],
        loadSize: 1,
      },
    );

    envB.trackItemUI('query', getTrackedUserSummary(query.items[0]));
    envB.trackItemUI('query-status', query.status);
    envB.trackItemUI('query-error', getTrackedErrorMessage(query.error));

    return query;
  });
  await advanceTime(0);

  expect(envBQuery.result.current).toMatchObject({
    status: 'refetching',
    items: [{ name: 'Alice', age: 30 }],
  });

  const messagesBeforeFailedFetch = getNonStatusMessages(
    transport.getMessages(),
  ).length;

  act(() => {
    envA.serverTable.setItem('users||1', {
      id: 1,
      name: 'Alice',
      age: 31,
    });
    envA.serverTable.setNextListFetchError('Network error');
    void envA.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'users' },
      1,
      {
        fields: ['name', 'age'],
      },
    );
  });
  await flushAllTimers();

  const messagesAfterFailedFetch = getNonStatusMessages(
    transport.getMessages(),
  ).slice(messagesBeforeFailedFetch);
  expect(messagesAfterFailedFetch.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messagesAfterFailedFetch).size).toBe(1);
  expect(getMessageKinds(messagesAfterFailedFetch)).toEqual(
    expect.arrayContaining(['fetch-start']),
  );
  expect(getMessageKinds(messagesAfterFailedFetch)).not.toContain(
    'fetch-success',
  );
  expect(getMessageKinds(messagesAfterFailedFetch)).not.toContain(
    'list-query-snapshot',
  );

  expect(envAQuery.result.current).toMatchObject({
    status: 'error',
    items: [{ name: 'Alice', age: 30 }],
  });
  expect(envAQuery.result.current.error).toMatchObject({
    message: 'Network error',
  });
  expect(envBQuery.result.current).toMatchObject({
    status: 'refetching',
    items: [{ name: 'Alice', age: 30 }],
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['name']);
  expect(envB.store.state.itemFieldInvalidationFields[itemKeyB]).toEqual([
    'age',
  ]);
  expect(envB.store.state.items[itemKeyB]).toEqual({
    age: 30,
    name: 'Alice',
  });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'list')).toBe(
    1,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | query    | query-error   | query-status |
    10ms  | -        | -             | -            | 🔴 >list-fetch-started
    810ms | -        | -             | -            | 🔴 <list-fetch-finished (value: {"count":1})
    2.62s | -        | -             | -            | <confirmed-query-snapshot-received (value: {"queryKey":"{tableId:\\"users\\"}","itemCount":1})
    .     | Alice:30 | ···           | success      | [query, query-status, query-error] ui-initialized
    .     | Alice:30 | ···           | success      | [users||1] server-data-changed (value: {"id":1,"name":"Alice","age":31})
    2.63s | Alice:30 | ···           | success      | 🟠 >list-fetch-started
    .     | Alice:30 | ···           | refetching   | [query-status] ui-changed
    3.43s | Alice:30 | ···           | refetching   | 🟠 <list-fetch-error (value: "error")
    .     | Alice:30 | Network error | error        | [query-status, query-error] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | query    | query-error | query-status |
    1.82s | -        | -           | -            | 🔴 >list-fetch-started
    2.62s | -        | -           | -            | 🔴 <list-fetch-finished (value: {"count":1})
    .     | Alice:30 | ···         | refetching   | [query, query-status, query-error] ui-initialized
    "
  `);
});

test('failed partial-resource item fetch does not broadcast stale metadata to sibling tab', async () => {
  const { envA, envB, transport } = createEnvs({
    storeId: 'list-query-partial-fetch-error',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

  // Both tabs load all fields initially.
  void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name', 'age'],
  });
  await flushAllTimers();
  void envB.apiStore.scheduleItemFetch('highPriority', 'users||1', {
    fields: ['name', 'age'],
  });
  await flushAllTimers();

  const itemKeyA = envA.getStoreItemKeyFromRaw('users||1');
  const itemKeyB = envB.getStoreItemKeyFromRaw('users||1');

  const envAHook = renderHook(() => {
    const item = envA.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetches: true,
      fields: ['name', 'age'],
    });

    envA.trackItemUI('item', getTrackedUserSummary(item.data));
    envA.trackItemUI('item-status', item.status);
    envA.trackItemUI('item-error', getTrackedErrorMessage(item.error));

    return item;
  });
  const envBHook = renderHook(() => {
    const item = envB.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetches: true,
      fields: ['name', 'age'],
    });

    envB.trackItemUI('item', getTrackedUserSummary(item.data));
    envB.trackItemUI('item-status', item.status);
    envB.trackItemUI('item-error', getTrackedErrorMessage(item.error));

    return item;
  });
  await advanceTime(0);

  // Tab A invalidates 'age' and the subsequent refetch fails.
  act(() => {
    envA.apiStore.invalidateQueryAndItems({
      queryPayload: false,
      itemPayload: 'users||1',
      type: 'highPriority',
      fields: ['age'],
    });
  });
  await advanceTime(0);

  expect(envA.store.state.itemLoadedFields[itemKeyA]).toEqual(['name']);
  expect(envA.store.state.itemFieldInvalidationFields[itemKeyA]).toEqual([
    'age',
  ]);

  const messagesBeforeFailedFetch = getNonStatusMessages(
    transport.getMessages(),
  ).length;

  act(() => {
    envA.serverTable.setNextFetchError('users||1', 'Network error');
    void envA.apiStore.scheduleItemFetch('highPriority', 'users||1', {
      fields: ['age'],
    });
  });
  await flushAllTimers();

  const messagesAfterFailedFetch = getNonStatusMessages(
    transport.getMessages(),
  ).slice(messagesBeforeFailedFetch);
  expect(messagesAfterFailedFetch.length).toBeGreaterThan(0);
  expect(getPublisherTabIds(messagesAfterFailedFetch).size).toBe(1);
  expect(getMessageKinds(messagesAfterFailedFetch)).toEqual(
    expect.arrayContaining(['fetch-start']),
  );
  expect(getMessageKinds(messagesAfterFailedFetch)).not.toContain(
    'fetch-success',
  );
  expect(getMessageKinds(messagesAfterFailedFetch)).not.toContain(
    'list-item-snapshot',
  );

  // After the error, tab A clears the invalidation marker but age remains
  // missing from loaded fields.
  expect(envAHook.result.current).toMatchObject({
    status: 'error',
    data: {
      name: 'Alice',
      age: 30,
    },
  });
  expect(envAHook.result.current.error).toMatchObject({
    message: 'Network error',
  });
  expect(envA.store.state.itemLoadedFields[itemKeyA]).toEqual(['name']);
  expect(
    envA.store.state.itemFieldInvalidationFields[itemKeyA],
  ).toBeUndefined();

  // Tab B must be completely unaffected — no error snapshot is broadcast, and
  // the sibling's field metadata stays intact.
  expect(envBHook.result.current).toMatchObject({
    status: 'success',
    data: {
      name: 'Alice',
      age: 30,
    },
  });
  expect(
    [...(envB.store.state.itemLoadedFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(
    envB.store.state.itemFieldInvalidationFields[itemKeyB],
  ).toBeUndefined();
  expect(envB.store.state.items[itemKeyB]).toEqual({
    age: 30,
    name: 'Alice',
  });
  expect(countFetchHistoryEntries(envB.serverTable.fetchHistory, 'fetch')).toBe(
    1,
  );
  expect(envA.timelineString).toMatchInlineSnapshot(`
    "
    time  | item     | item-error    | item-status |
    10ms  | -        | -             | -           | 🔴 [users||1] >fetch-started
    810ms | -        | -             | -           | 🔴 [users||1] <fetch-finished (value: {"name":"Alice","age":30})
    2.62s | -        | -             | -           | [users||1] <confirmed-item-snapshot-received (value: {"name":"Alice","age":30})
    .     | Alice:30 | ···           | success     | [item, item-status, item-error] ui-initialized
    2.63s | Alice:30 | ···           | success     | 🟠 [users||1] >fetch-started
    .     | Alice:30 | ···           | success     | 🟠 [users||1] <fetch-error (value: "error")
    .     | Alice:30 | Network error | error       | [item-status, item-status, item-error] ui-changed
    "
  `);
  expect(envB.timelineString).toMatchInlineSnapshot(`
    "
    time  | item     | item-error | item-status |
    1.82s | -        | -          | -           | 🔴 [users||1] >fetch-started
    2.62s | -        | -          | -           | 🔴 [users||1] <fetch-finished (value: {"name":"Alice","age":30})
    .     | Alice:30 | ···        | success     | [item, item-status, item-error] ui-initialized
    "
  `);
});

test('item deletion on one tab cleans up partial-resource field metadata on sibling tab', async () => {
  const { envA, envB } = createEnvs({
    storeId: 'list-query-partial-deletion-cleanup',
    data: { users: [{ id: 1, name: 'Alice', age: 30 }] },
    focusedTab: 'a',
  });

  // Load fields on both tabs and populate a query so we can verify removal.
  void envA.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    { fields: ['name', 'age'] },
  );
  await flushAllTimers();
  void envB.apiStore.scheduleListQueryFetch(
    'highPriority',
    { tableId: 'users' },
    1,
    { fields: ['name', 'age'] },
  );
  await flushAllTimers();

  const itemKeyB = envB.getStoreItemKeyFromRaw('users||1');
  const queryKeyB = envB.getQueryKey({ tableId: 'users' });

  expect(
    [...(envB.store.state.itemLoadedFields[itemKeyB] ?? [])].sort(),
  ).toEqual(['age', 'name']);
  expect(envB.store.state.queries[queryKeyB]?.items).toContain(itemKeyB);

  // Invalidate age on tab B so we can verify the invalidation metadata is also
  // cleaned up when the deletion snapshot arrives.
  envB.apiStore.invalidateQueryAndItems({
    queryPayload: false,
    itemPayload: 'users||1',
    type: 'highPriority',
    fields: ['age'],
  });
  await advanceTime(0);

  expect(envB.store.state.itemFieldInvalidationFields[itemKeyB]).toEqual([
    'age',
  ]);

  // Advance time so the deletion snapshot has a strictly newer sentAt than any
  // previously recorded sync version on tab B.
  await advanceTime(1);

  // Tab A deletes the item — tab B should receive the deletion snapshot and
  // clean up all field metadata.
  envA.apiStore.deleteItemState('users||1');
  await flushAllTimers();

  expect(envB.store.state.items[itemKeyB]).toBe(null);
  expect(envB.store.state.itemQueries[itemKeyB]).toBe(null);
  expect(envB.store.state.itemLoadedFields[itemKeyB]).toBeUndefined();
  expect(
    envB.store.state.itemFieldInvalidationFields[itemKeyB],
  ).toBeUndefined();
  expect(envB.store.state.queries[queryKeyB]?.items).not.toContain(itemKeyB);
});
