import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { act } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, range } from '../utils/genericTestUtils';

type UserRow = Row & { age: number; type: 'admin' | 'user' };

const initialServerData: Tables<UserRow> = {
  users: range(1, 10).map((id, index) => ({
    id,
    name: `User ${id}`,
    age: index % 2 === 0 ? 20 + index : 30 + index,
    type: index % 2 === 0 ? ('admin' as const) : ('user' as const),
  })),
};

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

function byTypeFilter(
  type: 'admin' | 'user',
): NonNullable<ListQueryParams['filters']> {
  return [{ op: 'eq', field: 'type', value: type }];
}

function byAgeRangeFilter(
  min: number,
  max: number,
): NonNullable<ListQueryParams['filters']> {
  return [{ op: 'range', field: 'age', min, max }];
}

function getQueriesRelatedToItem(
  env: ReturnType<typeof createListQueryStoreTestEnv<UserRow>>,
  itemId: string,
) {
  const queriesRelatedToItem = env.apiStore.getQueriesRelatedToItem(itemId);

  return queriesRelatedToItem.map((item) => ({
    queryPayload: item.query.payload,
    itemIndexInQuery: item.query.items.indexOf(getCompositeKey(itemId)),
    querySize: item.query.items.length,
    refetchOnMount: item.query.refetchOnMount,
  }));
}

function getQueryItems(
  env: ReturnType<typeof createListQueryStoreTestEnv<UserRow>>,
  itemId: string,
) {
  const queriesRelatedToItem = env.apiStore.getQueriesRelatedToItem(itemId);

  return queriesRelatedToItem.map((item) =>
    item.query.items.map((itemKey) => env.store.state.items[itemKey]),
  );
}

test('filter items optimistically to queries', () => {
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: {
      loaded: {
        queries: [
          { tableId: 'users', filters: byTypeFilter('admin') },
          { tableId: 'users', filters: byTypeFilter('user') },
          { tableId: 'users', filters: byAgeRangeFilter(20, 30) },
        ],
      },
    },
    optimisticListUpdates: [
      {
        queries: { tableId: 'users', filters: byTypeFilter('admin') },
        filterItem: (item) => item.type === 'admin',
      },
      {
        queries: (query) =>
          query.tableId === 'users' &&
          query.filters?.some(
            (filter) =>
              filter.op === 'eq' &&
              filter.field === 'type' &&
              filter.value === 'user',
          ) === true,
        filterItem: (item) => item.type === 'user',
        invalidateQueries: true,
        appendNewTo: 'start',
      },
      {
        queries: [{ tableId: 'users', filters: byAgeRangeFilter(20, 30) }],
        filterItem: (item) => item.age >= 20 && item.age <= 30,
      },
    ],
  });

  env.apiStore.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 20,
    type: 'user',
  });

  expect(getQueriesRelatedToItem(env, 'users||20')).toMatchInlineSnapshot(`
    - itemIndexInQuery: 0
      queryPayload:
        filters:
          - { field: 'type', op: 'eq', value: 'user' }
        tableId: 'users'
      querySize: 6
      refetchOnMount: 'highPriority'
    - itemIndexInQuery: 5
      queryPayload:
        filters:
          - { field: 'age', max: 30, min: 20, op: 'range' }
        tableId: 'users'
      querySize: 6
      refetchOnMount: '❌'
  `);

  env.apiStore.updateItemState('users||20', (item) => {
    item.age = 19;
  });

  expect(getQueriesRelatedToItem(env, 'users||20')).toMatchInlineSnapshot(`
    - itemIndexInQuery: 0
      queryPayload:
        filters:
          - { field: 'type', op: 'eq', value: 'user' }
        tableId: 'users'
      querySize: 6
      refetchOnMount: 'highPriority'
  `);
});

