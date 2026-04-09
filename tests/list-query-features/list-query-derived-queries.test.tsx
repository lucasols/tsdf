import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import '@testing-library/react/dont-cleanup-after-each';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';

import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import type { DerivedQueriesConfig } from '../../src/main';
import { createOfflineSession } from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { listQueryQueryPayloadSchema } from '../offline/offlineTestShared';
import { advanceTime, flushAllTimers, range } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';

const partialResourcesConfig: PartialResourcesConfig<Row> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
};

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({ id: rc_number, name: rc_string, age: rc_number.optional() }),
);

const initialServerData: Tables = {
  users: [
    { id: 1, name: 'Ada', age: 31 },
    { id: 2, name: 'Grace', age: 32 },
    { id: 3, name: 'Alan', age: 33 },
  ],
  products: range(1, 3).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 2).map((id) => ({ id, name: `Order ${id}` })),
};

type TestDerivedQueriesConfig = DerivedQueriesConfig<
  Row,
  ListQueryParams,
  string
>;

function getQueryGroup(queryPayload: ListQueryParams) {
  return queryPayload.tableId;
}

function getItemGroup(_item: Row, itemPayload: string) {
  return itemPayload.split('||')[0] ?? '';
}

const alwaysComplete: TestDerivedQueriesConfig['isComplete'] = () => true;

function getStartsWithNameFilter(queryPayload: ListQueryParams) {
  for (const filter of queryPayload.filters ?? []) {
    if (filter.op === 'startsWith' && filter.field === 'name') {
      return filter.value;
    }
  }

  return null;
}

function seedLocalRows(
  env: { apiStore: { addItemToState: (itemKey: string, row: Row) => void } },
  rows: Array<{ itemKey: string; row: Row }>,
) {
  for (const { itemKey, row } of rows) {
    env.apiStore.addItemToState(itemKey, row);
  }
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterAll(() => {
  cleanup();
  vi.useRealTimers();
});

type TestDeriveQuery = TestDerivedQueriesConfig['deriveQuery'];

test('online exact cached queries stay exact instead of being re-derived from the group', async () => {
  const deriveQuery = vi.fn<TestDeriveQuery>((queryPayload, items) => {
    const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

    return items
      .filter(({ data }) =>
        startsWithFilterValue
          ? data.name.startsWith(startsWithFilterValue)
          : true,
      )
      .sort((left, right) => left.data.name.localeCompare(right.data.name))
      .map(({ key }) => key);
  });
  const isComplete = vi.fn(alwaysComplete);

  // Start from a realistic warm-cache state where the exact query already exists.
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { tables: ['users'] } },
    derivedQueries: { getQueryGroup, getItemGroup, isComplete, deriveQuery },
  });

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true },
    ),
  );

  // Mount the hook and let any pending warm-cache work settle.
  await flushAllTimers();

  // The exact query result should win immediately, so derived query helpers stay unused.
  expect({
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemNames: ['Ada', 'Grace', 'Alan']
  `);
  expect(isComplete).not.toHaveBeenCalled();
  expect(deriveQuery).not.toHaveBeenCalled();
});

test('online filtered queries can be derived from a complete local group without creating a synthetic cache entry', async () => {
  const deriveQuery = vi.fn<TestDeriveQuery>((queryPayload, items) => {
    const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

    return items
      .filter(({ data }) =>
        startsWithFilterValue
          ? data.name.startsWith(startsWithFilterValue)
          : true,
      )
      .sort((left, right) => left.data.name.localeCompare(right.data.name))
      .map(({ key }) => key);
  });
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery,
    },
  });

  // Seed the full users group locally without seeding the filtered query itself.
  seedLocalRows(env, [
    { itemKey: 'users||1', row: { id: 1, name: 'Ada' } },
    { itemKey: 'users||2', row: { id: 2, name: 'Grace' } },
    { itemKey: 'users||3', row: { id: 3, name: 'Alan' } },
  ]);

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      {
        tableId: 'users',
        filters: [{ field: 'name', op: 'startsWith', value: 'A' }],
      },
      { disableRefetchOnMount: true },
    ),
  );

  // Derived results resolve synchronously from the local group.
  await act(async () => {
    await Promise.resolve();
  });

  // The hook should expose the filtered result without storing a fake query or hitting the server.
  expect({
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
    queryKeys: Object.keys(env.store.state.queries),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '✅'
    itemNames: ['Ada', 'Alan']
    queryKeys: []
    requests: []
  `);

  const onlineDerivedContext = deriveQuery.mock.lastCall?.[2];
  if (!onlineDerivedContext) {
    throw new Error('Expected deriveQuery to receive context');
  }

  expect(onlineDerivedContext).toMatchInlineSnapshot(`
    deriveSource: 'online'
    isOfflineMode: '❌'
  `);
});

