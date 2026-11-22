import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import { rc_literals, rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import type { FilterOperator } from '../mocks/serverTableMock';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { listQueryQueryPayloadSchema } from '../offline/offlineTestShared';
import {
  advanceTime,
  flushAllTimers,
  range,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { resetSessionForTests } from '../utils/resetSessionForTests';

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

test('an item moved between lists keeps the filters the client cannot evaluate of the list it left', () => {
  // Stands in for a server-side search, which the client rule cannot evaluate
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
    regularUsersSearch: {
      tableId: 'users',
      filters: [...byTypeFilter('user'), searchFilter],
    },
  } satisfies Record<string, ListQueryParams>;

  function getSearch(query: ListQueryParams): string | undefined {
    for (const filter of query.filters ?? []) {
      if (filter.op === 'startsWith') return filter.value;
    }

    return undefined;
  }

  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: { loaded: { queries: Object.values(queries) } },
    optimisticListUpdates: [
      {
        queries: () => true,
        filterItem: (
          user,
          { queryPayload, isInQuery, previousItem, previousQueries },
        ) => {
          const matchesTypeFilter = (queryPayload.filters ?? []).every(
            (filter) => userMatchesFilter(user, filter) !== false,
          );
          const search = getSearch(queryPayload);

          // Without a search, or for a user already known to match it, the
          // known filters decide the membership
          if (search === undefined || isInQuery) return matchesTypeFilter;

          // Only a type change moves the user between the lists
          if (!matchesTypeFilter || previousItem?.type === user.type) {
            return null;
          }

          // A user that was in a list with the same search matches it, so it
          // can be added to the list of its new type
          const wasInSameSearch = previousQueries.some(
            (previousQuery) => getSearch(previousQuery) === search,
          );

          return wasInSameSearch ? true : null;
        },
      },
    ],
  });

  const membership = createLoggerStore();
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('an admin inside the search results becomes a user');
  env.apiStore.updateItemState('users||1', (user) => {
    user.type = 'user';
  });
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('an admin outside the search results becomes a user');
  env.apiStore.updateItemState('users||3', (user) => {
    user.type = 'user';
  });
  membership.add(getQueriesMembership(env, queries));

  membership.addMark('a new admin is added');
  env.apiStore.addItemToState('users||11', {
    id: 11,
    name: 'User 11',
    age: 40,
    type: 'admin',
  });
  membership.add(getQueriesMembership(env, queries));

  // - users||1 moves from `adminsSearch` to `regularUsersSearch`: it was in a
  //   list with the same search before the change.
  // - users||3 moves from `admins` to `regularUsers` only: it was in no search
  //   list, so there is no way to know if it matches the search.
  // - the new users||11 has no previous state or lists, so it only enters the
  //   list without search.
  expect(membership.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ admins: users||1, users||3, users||5, users||7, users||9
    ⋅ adminsSearch: users||1
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10
    ⋅ regularUsersSearch: users||10
    └─

    >>> an admin inside the search results becomes a user

    ┌─
    ⋅ admins: users||3, users||5, users||7, users||9
    ⋅ adminsSearch: ''
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10, users||1
    ⋅ regularUsersSearch: users||10, users||1
    └─

    >>> an admin outside the search results becomes a user

    ┌─
    ⋅ admins: users||5, users||7, users||9
    ⋅ adminsSearch: ''
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10, users||1, users||3
    ⋅ regularUsersSearch: users||10, users||1
    └─

    >>> a new admin is added

    ┌─
    ⋅ admins: users||5, users||7, users||9, users||11
    ⋅ adminsSearch: ''
    ⋅ regularUsers: users||2, users||4, users||6, users||8, users||10, users||1, users||3
    ⋅ regularUsersSearch: users||10, users||1
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

test('a rule with filterItem and sort keeps the query sorted when its members change', () => {
  const regularUsersQuery = { tableId: 'users', filters: byTypeFilter('user') };
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: { loaded: { queries: [regularUsersQuery] } },
    optimisticListUpdates: [
      {
        // Membership and order of the query are declared in a single rule
        queries: regularUsersQuery,
        filterItem: (user) => user.type === 'user',
        sort: { sortBy: (user) => user.age, order: 'asc' },
      },
    ],
  });

  const usersOrder = createLoggerStore();

  function logUsersOrder() {
    const itemKeys = env.apiStore.getQueryState(regularUsersQuery)?.items ?? [];

    usersOrder.add({
      regularUsers: itemKeys
        .map((itemKey) => {
          const user = env.store.state.items[itemKey];

          return user ? `${user.name} (${user.age})` : 'missing';
        })
        .join(', '),
    });
  }

  // The server returns the query already sorted by age
  logUsersOrder();

  usersOrder.addMark('the youngest member becomes older than two members');
  env.apiStore.updateItemState('users||2', (user) => {
    user.age = 36;
  });
  logUsersOrder();

  usersOrder.addMark('a 34-year-old regular user is added');
  env.apiStore.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 34,
    type: 'user',
  });
  logUsersOrder();

  usersOrder.addMark('a member is promoted to admin');
  env.apiStore.updateItemState('users||6', (user) => {
    user.type = 'admin';
  });
  logUsersOrder();

  // - User 2 was already a member and still passes the filter, so it only
  //   moves to its new sorted position
  // - User 20 enters the query directly at its sorted position
  // - User 6 leaves the query and the remaining members keep their order
  expect(usersOrder.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> regularUsers: User 2 (31), User 4 (33), User 6 (35), User 8 (37), User 10 (39)

    >>> the youngest member becomes older than two members

    -> regularUsers: User 4 (33), User 6 (35), User 2 (36), User 8 (37), User 10 (39)

    >>> a 34-year-old regular user is added

    regularUsers: User 4 (33), User 20 (34), User 6 (35), User 2 (36), User 8 (37), User 10 (39)

    >>> a member is promoted to admin

    -> regularUsers: User 4 (33), User 20 (34), User 2 (36), User 8 (37), User 10 (39)
    "
  `);
});

test('a sort rule with invalidateQueries refetches the list once the mutation succeeds', async () => {
  const regularUsersQuery = { tableId: 'users', filters: byTypeFilter('user') };
  const env = createListQueryStoreTestEnv<UserRow>(initialServerData, {
    testScenario: { loaded: { queries: [regularUsersQuery] } },
    optimisticListUpdates: [
      {
        // The client sorts by age as a best guess, but the server owns the
        // final order, so the rule asks for a refetch to settle it.
        queries: regularUsersQuery,
        sort: { sortBy: (user) => user.age, order: 'asc' },
        invalidateQueries: true,
      },
    ],
  });

  const renders = createLoggerStore({ arrays: 'all' });

  renderHook(() => {
    const query = env.apiStore.useListQuery(regularUsersQuery, {
      disableRefetchOnMount: true,
    });

    renders.add({
      users: query.items.map((user) => `${user.name} (${user.age})`),
    });
  });

  renders.addMark('User 2 age is changed to 36 with an optimistic update');
  act(() => {
    void env.apiStore.performMutation('users||2', {
      // Only the sort rule can ask for a list refetch in this test
      revalidateOnSuccess: false,
      optimisticUpdate: (payload) => {
        env.apiStore.updateItemState(payload, (user) => {
          user.age = 36;
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem('users||2', { age: 36 }),
    });
  });

  // The list is re-sorted right away, but the refetch asked by the rule waits
  // for the mutation: refetching now would bring back the old server data.
  await advanceTime(1199);
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);

  renders.addMark('the mutation succeeds and the list is refetched');
  await flushAllTimers();
  cleanup();

  // The list is refetched a single time after the mutation succeeds
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

  // The server keeps its own order (by id), which replaces the client guess
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> users: [User 2 (31), User 4 (33), User 6 (35), User 8 (37), User 10 (39)]

    >>> User 2 age is changed to 36 with an optimistic update

    -> users: [User 4 (33), User 6 (35), User 2 (36), User 8 (37), User 10 (39)]

    >>> the mutation succeeds and the list is refetched

    -> users: [User 2 (36), User 4 (33), User 6 (35), User 8 (37), User 10 (39)]
    "
  `);

  // The refetch starts right after the mutation finishes at 1.2s
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    1.2s  | server-data-changed (value: {"age":36})
    1.21s | 🔴 >list-fetch-started
    2.01s | 🔴 <list-fetch-finished (value: {"count":5})
    "
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