test('optimistically create a query if it does not exist', () => {
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: {
      loaded: {
        queries: [{ tableId: 'users', filters: byTypeFilter('user') }],
      },
    },
    optimisticListUpdates: [
      {
        queries: { tableId: 'users', filters: byTypeFilter('admin') },
        filterItem: (item) => item.type === 'admin',
      },
    ],
  });

  expect(Object.keys(env.store.state.queries)).toMatchInlineSnapshot(
    `['{filters:[{field:"type",op:"eq",value:"user"}],tableId:"users"}']`,
  );

  env.apiStore.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 19,
    type: 'admin',
  });

  expect(getQueriesRelatedToItem(env, 'users||20')).toMatchInlineSnapshot(`
    - itemIndexInQuery: 0
      queryPayload:
        filters:
          - { field: 'type', op: 'eq', value: 'admin' }
        tableId: 'users'
      querySize: 1
      refetchOnMount: 'lowPriority'
  `);

  expect(Object.keys(env.store.state.queries)).toMatchInlineSnapshot(`
    - '{filters:[{field:"type",op:"eq",value:"user"}],tableId:"users"}'
    - '{filters:[{field:"type",op:"eq",value:"admin"}],tableId:"users"}'
  `);
});

test('optimistically sort items', () => {
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: {
      loaded: {
        queries: [{ tableId: 'users', filters: byTypeFilter('user') }],
      },
    },
    optimisticListUpdates: [
      {
        queries: (query) =>
          query.tableId === 'users' &&
          query.filters?.some(
            (filter) =>
              filter.op === 'eq' &&
              filter.field === 'type' &&
              filter.value === 'user',
          ) === true,
        filterItem: (item) => item.type === 'user',
      },
      {
        queries: () => true,
        sort: { sortBy: (item) => item.age, order: 'desc' },
      },
    ],
  });

  env.apiStore.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 19,
    type: 'user',
  });

  expect(getQueriesRelatedToItem(env, 'users||20')).toMatchInlineSnapshot(`
    - itemIndexInQuery: 5
      queryPayload:
        filters:
          - { field: 'type', op: 'eq', value: 'user' }
        tableId: 'users'
      querySize: 6
      refetchOnMount: '❌'
  `);

  expect(getQueryItems(env, 'users||20')).toMatchInlineSnapshot(`
    - - { age: 39, id: 10, name: 'User 10', type: 'user' }
      - { age: 37, id: 8, name: 'User 8', type: 'user' }
      - { age: 35, id: 6, name: 'User 6', type: 'user' }
      - { age: 33, id: 4, name: 'User 4', type: 'user' }
      - { age: 31, id: 2, name: 'User 2', type: 'user' }
      - { age: 19, id: 20, name: 'User 20', type: 'user' }
  `);

  env.apiStore.updateItemState('users||20', (item) => {
    item.age = 34;
  });

  expect(getQueriesRelatedToItem(env, 'users||20')).toMatchInlineSnapshot(`
    - itemIndexInQuery: 3
      queryPayload:
        filters:
          - { field: 'type', op: 'eq', value: 'user' }
        tableId: 'users'
      querySize: 6
      refetchOnMount: '❌'
  `);

  expect(getQueryItems(env, 'users||20')).toMatchInlineSnapshot(`
    - - { age: 39, id: 10, name: 'User 10', type: 'user' }
      - { age: 37, id: 8, name: 'User 8', type: 'user' }
      - { age: 35, id: 6, name: 'User 6', type: 'user' }
      - { age: 34, id: 20, name: 'User 20', type: 'user' }
      - { age: 33, id: 4, name: 'User 4', type: 'user' }
      - { age: 31, id: 2, name: 'User 2', type: 'user' }
  `);
});