test('the same hook recomputes derived results when the query payload changes', async () => {
  const renders = createLoggerStore({ arrays: 'all' });
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
  });

  // Seed a complete users group locally so the hook can keep deriving across rerenders.
  seedLocalRows(env, [
    { itemKey: 'users||1', row: { id: 1, name: 'Ada' } },
    { itemKey: 'users||2', row: { id: 2, name: 'Grace' } },
    { itemKey: 'users||3', row: { id: 3, name: 'Alan' } },
  ]);

  const hook = renderHook(
    ({ startsWith }: { startsWith: string }) => {
      const query = env.apiStore.useListQuery(
        {
          tableId: 'users',
          filters: [{ field: 'name', op: 'startsWith', value: startsWith }],
        },
        { disableRefetchOnMount: true },
      );

      renders.add({
        filter: startsWith,
        isDerived: query.isDerived,
        itemNames: query.items.map((item) => item.name),
      });

      return query;
    },
    { initialProps: { startsWith: 'A' } },
  );

  // Let the first derived render settle before changing the same hook payload.
  await act(async () => {
    await Promise.resolve();
  });

  renders.addMark('Change derived filter');

  // Rerender the same hook with a different filter, which is the real search/filter interaction path.
  act(() => {
    hook.rerender({ startsWith: 'G' });
  });
  await act(async () => {
    await Promise.resolve();
  });

  // The hook should recompute from the local group immediately instead of fetching or freezing the old selection.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> filter: A ⋅ isDerived: ✅ ⋅ itemNames: [Ada, Alan]

    >>> Change derived filter

    -> filter: G ⋅ isDerived: ✅ ⋅ itemNames: [Grace]
    "
  `);
  expect({
    itemNames: hook.result.current.items.map((item) => item.name),
    queryKeys: Object.keys(env.store.state.queries),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    itemNames: ['Grace']
    queryKeys: []
    requests: []
  `);
});

