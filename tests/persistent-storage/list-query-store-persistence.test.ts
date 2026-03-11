import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import {
  rc_number,
  rc_object,
  rc_string,
} from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { readManagedLocalStorageEntryByPayload } from '../../src/persistentStorage/localStorageMetadata';
import { localPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type {
  OffsetPaginationConfig,
  PartialResourcesConfig,
} from '../../src/listQueryStore/types';
import type {
  PersistedListQueryData,
  PersistentStorageSchema,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const rowSchema = __LEGIT_CAST__<PersistentStorageSchema<Row>, unknown>(
  rc_object({
    id: rc_number,
    name: rc_string,
    age: rc_number.optional(),
    email: rc_string.optional(),
  }),
);
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
const persistentStore = createLocalStoragePersistentTestStore();

function rawItemPayload(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemPayload(tableId, id));
}

function storeQueryKey(params: ListQueryParams): string {
  return getCompositeKey(params);
}

function itemStorageKey(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
): string {
  return `tsdf.${sessionKey}.${storeName}.listQuery.item.${storeItemKey(tableId, id)}`;
}

function queryStorageKey(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
): string {
  return `tsdf.${sessionKey}.${storeName}.listQuery.query.${storeQueryKey(params)}`;
}

function setCachedItem(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
  data: Row,
  version = 1,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedItem(tableId, id, data, { version }).storageKey;
}

function setCachedQuery(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
  items: string[],
  hasMore = false,
  version = 1,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedQuery(params, items, { hasMore, version });
}

function listStoredKeys(prefix: string): string[] {
  const keys: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keys.push(key.slice(prefix.length));
    }
  }

  return keys;
}

function getStoredEntryTimestamp(key: string): number {
  const entry = readManagedLocalStorageEntryByPayload(key);
  if (entry === null) {
    throw new Error(`Missing managed localStorage metadata for ${key}`);
  }

  return entry.lastAccessAt;
}

function getStoredQueryItemKeys(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
): string[] {
  const raw = localStorage.getItem(
    queryStorageKey(storeName, sessionKey, params),
  );
  if (raw === null) {
    throw new Error(`Missing localStorage entry for ${storeName}`);
  }

  const parsed = __LEGIT_CAST__<
    StorageCacheEntry<PersistedListQueryData>,
    unknown
  >(JSON.parse(raw));
  return parsed.data.items;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  maxQueries?: number;
  maxQuerySize?: number;
  pinnedItems?: string[];
  pinnedQueries?: ListQueryParams[];
  ignoreItems?: string[] | ((payload: string) => boolean);
  serverData?: Tables<Row>;
  onPersistentStorageError?: (error: unknown) => void;
  partialResources?: PartialResourcesConfig<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
  usesRealTimeUpdates?: boolean;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  bindFocusController?: {
    getWindowIsFocused: () => boolean;
    onWindowFocus: (handler: () => void) => () => void;
    onWindowBlur: (handler: () => void) => () => void;
  };
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    usesRealTimeUpdates: options.usesRealTimeUpdates,
    dynamicRealtimeThrottleMs: options.dynamicRealtimeThrottleMs,
    bindFocusController: options.bindFocusController,
    persistentStorage: {
      storeName: options.storeName,
      adapter: localPersistentStorage,
      schema: rowSchema,
      version: options.version,
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
      maxQuerySize: options.maxQuerySize,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
      ignoreItems: options.ignoreItems,
      onPersistentStorageError: options.onPersistentStorageError,
    },
  });
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