test('mutation optimistic list invalidations wait for success and deduplicate success revalidation', async () => {
  const adminQuery = { tableId: 'users', filters: byTypeFilter('admin') };
  const userQuery = { tableId: 'users', filters: byTypeFilter('user') };
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: { loaded: { queries: [adminQuery, userQuery] } },
    optimisticListUpdates: [
      { queries: adminQuery, filterItem: (item) => item.type === 'admin' },
      {
        queries: userQuery,
        filterItem: (item) => item.type === 'user',
        invalidateQueries: true,
      },
    ],
  });

  let mutationPromise!: ReturnType<typeof env.apiStore.performMutation>;

  act(() => {
    mutationPromise = env.apiStore.performMutation('users||1', {
      optimisticUpdate: (payload) => {
        env.apiStore.updateItemState(payload, (item) => ({
          ...item,
          type: 'user',
        }));
      },
      mutation: () =>
        env.serverTable.emulateClientMutation(
          'users||1',
          { id: 1, name: 'User 1', age: 20, type: 'user' },
          { duration: 100 },
        ),
      revalidateOnSuccess: {
        queries: (payload) =>
          getCompositeKey(payload) === getCompositeKey(userQuery),
        items: false,
      },
    });
  });

  // The optimistic move updates membership immediately, but should not schedule
  // list refetches until the request succeeds.
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    env.store.state.queries[getCompositeKey(userQuery)]?.refetchOnMount,
  ).toBe(false);

  await advanceTime(99);

  // The request is still in flight, so the deferred invalidation should remain
  // unapplied.
  expect(
    env.store.state.queries[getCompositeKey(userQuery)]?.refetchOnMount,
  ).toBe(false);

  await advanceTime(1);
  await mutationPromise;

  // Success should now apply the deferred invalidation once, merged with the
  // explicit success revalidation for the same query.
  expect(
    env.store.state.queries[getCompositeKey(userQuery)]?.refetchOnMount,
  ).toBe('highPriority');

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time |
    0    | >mutation-started (value: {"id":1,"name":"User 1","age":20,"type":"user"})
    70ms | <mutation-data-persisted (value: {"id":1,"name":"User 1","age":20,"type":"user"})
    "
  `);
});

test('destination query fetch waits for optimistic filter mutation to settle', async () => {
  const adminQuery = { tableId: 'users', filters: byTypeFilter('admin') };
  const userQuery = { tableId: 'users', filters: byTypeFilter('user') };
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: { loaded: { queries: [adminQuery, userQuery] } },
    optimisticListUpdates: [
      { queries: adminQuery, filterItem: (item) => item.type === 'admin' },
      { queries: userQuery, filterItem: (item) => item.type === 'user' },
    ],
  });

  let mutationPromise!: ReturnType<typeof env.apiStore.performMutation>;

  act(() => {
    // Optimistically move users||1 from admin → user. The mutation will fail
    // after 100ms, triggering a rollback.
    mutationPromise = env.apiStore.performMutation('users||1', {
      optimisticUpdate: (payload) => {
        env.apiStore.updateItemState(payload, (item) => ({
          ...item,
          type: 'user',
        }));
      },
      mutation: () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('boom')), 100);
        }),
    });

    // Simulate a concurrent server-side change that the deferred fetch should
    // pick up once it finally runs.
    env.serverTable.updateItem('users||2', { name: 'Grace refreshed' });

    // Request a fetch for the destination (user) query — it should be held back
    // by the query mutation lock until the mutation settles.
    env.scheduleFetch('highPriority', userQuery);
  });

  // The optimistic move touches the destination query immediately, so its fetch
  // must wait until rollback/success releases the query mutation lock.
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);
  expect(
    env.store.state.queries[getCompositeKey(userQuery)]?.items,
  ).toMatchInlineSnapshot(
    `['"users||2', '"users||4', '"users||6', '"users||8', '"users||10', '"users||1']`,
  );

  // Advance to just before the mutation fails — fetch should still be deferred.
  await advanceTime(99);

  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);

  // Mutation fails at 100ms, rolling back the optimistic move and releasing
  // the query mutation lock.
  await advanceTime(1);
  await mutationPromise;
  await flushAllTimers();

  // The deferred fetch ran and picked up the latest server data.
  expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          filters:
            - { field: 'type', op: 'eq', value: 'user' }
          pos: { limit: 50, offset: 0 }
        returned_items: 5
    `);

  // The concurrent server update to users||2 was picked up by the deferred fetch.
  expect(env.store.state.items[getCompositeKey('users||2')])
    .toMatchInlineSnapshot(`
      age: 31
      id: 2
      name: 'Grace refreshed'
      type: 'user'
    `);

  // After rollback, users||1 is no longer in the user query — only the original
  // 5 user-type items remain.
  expect(
    env.store.state.queries[getCompositeKey(userQuery)]?.items,
  ).toMatchInlineSnapshot(
    `['"users||2', '"users||4', '"users||6', '"users||8', '"users||10']`,
  );

  // Timeline shows the fetch was scheduled at t=0 but only started at t=110ms —
  // the 100ms mutation failure + rollback had to complete first.
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | server-data-changed (value: {"name":"Grace refreshed"})
    .     | scheduled-fetch-scheduled
    110ms | 🔴 >list-fetch-started
    910ms | 🔴 <list-fetch-finished (value: {"count":5})
    "
  `);
});
