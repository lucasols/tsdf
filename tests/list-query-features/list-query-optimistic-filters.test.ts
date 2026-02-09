import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { expect, test } from 'vitest';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { range } from '../utils/genericTestUtils';

type UserRow = Row & {
  age: number;
  type: 'admin' | 'user';
};

const initialServerData: Tables<UserRow> = {
  users: range(1, 10).map((id, index) => ({
    id,
    name: `User ${id}`,
    age: index % 2 === 0 ? 20 + index : 30 + index,
    type: index % 2 === 0 ? ('admin' as const) : ('user' as const),
  })),
};

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

test.concurrent('filter items optimistically to queries', () => {
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
          query.tableId === 'users'
          && query.filters?.some(
            (filter) =>
              filter.op === 'eq'
              && filter.field === 'type'
              && filter.value === 'user',
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

test.concurrent('optimistically create a query if it does not exist', () => {
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

test.concurrent('optimistically sort items', () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: {
      queries: [{ tableId: 'users', filters: { type: 'user' } }],
    },
    disableInitialDataInvalidation: true,

    optimisticListUpdates: [
      {
        queries: (query) => query.filters?.type === 'user',
        filterItem: (item) => item.type === 'user',
      },
      {
        queries: () => true,
        sort: {
          sortBy: (item) => item.age!,
          order: 'desc',
        },
      },
    ],
  });

  env.store.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 19,
    type: 'user',
  });

  expect(getSortSnapshot(env)).toMatchInlineSnapshotString(`
    "[
      {
        query: {
          error: null,
          status: 'success',
          refetchOnMount: false,
          wasLoaded: true,
          payload: { tableId: 'users', filters: { type: 'user' } },
          items:       [
            { id: 10, name: 'User 10', age: 39, type: 'user' },
            { id: 8, name: 'User 8', age: 37, type: 'user' },
            { id: 6, name: 'User 6', age: 35, type: 'user' },
            { id: 4, name: 'User 4', age: 33, type: 'user' },
            { id: 2, name: 'User 2', age: 31, type: 'user' },
            { id: 20, name: 'User 20', age: 19, type: 'user' },
          ],
          hasMore: false,
        },
        key: '[{"filters":{"type":"user"}},{"tableId":"users"}]',
      },
    ]"
  `);

  env.store.updateItemState('users||20', (item) => {
    item.age = 34;
  });

  expect(getSortSnapshot(env)).toMatchInlineSnapshotString(`
    "[
      {
        query: {
          error: null,
          status: 'success',
          refetchOnMount: false,
          wasLoaded: true,
          payload: { tableId: 'users', filters: { type: 'user' } },
          items:       [
            { id: 10, name: 'User 10', age: 39, type: 'user' },
            { id: 8, name: 'User 8', age: 37, type: 'user' },
            { id: 6, name: 'User 6', age: 35, type: 'user' },
            { id: 20, name: 'User 20', age: 34, type: 'user' },
            { id: 4, name: 'User 4', age: 33, type: 'user' },
            { id: 2, name: 'User 2', age: 31, type: 'user' },
          ],
          hasMore: false,
        },
        key: '[{"filters":{"type":"user"}},{"tableId":"users"}]',
      },
    ]"
  `);
});

function getSortSnapshot(env: ReturnType<typeof createTestEnv>): string {
  return jsonFormatter(
    env.store
      .getQueriesState(() => true)
      .map((q) => ({
        ...q,
        query: {
          ...q.query,
          items: q.query.items.map((id) => {
            const item = env.store.getItemState(id);
            return item!;
          }),
        },
      })),
  );
}
