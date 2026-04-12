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
import {
  getLocalStorageTree,
  getOpfsDirTree,
  startOpfsPersistentStorageOperationCapture,
  startPersistentStorageOperationCapture,
} from '../utils/persistentStorageOptimizationTestUtils';

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
            `${context.deriveSource}:${context.isOfflineMode}:${JSON.stringify(context.fields)}`,
            {
              fields: context.fields,
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

test('deriveQuery receives partial fields and can skip derivation for partial-resource queries', async () => {
  const deriveQuery = vi.fn<TestDeriveQuery>((queryPayload, items, context) => {
    if (Array.isArray(context.fields) && context.fields.includes('age')) {
      return false;
    }

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
    partialResources: partialResourcesConfig,
    derivedQueries: {
      getQueryGroup,
      getItemGroup,
      isComplete: alwaysComplete,
      deriveQuery,
    },
  });

  // Only seed the fields that make the query group sortable, not the full item
  // shape the hook asks for.
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

  // Partial-resource derivation policy now lives in `deriveQuery`, so it can
  // decline to derive when the requested fields are not fully present locally.
  expect({
    isDerived: hook.result.current.isDerived,
    itemCount: hook.result.current.items.length,
    status: hook.result.current.status,
  }).toMatchInlineSnapshot(`
    isDerived: '❌'
    itemCount: 0
    status: 'loading'
  `);

  const partialFieldsContext = deriveQuery.mock.lastCall?.[2];
  if (!partialFieldsContext) {
    throw new Error('Expected deriveQuery to receive partial fields context');
  }

  expect(partialFieldsContext).toMatchInlineSnapshot(`
    deriveSource: 'online'
    fields: ['id', 'name', 'age']
    isOfflineMode: '❌'
  `);

  // Once the fetch finishes, the exact server result should settle normally.
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

  // Snapshot the persisted local-sync state so the restart coverage also
  // protects the stored query membership and item index shape.
  expect(getLocalStorageTree()).toMatchInlineSnapshot(`
    "tsdf (2.13 kb)
    ├ _m.r.n:derived-queries-persisted-groups.derived-queries-persisted-groups-store.li.m (0.81 kb)
    └ derived-queries-persisted-groups.derived-queries-persisted-groups-store (1.31 kb)
      ├ li (0.73 kb)
      │ ├ "products||1 (0.12 kb)
      │ ├ "products||2 (0.12 kb)
      │ ├ "products||3 (0.12 kb)
      │ ├ "users||1 (0.12 kb)
      │ ├ "users||2 (0.12 kb)
      │ └ "users||3 (0.12 kb)
      └ lq (0.44 kb)
        ├ {tableId:"products"} (0.23 kb)
        └ {tableId:"users"} (0.21 kb)"
  `);

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

  // Drain the one-off local-sync startup scan so the next capture focuses only
  // on the restart hydration path that this test cares about.
  await advanceTime(2100);
  await flushAllTimers();
  restartedEnv.clearTimeline();
  restartedEnv.addTimelineComments('beforeNextAction', [
    'mount only the users query after restart; products should stay cold',
  ]);

  const hydrationCapture = startPersistentStorageOperationCapture();
  const hook = renderHook(() => {
    const query = restartedEnv.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true },
    );

    restartedEnv.trackItemUI('query-status', query.status);
    restartedEnv.trackItemUI(
      'query-items',
      query.items.map((item) => item.name).join(', '),
    );
    restartedEnv.trackItemUI('is-derived', query.isDerived ? 'yes' : 'no');

    return query;
  });

  // Hydration should materialize only the users group that this hook actually requested.
  await act(async () => {
    await Promise.resolve();
  });
  const hydrationOperations = hydrationCapture.finish().timelineString;
  await flushAllTimers();

  expect(hydrationOperations).toMatchInlineSnapshot(`
    "
    time |
    0    | 📖 #1 ✅ tsdf.derived-queries-persisted-groups.derived-queries-persisted-groups-store.lq.{tableId:"users"}
         |    └ (query data, <{tableId:"users"}>) | 0.17 kb
    .    | 📖 #2 ✅ tsdf._m.r.n:derived-queries-persisted-groups.derived-queries-persisted-groups-store.li.m
         |    └ (items index) | 0.66 kb
    .    | 📖 #3 ✅ tsdf.derived-queries-persisted-groups.derived-queries-persisted-groups-store.li."users||1
         |    └ (item data, <"users||1>) | 0.10 kb
    .    | 📖 #2 ✅ tsdf._m.r.n:derived-queries-persisted-groups.derived-queries-persisted-groups-store.li.m
         |    └ (items index) | 0.66 kb ⚠️ REPEATED READ <10ms UNCHANGED
    .    | 📖 #4 ✅ tsdf.derived-queries-persisted-groups.derived-queries-persisted-groups-store.li."users||2
         |    └ (item data, <"users||2>) | 0.10 kb
    .    | 📖 #2 ✅ tsdf._m.r.n:derived-queries-persisted-groups.derived-queries-persisted-groups-store.li.m
         |    └ (items index) | 0.66 kb ⚠️ REPEATED READ <10ms UNCHANGED
    .    | 📖 #5 ✅ tsdf.derived-queries-persisted-groups.derived-queries-persisted-groups-store.li."users||3
         |    └ (item data, <"users||3>) | 0.10 kb
    "
  `);
  expect(hydrationOperations).not.toContain('products');
  expect(restartedEnv.timelineString).toMatchInlineSnapshot(`
    "
    time | is-derived | query-items      | query-status |
    2.1s | -          | -                | -            | -- timeline-cleared
    .    | -          | -                | -            | -- mount only the users query after restart; products should stay cold
    .    | yes        | Ada, Alan, Grace | success      | [query-status, query-items, is-derived, query-status, query-items, is-derived] ui-initialized
    "
  `);
  expect({
    hydratedItemKeys: Object.keys(restartedEnv.store.state.items).sort(),
    hydratedProductItemKeys: Object.keys(restartedEnv.store.state.items)
      .filter((itemKey) => itemKey.includes('products'))
      .sort(),
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
  }).toMatchInlineSnapshot(`
    hydratedItemKeys: ['"users||1', '"users||2', '"users||3']
    hydratedProductItemKeys: []
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

  // Snapshot the persisted OPFS layout so the test also protects which groups
  // and exact queries were written before the offline restart.
  expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
    "tsdf (2.14 kb)
    ├ derived-queries-opfs-groups (2.07 kb)
    │ └ derived-queries-opfs-groups-store (2.02 kb)
    │   ├ li._i.r.json (0.79 kb)
    │   ├ li.h~1937155452.p.json (0.11 kb)
    │   ├ li.h~228010772.p.json (0.10 kb)
    │   ├ li.h~3098628732.p.json (0.10 kb)
    │   ├ li.h~3224064498.p.json (0.10 kb)
    │   ├ li.h~4067562186.p.json (0.10 kb)
    │   ├ li.h~993806230.p.json (0.09 kb)
    │   ├ lq._i.r.json (0.31 kb)
    │   ├ lq.h~2167180490.p.json (0.14 kb)
    │   └ lq.h~2902406637.p.json (0.12 kb)
    └ tsdf._am.g* (0.06 kb)"
  `);

  // Restart offline so the next hook can only derive from async-preloaded persisted items.
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

  // Drain the one-off async startup scan so the next capture isolates the
  // derived-group preload reads for this restart path.
  await advanceTime(3000);
  await flushAllTimers();
  mockAdapter.clearInstrumentation();
  restartedEnv.clearTimeline();
  restartedEnv.addTimelineComments('beforeNextAction', [
    'mount only the users query after restart; products should stay cold',
  ]);

  const hydrationCapture =
    startOpfsPersistentStorageOperationCapture(mockAdapter);
  const hook = renderHook(() => {
    const query = restartedEnv.apiStore.useListQuery(
      { tableId: 'users' },
      { disableRefetchOnMount: true },
    );

    restartedEnv.trackItemUI('query-status', query.status);
    restartedEnv.trackItemUI(
      'query-items',
      query.items.map((item) => item.name).join(', '),
    );
    restartedEnv.trackItemUI('is-derived', query.isDerived ? 'yes' : 'no');

    return query;
  });

  // Give the async derived-group preload effect time to hydrate the requested users group.
  await act(async () => {
    await Promise.resolve();
  });
  await advanceTime(250);
  const hydrationOperations = hydrationCapture.finish().timelineString;
  await flushAllTimers();

  expect(hydrationOperations).toMatchInlineSnapshot(`
    "
    time |
    0    | 📖 #1 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/lq._i.r.json
         |    └ (queries index) | 0.28 kb
    .    | 📖 #2 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/li._i.r.json
         |    └ (items index) | 0.77 kb
    3ms  | 📖 #3 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/lq.h~2902406637.p.json
         |    └ (query data, <{tableId:"users"}>) | 0.08 kb
    .    | 📖 #2 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/li._i.r.json
         |    └ (items index) | 0.77 kb ⚠️ REPEATED READ <10ms UNCHANGED
    6ms  | 📖 #4 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/li.h~228010772.p.json
         |    └ (item data, <"users||1>) | 0.06 kb
    .    | 📖 #5 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/li.h~1937155452.p.json
         |    └ (item data, <"users||2>) | 0.06 kb
    .    | 📖 #6 tsdf/derived-queries-opfs-groups/derived-queries-opfs-groups-store/li.h~3224064498.p.json
         |    └ (item data, <"users||3>) | 0.06 kb
    9ms  | end
    "
  `);
  expect(hydrationOperations).not.toContain('products');
  expect(restartedEnv.timelineString).toMatchInlineSnapshot(`
    "
    time   | is-derived | query-items      | query-status |
    3s     | -          | -                | -            | -- timeline-cleared
    .      | -          | -                | -            | -- mount only the users query after restart; products should stay cold
    .      | no         |                  | loading      | [query-status, query-items, is-derived] ui-initialized
    3.009s | yes        | Ada, Alan, Grace | success      | [query-status, query-items, is-derived] ui-changed
    "
  `);
  // Only the requested users group should be hydrated into state; unrelated persisted groups stay cold.
  expect({
    hydratedItemKeys: Object.keys(restartedEnv.store.state.items).sort(),
    hydratedProductItemKeys: Object.keys(restartedEnv.store.state.items)
      .filter((itemKey) => itemKey.includes('products'))
      .sort(),
    isDerived: hook.result.current.isDerived,
    itemNames: hook.result.current.items.map((item) => item.name),
  }).toMatchInlineSnapshot(`
    hydratedItemKeys: ['"users||1', '"users||2', '"users||3']
    hydratedProductItemKeys: []
    isDerived: '✅'
    itemNames: ['Ada', 'Alan', 'Grace']
  `);
});
