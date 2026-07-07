import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
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
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type {
  PersistedListQueryData,
  PersistedListQueryItemData,
  PersistentStorageSchema,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  createOpfsPersistentStorageTestStore,
  type OpfsPersistentStorageTestStoreOptions,
} from '../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
} from '../utils/persistentStorageOptimizationTestUtils';
import {
  getAsyncListItemEntrySizeBytes,
  getAsyncListQueryEntrySizeBytes,
  sumPersistedEntryBytes,
} from './persistentStorageByteBudgetTestUtils';

const utf8Encoder = new TextEncoder();

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
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
};
const fullLoadedFields = ['age', 'email', 'id', 'name'];

function getLogicalListItemEntrySizeBytes(payload: string, data: Row): number {
  return utf8Encoder.encode(JSON.stringify({ data, payload })).byteLength;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  maxItemBytes?: number;
  maxQueryBytes?: number;
  maxQuerySize?: number;
  ignoreItems?: string[] | ((payload: string) => boolean);
  pinnedItems?: string[];
  pinnedQueries?: ListQueryParams[];
  serverData?: Tables<Row>;
  partialResources?: PartialResourcesConfig<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
}) {
  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    persistentStorage: {
      adapter: opfsPersistentStorage,
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      maxItemBytes: options.maxItemBytes,
      maxQueryBytes: options.maxQueryBytes,
      maxQuerySize: options.maxQuerySize,
      ignoreItems: options.ignoreItems,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
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

function createListQueryOpfsTestStore(options: {
  storeName: string;
  sessionKey: string;
  initialState?: NonNullable<
    OpfsPersistentStorageTestStoreOptions['initialState']
  >['listQuery'];
}) {
  const mockAdapter = createOpfsPersistentStorageTestStore({
    ...(options.initialState !== undefined
      ? {
          initialState: {
            storeName: options.storeName,
            sessionKey: options.sessionKey,
            listQuery: options.initialState,
          },
        }
      : {}),
  });
  const listQueryScope = mockAdapter.scope(
    options.storeName,
    options.sessionKey,
  ).listQuery;

  return { mockAdapter, listQueryScope };
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

describe('opfs: list query store persistence', () => {
  test('first query hook read hydrates the requested query and its items, then refetches', async () => {
    const storeName = 'lq-opfs-hook';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const { mockAdapter } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
        items: [
          { tableId: 'users', id: 1, data: { id: 1, name: 'Cached' } },
          { tableId: 'projects', id: 1, data: { id: 1, name: 'Cold' } },
        ],
        queries: [{ params: usersQuery, items: [{ tableId: 'users', id: 1 }] }],
      },
    });
    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    expect(env.apiStore.getQueriesState(() => true)).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getQueryState(usersQuery)).toBeUndefined();
    expect(env.apiStore.getItemState('users||1')).toBeUndefined();
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(mockAdapter.scopeReadRequests({ storeName, sessionKey }).slice(0, 2))
      .toMatchInlineSnapshot(`
        ['lq.{tableId:"users"}', 'li."users||1']
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
    createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
        items: [{ tableId: 'users', id: 1, data: { id: 1, name: 'Cached' } }],
        queries: [{ params: usersQuery, items: [{ tableId: 'users', id: 1 }] }],
      },
    });

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
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

  test('large list item keys use hashed OPFS filenames and still hydrate correctly', async () => {
    const storeName = 'lq-opfs-large-item-key';
    const sessionKey = 'sess1';
    const longTableId = `users-${'x'.repeat(320)}`;
    const { mockAdapter } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
        items: [
          { tableId: longTableId, id: 1, data: { id: 1, name: 'Cached' } },
        ],
      },
    });

    // The physical OPFS filename should stay short even when the logical item key is huge.
    const storeEntries = mockAdapter.mockBrowserOpfs
      .listEntries(`tsdf/${sessionKey}/${storeName}`)
      .sort();
    expect({
      payloadFileLengths: storeEntries
        .filter((entry) => entry.endsWith('.p.json'))
        .map((entry) => entry.length),
      storeEntries,
    }).toMatchInlineSnapshot(`
      payloadFileLengths: [27]
      storeEntries: ['file:li._i.r.json', 'file:li.h~2529159976.p.json']
    `);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { [longTableId]: [{ id: 1, name: 'Fresh' }] },
    });

    // Item hydration should keep using the raw logical key even though the OPFS file is hashed.
    const preloadPromise = env.apiStore.preloadItemFromStorage(
      `${longTableId}||1`,
    );
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - payload: 'users-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx||1'
        preloaded: '✅'
    `);

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(`${longTableId}||1`, {
        returnRefetchingStatus: true,
      });

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

  test('large list query payloads use hashed OPFS filenames and still hydrate correctly', async () => {
    const storeName = 'lq-opfs-large-query-key';
    const sessionKey = 'sess1';
    const longSearch = `user-${'x'.repeat(320)}`;
    const query: ListQueryParams = {
      filters: [{ field: 'name', op: 'eq', value: longSearch }],
      tableId: 'users',
    };
    const { mockAdapter } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
        items: [{ tableId: 'users', id: 1, data: { id: 1, name: 'Cached' } }],
        queries: [{ params: query, items: [{ tableId: 'users', id: 1 }] }],
      },
    });

    // Large serialized query payloads should also map to short OPFS payload filenames.
    const storeEntries = mockAdapter.mockBrowserOpfs
      .listEntries(`tsdf/${sessionKey}/${storeName}`)
      .sort();
    expect({
      payloadFileLengths: storeEntries
        .filter((entry) => entry.endsWith('.p.json'))
        .map((entry) => entry.length)
        .sort((left, right) => left - right),
      storeEntries,
    }).toMatchInlineSnapshot(`
      payloadFileLengths: [26, 27]
      storeEntries:
        - 'file:li._i.r.json'
        - 'file:li.h~228010772.p.json'
        - 'file:lq._i.r.json'
        - 'file:lq.h~2854012034.p.json'
    `);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    // Query hydration should still find the large logical query payload through the hashed file.
    const preloadPromise = env.apiStore.preloadQueryFromStorage(query);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - payload:
          filters:
            - field: 'name'
              op: 'eq'
              value: 'user-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
          tableId: 'users'
        preloaded: '✅'
    `);

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(query, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: []
      "
    `);
  });

  test('ignored cached items are skipped during query preload and removed from opfs', async () => {
    const storeName = 'lq-opfs-ignore';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
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
    });

    const env = createEnv({
      storeName,
      sessionKey,
      ignoreItems: (payload) => payload.endsWith('||2'),
    });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(preloadPromise);
    await advanceTime(2100);
    await flushAllTimers();

    expect(env.apiStore.getQueryState(usersQuery)?.items)
      .toMatchInlineSnapshot(`
        ['"users||1']
      `);
    expect(env.apiStore.getItemState('users||2')).toBeUndefined();
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 2))).toBe(
      false,
    );
  });

  test('round-trip persistence preserves partial-resource metadata for cached list queries', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-partial-roundtrip';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    // The writer persists a partial query that only has the requested fields.
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

    const renders = createLoggerStore({ arrays: 'all' });

    // The reader should show the cached partial item first, then revalidate it.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    // Revalidation must not lose the field metadata restored from storage.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(1);
    expect(
      readerEnv.store.state.itemLoadedFields[
        listQueryScope.itemKey('users', 1)
      ],
    ).toMatchInlineSnapshot(`['id', 'name']`);
  });

  test('partial-resource persistence stores each item with its own loaded fields', async () => {
    const storeName = 'lq-opfs-partial-multiple-item-fields';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [
          { id: 1, name: 'Alice', age: 31, email: 'alice@site.test' },
          { id: 2, name: 'Bob', age: 42, email: 'bob@site.test' },
        ],
      },
    });

    env.apiStore.scheduleItemFetch('highPriority', 'users||1', {
      fields: ['id', 'name'],
    });
    env.apiStore.scheduleItemFetch('highPriority', 'users||2', {
      fields: ['id', 'name', 'age'],
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedOpfsFileData(
        `tsdf/${sessionKey}/${storeName}/li.<${listQueryScope.itemKey('users', 1)}>.p.json`,
      ),
    ).toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);
    expect(
      getParsedOpfsFileData(
        `tsdf/${sessionKey}/${storeName}/li.<${listQueryScope.itemKey('users', 2)}>.p.json`,
      ),
    ).toMatchInlineSnapshot(`
      age: 42
      id: 2
      name: 'Bob'
    `);
  });

  test('hydration keeps extra persisted fields visible even when loadedFields is narrower', async () => {
    const storeName = 'lq-opfs-partial-extra-data-visible';
    const sessionKey = 'sess1';
    const itemPayload = 'users||1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedItem(
      'users',
      1,
      { id: 1, name: 'Cached', email: 'cached@site.test' },
      { loadedFields: ['id', 'name'] },
    );

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', email: 'fresh@site.test' }],
      },
    });

    // Preload restores the cached item before any hook subscribes to it.
    const preloadPromise = env.apiStore.preloadItemFromStorage(itemPayload);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);

    const renders = createLoggerStore();

    // The hook asks for an extra field; cached data stays visible while the
    // item revalidates with the larger field set.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem(itemPayload, {
        fields: ['id', 'name', 'email'],
        returnRefetchingStatus: true,
      });

      renders.add({
        status,
        name: data?.name ?? null,
        email: data?.email ?? null,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached ⋅ email: cached@site.test
      -> status: refetching ⋅ name: Cached ⋅ email: cached@site.test
      -> status: success ⋅ name: Fresh ⋅ email: fresh@site.test
      "
    `);
    // The revalidation should be an item fetch for the complete requested fields.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['id', 'name', 'email']
            itemId: 'users||1'
      `);
  });

  test('later partial saves keep extra fields already present in persisted item data', async () => {
    const storeName = 'lq-opfs-partial-keep-extra-fields-on-save';
    const sessionKey = 'sess1';
    const itemPayload = 'users||1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedItem(
      'users',
      1,
      { id: 1, name: 'Cached', email: 'cached@site.test' },
      { loadedFields: ['id', 'name'] },
    );

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', email: 'fresh@site.test' }],
      },
    });

    // Start from a cached item that has email stored but only id/name marked loaded.
    const preloadPromise = env.apiStore.preloadItemFromStorage(itemPayload);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);

    // Mounting with id/name triggers the normal hydration revalidation path.
    renderHook(() => {
      env.apiStore.useItem(itemPayload, { fields: ['id', 'name'] });
    });

    await flushAllTimers();

    // Saving a later partial fetch must preserve the already persisted email.
    env.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: ['id', 'name'],
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedOpfsFileData(
        `tsdf/${sessionKey}/${storeName}/li.<${listQueryScope.itemKey('users', 1)}>.p.json`,
      ),
    ).toMatchInlineSnapshot(`
      email: 'cached@site.test'
      id: 1
      name: 'Fresh'
    `);
  });

  test('hydrated partial-resource items keep loading until missing fields are fetched', async () => {
    const storeName = 'lq-opfs-item-partial-missing-fields';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const itemPayload = 'users||1';

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
      readerEnv.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'age', 'email']
          itemId: 'users||1'
    `);
    expect(
      readerEnv.store.state.itemLoadedFields[
        listQueryScope.itemKey('users', 1)
      ],
    ).toMatchInlineSnapshot(`
      ['age', 'email', 'id', 'name']
    `);
  });

  test('hydrated partial-resource queries refetch when hooks request fields missing from storage', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-partial-missing-fields';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

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
        listQueryScope.itemKey('users', 1)
      ],
    ).toMatchInlineSnapshot(`
      ['age', 'email', 'id', 'name']
    `);
  });

  test('round-trip persistence preserves offset-pagination progress for loadMore', async () => {
    createOpfsPersistentStorageTestStore();
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
      serverData: { products },
      defaultQuerySize: 5,
      offsetPagination: { maxInvalidationLimit: 100 },
    });

    // Persist two pages so the restored query starts with 10 loaded items.
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

    // Explicit preload simulates opening the app with data already in OPFS.
    const preloadPromise =
      readerEnv.apiStore.preloadQueryFromStorage(productsQuery);
    await resolveAfterAllTimers(preloadPromise);

    const renders = createLoggerStore();

    // The hook should render the restored page immediately and then perform
    // the normal hydration revalidation against the same 10-item range.
    renderHook(() => {
      const { items, status, hasMore } = readerEnv.apiStore.useListQuery(
        productsQuery,
        { returnRefetchingStatus: true },
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
      -> status: success ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      -> status: refetching ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      -> status: success ⋅ count: 10 ⋅ lastName: Product 10 ⋅ hasMore: ✅
      "
    `);
    // The hydration revalidation should reconcile the same 10-item window that
    // was restored from storage.
    expect(
      readerEnv.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 10, offset: 0 }
        returned_items: 10
    `);

    // After hydration revalidation settles, loadMore should continue from
    // offset 10 rather than refetching the head again.
    readerEnv.serverTable.clearFetchHistory();
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
    createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: createPersistedListQueryState(
        'products',
        Array.from({ length: 20 }, (_, index) => ({
          id: index + 1,
          name: `Cached Product ${index + 1}`,
        })),
        10,
      ).listQuery,
    });

    const readerEnv = createEnv({
      storeName,
      sessionKey,
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
    createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: createPersistedListQueryState('products', cachedProducts, 5)
        .listQuery,
    });

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
    createOpfsPersistentStorageTestStore();
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-state-roundtrip';
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

    // Persist local-only state changes to verify storage round-trips manual edits too.
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

    // Preloading should hydrate the local-only membership before a mount effect
    // has a chance to revalidate against the server.
    const preloadPromise =
      readerEnv.apiStore.preloadQueryFromStorage(usersQuery);
    await resolveAfterAllTimers(preloadPromise);

    const renders = createLoggerStore({ arrays: 'all' });

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    // This immediate assertion protects the persisted local edits, not the later
    // mount revalidation path covered by the other tests in this file.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Edited Alice, Bob, Local User]
      "
    `);
    // No request has run yet because this test asserts the immediate hydrated
    // state before effects are flushed.
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
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const deletedItemStorageKey = listQueryScope.itemStorageKey('users', 1);

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

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(true);

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-delete-persisted-item/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);

    env.apiStore.deleteItemState('users||1');
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-delete-persisted-item/lq.<{tableId:"users"}>.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||2']`);
  });

  test('cold persisted query items can be evicted during unrelated maxItemBytes cleanup and later hydrate with missing items filtered out', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-cold-query-items';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    listQueryScope.seedItem('users', 1, { id: 1, name: 'Older cached' });
    await advanceTime(100);
    listQueryScope.seedItem('users', 2, { id: 2, name: 'Newer cached' });
    listQueryScope.seedQuery(usersQuery, [
      listQueryScope.itemKey('users', 1),
      listQueryScope.itemKey('users', 2),
    ]);
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
      ),
    });

    // Adding a standalone item forces maxItemBytes cleanup without rewriting the
    // cold query payload, leaving one referenced item missing from storage.
    writerEnv.apiStore.addItemToState('users||3', {
      id: 3,
      name: 'Fresh standalone',
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(`
      ['{tableId:"users"}']
    `);
    expect(listQueryScope.listStoredItemKeys().sort()).toMatchInlineSnapshot(`
      ['"users||2', '"users||3']
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-query-items/lq.%7BtableId%3A%22users%22%7D.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||1', {
            id: 1,
            name: 'Older cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
        sumPersistedEntryBytes(
          getAsyncListItemEntrySizeBytes('users||2', {
            id: 2,
            name: 'Newer cached',
          }),
          getAsyncListItemEntrySizeBytes(
            'users||3',
            { id: 3, name: 'Fresh standalone' },
            { loadedFields: fullLoadedFields },
          ),
        ),
      ),
      serverData: {
        users: [
          { id: 1, name: 'Older cached' },
          { id: 2, name: 'Newer cached' },
          { id: 3, name: 'Fresh standalone' },
        ],
      },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    // The reader first hydrates the remaining cached item, then revalidates the
    // list and restores the missing server items.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Newer cached]
      -> status: refetching ⋅ names: [Newer cached]
      -> status: success ⋅ names: [Older cached, Newer cached, Fresh standalone]
      "
    `);
    // The mount revalidation should repair the incomplete hydrated query.
    expect(
      readerEnv.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 3
    `);
  });

  test('explicit item preload hydrates only the targeted item', async () => {
    const storeName = 'lq-opfs-preload-item';
    const sessionKey = 'sess1';
    createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
        items: [
          { tableId: 'users', id: 1, data: { id: 1, name: 'Alice' } },
          { tableId: 'users', id: 2, data: { id: 2, name: 'Bob' } },
        ],
      },
    });

    const env = createEnv({ storeName, sessionKey });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
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

  test('missing item preloads still recheck storage on later retries', async () => {
    const storeName = 'lq-opfs-missing-item-cache';
    const sessionKey = 'sess1';
    const { mockAdapter } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    const env = createEnv({ storeName, sessionKey });

    await advanceTime(2100);
    await flushAllTimers();

    const firstCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const firstPreloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(firstPreloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);
    const firstOperations = firstCapture.finish().timelineString;

    expect(firstOperations).not.toBe('empty');

    const secondCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const secondPreloadPromise =
      env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(secondPreloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);
    const secondOperations = secondCapture.finish().timelineString;
    expect(secondOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ❌ tsdf/sess1 (session directory)
      1ms  | end
      "
    `);
  });

  test('persisted list item maxItemBytes policy is enforced on cold startup before the store mounts', async () => {
    const storeName = 'lq-opfs-cold-policy-max-items';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const keptOlderItem = { id: 2, name: 'Older kept' };
    const keptNewestItem = { id: 3, name: 'Newest kept' };

    listQueryScope.seedItem('users', 1, { id: 1, name: 'Older cached' });
    await advanceTime(100);
    listQueryScope.seedItem('users', 2, keptOlderItem);
    await advanceTime(100);
    listQueryScope.seedItem('users', 3, keptNewestItem);
    listQueryScope.setItemStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes('users||2', keptOlderItem),
        getAsyncListItemEntrySizeBytes('users||3', keptNewestItem),
      ),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||2', '"users||3']
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-max-items/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "users||2: { a: 1735689600100, p: 'users||2', z: 62 }
        "users||3: { a: 1735689600200, p: 'users||3', z: 63 }

      s: { b: 125 }
    `);
  });

  test('maxItemBytes rewrites the surviving standalone item after a newer item is removed', async () => {
    const storeName = 'lq-opfs-rewrite-after-item-byte-eviction';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const olderPayload = 'users||1';
    const newerPayload = 'users||2';
    const olderItem = { id: 1, name: 'Older kept later' };
    const newerItem = { id: 2, name: 'Newer evicted later' };
    const maxItemBytes = sumPersistedEntryBytes(
      getAsyncListItemEntrySizeBytes(olderPayload, olderItem),
      getLogicalListItemEntrySizeBytes(newerPayload, newerItem),
    );

    expect(maxItemBytes).toBeLessThan(
      sumPersistedEntryBytes(
        getAsyncListItemEntrySizeBytes(olderPayload, olderItem),
        getAsyncListItemEntrySizeBytes(newerPayload, newerItem),
      ),
    );

    const env = createEnv({ storeName, sessionKey, maxItemBytes });

    env.apiStore.addItemToState(olderPayload, olderItem);
    await advanceTime(1100);
    await flushAllTimers();

    env.apiStore.addItemToState(newerPayload, newerItem);
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||2']
    `);

    env.apiStore.deleteItemState(newerPayload);
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||1']
    `);

    opfsPersistentStorage.resetForTests?.();
    const readerEnv = createEnv({ storeName, sessionKey });

    await expect(
      resolveAfterAllTimers(
        readerEnv.apiStore.preloadItemFromStorage(olderPayload),
      ),
    ).resolves.toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);
  });

  test('persisted list query maxQueryBytes policy is enforced on cold startup before the store mounts', async () => {
    const storeName = 'lq-opfs-cold-policy-max-queries';
    const sessionKey = 'sess1';
    const firstQuery = { tableId: 'users-1' };
    const secondQuery = { tableId: 'users-2' };
    const thirdQuery = { tableId: 'users-3' };
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedQuery(firstQuery, []);
    await advanceTime(100);
    listQueryScope.seedQuery(secondQuery, []);
    await advanceTime(100);
    listQueryScope.seedQuery(thirdQuery, []);
    listQueryScope.setQueryStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, []),
        getAsyncListQueryEntrySizeBytes(thirdQuery, []),
      ),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(
      `['{tableId:"users-2"}', '{tableId:"users-3"}']`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-max-queries/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users-2"}:
          a: 1735689600100
          p: { tableId: 'users-2' }
          z: 47
        {tableId:"users-3"}:
          a: 1735689600200
          p: { tableId: 'users-3' }
          z: 47

      s: { b: 94 }
    `);
  });

  test('maxQueryBytes keeps the two newest async-written queries when they exactly fit', async () => {
    const storeName = 'lq-opfs-inline-query-byte-budget';
    const sessionKey = 'sess1';
    const firstQuery = { tableId: 'first' };
    const secondQuery = { tableId: 'second' };
    const thirdQuery = { tableId: 'third' };
    const secondItemKey = getCompositeKey('second||1');
    const thirdItemKey = getCompositeKey('third||1');
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, [secondItemKey]),
        getAsyncListQueryEntrySizeBytes(thirdQuery, [thirdItemKey]),
      ),
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
        third: [{ id: 1, name: 'Third' }],
      },
    });

    writerEnv.scheduleFetch('highPriority', firstQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    writerEnv.scheduleFetch('highPriority', secondQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    opfsPersistentStorage.resetForTests?.();
    const readerEnv = createEnv({
      storeName,
      sessionKey,
      maxQueryBytes: sumPersistedEntryBytes(
        getAsyncListQueryEntrySizeBytes(secondQuery, [secondItemKey]),
        getAsyncListQueryEntrySizeBytes(thirdQuery, [thirdItemKey]),
      ),
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
        third: [{ id: 1, name: 'Third' }],
      },
    });

    readerEnv.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(`
      ['{tableId:"second"}', '{tableId:"third"}']
    `);
  });

  test('persisted pinned list item keys survive cold startup cleanup', async () => {
    const storeName = 'lq-opfs-cold-policy-pinned-item';
    const sessionKey = 'sess1';
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedItem('users', 1, { id: 1, name: 'Pinned older' });
    await advanceTime(100);
    listQueryScope.seedItem('users', 2, { id: 2, name: 'Newer other' });
    listQueryScope.setItemStaticPolicy({
      k: [listQueryScope.itemKey('users', 1)],
      b: getAsyncListItemEntrySizeBytes('users||1', {
        id: 1,
        name: 'Pinned older',
      }),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||1']
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-pinned-item/li._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "users||1: { a: 1735689600000, p: 'users||1', z: 64 }

      s:
        b: 64
        k: ['"users||1']
    `);
  });

  test('persisted pinned query keys survive cold startup cleanup', async () => {
    const storeName = 'lq-opfs-cold-policy-pinned-query';
    const sessionKey = 'sess1';
    const pinnedQuery = { tableId: 'users-pinned' };
    const otherQuery = { tableId: 'users-other' };
    const { listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });

    listQueryScope.seedQuery(pinnedQuery, []);
    await advanceTime(100);
    listQueryScope.seedQuery(otherQuery, []);
    listQueryScope.setQueryStaticPolicy({
      k: [listQueryScope.queryKey(pinnedQuery)],
      b: getAsyncListQueryEntrySizeBytes(pinnedQuery, []),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-list-query', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(listQueryScope.listStoredQueryKeys()).toMatchInlineSnapshot(
      `['{tableId:"users-pinned"}']`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-cold-policy-pinned-query/lq._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        {tableId:"users-pinned"}:
          a: 1735689600000
          p: { tableId: 'users-pinned' }
          z: 52

      s:
        b: 52
        k: ['{tableId:"users-pinned"}']
    `);
  });

  test('invalid cached items are removed during targeted preload', async () => {
    const storeName = 'lq-opfs-invalid';
    const sessionKey = 'sess1';
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const key = listQueryScope.itemStorageKey('users', 1);
    const entry: StorageCacheEntry<PersistedListQueryItemData<{ bad: true }>> =
      {
        data: { data: { bad: true }, payload: 'users||1' },
        timestamp: Date.now(),
        version: 1,
      };
    mockAdapter.storage.writeValue(key, entry);

    const env = createEnv({ storeName, sessionKey });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('items marked missing can be re-persisted and later preloaded again', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-repersist-missing-item';
    const sessionKey = 'sess1';
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Alice' }] },
    });

    await advanceTime(2100);
    await flushAllTimers();

    const missingPreloadPromise =
      env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(missingPreloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);

    env.scheduleFetch('highPriority', usersQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(listQueryScope.listStoredItemKeys()).toMatchInlineSnapshot(`
      ['"users||1']
    `);

    // Drop the in-memory item without touching the persisted copy so the next
    // preload must go back to storage. Item keys are the serialized payload, so
    // the string payload 'users||1' is stored under the key '"users||1'.
    act(() => {
      env.store.produceState((draft) => {
        delete draft.items['"users||1'];
        delete draft.itemQueries['"users||1'];
        delete draft.itemLoadedFields['"users||1'];
      });
    });

    // Clearing adapter caches and pending commits keeps the assertion focused on
    // whether the next preload really goes back to storage.
    opfsPersistentStorage.resetForTests?.();

    const reloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const reloadedItem = env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(reloadedItem)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);
    expect(reloadCapture.finish().timelineString).toContain(
      '(item data, <"users||1>)',
    );
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Alice'
    `);
  });

  test('invalid cached item payloads are removed during targeted preload', async () => {
    const storeName = 'lq-opfs-invalid-item-payload';
    const sessionKey = 'sess1';
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const key = listQueryScope.itemStorageKey('users', 1);
    const entry: StorageCacheEntry<
      PersistedListQueryItemData<Row> & { payload: boolean }
    > = {
      data: { data: { id: 1, name: 'Alice' }, payload: true },
      timestamp: Date.now(),
      version: 1,
    };
    mockAdapter.storage.writeValue(key, entry);

    const env = createEnv({ storeName, sessionKey });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '❌' }
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('invalid cached queries are removed during targeted preload', async () => {
    const storeName = 'lq-opfs-invalid-query';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const key = listQueryScope.queryStorageKey(usersQuery);
    const entry: StorageCacheEntry<
      PersistedListQueryData & { payload: boolean }
    > = {
      data: {
        payload: true,
        items: [listQueryScope.itemKey('users', 1)],
        hasMore: false,
      },
      timestamp: Date.now(),
      version: 1,
    };
    mockAdapter.storage.writeValue(key, entry);
    listQueryScope.seedItem('users', 1, { id: 1, name: 'Alice' });

    const env = createEnv({ storeName, sessionKey });

    const preloadPromise = env.apiStore.preloadQueryFromStorage(usersQuery);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '❌'
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('reset cancels stale async hydrations', async () => {
    const storeName = 'lq-opfs-reset';
    const sessionKey = 'sess1';
    createListQueryOpfsTestStore({
      storeName,
      sessionKey,
      initialState: {
        items: [{ tableId: 'users', id: 1, data: { id: 1, name: 'Stale' } }],
      },
    });

    const env = createEnv({ storeName, sessionKey });

    const preloadPromise = env.apiStore.preloadItemFromStorage('users||1');

    env.apiStore.reset();

    await resolveAfterAllTimers(preloadPromise);

    expect(env.apiStore.getItemState('users||1')).toBeUndefined();
  });

  test('maxQuerySize persists only the first items from each query', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-opfs-max-query-size';
    const sessionKey = 'sess1';
    const { mockAdapter, listQueryScope } = createListQueryOpfsTestStore({
      storeName,
      sessionKey,
    });
    const writerEnv = createEnv({
      storeName,
      sessionKey,
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

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/lq-opfs-max-query-size/lq.%7BtableId%3A%22users%22%7D.p.json',
      ),
    ).toMatchInlineSnapshot(`['"users||1', '"users||2']`);
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 1))).toBe(
      true,
    );
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 2))).toBe(
      true,
    );
    expect(mockAdapter.has(listQueryScope.itemStorageKey('users', 3))).toBe(
      false,
    );

    const readerEnv = createEnv({
      storeName,
      sessionKey,
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

    // Only the query is preloaded; the mounted hook hydrates its items and then
    // revalidates the full list.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: []
      -> status: success ⋅ names: [Alice, Bob]
      -> status: refetching ⋅ names: [Alice, Bob]
      -> status: success ⋅ names: [Alice, Bob, Carol]
      "
    `);
    // Revalidation can include the evicted third item even though the OPFS
    // maxQuerySize limit kept only two items persisted.
    expect(
      readerEnv.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 3
    `);
  });
});