test('online queries fetch from the server when the local group is incomplete', async () => {
  const deriveQuery = vi.fn<TestDeriveQuery>((queryPayload, items) => {
    const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

    return items
      .filter(({ data }) =>
        startsWithFilterValue
          ? data.name.startsWith(startsWithFilterValue)
          : true,
      )
      .sort((left, right) => left.data.name.localeCompare(right.data.name))
      .map(({ key }) => key);
  });
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: () => false,
      deriveQuery,
    },
  });

  seedLocalRows(env, [
    { itemKey: 'users||1', row: { id: 1, name: 'Ada' } },
    { itemKey: 'users||2', row: { id: 2, name: 'Grace' } },
  ]);

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      { tableId: 'users' },
      { returnRefetchingStatus: true },
    ),
  );

  // Let the fetch complete so we can assert the final steady state and request contract.
  await flushAllTimers();

  // Incomplete local state must skip derivation and fall back to the normal list fetch.
  expect({
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemNames: ['Ada', 'Grace', 'Alan']
    requests:
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 3
  `);
  expect(deriveQuery).not.toHaveBeenCalled();
});

test('online queries fetch when deriveQuery explicitly declines to derive a result', async () => {
  const deriveQuery = vi.fn<TestDeriveQuery>(() => false as const);
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery,
    },
  });

  // Seed a complete group so the only reason to skip derivation is the explicit `false` return.
  seedLocalRows(env, [
    { itemKey: 'users||1', row: { id: 1, name: 'Ada' } },
    { itemKey: 'users||2', row: { id: 2, name: 'Grace' } },
    { itemKey: 'users||3', row: { id: 3, name: 'Alan' } },
  ]);

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      {
        tableId: 'users',
        filters: [{ field: 'name', op: 'startsWith', value: 'A' }],
      },
      { returnRefetchingStatus: true },
    ),
  );

  // Let the hook attempt derivation, then complete the fallback fetch.
  await flushAllTimers();

  // `deriveQuery === false` should behave like "cannot derive", not like an empty success result.
  expect({
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemNames: ['Ada', 'Alan']
    requests:
      - _type: 'list'
        payload:
          fields: '*'
          filters:
            - { field: 'name', op: 'startsWith', value: 'A' }
          pos: { limit: 50, offset: 0 }
        returned_items: 2
  `);
  // Verify the full group was passed to deriveQuery — it chose to decline, not that it received incomplete data.
  const lastDeriveCall = deriveQuery.mock.lastCall;
  if (!lastDeriveCall) {
    throw new Error('Expected deriveQuery to be called');
  }

  const [, derivedItems] = lastDeriveCall;

  expect(derivedItems.map(({ data }) => data.name)).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Alan']
  `);
});

test('online queries do not synthesize an empty derived success when the group has no local items', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
  });

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      {
        tableId: 'users',
        filters: [{ field: 'name', op: 'startsWith', value: 'Z' }],
      },
      { returnRefetchingStatus: true },
    ),
  );

  // Before the fetch finishes, the hook should still be in a real loading state.
  expect({
    isDerived: hook.result.current.isDerived,
    itemCount: hook.result.current.items.length,
    status: hook.result.current.status,
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemCount: 0
    status: 'loading'
  `);

  // Once the server confirms the empty result, the query can settle successfully.
  await flushAllTimers();

  expect({
    isDerived: hook.result.current.isDerived,
    status: hook.result.current.status,
    itemNames: hook.result.current.items.map((item) => item.name),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemNames: []
    requests:
      - _type: 'list'
        payload:
          fields: '*'
          filters:
            - { field: 'name', op: 'startsWith', value: 'Z' }
          pos: { limit: 50, offset: 0 }
        returned_items: 0
    status: 'success'
  `);
});

test('derived query shows empty success when filter matches no items in a complete local group', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
  });

  // Seed the full users group so derivation runs on a complete dataset.
  seedLocalRows(env, [
    { itemKey: 'users||1', row: { id: 1, name: 'Ada' } },
    { itemKey: 'users||2', row: { id: 2, name: 'Grace' } },
    { itemKey: 'users||3', row: { id: 3, name: 'Alan' } },
  ]);

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      {
        tableId: 'users',
        filters: [{ field: 'name', op: 'startsWith', value: 'Z' }],
      },
      { disableRefetchOnMount: true },
    ),
  );

  // Let the derived result compute — no items match 'Z', but the group is complete, so
  // this is a legitimate empty derived success (not the "no data available" case).
  await act(async () => {
    await Promise.resolve();
  });

  expect({
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
    status: hook.result.current.status,
    queryKeys: Object.keys(env.store.state.queries),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '✅'
    itemNames: []
    queryKeys: []
    requests: []
    status: 'success'
  `);
});