describe('localStorage: list query store persistence', () => {
  test('direct query reads lazily hydrate only the requested query and its items', () => {
    const usersQuery = { tableId: 'users' };
    const projectsQuery = { tableId: 'projects' };
    const usersItem1 = storeItemKey('users', 1);
    const usersItem2 = storeItemKey('users', 2);
    const projectsItem1 = storeItemKey('projects', 1);

    setCachedItem('lq-local', 'sess1', 'users', 1, { id: 1, name: 'Alice' });
    setCachedItem('lq-local', 'sess1', 'users', 2, { id: 2, name: 'Bob' });
    setCachedItem('lq-local', 'sess1', 'projects', 1, {
      id: 1,
      name: 'Secret',
    });
    setCachedQuery('lq-local', 'sess1', usersQuery, [usersItem1, usersItem2]);
    setCachedQuery('lq-local', 'sess1', projectsQuery, [projectsItem1]);

    const env = createEnv({ storeName: 'lq-local', sessionKey: 'sess1' });

    expect(env.apiStore.getQueriesState(() => true)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getQueriesRelatedToItem(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        []
      `);

    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1', '"users||2']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(env.apiStore.getQueriesState(() => true).map(({ key }) => key))
      .toMatchInlineSnapshot(`
        ['{tableId:"users"}']
      `);
    expect(
      env.apiStore
        .getItemState(() => true)
        .map(({ payload }) => payload)
        .sort(),
    ).toMatchInlineSnapshot(`
      ['users||1', 'users||2']
    `);
  });

  test('direct item reads lazily hydrate only the requested cached item', () => {
    setCachedItem('lq-item-local', 'sess1', 'users', 1, {
      id: 1,
      name: 'Alice',
    });
    setCachedItem('lq-item-local', 'sess1', 'users', 2, { id: 2, name: 'Bob' });

    const env = createEnv({ storeName: 'lq-item-local', sessionKey: 'sess1' });

    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Alice'
      `);
    expect(env.apiStore.getItemState(() => true).map(({ payload }) => payload))
      .toMatchInlineSnapshot(`
        ['users||1']
      `);
  });

  test('first item hook read returns cached data then refetches', async () => {
    setCachedItem('lq-item-hook', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });

    const env = createEnv({
      storeName: 'lq-item-hook',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { returnRefetchingStatus: true },
      );

      renders.add({ status, name: data?.name ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      -> status: refetching ⋅ name: Cached
      -> status: success ⋅ name: Fresh
      "
    `);
  });

  test('first query hook read returns cached data then refetches', async () => {
    const usersQuery = { tableId: 'users' };
    const usersItem = storeItemKey('users', 1);

    setCachedItem('lq-hook', 'sess1', 'users', 1, { id: 1, name: 'Cached' });
    setCachedQuery('lq-hook', 'sess1', usersQuery, [usersItem]);

    const env = createEnv({
      storeName: 'lq-hook',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

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

  test('disableRefetchOnMount keeps cached query data without refetching and refreshes stored timestamps', async () => {
    const usersQuery = { tableId: 'users' };
    const usersItem = setCachedItem('lq-hook-no-refetch', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });
    const usersQueryKey = setCachedQuery(
      'lq-hook-no-refetch',
      'sess1',
      usersQuery,
      [storeItemKey('users', 1)],
    );
    const originalItemTimestamp = getStoredEntryTimestamp(usersItem);
    const originalQueryTimestamp = getStoredEntryTimestamp(usersQueryKey);

    const env = createEnv({
      storeName: 'lq-hook-no-refetch',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
    expect(getStoredEntryTimestamp(usersItem)).toBeGreaterThan(
      originalItemTimestamp,
    );
    expect(getStoredEntryTimestamp(usersQueryKey)).toBeGreaterThan(
      originalQueryTimestamp,
    );
  });

  test('round-trip persistence preserves partial-resource metadata for cached list queries', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-partial-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
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
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(0);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['id', 'name']
      `);
  });

  test('hydrated partial-resource items keep loading until missing fields are fetched', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-item-partial-missing-fields';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
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
      readerEnv.serverTable.getRequestHistory('item').map((entry) => {
        const { time: _time, ...request } = entry;
        return request;
      }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'age', 'email']
          itemId: 'users||1'
    `);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['age', 'email', 'id', 'name']
      `);
  });

  test('hydrated partial-resource queries refetch when hooks request fields missing from storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-partial-missing-fields';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
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
      readerEnv.serverTable.getRequestHistory('list').map((entry) => {
        const { time: _time, ...request } = entry;
        return request;
      }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'age', 'email']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['age', 'email', 'id', 'name']
      `);
  });

  test('round-trip persistence preserves offset-pagination progress for loadMore', async () => {
    const productsQuery = { tableId: 'products' };
    const products = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Product ${index + 1}`,
    }));
    const storeName = 'lq-offset-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
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
      serverData: { products },
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

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
    expect(readerEnv.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);

    // Hydrated query should continue paging from the restored size.
    readerEnv.apiStore.loadMore(productsQuery);
    await flushAllTimers();

    expect(
      readerEnv.apiStore.getQueryState(productsQuery)?.items.length,
    ).toMatchInlineSnapshot(`15`);
    expect(
      readerEnv.serverTable.fetchHistory.map((entry) => {
        if (entry.type !== 'list') return entry.type;
        return {
          type: entry.type,
          offset: entry.offset,
          limit: entry.limit,
          itemIds:
            entry.results === 'aborted'
              ? 'aborted'
              : entry.results.map((result) => result.itemId),
        };
      }),
    ).toMatchInlineSnapshot(`
      - itemIds: ['products||11', 'products||12', 'products||13', 'products||14', 'products||15']
        limit: 5
        offset: 10
        type: 'list'
    `);
  });

  test('hook loadSize smaller than hydrated query keeps the persisted larger size during refetch', async () => {
    const productsQuery = { tableId: 'products' };
    const cachedProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Cached Product ${index + 1}`,
    }));
    const freshProducts = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      name: `Fresh Product ${index + 1}`,
    }));
    const storeName = 'lq-hook-loadsize-smaller';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: cachedProducts },
      defaultQuerySize: 5,
    });

    writerEnv.apiStore.scheduleListQueryFetch(
      'highPriority',
      productsQuery,
      10,
    );
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: freshProducts },
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
      -> status: success ⋅ count: 10 ⋅ lastName: Cached Product 10 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 10 ⋅ lastName: Cached Product 10 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Fresh Product 10 ⋅ hasMore: ✅
      "
    `);
    expect(
      readerEnv.serverTable.fetchHistory.map((entry) => {
        if (entry.type !== 'list') return entry.type;
        return {
          type: entry.type,
          offset: entry.offset,
          limit: entry.limit,
          itemIds:
            entry.results === 'aborted'
              ? 'aborted'
              : entry.results.map((result) => result.itemId).join(','),
        };
      }),
    ).toMatchInlineSnapshot(`
      - itemIds: 'products||1,products||2,products||3,products||4,products||5,products||6,products||7,products||8,products||9,products||10'
        limit: 10
        offset: 0
        type: 'list'
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
    const storeName = 'lq-hook-loadsize-larger';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      serverData: { products: cachedProducts },
      defaultQuerySize: 5,
    });

    writerEnv.apiStore.scheduleListQueryFetch('highPriority', productsQuery, 5);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
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
      -> status: success ⋅ count: 5 ⋅ lastName: Cached Product 5 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 5 ⋅ lastName: Cached Product 5 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Fresh Product 10 ⋅ hasMore: ✅
      "
    `);
    expect(
      readerEnv.serverTable.fetchHistory.map((entry) => {
        if (entry.type !== 'list') return entry.type;
        return {
          type: entry.type,
          offset: entry.offset,
          limit: entry.limit,
          itemIds:
            entry.results === 'aborted'
              ? 'aborted'
              : entry.results.map((result) => result.itemId).join(','),
        };
      }),
    ).toMatchInlineSnapshot(`
      - itemIds: 'products||1,products||2,products||3,products||4,products||5,products||6,products||7,products||8,products||9,products||10'
        limit: 10
        offset: 0
        type: 'list'
    `);
  });

  test('round-trip persistence keeps state-manipulated query membership and item updates', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-state-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
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
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Edited Alice, …(2 more)]
      "
    `);
    expect(readerEnv.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);
    expect(readerEnv.apiStore.getItemState('users||20')).toMatchInlineSnapshot(`
      id: 20
      name: 'Local User'
    `);
  });

  test('deleteItemState removes deleted items from persisted storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-delete-persisted-item';
    const sessionKey = 'sess1';
    const deletedItemStorageKey = itemStorageKey(
      storeName,
      sessionKey,
      'users',
      1,
    );

    const env = createEnv({
      storeName,
      sessionKey,
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

    expect(localStorage.getItem(deletedItemStorageKey)).not.toBeNull();
    expect(getStoredQueryItemKeys(storeName, sessionKey, usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);

    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem(deletedItemStorageKey)).toBeNull();
    expect(getStoredQueryItemKeys(storeName, sessionKey, usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||2']
      `);
  });

  test('when maxQueries is exceeded, the least recently read query is evicted first', async () => {
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const storeName = 'lq-query-lru';
    const sessionKey = 'sess1';

    setCachedQuery(storeName, sessionKey, firstQuery, []);
    await advanceTime(100);
    setCachedQuery(storeName, sessionKey, secondQuery, []);

    const env = createEnv({
      storeName,
      sessionKey,
      maxQueries: 2,
      serverData: { third: [{ id: 1, name: 'Third' }] },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status, hasMore } = env.apiStore.useListQuery(firstQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, count: items.length, hasMore });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 0 ⋅ hasMore: ❌
      "
    `);

    await advanceTime(2100);

    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.query.`))
      .toMatchInlineSnapshot(`
        ['{tableId:"first"}', '{tableId:"third"}']
      `);
  });

  test('when maxItems is exceeded, the least recently read item is evicted first', async () => {
    const storeName = 'lq-item-lru';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Oldest cached',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newer cached',
    });

    const env = createEnv({ storeName, sessionKey, maxItems: 2 });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { disableRefetchOnMount: true, returnRefetchingStatus: true },
      );

      renders.add({ status, data: data ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Oldest cached}
      "
    `);

    await advanceTime(2100);

    env.apiStore.addItemToState('users||3', { id: 3, name: 'Fresh' });

    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.item.`))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||3']
      `);
  });

  test('items and queries are saved per entry and pinned entries survive eviction', async () => {
    const pinnedItemPayload = rawItemPayload('second', 1);
    const pinnedQueryPayload = { tableId: 'second' };
    const env = createEnv({
      storeName: 'lq-evict',
      sessionKey: 'sess1',
      maxItems: 1,
      maxQueries: 1,
      pinnedItems: [pinnedItemPayload],
      pinnedQueries: [pinnedQueryPayload],
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
      },
    });

    env.scheduleFetch('highPriority', { tableId: 'first' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'second' });
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem('tsdf.sess1.lq-evict')).toBeNull();

    expect(listStoredKeys('tsdf.sess1.lq-evict.listQuery.query.'))
      .toMatchInlineSnapshot(`
        ['{tableId:"second"}']
      `);
    expect(listStoredKeys('tsdf.sess1.lq-evict.listQuery.item.'))
      .toMatchInlineSnapshot(`
        ['"second||1']
      `);
  });

  test('pinned items survive eviction even when their query is evicted', async () => {
    const env = createEnv({
      storeName: 'lq-pinned-item-only',
      sessionKey: 'sess1',
      maxItems: 1,
      maxQueries: 1,
      pinnedItems: [rawItemPayload('second', 1)],
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
      },
    });

    // Load the pinned item first, then make a different query the one that survives maxQueries.
    env.scheduleFetch('highPriority', { tableId: 'second' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'first' });
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys('tsdf.sess1.lq-pinned-item-only.listQuery.query.').length,
    ).toMatchInlineSnapshot(`1`);
    expect(listStoredKeys('tsdf.sess1.lq-pinned-item-only.listQuery.item.'))
      .toMatchInlineSnapshot(`
        ['"second||1']
      `);
  });

  test('default persistence limits keep up to 500 items and 100 queries', async () => {
    const storeName = 'lq-default-limits';
    const sessionKey = 'sess1';
    const serverData = Object.fromEntries(
      Array.from({ length: 25 }, (tableEntry_, tableIdx) => [
        `table-${tableIdx + 1}`,
        Array.from({ length: 5 }, (itemEntry_, itemIdx) => ({
          id: itemIdx + 1,
          name: `Item ${tableIdx + 1}-${itemIdx + 1}`,
        })),
      ]),
    );
    const env = createEnv({ storeName, sessionKey, serverData });

    for (let tableIndex = 0; tableIndex < 25; tableIndex++) {
      env.scheduleFetch('highPriority', { tableId: `table-${tableIndex + 1}` });
      await flushAllTimers();
    }

    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.query.`).length,
    ).toMatchInlineSnapshot(`25`);
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.listQuery.item.`).length,
    ).toMatchInlineSnapshot(`125`);
  });

  test('maxQuerySize persists only the first items from each query', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-max-query-size',
      sessionKey: 'sess1',
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(getStoredQueryItemKeys('lq-max-query-size', 'sess1', usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);
    expect(listStoredKeys('tsdf.sess1.lq-max-query-size.listQuery.item.'))
      .toMatchInlineSnapshot(`
        ['"users||1', '"users||2']
      `);

    const readerEnv = createEnv({
      storeName: 'lq-max-query-size',
      sessionKey: 'sess1',
      maxQuerySize: 2,
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ],
      },
    });
    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Alice, Bob]
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('all'),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('ignoreItems excludes matching item payloads from persisted items and queries', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-ignore',
      sessionKey: 'sess1',
      ignoreItems: ['users||2'],
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredKeys('tsdf.sess1.lq-ignore.listQuery.item.'))
      .toMatchInlineSnapshot(`
        ['"users||1']
      `);
    expect(getStoredQueryItemKeys('lq-ignore', 'sess1', usersQuery))
      .toMatchInlineSnapshot(`
        ['"users||1']
      `);

    const readerEnv = createEnv({
      storeName: 'lq-ignore',
      sessionKey: 'sess1',
      ignoreItems: ['users||2'],
      serverData: {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      },
    });
    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Alice]
      "
    `);
    expect(readerEnv.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);
  });

  test('preload reports unavailable async preload through persistent storage error handler', async () => {
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'lq-preload-local',
      sessionKey: 'sess1',
      onPersistentStorageError,
    });

    await expect(env.apiStore.preloadQueryFromStorage({ tableId: 'users' }))
      .resolves.toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '❌'
    `);
    await expect(env.apiStore.preloadItemFromStorage('users||1')).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);

    expect(onPersistentStorageError).toHaveBeenCalledTimes(2);
    expect(onPersistentStorageError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Async preload is not available',
    });
    expect(onPersistentStorageError.mock.calls[1]?.[0]).toMatchObject({
      message: 'Async preload is not available',
    });
  });

  test('invalid cached query entries are cleaned up only after a direct read', async () => {
    const key = setCachedQuery(
      'lq-invalid',
      'sess1',
      { tableId: 'users' },
      [storeItemKey('users', 1)],
      false,
      1,
    );

    const env = createEnv({
      storeName: 'lq-invalid',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(env.apiStore.getQueryState({ tableId: 'users' })).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid cached query entries are also cleaned up after a hook read', async () => {
    const usersQuery = { tableId: 'users' };
    const key = setCachedQuery(
      'lq-invalid-hook',
      'sess1',
      usersQuery,
      [storeItemKey('users', 1)],
      false,
      1,
    );

    const env = createEnv({
      storeName: 'lq-invalid-hook',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(localStorage.getItem(key)).not.toBeNull();

    renderHook(() => {
      env.apiStore.useListQuery(usersQuery, {
        // The hook should exercise the lazy query read path without
        // kicking off a fetch that could hide the cleanup behavior.
        isOffScreen: true,
      });
    });

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });
});