describe('queries only in persistent storage', () => {
  type TaskRow = { id: number; name: string; status: 'todo' | 'done' };

  const taskRowSchema = rc_object({
    id: rc_number,
    name: rc_string,
    status: rc_literals('todo', 'done'),
  });

  function statusQuery(status: TaskRow['status']): ListQueryParams {
    return {
      tableId: 'tasks',
      filters: [{ op: 'eq', field: 'status', value: status }],
    };
  }

  const todoColumn = statusQuery('todo');
  const doneColumn = statusQuery('done');
  const projectsQuery: ListQueryParams = { tableId: 'projects' };

  const storages = [
    { storage: 'local storage', adapter: 'local-sync' },
    { storage: 'async storage', adapter: opfsPersistentStorage },
  ] as const;

  type StorageAdapter = (typeof storages)[number]['adapter'];

  /**
   * Task board with one column per status. The board decides the column of a
   * card from the column's status filter, declared either by the column
   * payloads or by a filter that matches every column.
   */
  function createBoardEnv({
    adapter,
    rule,
    maxQueries,
  }: {
    adapter: StorageAdapter;
    rule: 'payloads' | 'filter';
    maxQueries?: number;
  }) {
    const taskIsInColumn = (task: TaskRow, column: ListQueryParams) => {
      const filter = column.filters?.[0];
      return filter?.op === 'eq' && filter.field === 'status'
        ? task.status === filter.value
        : null;
    };

    return createListQueryStoreTestEnv<TaskRow>(
      {
        tasks: [
          { id: 1, name: 'Write report', status: 'todo' },
          { id: 2, name: 'Pay invoice', status: 'done' },
          { id: 3, name: 'Book flight', status: 'done' },
        ],
        projects: [{ id: 1, name: 'Website', status: 'todo' }],
      },
      {
        id: 'task-board',
        getSessionKey: () => 'task-board-session',
        maxQueries,
        persistentStorage: {
          adapter,
          schema: taskRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
        },
        optimisticListUpdates:
          rule === 'payloads'
            ? [
                {
                  queries: todoColumn,
                  filterItem: (task) => task.status === 'todo',
                },
                {
                  queries: doneColumn,
                  filterItem: (task) => task.status === 'done',
                },
              ]
            : [
                {
                  queries: (query) => query.tableId === 'tasks',
                  filterItem: (task, { queryPayload }) =>
                    taskIsInColumn(task, queryPayload),
                },
              ],
      },
    );
  }

  type BoardEnv = ReturnType<typeof createBoardEnv>;

  function renderColumn(env: BoardEnv, column: ListQueryParams, label = '') {
    return renderHook(() => {
      const query = env.apiStore.useListQuery(column, {
        itemSelector: (task) => task.name,
      });
      if (label) env.trackItemUI(label, query.items.join(', '));
      return query;
    });
  }

  async function moveToDone(env: BoardEnv, itemId: string) {
    await act(async () => {
      await resolveAfterAllTimers(
        env.apiStore.performMutation(itemId, {
          optimisticUpdate: () => {
            env.apiStore.updateItemState(itemId, (task) => ({
              ...task,
              status: 'done',
            }));
          },
          mutation: () =>
            env.serverTable.delayedUpdateItem(itemId, { status: 'done' }),
        }),
      );
    });
  }

  beforeEach(() => {
    vi.setSystemTime(TEST_INITIAL_TIME);
    resetSessionForTests({ clearStorage: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    resetSessionForTests({ clearStorage: true });
  });

  /**
   * The user sees the board once, so both columns are saved to storage, then
   * restarts the app on the todo column: the done column is not read from
   * storage yet.
   */
  async function restartOnTodoColumn(adapter: StorageAdapter) {
    if (adapter !== 'local-sync') createOpfsPersistentStorageTestStore();

    const first = createBoardEnv({ adapter, rule: 'payloads' });
    const firstTodo = renderColumn(first, todoColumn);
    const firstDone = renderColumn(first, doneColumn);
    await flushAllTimers();
    firstTodo.unmount();
    firstDone.unmount();
    first.apiStore.dispose();

    resetSessionForTests();
    const env = createBoardEnv({ adapter, rule: 'payloads' });
    const todo = renderColumn(env, todoColumn);
    await flushAllTimers();

    return { env, todo };
  }

  /**
   * Moves a card to the done column after a restart on the todo column.
   * Returns the timeline of opening the done column afterwards.
   */
  async function moveCardToColumnOnlyInStorageAfterRestart(
    adapter: StorageAdapter,
  ) {
    const { env, todo } = await restartOnTodoColumn(adapter);
    await moveToDone(env, 'tasks||1');
    await flushAllTimers();
    // The card left the todo column
    expect(todo.result.current.items).toMatchInlineSnapshot(`[]`);

    env.clearTimeline();
    env.addTimelineComments('beforeNextAction', ['open the done column']);
    const done = renderColumn(env, doneColumn, 'done-column');
    await flushAllTimers();

    todo.unmount();
    done.unmount();

    return env.timelineString;
  }

  test('a card moved to a column that is only in local storage after a restart keeps the saved cards of the column', async () => {
    // The column shows its saved cards right away, instead of only the moved
    // card, then the refetch adds the moved card.
    expect(await moveCardToColumnOnlyInStorageAfterRestart('local-sync'))
      .toMatchInlineSnapshot(`
        "
        time   | done-column                            |
        13.2s  | -                                      | -- timeline-cleared
        .      | -                                      | -- open the done column
        .      | Pay invoice, Book flight               | ui-initialized
        13.21s | Pay invoice, Book flight               | 🟠 >list-fetch-started
        14.01s | Pay invoice, Book flight               | 🟠 <list-fetch-finished (value: {"count":3})
        .      | Write report, Pay invoice, Book flight | ui-changed
        "
      `);
  });

  test('a card moved to a column that is only in async storage after a restart keeps the saved cards of the column', async () => {
    // The column shows its saved cards once they are read, instead of only the
    // moved card, then the refetch adds the moved card.
    expect(
      await moveCardToColumnOnlyInStorageAfterRestart(opfsPersistentStorage),
    ).toMatchInlineSnapshot(`
      "
      time    | done-column                            |
      13.2s   | -                                      | -- timeline-cleared
      .       | -                                      | -- open the done column
      .       |                                        | ui-initialized
      13.208s | Pay invoice, Book flight               | ui-changed
      13.218s | Pay invoice, Book flight               | 🟠 >list-fetch-started
      14.018s | Pay invoice, Book flight               | 🟠 <list-fetch-finished (value: {"count":3})
      .       | Write report, Pay invoice, Book flight | ui-changed
      "
    `);
  });

  test('a column only in storage opened while a card is being moved to it shows the card once the move is saved', async () => {
    const { env, todo } = await restartOnTodoColumn('local-sync');

    // Move a card to done with a slow save, and open the done column right
    // after, while the save is still running
    env.clearTimeline();
    let movePromise: Promise<unknown> = Promise.resolve();
    act(() => {
      movePromise = env.apiStore.performMutation('tasks||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('tasks||1', (task) => ({
            ...task,
            status: 'done',
          }));
        },
        mutation: () =>
          env.serverTable.delayedUpdateItem(
            'tasks||1',
            { status: 'done' },
            { durationMs: 2000 },
          ),
      });
    });
    await advanceTime(5);
    env.addTimelineComments('beforeNextAction', ['open the done column']);
    const done = renderColumn(env, doneColumn, 'done-column');
    await flushAllTimers();
    await movePromise;

    // The column shows its saved cards right away, but its refetch waits for
    // the save: a fetch that ran before it would return the column without the
    // moved card, which already left the todo column, so the card would be
    // missing from both columns.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time    | done-column                            |
      12s     | -                                      | -- timeline-cleared
      12.005s | -                                      | -- open the done column
      .       | Pay invoice, Book flight               | [done-column] ui-initialized
      14s     | Pay invoice, Book flight               | [tasks||1] server-data-changed (value: {"status":"done"})
      14.01s  | Pay invoice, Book flight               | 🟠 >list-fetch-started
      14.81s  | Pay invoice, Book flight               | 🟠 <list-fetch-finished (value: {"count":3})
      .       | Write report, Pay invoice, Book flight | [done-column] ui-changed
      "
    `);
    expect(done.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Pay invoice', 'Book flight']`,
    );

    todo.unmount();
    done.unmount();
  });

  test('a card created in a column evicted from memory shows in the column right away with local storage', async () => {
    // Only two lists fit in memory: opening the projects screen after leaving
    // the done column evicts the done column, which stays saved in local
    // storage
    const env = createBoardEnv({
      adapter: 'local-sync',
      rule: 'payloads',
      maxQueries: 2,
    });
    const todo = renderColumn(env, todoColumn);
    const leftDone = renderColumn(env, doneColumn);
    await flushAllTimers();
    leftDone.unmount();
    const projects = renderHook(() => env.apiStore.useListQuery(projectsQuery));
    await flushAllTimers();
    // The done column is no longer in memory
    expect(Object.keys(env.store.state.queries)).toMatchInlineSnapshot(`
      - '{filters:[{field:"status",op:"eq",value:"todo"}],tableId:"tasks"}'
      - '{tableId:"projects"}'
    `);

    // The app creates a done card and adds it to the lists a filter picks: the
    // filter reads the saved done column back from local storage
    act(() => {
      env.apiStore.addItemToState(
        'tasks||4',
        { id: 4, name: 'Call bank', status: 'done' },
        {
          addItemToQueries: {
            queries: (query) =>
              query.filters?.[0]?.op === 'eq' &&
              query.filters[0].value === 'done',
            appendTo: 'start',
          },
        },
      );
    });

    // The done column got the new card and kept its saved cards, so opening
    // it shows the card before any refetch
    const done = renderColumn(env, doneColumn);
    expect(done.result.current.items).toMatchInlineSnapshot(
      `['Call bank', 'Pay invoice', 'Book flight']`,
    );

    await flushAllTimers();
    todo.unmount();
    projects.unmount();
    done.unmount();
  });

  test('a card moved to a column evicted from memory keeps the saved cards of the column', async () => {
    createOpfsPersistentStorageTestStore();

    // Only two lists fit in memory: opening the projects screen after leaving
    // the done column evicts the done column, which stays saved. With local
    // storage the column rule reads it back synchronously, so this case is
    // only reachable with async storage.
    const env = createBoardEnv({
      adapter: opfsPersistentStorage,
      rule: 'filter',
      maxQueries: 2,
    });
    const todo = renderColumn(env, todoColumn);
    const leftDone = renderColumn(env, doneColumn);
    await flushAllTimers();
    leftDone.unmount();
    const projects = renderHook(() => env.apiStore.useListQuery(projectsQuery));
    await flushAllTimers();
    // The done column is no longer in memory
    expect(Object.keys(env.store.state.queries)).toMatchInlineSnapshot(`
      - '{filters:[{field:"status",op:"eq",value:"todo"}],tableId:"tasks"}'
      - '{tableId:"projects"}'
    `);

    await moveToDone(env, 'tasks||1');
    await flushAllTimers();

    // Opening the done column again shows its saved cards, instead of only
    // the moved card, then the refetch adds the moved card.
    env.clearTimeline();
    env.addTimelineComments('beforeNextAction', ['open the done column']);
    const done = renderColumn(env, doneColumn, 'done-column');
    await flushAllTimers();

    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time    | done-column                            |
      17.019s | -                                      | -- timeline-cleared
      .       | -                                      | -- open the done column
      .       | Pay invoice, Book flight               | ui-initialized
      17.029s | Pay invoice, Book flight               | 🟢 >list-fetch-started
      17.829s | Pay invoice, Book flight               | 🟢 <list-fetch-finished (value: {"count":3})
      .       | Write report, Pay invoice, Book flight | ui-changed
      "
    `);

    todo.unmount();
    projects.unmount();
    done.unmount();
  });
});