test('derived results always expose hasMore false and skip loadMore', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
  });

  // Seed only local group items so the result must come from derivation, not an exact cached query.
  seedLocalRows(env, [
    { itemKey: 'users||1', row: { id: 1, name: 'Ada' } },
    { itemKey: 'users||2', row: { id: 2, name: 'Grace' } },
    { itemKey: 'users||3', row: { id: 3, name: 'Alan' } },
  ]);

  const derivedPayload: ListQueryParams = {
    tableId: 'users',
    filters: [{ field: 'name', op: 'startsWith', value: 'A' }],
  };
  const hook = renderHook(() =>
    env.apiStore.useListQuery(derivedPayload, { disableRefetchOnMount: true }),
  );

  // Let the hook compute the derived result before exercising the public pagination API.
  await act(async () => {
    await Promise.resolve();
  });

  // Derived queries advertise no next page, so loadMore should be a no-op through the public API.
  let loadMoreResult: ReturnType<typeof env.apiStore.loadMore> | undefined;
  act(() => {
    loadMoreResult = env.apiStore.loadMore(derivedPayload);
  });
  await flushAllTimers();

  expect({
    hasMore: hook.result.current.hasMore,
    isDerived: hook.result.current.isDerived,
    loadMoreResult,
    queryStateExists: env.apiStore.getQueryState(derivedPayload) !== undefined,
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    hasMore: '❌'
    isDerived: '✅'
    loadMoreResult: 'skipped'
    queryStateExists: '❌'
    requests: []
  `);
});

test('isComplete receives sibling query metadata from the same derived group', async () => {
  const isComplete = vi.fn(() => false);
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: {
      loaded: {
        queries: [
          {
            tableId: 'users',
            filters: [{ field: 'name', op: 'startsWith', value: 'A' }],
          },
          {
            tableId: 'users',
            filters: [{ field: 'name', op: 'startsWith', value: 'G' }],
          },
        ],
      },
    },
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
  });

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      {
        tableId: 'users',
        filters: [{ field: 'name', op: 'startsWith', value: 'Al' }],
      },
      { returnRefetchingStatus: true },
    ),
  );

  // Let the completeness check run and the fallback fetch finish.
  await flushAllTimers();

  // The derived-query completeness check should see the existing sibling queries in the same group.
  expect(isComplete).toHaveBeenCalled();
  const lastIsCompleteCall = __LEGIT_CAST__<
    | [
        ListQueryParams,
        {
          queries: Array<{
            payload: ListQueryParams;
            hasMore: boolean;
            itemCount: number;
          }>;
        },
      ]
    | undefined,
    unknown
  >(isComplete.mock.lastCall);
  if (!lastIsCompleteCall) {
    throw new Error('Expected isComplete to be called');
  }

  expect(lastIsCompleteCall[1]).toMatchInlineSnapshot(`
    queries:
      - hasMore: '❌'
        itemCount: 2
        payload:
          filters:
            - { field: 'name', op: 'startsWith', value: 'A' }
          tableId: 'users'
      - hasMore: '❌'
        itemCount: 1
        payload:
          filters:
            - { field: 'name', op: 'startsWith', value: 'G' }
          tableId: 'users'
  `);
  expect({
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemNames: ['Alan']
    requests:
      - _type: 'list'
        payload:
          fields: '*'
          filters:
            - { field: 'name', op: 'startsWith', value: 'Al' }
          pos: { limit: 50, offset: 0 }
        returned_items: 1
  `);
});

