import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import type { FilterOperator } from '../mocks/serverTableMock';
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

/**
 * Client-side copy of the server filters, like an app would write to decide
 * list membership from the payload of the query being evaluated.
 *
 * Returns `null` for filters the client cannot evaluate from the item data.
 */
function userMatchesFilter(
  user: UserRow,
  filter: FilterOperator,
): boolean | null {
  if (filter.op === 'eq' && filter.field === 'type') {
    return user.type === filter.value;
  }

  if (filter.op === 'range' && filter.field === 'age') {
    return user.age >= filter.min && user.age <= filter.max;
  }

  return null;
}

/** Lists the item payloads of each query, in query order. */
function getQueriesMembership(
  env: ReturnType<typeof createListQueryStoreTestEnv<UserRow>>,
  queries: Record<string, ListQueryParams>,
) {
  const membership: Record<string, string> = {};

  for (const [label, query] of Object.entries(queries)) {
    const itemKeys = env.apiStore.getQueryState(query)?.items ?? [];

    membership[label] = itemKeys
      .map((itemKey) => env.store.state.itemQueries[itemKey]?.payload)
      .join(', ');
  }

  return membership;
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

test('a single rule decides the membership of each query from the query payload', () => {
  const queries = {
    admins: { tableId: 'users', filters: byTypeFilter('admin') },
    regularUsers: { tableId: 'users', filters: byTypeFilter('user') },
    usersAged20To30: { tableId: 'users', filters: byAgeRangeFilter(20, 30) },
    regularUsersAged30To35: {
      tableId: 'users',
      filters: [...byTypeFilter('user'), ...byAgeRangeFilter(30, 35)],
    },
    regularGuests: { tableId: 'guests', filters: byTypeFilter('user') },
  } satisfies Record<string, ListQueryParams>;

  const env = createListQueryStoreTestEnv<UserRow>(
    {
      ...initialServerData,
      guests: [
        { id: 1, name: 'Guest 1', age: 25, type: 'user' },
        { id: 2, name: 'Guest 2', age: 32, type: 'user' },
      ],
    },
    {
      testScenario: { loaded: { queries: Object.values(queries) } },
      optimisticListUpdates: [
        {
          // One rule for every query: membership is decided per query, from
          // the filters of the query being evaluated.
          queries: () => true,
          filterItem: (user, { queryPayload, itemPayload }) => {
            // Rows do not carry their table, only the item payload does
            if (!itemPayload.startsWith(`${queryPayload.tableId}||`)) {
              return false;
            }

            return (queryPayload.filters ?? []).every(
              (filter) => userMatchesFilter(user, filter) === true,
            );
          },
        },
      ],
    },
  );

  const membership = createLoggerStore();
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('a 32-year-old regular user is added to the users table');
  env.apiStore.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 32,
    type: 'user',
  });
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('the age of the new user changes to 25');
  env.apiStore.updateItemState('users||20', (user) => {
    user.age = 25;
  });
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('the new user is promoted to admin');
  env.apiStore.updateItemState('users||20', (user) => {
    user.type = 'admin';
  });
  membership.add(getQueriesMembership(env, queries));

  // users||20 only enters the queries whose own filters it matches, follows
  // them as its data changes, and never leaks into the guests table query
  // even when it matches that query's filters.
  expect(membership.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10
    ⋅ usersAged20To30: users||1, users||3, users||5, users||7, users||9
    ⋅ regularUsersAged30To35: users||2, users||4, users||6
    ⋅ regularGuests: guests||1, guests||2
    └─

    >>> a 32-year-old regular user is added to the users table

    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10, users||20
    ⋅ usersAged20To30: users||1, users||3, users||5, users||7, users||9
    ⋅ regularUsersAged30To35: users||2, users||4, users||6, users||20
    ⋅ regularGuests: guests||1, guests||2
    └─

    >>> the age of the new user changes to 25

    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10, users||20
    ⋅ usersAged20To30: users||1, users||3, users||5, users||7, users||9, users||20
    ⋅ regularUsersAged30To35: users||2, users||4, users||6
    ⋅ regularGuests: guests||1, guests||2
    └─

    >>> the new user is promoted to admin

    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9, users||20
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10
    ⋅ usersAged20To30: users||1, users||3, users||5, users||7, users||9, users||20
    ⋅ regularUsersAged30To35: users||2, users||4, users||6
    ⋅ regularGuests: guests||1, guests||2
    └─
    "
  `);
});

test('a rule keeps the membership as is when the query has filters the client cannot evaluate', () => {
  // Stands in for a server-side search: the client rule does not know how to
  // evaluate it, so it cannot tell if an item should be added to the query.
  const searchFilter: FilterOperator = {
    op: 'startsWith',
    field: 'name',
    value: 'User 1',
  };

  const queries = {
    admins: { tableId: 'users', filters: byTypeFilter('admin') },
    adminsSearch: {
      tableId: 'users',
      filters: [...byTypeFilter('admin'), searchFilter],
    },
    regularUsers: { tableId: 'users', filters: byTypeFilter('user') },
  } satisfies Record<string, ListQueryParams>;

  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: { loaded: { queries: Object.values(queries) } },
    optimisticListUpdates: [
      {
        queries: () => true,
        filterItem: (user, { queryPayload, isInQuery }) => {
          const filtersResults = (queryPayload.filters ?? []).map((filter) =>
            userMatchesFilter(user, filter),
          );
          const matchesKnownFilters = !filtersResults.includes(false);

          if (!filtersResults.includes(null)) return matchesKnownFilters;

          // The query has a filter only the server can evaluate. An item
          // already in the query is known to pass it, so it only has to keep
          // matching the other filters. For an item outside the query there is
          // no way to know, so it is kept as is.
          return isInQuery ? matchesKnownFilters : null;
        },
      },
    ],
  });

  const membership = createLoggerStore();
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('an admin outside the search results is updated');
  env.apiStore.updateItemState('users||3', (user) => {
    user.age = 50;
  });
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('an admin inside the search results is updated');
  env.apiStore.updateItemState('users||1', (user) => {
    user.age = 50;
  });
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('the admin inside the search results becomes a user');
  env.apiStore.updateItemState('users||1', (user) => {
    user.type = 'user';
  });
  membership.add(getQueriesMembership(env, queries));

  // - users||3 matches the admin filter of `adminsSearch`, but is not added to
  //   it: the rule cannot evaluate the search, so it returns `null`.
  // - users||1 stays in `adminsSearch` while it is still an admin.
  // - users||1 leaves `adminsSearch` once it stops matching the admin filter,
  //   and moves from `admins` to `regularUsers`.
  expect(membership.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ adminsSearch: users||1
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10
    └─

    >>> an admin outside the search results is updated

    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ adminsSearch: users||1
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10
    └─

    >>> an admin inside the search results is updated

    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ adminsSearch: users||1
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10
    └─

    >>> the admin inside the search results becomes a user

    ┌─
    ⋅ admins: users||3, users||5, users||7, users||9
    ⋅ adminsSearch: ''
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10, users||1
    └─
    "
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
