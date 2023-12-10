import { expect, test } from 'vitest';
import { createDefaultListQueryStore } from './utils/createDefaultListQueryStore';
import { jsonFormatter } from './utils/jsonFormatter';
import { range } from './utils/range';

const createTestEnv = createDefaultListQueryStore;

const initialServerData = {
  users: range(1, 10).map((id, i) => ({
    id,
    name: `User ${id}`,
    age: i % 2 === 0 ? 20 + i : 30 + i,
    type: i % 2 === 0 ? ('admin' as const) : ('user' as const),
  })),
};

test.concurrent('filter items optimistically to queries', () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: {
      queries: [
        { tableId: 'users', filters: { type: 'admin' } },
        { tableId: 'users', filters: { type: 'user' } },
        { tableId: 'users', filters: { ageRange: [20, 30] } },
      ],
    },
    disableInitialDataInvalidation: true,

    optimisticListUpdates: [
      {
        queries: { tableId: 'users', filters: { type: 'admin' } },
        filterItem: (item) => item.type === 'admin',
      },
      {
        queries: (query) => query.filters?.type === 'user',
        filterItem: (item) => item.type === 'user',
        invalidateQueries: true,
        appendNewTo: 'start',
      },
      {
        queries: [{ tableId: 'users', filters: { ageRange: [20, 30] } }],
        filterItem: (item) => item.age! >= 20 && item.age! <= 30,
      },
    ],
  });

  env.store.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 20,
    type: 'user',
  });

  expect(jsonFormatter(env.store.getQueriesState(() => true)))
    .toMatchInlineSnapshotString(`
      "[
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: false,
            wasLoaded: true,
            payload: { tableId: 'users', filters: { type: 'admin' } },
            items: [ 'users||1', 'users||3', 'users||5', 'users||7', 'users||9' ],
            hasMore: false,
          },
          key: '[{"filters":{"type":"admin"}},{"tableId":"users"}]',
        },
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: 'highPriority',
            wasLoaded: true,
            payload: { tableId: 'users', filters: { type: 'user' } },
            items: [ 'users||20', 'users||2', 'users||4', 'users||6', 'users||8', 'users||10' ],
            hasMore: false,
          },
          key: '[{"filters":{"type":"user"}},{"tableId":"users"}]',
        },
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: false,
            wasLoaded: true,
            payload: { tableId: 'users', filters: { ageRange: [ 20, 30 ] } },
            items: [ 'users||1', 'users||3', 'users||5', 'users||7', 'users||9', 'users||20' ],
            hasMore: false,
          },
          key: '[{"filters":{"ageRange":[20,30]}},{"tableId":"users"}]',
        },
      ]"
    `);

  env.store.updateItemState('users||20', (item) => {
    item.age = 19;
  });

  expect(jsonFormatter(env.store.getQueriesState(() => true)))
    .toMatchInlineSnapshotString(`
      "[
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: false,
            wasLoaded: true,
            payload: { tableId: 'users', filters: { type: 'admin' } },
            items: [ 'users||1', 'users||3', 'users||5', 'users||7', 'users||9' ],
            hasMore: false,
          },
          key: '[{"filters":{"type":"admin"}},{"tableId":"users"}]',
        },
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: 'highPriority',
            wasLoaded: true,
            payload: { tableId: 'users', filters: { type: 'user' } },
            items: [ 'users||20', 'users||2', 'users||4', 'users||6', 'users||8', 'users||10' ],
            hasMore: false,
          },
          key: '[{"filters":{"type":"user"}},{"tableId":"users"}]',
        },
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: false,
            wasLoaded: true,
            payload: { tableId: 'users', filters: { ageRange: [ 20, 30 ] } },
            items: [ 'users||1', 'users||3', 'users||5', 'users||7', 'users||9' ],
            hasMore: false,
          },
          key: '[{"filters":{"ageRange":[20,30]}},{"tableId":"users"}]',
        },
      ]"
    `);
});

test.concurrent('optimistically create a query if it not exist', () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: {
      queries: [{ tableId: 'users', filters: { type: 'user' } }],
    },
    disableInitialDataInvalidation: true,

    optimisticListUpdates: [
      {
        queries: { tableId: 'users', filters: { type: 'admin' } },
        filterItem: (item) => item.type === 'admin',
      },
    ],
  });

  env.store.addItemToState('users||20', {
    id: 20,
    name: 'User 20',
    age: 19,
    type: 'admin',
  });

  expect(jsonFormatter(env.store.getQueriesState(() => true)))
    .toMatchInlineSnapshotString(`
      "[
        {
          query: {
            error: null,
            status: 'success',
            refetchOnMount: false,
            wasLoaded: true,
            payload: { tableId: 'users', filters: { type: 'user' } },
            items: [ 'users||2', 'users||4', 'users||6', 'users||8', 'users||10' ],
            hasMore: false,
          },
          key: '[{"filters":{"type":"user"}},{"tableId":"users"}]',
        },
        {
          query: {
            status: 'success',
            items: [ 'users||20' ],
            error: null,
            hasMore: false,
            payload: { tableId: 'users', filters: { type: 'admin' } },
            refetchOnMount: 'lowPriority',
            wasLoaded: true,
          },
          key: '[{"filters":{"type":"admin"}},{"tableId":"users"}]',
        },
      ]"
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
