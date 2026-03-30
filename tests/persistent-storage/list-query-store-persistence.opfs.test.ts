import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import type {
  OffsetPaginationConfig,
  PartialResourcesConfig,
} from '../../src/listQueryStore/types';
import type {
  PersistedListQueryData,
  PersistedListQueryItemData,
  PersistentStorageSchema,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';

import {
  createListQueryStoreTestEnv,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);
const listQueryParamsSchema = rc_object({ tableId: rc_string });
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

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  storageAdapter: ReturnType<typeof createMockOpfsStorageAdapter>['adapter'];
  maxQuerySize?: number;
  ignoreItems?: string[] | ((payload: string) => boolean);
  serverData?: Tables<Row>;
  partialResources?: PartialResourcesConfig<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    storageAdapter: options.storageAdapter,
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    persistentStorage: {
      storeName: options.storeName,
      backend: 'opfs',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxQuerySize: options.maxQuerySize,
      ignoreItems: options.ignoreItems,
    },
  });
}

function createPersistedListQueryState(
  tableId: string,
  items: Row[],
  persistedSize: number,
) {
  const persistedItems = items.slice(0, persistedSize);

  return {
    listQuery: {
      items: persistedItems.map((item) => ({
        tableId,
        id: item.id,
        data: item,
      })),
      queries: [
        {
          params: { tableId },
          items: persistedItems.map((item) => ({ tableId, id: item.id })),
          hasMore: items.length > persistedSize,
        },
      ],
    },
  };
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('opfs: list query store persistence', () => {
  test('first query hook read hydrates the requested query and its items, then refetches', async () => {
    const storeName = 'lq-opfs-hook';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { id: 1, name: 'Cached' } },
            { tableId: 'projects', id: 1, data: { id: 1, name: 'Cold' } },
          ],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });
    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    expect(env.apiStore.getQueriesState(() => true)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getQueryState(usersQuery)).toBeUndefined();
    expect(env.apiStore.getItemState('users||1')).toBeUndefined();
    expect(mockAdapter.readRequests).toMatchInlineSnapshot(`[]`);

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(mockAdapter.scopeReadRequests().slice(0, 2)).toMatchInlineSnapshot(`
      ['listQuery.query.{tableId:"users"}', 'listQuery.item."users||1']
    `);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
  });

  test('explicit query preload hydrates cached data before mount', async () => {
    const storeName = 'lq-opfs-preload-query';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [{ tableId: 'users', id: 1, data: { id: 1, name: 'Cached' } }],
          queries: [
            { params: usersQuery, items: [{ tableId: 'users', id: 1 }] },
          ],
        },
      },
    });

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await advanceTime(200);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
  });

  test('ignored cached items are skipped during query preload and removed from opfs', async () => {
    const storeName = 'lq-opfs-ignore';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { id: 1, name: 'Kept' } },
            { tableId: 'users', id: 2, data: { id: 2, name: 'Ignored' } },
          ],
          queries: [
            {
              params: usersQuery,
              items: [
                { tableId: 'users', id: 1 },
                { tableId: 'users', id: 2 },
              ],
            },
          ],
        },
      },
    });

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      ignoreItems: (payload) => payload.endsWith('||2'),
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await advanceTime(100);
    await preloadPromise;
    await advanceTime(2100);
    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQuery)?.items)
      .toMatchInlineSnapshot(`
        ['"users||1']
      `);
    expect(env.apiStore.getItemState('users||2')).toBeUndefined();
    expect(
      mockAdapter.has(mockAdapter.listQuery.itemStorageKey('users', 2)),
    ).toBe(false);
  });

  test('round-trip persistence preserves partial-resource metadata for cached list queries', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-partial-roundtrip';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
    });

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    renderHook(() => {
      writerEnv.apiStore.useListQuery(usersQuery, { fields: ['id', 'name'] });
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await advanceTime(200);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Cached]
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(0);
    expect(
      readerEnv.store.state.itemLoadedFields[
        mockAdapter.listQuery.itemKey('users', 1)
      ],
    ).toMatchInlineSnapshot(`
      ['id', 'name']
    `);
  });

  test('hydrated partial-resource items keep loading until missing fields are fetched', async () => {
    const storeName = 'lq-opfs-item-partial-missing-fields';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
    });
    const itemPayload = 'users||1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 20, email: 'cached@site.test' }],
      },
    });

    renderHook(() => {
      writerEnv.apiStore.useItem(itemPayload, {
        fields: ['id', 'name', 'age'],
      });
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 21, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: ['id', 'name', 'age', 'email'],
        returnRefetchingStatus: true,
      });

      renders.add({
        status,
        name: data?.name ?? null,
        age: data?.age ?? null,
        email: data?.email ?? null,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: null ⋅ age: null ⋅ email: null
      -> status: success ⋅ name: Fresh ⋅ age: 21 ⋅ email: fresh@site.test
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'age', 'email']
          itemId: 'users||1'
    `);
    expect(
      readerEnv.store.state.itemLoadedFields[
        mockAdapter.listQuery.itemKey('users', 1)
      ],
    ).toMatchInlineSnapshot(`
      ['age', 'email', 'id', 'name']
    `);
  });

  test('hydrated partial-resource queries refetch when hooks request fields missing from storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-partial-missing-fields';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
    });

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 20, email: 'cached@site.test' }],
      },
    });

    renderHook(() => {
      writerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name', 'age'],
      });
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 21, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name', 'age', 'email'],
        returnRefetchingStatus: true,
      });

      const firstItem = items[0];

      renders.add({
        status,
        item:
          firstItem === undefined
            ? null
            : {
                name: firstItem.name,
                age: firstItem.age ?? null,
                email: firstItem.email ?? null,
              },
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ item: null
      -> status: success ⋅ item: {name:Fresh, age:21, email:fresh@site.test}
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'age', 'email']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
    expect(
      readerEnv.store.state.itemLoadedFields[
        mockAdapter.listQuery.itemKey('users', 1)
      ],
    ).toMatchInlineSnapshot(`
      ['age', 'email', 'id', 'name']
    `);
  });

  test('round-trip persistence preserves offset-pagination progress for loadMore', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 100 });
    const productsQuery = { tableId: 'products' };
    const products = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Product ${index + 1}`,
    }));
    const storeName = 'lq-opfs-offset-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: { products },
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    writerEnv.apiStore.scheduleListQueryFetch('highPriority', productsQuery, 5);
    await flushAllTimers();

    writerEnv.apiStore.loadMore(productsQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: { products },
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    const preloadPromise =
      readerEnv.apiStore.preloadQueryFromStorage(productsQuery);
    await advanceTime(200);
    await preloadPromise;

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { disableRefetchOnMount: true, returnRefetchingStatus: true },
      );

      renders.add({
        status,
        count: items.length,
        lastName: items.at(-1)?.name ?? null,
        hasMore,
      });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('all'),
    ).toMatchInlineSnapshot(`[]`);

    // Preloaded query should continue from offset 10 rather than refetching the head.
    readerEnv.apiStore.loadMore(productsQuery);
    await flushAllTimers();

    expect(
      readerEnv.apiStore.getQueryState(productsQuery)?.items.length,
    ).toMatchInlineSnapshot(`15`);
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 5, offset: 10 }
        returned_items: 5
    `);
  });

  test('hook loadSize smaller than hydrated query keeps the persisted larger size during refetch', async () => {
    const productsQuery = { tableId: 'products' };
    const storeName = 'lq-opfs-hook-loadsize-smaller';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
      initialState: createPersistedListQueryState(
        'products',
        Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          name: `Cached Product ${index + 1}`,
        })),
        10,
      ),
    });

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: {
        products: Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          name: `Fresh Product ${index + 1}`,
        })),
      },
      defaultQuerySize: 5,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { loadSize: 5, returnRefetchingStatus: true },
      );

      renders.add({
        status,
        count: items.length,
        lastName: items.at(-1)?.name ?? null,
        hasMore,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ count: 0 ⋅ lastName: null ⋅ hasMore: ❌
      -> status: success ⋅ count: 10 ⋅ lastName: Cached Product 10 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 10 ⋅ lastName: Cached Product 10 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Fresh Product 10 ⋅ hasMore: ✅
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 10, offset: 0 }
        returned_items: 10
    `);
  });

  test('hook loadSize larger than hydrated query expands the persisted list on refetch', async () => {
    const productsQuery = { tableId: 'products' };
    const cachedProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Cached Product ${index + 1}`,
    }));
    const freshProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Fresh Product ${index + 1}`,
    }));
    const storeName = 'lq-opfs-hook-loadsize-larger';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
      initialState: createPersistedListQueryState(
        'products',
        cachedProducts,
        5,
      ),
    });

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: { products: freshProducts },
      defaultQuerySize: 5,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { loadSize: 10, returnRefetchingStatus: true },
      );

      renders.add({
        status,
        count: items.length,
        lastName: items.at(-1)?.name ?? null,
        hasMore,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ count: 0 ⋅ lastName: null ⋅ hasMore: ❌
      -> status: success ⋅ count: 5 ⋅ lastName: Cached Product 5 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 5 ⋅ lastName: Cached Product 5 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Fresh Product 10 ⋅ hasMore: ✅
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 10, offset: 0 }
        returned_items: 10
    `);
  });

  test('round-trip persistence keeps state-manipulated query membership and item updates', async () => {
    const mockAdapter = createMockOpfsStorageAdapter({ readDelayMs: 100 });
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-state-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    writerEnv.apiStore.scheduleListQueryFetch('highPriority', usersQuery);
    await flushAllTimers();

    writerEnv.apiStore.updateItemState('users||1', (draft) => {
      draft.name = 'Edited Alice';
    });
    writerEnv.apiStore.addItemToState(
      'users||20',
      { id: 20, name: 'Local User' },
      { addItemToQueries: { queries: usersQuery, appendTo: 'end' } },
    );

    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    const preloadPromise =
      readerEnv.apiStore.preloadQueryFromStorage(usersQuery);
    await advanceTime(200);
    await preloadPromise;

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Edited Alice, Bob, Local User]
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('all'),
    ).toMatchInlineSnapshot(`[]`);
    expect(readerEnv.apiStore.getItemState('users||20')).toMatchInlineSnapshot(`
      id: 20
      name: 'Local User'
    `);
  });

  test('deleteItemState removes deleted items from persisted storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-delete-persisted-item';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
    });
    const deletedItemStorageKey = mockAdapter.listQuery.itemStorageKey(
      'users',
      1,
    );

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    env.apiStore.scheduleListQueryFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(true);
    expect(mockAdapter.listQuery.readQueryEntry(usersQuery)).toMatchObject({
      data: {
        items: [
          mockAdapter.listQuery.itemKey('users', 1),
          mockAdapter.listQuery.itemKey('users', 2),
        ],
      },
    });

    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(mockAdapter.listQuery.readQueryEntry(usersQuery)).toMatchObject({
      data: { items: [mockAdapter.listQuery.itemKey('users', 2)] },
    });
  });

  test('explicit item preload hydrates only the targeted item', async () => {
    const storeName = 'lq-opfs-preload-item';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [
            { tableId: 'users', id: 1, data: { id: 1, name: 'Alice' } },
            { tableId: 'users', id: 2, data: { id: 2, name: 'Bob' } },
          ],
        },
      },
    });

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await advanceTime(100);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);

    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);
    expect(env.apiStore.getItemState(() => true).map(({ payload }) => payload))
      .toMatchInlineSnapshot(`
        ['users||1']
      `);
  });

  test('invalid cached items are removed during targeted preload', async () => {
    const storeName = 'lq-opfs-invalid';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
    });
    const key = mockAdapter.listQuery.itemStorageKey('users', 1);
    const entry: StorageCacheEntry<PersistedListQueryItemData<{ bad: true }>> =
      {
        data: { data: { bad: true }, payload: 'users||1' },
        timestamp: Date.now(),
        version: 1,
      };
    mockAdapter.storage.writeValue(key, entry);

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await advanceTime(50);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);
    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('invalid cached item payloads are removed during targeted preload', async () => {
    const storeName = 'lq-opfs-invalid-item-payload';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
    });
    const key = mockAdapter.listQuery.itemStorageKey('users', 1);
    const entry: StorageCacheEntry<
      PersistedListQueryItemData<Row> & { payload: boolean }
    > = {
      data: { data: { id: 1, name: 'Alice' }, payload: true },
      timestamp: Date.now(),
      version: 1,
    };
    mockAdapter.storage.writeValue(key, entry);

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await advanceTime(50);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);
    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('invalid cached queries are removed during targeted preload', async () => {
    const storeName = 'lq-opfs-invalid-query';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
    });
    const key = mockAdapter.listQuery.queryStorageKey(usersQuery);
    const entry: StorageCacheEntry<
      PersistedListQueryData & { payload: boolean }
    > = {
      data: {
        payload: true,
        items: [mockAdapter.listQuery.itemKey('users', 1)],
        hasMore: false,
      },
      timestamp: Date.now(),
      version: 1,
    };
    mockAdapter.storage.writeValue(key, entry);
    mockAdapter.listQuery.seedItem('users', 1, { id: 1, name: 'Alice' });

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await advanceTime(50);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '❌'
    `);
    await advanceTime(2100);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('reset cancels stale async hydrations', async () => {
    const storeName = 'lq-opfs-reset';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 100,
      storeName,
      sessionKey,
      initialState: {
        listQuery: {
          items: [{ tableId: 'users', id: 1, data: { id: 1, name: 'Stale' } }],
        },
      },
    });

    const env = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');

    env.apiStore.reset();

    await advanceTime(100);
    await preloadPromise;

    expect(env.apiStore.getItemState('users||1')).toBeUndefined();
  });

  test('maxQuerySize persists only the first items from each query', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-max-query-size';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });

    writerEnv.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.listQuery.readQueryEntry(usersQuery).data.items)
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);
    expect(
      mockAdapter.has(mockAdapter.listQuery.itemStorageKey('users', 1)),
    ).toBe(true);
    expect(
      mockAdapter.has(mockAdapter.listQuery.itemStorageKey('users', 2)),
    ).toBe(true);
    expect(
      mockAdapter.has(mockAdapter.listQuery.itemStorageKey('users', 3)),
    ).toBe(false);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Alice, Bob]
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('all'),
    ).toMatchInlineSnapshot(`[]`);
  });
});