test('offline derived queries stay sticky across reconnect until the query is invalidated', async () => {
  const network = createOfflineNetworkMock();
  network.install();
  const sessionKey = 'derived-queries-offline';
  const renders = createLoggerStore({ arrays: 'all' });
  const deriveQuery = vi.fn<TestDeriveQuery>((queryPayload, items) => {
    const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

    return items
      .filter(({ data }) =>
        startsWithFilterValue
          ? data.name.startsWith(startsWithFilterValue)
          : true,
      )
      .sort((left, right) => left.data.name.localeCompare(right.data.name))
      .map(({ key }) => key);
  });
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery,
    },
    persistentStorage: {
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryQueryPayloadSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
        operations: {},
      },
    },
    getSessionKey: () => sessionKey,
    testScenario: { loaded: { tables: ['users'] } },
  });

  renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true, returnRefetchingStatus: true },
    );

    renders.add({
      status: query.status,
      isOnline: network.isOnline(),
      isDerived: query.isDerived,
      itemNames: query.items.map((item) => item.name),
    });
  });

  // Mount in a normal online exact-cache state first.
  await flushAllTimers();

  // Going offline plus a local-only item should switch the hook to the derived group view.
  act(() => {
    network.goOffline();
    env.apiStore.addItemToState('users||99', { id: 99, name: 'Offline user' });
  });
  await flushAllTimers();

  renders.addMark('Reconnect without invalidation');

  // Reconnecting alone should not drop the sticky derived result or trigger a refetch yet.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // No server requests — the sticky derived result stays active until explicit invalidation.
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }).length,
  ).toBe(0);
  expect(
    Array.from(
      new Map(
        deriveQuery.mock.calls.map(([, , context]) => {
          return [
            `${context.deriveSource}:${context.isOfflineMode}`,
            {
              deriveSource: context.deriveSource,
              isOfflineMode: context.isOfflineMode,
            },
          ];
        }),
      ).values(),
    ),
  ).toMatchInlineSnapshot(`
    - { deriveSource: 'offline', isOfflineMode: '✅' }
    - { deriveSource: 'sticky-offline', isOfflineMode: '❌' }
  `);

  renders.addMark('Invalidate after reconnect');

  // Explicit invalidation is what clears the sticky derived mode and resumes normal fetching.
  act(() => {
    env.apiStore.invalidateQueryAndItems({
      itemPayload: false,
      queryPayload: { tableId: 'users' },
      type: 'lowPriority',
    });
  });
  await flushAllTimers();

  // Invalidation cleared sticky mode and triggered exactly one server fetch.
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }).length,
  ).toBe(1);
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ isOnline: ✅ ⋅ isDerived: ❌ ⋅ itemNames: [Ada, Grace, Alan]
    ┌─
    ⋅ status: success
    ⋅ isOnline: ❌
    ⋅ isDerived: ✅
    ⋅ itemNames: [Ada, Alan, Grace, Offline user]
    └─

    >>> Reconnect without invalidation

    ┌─
    ⋅ status: success
    ⋅ isOnline: ✅
    ⋅ isDerived: ✅
    ⋅ itemNames: [Ada, Alan, Grace, Offline user]
    └─

    >>> Invalidate after reconnect

    -> status: success ⋅ isOnline: ✅ ⋅ isDerived: ❌ ⋅ itemNames: [Ada, Grace, Alan]
    -> status: refetching ⋅ isOnline: ✅ ⋅ isDerived: ❌ ⋅ itemNames: [Ada, Grace, Alan]
    -> status: success ⋅ isOnline: ✅ ⋅ isDerived: ❌ ⋅ itemNames: [Ada, Grace, Alan]
    "
  `);
});

test('sticky offline-derived queries keep following local updates and deletes until invalidation', async () => {
  const network = createOfflineNetworkMock();
  network.install();
  const sessionKey = 'derived-queries-offline-local-edits';
  const renders = createLoggerStore({ arrays: 'all' });
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
    persistentStorage: {
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryQueryPayloadSchema,
      offline: {
        session: createOfflineSession({
          getSessionKey: () => sessionKey,
          config: { network: network.config },
        }),
        operations: {},
      },
    },
    getSessionKey: () => sessionKey,
    testScenario: { loaded: { tables: ['users'] } },
  });

  renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true, returnRefetchingStatus: true },
    );

    renders.add({
      status: query.status,
      isDerived: query.isDerived,
      itemNames: query.items.map((item) => item.name),
    });
  });

  // Start from the normal exact result, then switch into sticky offline-derived mode.
  await flushAllTimers();
  act(() => {
    network.goOffline();
    env.apiStore.addItemToState('users||99', { id: 99, name: 'Offline user' });
  });
  await flushAllTimers();

  renders.addMark('Update while offline');

  // Local edits should immediately re-run the derived ordering while the query stays sticky-derived.
  act(() => {
    env.apiStore.updateItemState('users||2', (item) => ({
      ...item,
      name: 'Beatrice',
    }));
  });
  await flushAllTimers();

  renders.addMark('Delete while offline');

  // Deleting a local item should also recompute the sticky derived result instead of freezing stale items.
  act(() => {
    env.apiStore.deleteItemState('users||1');
  });
  await flushAllTimers();

  renders.addMark('Reconnect without invalidation');

  // Reconnecting still must not fetch until invalidation explicitly clears sticky mode.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  // No server requests — the sticky derived result survives reconnection.
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }).length,
  ).toBe(0);
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ isDerived: ❌ ⋅ itemNames: [Ada, Grace, Alan]
    -> status: success ⋅ isDerived: ✅ ⋅ itemNames: [Ada, Alan, Grace, Offline user]

    >>> Update while offline

    -> status: success ⋅ isDerived: ✅ ⋅ itemNames: [Ada, Alan, Beatrice, Offline user]

    >>> Delete while offline

    -> status: success ⋅ isDerived: ✅ ⋅ itemNames: [Alan, Beatrice, Offline user]

    >>> Reconnect without invalidation

    -> status: success ⋅ isDerived: ✅ ⋅ itemNames: [Alan, Beatrice, Offline user]
    "
  `);
});

test('derived partial results still fetch missing fields before settling on the server result', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
  });

  // Only seed the fields that make the query derivable, not the full item shape the hook asks for.
  seedLocalRows(env, [{ itemKey: 'users||1', row: { id: 1, name: 'Ada' } }]);

  const hook = renderHook(() =>
    env.apiStore.useListQuery(
      { tableId: 'users' },
      {
        fields: ['id', 'name', 'age'],
        returnRefetchingStatus: true,
        showPartialAsRefetching: true,
      },
    ),
  );

  // The first render can be derived, but it still needs a fetch because `age` is missing.
  expect({
    isDerived: hook.result.current.isDerived,
    itemCount: hook.result.current.items.length,
    status: hook.result.current.status,
  }).toMatchInlineSnapshot(`
    isDerived: '✅'
    itemCount: 1
    status: 'refetching'
  `);

  // Once the fetch finishes, the exact server result should replace the temporary derived result.
  await flushAllTimers();

  expect({
    isDerived: hook.result.current.isDerived,
    items: hook.result.current.items,
    requests: env.serverTable.getRequestHistory('list', { includeTime: false }),
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    items:
      - { age: 31, id: 1, name: 'Ada' }
      - { age: 32, id: 2, name: 'Grace' }
      - { age: 33, id: 3, name: 'Alan' }
    requests:
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'age']
          pos: { limit: 50, offset: 0 }
        returned_items: 3
  `);
});

test('useMultipleListQueries can return exact, derived, and fetched results in the same render', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
    testScenario: { loaded: { tables: ['users'] } },
  });

  // Only the products query relies on derivation; orders still need a real fetch.
  seedLocalRows(env, [
    { itemKey: 'products||1', row: { id: 1, name: 'Derived product 1' } },
    { itemKey: 'products||2', row: { id: 2, name: 'Derived product 2' } },
  ]);

  const hook = renderHook(() =>
    env.apiStore.useMultipleListQueries([
      { payload: { tableId: 'users' }, disableRefetchOnMount: true },
      { payload: { tableId: 'products' }, disableRefetchOnMount: true },
      { payload: { tableId: 'orders' }, returnRefetchingStatus: true },
    ]),
  );

  // Flush the exact query reuse and the outstanding orders fetch together.
  await flushAllTimers();

  // The combined hook should keep each query on its natural resolution path.
  expect(
    hook.result.current.map((query) => ({
      isDerived: query.isDerived,
      itemNames: query.items.map((item) => item.name),
      status: query.status,
    })),
  ).toMatchInlineSnapshot(`
    - isDerived: '❌'
      itemNames: ['Ada', 'Grace', 'Alan']
      status: 'success'
    - isDerived: '✅'
      itemNames: ['Derived product 1', 'Derived product 2']
      status: 'success'
    - isDerived: '❌'
      itemNames: ['Order 1', 'Order 2']
      status: 'success'
  `);
});

test('offline derived query hydration only loads the requested group from persistence', async () => {
  const network = createOfflineNetworkMock();
  network.install();
  const sessionKey = 'derived-queries-persisted-groups';
  const storeId = 'derived-queries-persisted-groups-store';
  const persistentStorage = {
    adapter: 'local-sync' as const,
    schema: rowSchema,
    itemPayloadSchema: rc_string,
    queryPayloadSchema: listQueryQueryPayloadSchema,
    offline: {
      session: createOfflineSession({
        getSessionKey: () => sessionKey,
        config: { network: network.config },
      }),
      operations: {},
    },
  };

  // First persist multiple groups so the restart has more data available than the new hook asks for.
  const firstEnv = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
    getSessionKey: () => sessionKey,
    id: storeId,
    persistentStorage,
  });

  const seedHook = renderHook(() => {
    const users = firstEnv.apiStore.useListQuery({ tableId: 'users' });
    const products = firstEnv.apiStore.useListQuery({ tableId: 'products' });
    return { users, products };
  });

  // Let both groups fetch and flush to persistence before simulating the offline restart.
  await flushAllTimers();
  await advanceTime(1100);
  await flushAllTimers();
  seedHook.unmount();

  // Restart offline so the next hook can only hydrate from persistence.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  const restartedEnv = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
    getSessionKey: () => sessionKey,
    id: storeId,
    persistentStorage,
  });

  const hook = renderHook(() =>
    restartedEnv.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true },
    ),
  );

  // Hydration should materialize only the users group that this hook actually requested.
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  expect({
    hydratedItemKeys: Object.keys(restartedEnv.store.state.items).sort(),
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
  }).toMatchInlineSnapshot(`
    hydratedItemKeys: ['"users||1', '"users||2', '"users||3']
    isDerived: '✅'
    itemNames: ['Ada', 'Alan', 'Grace']
  `);
});

test('offline derived query hydration with opfs preloads only the requested group', async () => {
  const network = createOfflineNetworkMock();
  network.install();
  const sessionKey = 'derived-queries-opfs-groups';
  const storeId = 'derived-queries-opfs-groups-store';
  const mockAdapter = createOpfsPersistentStorageTestStore();
  const persistentStorage = {
    adapter: opfsPersistentStorage,
    schema: rowSchema,
    itemPayloadSchema: rc_string,
    queryPayloadSchema: listQueryQueryPayloadSchema,
    offline: {
      session: createOfflineSession({
        getSessionKey: () => sessionKey,
        config: { network: network.config },
      }),
      operations: {},
    },
  };

  // First persist multiple groups through the real store so OPFS records derived-group metadata.
  const firstEnv = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
    getSessionKey: () => sessionKey,
    id: storeId,
    persistentStorage,
  });

  const seedHook = renderHook(() => {
    const users = firstEnv.apiStore.useListQuery({ tableId: 'users' });
    const products = firstEnv.apiStore.useListQuery({ tableId: 'products' });
    return { users, products };
  });

  // Let both groups fetch, then wait for the debounced OPFS persistence writes to finish.
  await flushAllTimers();
  await advanceTime(1100);
  await flushAllTimers();
  seedHook.unmount();

  expect(mockAdapter.scope(storeId, sessionKey).listQuery.listStoredItemKeys())
    .toMatchInlineSnapshot(`
      - '"products||1'
      - '"products||2'
      - '"products||3'
      - '"users||1'
      - '"users||2'
      - '"users||3'
    `);

  // Restart offline so the next hook can only derive from async-preloaded persisted items.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();
  mockAdapter.clearReadRequests();

  const restartedEnv = createListQueryStoreTestEnv(initialServerData, {
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery: (queryPayload, items) => {
        const startsWithFilterValue = getStartsWithNameFilter(queryPayload);

        return items
          .filter(({ data }) =>
            startsWithFilterValue
              ? data.name.startsWith(startsWithFilterValue)
              : true,
          )
          .sort((left, right) => left.data.name.localeCompare(right.data.name))
          .map(({ key }) => key);
      },
    },
    getSessionKey: () => sessionKey,
    id: storeId,
    persistentStorage,
  });

  const hook = renderHook(() =>
    restartedEnv.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true },
    ),
  );

  // Give the async derived-group preload effect time to hydrate the requested users group.
  await act(async () => {
    await Promise.resolve();
  });
  await flushAllTimers();

  // Only the requested users group should be hydrated into state; unrelated persisted groups stay cold.
  expect({
    hydratedItemKeys: Object.keys(restartedEnv.store.state.items).sort(),
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
    readRequests: mockAdapter.scopeReadRequests({
      sessionKey,
      storeName: storeId,
    }),
  }).toMatchInlineSnapshot(`
    hydratedItemKeys: ['"users||1', '"users||2', '"users||3']
    isDerived: '✅'
    itemNames: ['Ada', 'Alan', 'Grace']
    readRequests: ['lq.{tableId:"users"}', 'li."users||1', 'li."users||2', 'li."users||3']
  `);
});
