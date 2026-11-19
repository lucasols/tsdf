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
import { createCompactLocalStorageEntry } from '../../src/persistentStorage/compactLocalStorageEntry';
import { readManagedLocalStorageNamespaceEntryByPayload } from '../../src/persistentStorage/localStorageMetadata';
import type { OfflineNetworkModeConfig } from '../../src/persistentStorage/offline/types';
import { SYNC_STORAGE_TOUCH_THROTTLE_MS } from '../../src/persistentStorage/persistentStorageManager';
import type { PersistentStorageSchema } from '../../src/persistentStorage/types';
import { createStoreManager } from '../../src/storeManager';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { getParsedLocalStorageValue } from '../utils/persistentStorageOptimizationTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';
import {
  getLocalListItemEntrySizeBytes,
  getLocalListQueryEntrySizeBytes,
  sumPersistedEntryBytes,
} from './persistentStorageByteBudgetTestUtils';

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
const persistentStore = createLocalStoragePersistentTestStore();
let network = createOfflineNetworkMock();

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
  return `tsdf.${sessionKey}.${storeName}.li.${storeItemKey(tableId, id)}`;
}

function queryStorageKey(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
): string {
  return `tsdf.${sessionKey}.${storeName}.lq.${storeQueryKey(params)}`;
}

function setCachedItem(
  storeName: string,
  sessionKey: string,
  tableId: string,
  id: number,
  data: Row,
  version: number | undefined = undefined,
  timestamp = Date.now(),
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedItem(tableId, id, data, { version, timestamp }).storageKey;
}

function setCachedQuery(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
  items: string[],
  hasMore = false,
  version: number | undefined = undefined,
  timestamp = Date.now(),
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .listQuery.seedQuery(params, items, { hasMore, version, timestamp });
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
  const itemIndex = key.indexOf('.li.');
  const queryIndex = key.indexOf('.lq.');
  if (queryIndex !== -1) {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      throw new Error(`Missing localStorage entry for ${key}`);
    }

    const parsed = __LEGIT_CAST__<{ a: number }, unknown>(JSON.parse(raw));
    return parsed.a;
  }

  const splitIndex = itemIndex;
  const prefix = splitIndex === -1 ? `${key}.` : key.slice(0, splitIndex + 4);
  const entry = readManagedLocalStorageNamespaceEntryByPayload(key, prefix);
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

  const parsed = __LEGIT_CAST__<{ i: string[] }, unknown>(JSON.parse(raw));
  return parsed.i;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItemBytes?: number;
  maxQueryBytes?: number;
  maxQuerySize?: number;
  pinnedItems?: string[];
  pinnedQueries?: ListQueryParams[];
  ignoreItems?: string[] | ((payload: string) => boolean);
  serverData?: Tables<Row>;
  onPersistentStorageError?: (error: unknown) => void;
  partialResources?: PartialResourcesConfig<Row>;
  offsetPagination?: OffsetPaginationConfig;
  defaultQuerySize?: number;
  /** Makes the store offline-capable, tracking this network state. */
  offlineNetwork?: OfflineNetworkModeConfig;
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
  const getSessionKey = () => options.sessionKey ?? 'session1';

  return createListQueryStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey,
    storeManager: options.offlineNetwork
      ? createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey,
          offlineSession: { network: options.offlineNetwork },
        })
      : undefined,
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    usesRealTimeUpdates: options.usesRealTimeUpdates,
    dynamicRealtimeThrottleMs: options.dynamicRealtimeThrottleMs,
    bindFocusController: options.bindFocusController,
    persistentStorage: {
      adapter: 'local-sync',
      schema: rowSchema,
      itemPayloadSchema: rc_string,
      queryPayloadSchema: listQueryParamsSchema,
      version: options.version,
      maxItemBytes: options.maxItemBytes,
      maxQueryBytes: options.maxQueryBytes,
      maxQuerySize: options.maxQuerySize,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
      ignoreItems: options.ignoreItems,
      onPersistentStorageError: options.onPersistentStorageError,
      offline: options.offlineNetwork ? { operations: {} } : undefined,
    },
  });
}

const usersListQuery = { tableId: 'users' };

/**
 * Runs the app sessions that leave the users list (two rows) cached while
 * some of its rows were evicted by `maxItemBytes`, and returns a function that
 * starts the next app session (a cold start).
 */
async function cacheUsersListAndEvictRows(options: {
  storeName: string;
  evictedRows: 'User 1' | 'all';
  offlineNetwork?: OfflineNetworkModeConfig;
}) {
  const projectsQuery = { tableId: 'projects' };
  const serverData = {
    users: [
      { id: 1, name: 'User 1' },
      { id: 2, name: 'User 2' },
    ],
    projects: [
      { id: 1, name: 'Project 1' },
      { id: 2, name: 'Project 2' },
    ],
  };
  const projectRowsBytes = sumPersistedEntryBytes(
    getLocalListItemEntrySizeBytes(rawItemPayload('projects', 1), {
      id: 1,
      name: 'Project 1',
    }),
    getLocalListItemEntrySizeBytes(rawItemPayload('projects', 2), {
      id: 2,
      name: 'Project 2',
    }),
  );
  // The item budget fits the two project rows, plus a single user row when
  // only "User 1" is meant to be evicted.
  const maxItemBytes =
    options.evictedRows === 'all'
      ? projectRowsBytes
      : projectRowsBytes +
        getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
          id: 2,
          name: 'User 2',
        });

  function startNextSession() {
    return createEnv({
      storeName: options.storeName,
      sessionKey: 'sess1',
      maxItemBytes,
      offlineNetwork: options.offlineNetwork,
      serverData: structuredClone(serverData),
    });
  }

  // The users list is loaded and cached with both rows.
  let session = startNextSession();
  const usersList = renderHook(() =>
    session.apiStore.useListQuery(usersListQuery),
  );
  await flushAllTimers();
  usersList.unmount();
  await advanceTime(60_000);

  if (options.evictedRows === 'User 1') {
    // In a new session only "User 2" is opened, which refreshes its recency.
    session = startNextSession();
    const userDetails = renderHook(() =>
      session.apiStore.useItem(rawItemPayload('users', 2)),
    );
    await flushAllTimers();
    // Wait for the localStorage touch throttle so the read recency is stored.
    await advanceTime(SYNC_STORAGE_TOUCH_THROTTLE_MS + 100);
    userDetails.unmount();
  }

  // Loading the projects list pushes the items over maxItemBytes: the least
  // recently read rows are evicted.
  const projectsList = renderHook(() =>
    session.apiStore.useListQuery(projectsQuery),
  );
  await flushAllTimers();
  await advanceTime(1100);
  await flushAllTimers();
  projectsList.unmount();

  return { startNextSession };
}

function mountUsersList(env: ReturnType<typeof createEnv>) {
  const renders = createLoggerStore({ arrays: 'all' });

  const { unmount } = renderHook(() => {
    const { items, status, error } = env.apiStore.useListQuery(usersListQuery, {
      returnRefetchingStatus: true,
    });

    renders.add({
      status,
      error: error?.id ?? null,
      names: items.map((item) => item.name),
    });
  });

  return { renders, unmount };
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage: list query store persistence', () => {
  test('dev-only check rejects store ids containing dots', () => {
    expect(() =>
      createEnv({ storeName: 'users.with-dot', sessionKey: 'sess1' }),
    ).toThrow(
      '[tsdf] store id "users.with-dot" must not contain "." when persistentStorage is enabled.',
    );
  });

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

  test('direct cold item reads materialize state and stop consulting localStorage', () => {
    const storeName = 'lq-item-external-overwrite';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached v1',
    });

    const env = createEnv({ storeName, sessionKey });

    // First cold read hydrates from the persisted item entry.
    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached v1'
      `);
    expect(env.store.state.items[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached v1'
      `);

    // Once the cached entry is read through into state, later storage changes
    // should not silently replace the live in-memory state.
    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached v2',
    });

    expect(env.apiStore.getItemState(rawItemPayload('users', 1)))
      .toMatchInlineSnapshot(`
        id: 1
        name: 'Cached v1'
      `);
  });

  test('direct cold query reads materialize state and stop consulting localStorage', () => {
    const storeName = 'lq-query-external-overwrite';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const usersItem1 = storeItemKey('users', 1);
    const usersItem2 = storeItemKey('users', 2);

    setCachedItem(storeName, sessionKey, 'users', 1, { id: 1, name: 'Alice' });
    setCachedQuery(storeName, sessionKey, usersQuery, [usersItem1]);

    const env = createEnv({ storeName, sessionKey });

    // First cold read hydrates the persisted query metadata.
    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state.queries[getCompositeKey(usersQuery)])
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);

    // Once the cached query is read through into state, later storage changes
    // should not silently replace the live in-memory query snapshot.
    setCachedItem(storeName, sessionKey, 'users', 2, { id: 2, name: 'Bob' });
    setCachedQuery(storeName, sessionKey, usersQuery, [usersItem1, usersItem2]);

    expect(env.apiStore.getQueryState(usersQuery)).toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
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

  test('loadFromStateOnly ignores cold persisted items', async () => {
    const storeName = 'lq-load-from-state-only';
    const sessionKey = 'sess1';

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Cached only',
    });

    const env = createEnv({ storeName, sessionKey });
    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status, error, isLoading } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { loadFromStateOnly: true },
      );

      renders.add({ status, data, error, isLoading });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ status: error
      ⋅ data: null
      ⋅ error: {code:460, id:cache-miss, message:Cache miss}
      ⋅ isLoading: ❌
      └─
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

  test('realtime stores revalidate cached localStorage query after first hydration', async () => {
    const usersQuery = { tableId: 'users' };
    const usersItem = storeItemKey('users', 1);

    // Seed the browser cache with stale data so the hook can show persisted
    // state immediately before doing its first server reconciliation.
    setCachedItem('lq-rtu-first-sync', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });
    setCachedQuery('lq-rtu-first-sync', 'sess1', usersQuery, [usersItem]);

    const env = createEnv({
      storeName: 'lq-rtu-first-sync',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
      usesRealTimeUpdates: true,
    });

    const renders = createLoggerStore();

    // usesRealTimeUpdates should not skip the first hydration refetch; only
    // later freshness is expected to come from realtime invalidations.
    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    // The cached row is stale-while-revalidate data: visible immediately, then
    // replaced by the server row after the mount revalidation finishes.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('disableRefetchOnMount still revalidates cached query data marked refetchOnMount', async () => {
    const usersQuery = { tableId: 'users' };
    // Make both persisted entries old enough that the touch-throttle path must
    // refresh their timestamps when they are read back from localStorage.
    const originalTimestamp = Date.now() - SYNC_STORAGE_TOUCH_THROTTLE_MS - 1;
    const usersItem = setCachedItem(
      'lq-hook-no-refetch',
      'sess1',
      'users',
      1,
      { id: 1, name: 'Cached' },
      undefined,
      originalTimestamp,
    );
    const usersQueryKey = setCachedQuery(
      'lq-hook-no-refetch',
      'sess1',
      usersQuery,
      [storeItemKey('users', 1)],
      false,
      undefined,
      originalTimestamp,
    );
    const originalItemTimestamp = getStoredEntryTimestamp(usersItem);
    const originalQueryTimestamp = getStoredEntryTimestamp(usersQueryKey);

    const env = createEnv({
      storeName: 'lq-hook-no-refetch',
      sessionKey: 'sess1',
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });

    const renders = createLoggerStore();

    // disableRefetchOnMount only suppresses the hook's own mount policy. It
    // must not ignore the persisted refetchOnMount marker restored from cache.
    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    await flushAllTimers();

    // The cached data still revalidates because the restored query explicitly
    // asked for it, and the storage entries are touched as part of hydration.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: success ⋅ names: [Fresh]
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
    expect(getStoredEntryTimestamp(usersItem)).toBeGreaterThan(
      originalItemTimestamp,
    );
    expect(getStoredEntryTimestamp(usersQueryKey)).toBeGreaterThan(
      originalQueryTimestamp,
    );
  });

  test('failed list-query hook fetch does not create persisted query or item entries', async () => {
    const storeName = 'lq-fetch-error-no-persist';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Alice' }] },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    // Fail the first hook-triggered list fetch before anything can be cached.
    env.serverTable.setNextListFetchError('Network error');

    renderHook(() => {
      const { items, status, error } = env.apiStore.useListQuery(usersQuery);

      renders.add({ status, names: items.map((item) => item.name), error });
    });

    await flushAllTimers();

    // Wait past the debounced persistence window so accidental writes would materialize.
    await advanceTime(1100);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ names: [] ⋅ error: null
      ┌─
      ⋅ status: error
      ⋅ names: []
      ⋅ error: {code:500, id:fetch-error, message:Network error}
      └─
      "
    `);
    expect(
      persistentStore.storage.readEntry(
        queryStorageKey(storeName, sessionKey, usersQuery),
      ),
    ).toBeNull();
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('failed refetch keeps the previous persisted list-query snapshots', async () => {
    const storeName = 'lq-refetch-error-keeps-cache';
    const sessionKey = 'sess1';
    const usersQuery = { tableId: 'users' };

    // Seed both the cached query metadata and its hydrated item snapshot.
    setCachedItem(storeName, sessionKey, 'users', 1, { id: 1, name: 'Cached' });
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
    ]);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });
    const renders = createLoggerStore({ arrays: 'all' });

    env.serverTable.setNextListFetchError('Network error');

    renderHook(() => {
      const { items, status, error } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name), error });
    });

    await flushAllTimers();
    await advanceTime(1100);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached] ⋅ error: null
      -> status: refetching ⋅ names: [Cached] ⋅ error: null
      ┌─
      ⋅ status: error
      ⋅ names: [Cached]
      ⋅ error: {code:500, id:fetch-error, message:Network error}
      └─
      "
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(usersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||1']
      payload: { tableId: 'users' }
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readItemEntry<Row>('users', 1).data,
    ).toMatchInlineSnapshot(`
      data: { id: 1, name: 'Cached' }
      payload: 'users||1'
    `);
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

    // The writer persists a partial list result, including the loaded-field
    // metadata needed to know which item fields are actually complete.
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

    // Assert the synchronous hydration result before flushing the mount effect;
    // this isolates whether localStorage restored the partial metadata.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(0);
    // The restored item must still know that only id/name were loaded, even
    // though the cached object is already usable by the hook.
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['id', 'name']
      `);
  });

  test("round-trip persistence preserves the fully-loaded ('*') marker for cached items", async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-full-star-roundtrip';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Cached', age: 31, email: 'cached@site.test' }],
      },
    });

    // The writer fetches the complete item; the persisted snapshot must carry
    // the fully-loaded marker (`lf: '*'`) instead of an enumerated field list.
    writerEnv.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: '*',
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { age: 31, email: 'cached@site.test', id: 1, name: 'Cached' }
      lf: '*'
      p: 'users||1'
    `);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 32, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    // A full ('*') read must be satisfiable straight from hydration: the first
    // render is already a success, which only happens when the restored marker
    // is '*' — a fabricated field list would not vouch for a complete item.
    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: '*',
        returnRefetchingStatus: true,
      });

      renders.add({ status, name: data?.name ?? null });
    });

    // Assert the synchronous hydration result before flushing the mount effect.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      "
    `);
    expect(readerEnv.serverTable.numOfFinishedFetches).toBe(0);
    expect(
      readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toBe('*');

    await flushAllTimers();

    // The hydrated snapshot only revalidates (a single low-priority refetch of
    // the complete item), it never blocks the UI behind a loading state.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      ⋅⋅⋅
      -> status: refetching ⋅ name: Cached
      -> status: success ⋅ name: Fresh
      "
    `);
    expect(
      readerEnv.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
    `);
    expect(
      readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toBe('*');
  });

  test('items invalidated before a reload are still shown from cache, including fields the server omitted', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-partial-invalidated-before-reload';
    const sessionKey = 'sess1';
    const requestedFields = ['id', 'name', 'email'];

    // The server row has no `email`: the request loads the field, but the
    // item snapshot does not carry it, so `inferFields` cannot vouch for it —
    // only the loaded-fields metadata can.
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    const { unmount } = renderHook(() => {
      writerEnv.apiStore.useListQuery(usersQuery, { fields: requestedFields });
    });
    await flushAllTimers();
    unmount();

    // Everything gets invalidated (e.g. a realtime reconnect) and the tab is
    // closed before any refetch: the invalidation must not erase which fields
    // the persisted snapshot holds.
    act(() => {
      writerEnv.apiStore.invalidateQueryAndItems({
        all: true,
        type: 'realtimeUpdate',
      });
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Cached' }
      lf: ['email', 'id', 'name']
      p: 'users||1'
    `);

    // After the reload the server cannot be reached (offline), so the cache
    // is all the UI has.
    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });
    readerEnv.serverTable.setNextListFetchError('offline');

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        fields: requestedFields,
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    // The cached row is visible from the first render and stays visible when
    // the revalidation fails, instead of an endless loading state with no rows.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Cached]
      -> status: refetching ⋅ names: [Cached]
      -> status: error ⋅ names: [Cached]
      "
    `);
  });

  test("a fully-loaded ('*') item invalidated before a reload still satisfies a full read from cache", async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-full-star-invalidated-before-reload';
    const sessionKey = 'sess1';

    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Cached' }] },
    });

    writerEnv.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: '*',
    });
    await flushAllTimers();

    // The complete item is invalidated and the tab is closed before a refetch.
    act(() => {
      writerEnv.apiStore.invalidateItem(itemPayload, 'realtimeUpdate');
    });
    await advanceTime(1100);
    await flushAllTimers();

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Fresh' }] },
    });
    readerEnv.serverTable.setNextFetchError(itemPayload, 'offline');

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: '*',
        returnRefetchingStatus: true,
      });

      renders.add({ status, name: data?.name ?? null });
    });
    await flushAllTimers();

    // The restored snapshot is still a complete item: it is shown right away
    // and kept while the revalidation cannot reach the server.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Cached
      -> status: refetching ⋅ name: Cached
      -> status: error ⋅ name: Cached
      "
    `);
  });

  test('a failed mutation rollback keeps a concurrent invalidation in state and the snapshot fields in storage', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-rollback-loaded-fields';
    const sessionKey = 'sess1';

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Server' }] },
    });

    // A manually added item has no loadedFields metadata entry — for such
    // items `inferFields` governs the staleness baseline, so the persisted
    // snapshot must carry no `lf` field either.
    act(() => {
      env.apiStore.addItemToState(itemPayload, { id: 1, name: 'Client draft' });
    });
    await advanceTime(1100);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Client draft' }
      p: 'users||1'
    `);

    // Start a slow save that will ultimately fail. The rollback snapshot is
    // captured now, while the item is still metadata-free.
    let rejectMutation: (error: Error) => void = () => {};
    let mutationResult!: Promise<unknown>;
    act(() => {
      mutationResult = env.apiStore.performMutation(itemPayload, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemPayload, (draft) => {
            draft.name = 'Optimistic';
          });
        },
        mutation: () =>
          new Promise((_resolve, reject) => {
            rejectMutation = reject;
          }),
      });
    });

    // While the save is in flight the item gets invalidated (e.g. by a
    // real-time event). On a partial-resources store this clears the loaded
    // fields to `[]`, and the refetch it schedules is deferred until the
    // mutation settles. Make that deferred refetch fail so no fresh fetch
    // metadata masks what the rollback leaves behind.
    env.serverTable.setNextFetchError(itemPayload, 'refetch offline');
    act(() => {
      env.apiStore.invalidateItem(itemPayload);
    });

    // A regular flush runs mid-mutation. The invalidation only marks the item
    // as stale: the persisted entry keeps listing the fields its snapshot
    // holds, so the cache stays usable if the tab is reloaded right now.
    await advanceTime(1100);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Optimistic' }
      lf: ['id', 'name']
      p: 'users||1'
    `);

    // The save fails: the rollback only reverts what the optimistic update
    // changed (the name). The invalidation happened independently of the
    // mutation, so its cleared loaded fields stay, just like they would have
    // without the mutation.
    rejectMutation(new Error('save failed'));
    await act(async () => {
      await mutationResult;
    });
    await advanceTime(1100);
    await flushAllTimers();

    // The invalidation is still pending in state (nothing was refetched), and
    // the follow-up flush persists the reverted data with the fields the
    // snapshot holds.
    expect(
      env.store.state.itemLoadedFields[storeItemKey('users', 1)],
    ).toMatchInlineSnapshot(`[]`);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Client draft' }
      lf: ['id', 'name']
      p: 'users||1'
    `);
  });

  test('partial-resource persistence stores each item with its own loaded fields', async () => {
    const storeName = 'lq-partial-multiple-item-fields';
    const sessionKey = 'sess1';

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

    // Each item is fetched through the public item API with a different field set.
    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 1), {
      fields: ['id', 'name'],
    });
    env.apiStore.scheduleItemFetch('highPriority', rawItemPayload('users', 2), {
      fields: ['id', 'name', 'age'],
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { id: 1, name: 'Alice' }
      lf: ['id', 'name']
      p: 'users||1'
    `);
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 2),
      ),
    ).toMatchInlineSnapshot(`
      d: { age: 42, id: 2, name: 'Bob' }
      lf: ['age', 'id', 'name']
      p: 'users||2'
    `);
  });

  test('hydration keeps extra persisted fields visible even when loadedFields is narrower', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-partial-extra-data-visible';
    const sessionKey = 'sess1';

    // Seed a realistic persisted entry where the data snapshot is richer than
    // the saved partial-resource metadata.
    persistentStore
      .scope(storeName, sessionKey)
      .listQuery.seedItem(
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

    const renders = createLoggerStore();

    // The hook asks for email too. Cached email remains visible immediately,
    // but loadedFields is narrower, so the item should revalidate.
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
    // The revalidation fetches the complete field set requested by the mounted
    // hook, not just the narrower metadata restored from storage.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['email', 'id', 'name']
            itemId: 'users||1'
      `);
  });

  test('later partial saves keep extra fields already present in persisted item data', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-partial-keep-extra-fields-on-save';
    const sessionKey = 'sess1';

    // Seed a cached item whose data has email, while loadedFields says future
    // partial fetches only need to keep id/name fresh.
    persistentStore
      .scope(storeName, sessionKey)
      .listQuery.seedItem(
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

    // Mounting with id/name triggers the normal hydration revalidation for the
    // same partial field set.
    renderHook(() => {
      env.apiStore.useItem(itemPayload, { fields: ['id', 'name'] });
    });

    await flushAllTimers();

    // Save new partial data for the same item. The persisted snapshot should
    // keep the older extra field instead of cleaning it up.
    env.apiStore.scheduleItemFetch('highPriority', itemPayload, {
      fields: ['id', 'name'],
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { email: 'cached@site.test', id: 1, name: 'Fresh' }
      lf: ['id', 'name']
      p: 'users||1'
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
          fields: ['age', 'email', 'id', 'name']
          itemId: 'users||1'
    `);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['age', 'email', 'id', 'name']
      `);
  });

  test('a hydrated fields:"*" hook does not report success from a partial persisted snapshot', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-item-partial-full-hook';
    const sessionKey = 'sess1';

    // Persisted entry only holds a partial field set (id/name). This config's
    // inferFields never returns '*', so the fallback snapshot is genuinely
    // incomplete — a fields:'*' hook must not trust it.
    persistentStore
      .scope(storeName, sessionKey)
      .listQuery.seedItem(
        'users',
        1,
        { id: 1, name: 'Cached' },
        { loadedFields: ['id', 'name'] },
      );

    const env = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', age: 21, email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(itemPayload, {
        fields: '*',
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

    // The fields:'*' hook must revalidate: it may not surface `success` from the
    // partial persisted fallback (which lacks age/email). Previously the
    // fallback render treated any fields:'*' request as satisfied.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ name: null ⋅ age: null ⋅ email: null
      -> status: success ⋅ name: Fresh ⋅ age: 21 ⋅ email: fresh@site.test
      "
    `);

    // A full-item fetch is issued to complete the missing fields.
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: 'users||1' }
      `);
  });

  test('hydrating an item persisted without loadedFields metadata does not fabricate metadata from object keys', async () => {
    const itemPayload = rawItemPayload('users', 1);
    const storeName = 'lq-item-metadata-free-hydration';
    const sessionKey = 'sess1';

    // A client-created item is persisted. `addItemToState` sets no
    // `itemLoadedFields`, so the persisted entry carries no `lf` metadata —
    // `inferFields` is the designed authority for such snapshots.
    const writerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
    });

    // No hooks are mounted on the writer env; no act() wrapper needed.
    writerEnv.apiStore.addItemToState(itemPayload, {
      id: 1,
      name: 'Created',
      email: 'created@site.test',
    });

    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    // The persisted entry has no `lf` key.
    expect(
      getParsedLocalStorageValue(
        itemStorageKey(storeName, sessionKey, 'users', 1),
      ),
    ).toMatchInlineSnapshot(`
      d: { email: 'created@site.test', id: 1, name: 'Created' }
      p: 'users||1'
    `);

    const readerEnv = createEnv({
      storeName,
      sessionKey,
      partialResources: partialResourcesConfig,
      serverData: {
        users: [{ id: 1, name: 'Fresh', email: 'fresh@site.test' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = readerEnv.apiStore.useItem(itemPayload, {
        fields: ['id', 'name'],
        returnRefetchingStatus: true,
      });

      renders.add({ status, name: data?.name ?? null });
    });

    await flushAllTimers();

    // Cached data is visible immediately and the mount revalidation refreshes
    // the requested fields.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ name: Created
      -> status: refetching ⋅ name: Created
      -> status: success ⋅ name: Fresh
      "
    `);

    // Only the fields actually fetched become loaded-field metadata. Previously
    // hydration fabricated `['email', 'id', 'name']` from the snapshot's object
    // keys — the shallow inference the partial-resources design forbids — and
    // the never-fetched email was falsely marked as loaded/fresh.
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['id', 'name']
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
          fields: ['age', 'email', 'id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
    expect(readerEnv.store.state.itemLoadedFields[storeItemKey('users', 1)])
      .toMatchInlineSnapshot(`
        ['age', 'email', 'id', 'name']
      `);
  });

  test('a list requesting more fields than a loaded query holds shows a loading state, not an empty list, while the missing fields are fetched', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-unrestorable-rows',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: {
        users: [
          { id: 1, name: 'Ada', age: 30 },
          { id: 2, name: 'Grace', age: 40 },
        ],
      },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // The list as first shown: only ids. Rows holding only `id` are saved
        // to storage but cannot be restored from it, since the storage schema
        // requires `name` — so storage has the query without any usable row.
        const idsOnly = env.apiStore.useListQuery(usersQuery, {
          fields: ['id'],
        });
        // The same query read with more columns, mounted later.
        const moreColumns = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'] },
        );
        // Same, but opting into showing the cached columns meanwhile.
        const moreColumnsKeepingRows = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'], showPartialAsRefetching: true },
        );

        renders.add({
          idsOnly: `${idsOnly.status} ${JSON.stringify(idsOnly.items)}`,
          moreColumns: `${moreColumns.status} (isLoading: ${moreColumns.isLoading}) ${JSON.stringify(moreColumns.items)}`,
          moreColumnsKeepingRows: `${moreColumnsKeepingRows.status} (loadingFields: ${moreColumnsKeepingRows.loadingFields?.join(',') ?? 'none'}) ${JSON.stringify(moreColumnsKeepingRows.items)}`,
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    // While `name` and `age` are fetched the wider list must not report
    // `success` with no rows (an empty state): it is `loading`, or keeps the
    // cached rows with `showPartialAsRefetching`. The ids-only list is not
    // disturbed.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      ┌─
      ⋅ idsOnly: loading []
      ⋅ moreColumns: idle (isLoading: false) []
      ⋅ moreColumnsKeepingRows: idle (loadingFields: none) []
      └─
      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: idle (isLoading: false) []
      ⋅ moreColumnsKeepingRows: idle (loadingFields: none) []
      └─

      >>> more columns are shown

      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: loading (isLoading: true) []
      ⋅ moreColumnsKeepingRows: success (loadingFields: name,age) [{"id":1},{"id":2}]
      └─
      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: success (isLoading: false) [{"id":1,"name":"Ada","age":30},{"id":2,"name":"Grace","age":40}]
      ⋅ moreColumnsKeepingRows: success (loadingFields: none) [{"id":1,"name":"Ada","age":30},{"id":2,"name":"Grace","age":40}]
      └─
      "
    `);
    // One fetch for the first list, one for the columns that were missing.
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id']
            pos: { limit: 50, offset: 0 }
          returned_items: 2
        - _type: 'list'
          payload:
            fields: ['age', 'id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 2
      `);
  });

  test('a list requesting more fields than a loaded query holds keeps loading when storage can restore the rows already loaded', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-restorable-rows',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Ada', age: 30 }] },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // `id` and `name` satisfy the storage schema, so these rows can be
        // restored from storage — but they still lack `age`.
        const fewColumns = env.apiStore.useListQuery(usersQuery, {
          fields: ['id', 'name'],
        });
        const moreColumns = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'] },
        );

        renders.add({
          fewColumns: `${fewColumns.status} ${JSON.stringify(fewColumns.items)}`,
          moreColumns: `${moreColumns.status} ${JSON.stringify(moreColumns.items)}`,
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> fewColumns: loading [] ⋅ moreColumns: idle []
      -> fewColumns: success [{"id":1,"name":"Ada"}] ⋅ moreColumns: idle []

      >>> more columns are shown

      -> fewColumns: success [{"id":1,"name":"Ada"}] ⋅ moreColumns: loading []
      ┌─
      ⋅ fewColumns: success [{"id":1,"name":"Ada"}]
      ⋅ moreColumns: success [{"id":1,"name":"Ada","age":30}]
      └─
      "
    `);
  });

  test('a list requesting more fields does not show only the rows another hook already loaded in full', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-truncated-rows',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: {
        users: [
          { id: 1, name: 'Ada', age: 30 },
          { id: 2, name: 'Grace', age: 40 },
        ],
      },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // The list holds only ids, and a details view loaded the first user
        // with every column the wider list will need. Storage can restore
        // that user only: the row of the second user holds just `id`, which
        // the storage schema rejects.
        const idsOnly = env.apiStore.useListQuery(usersQuery, {
          fields: ['id'],
        });
        env.apiStore.useItem('users||1', { fields: ['id', 'name', 'age'] });
        const moreColumns = env.apiStore.useListQuery(
          showMoreColumns && usersQuery,
          { fields: ['id', 'name', 'age'] },
        );

        renders.add({
          idsOnly: `${idsOnly.status} ${JSON.stringify(idsOnly.items)}`,
          moreColumns: `${moreColumns.status} ${JSON.stringify(moreColumns.items)}`,
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    // The wider list must not report `success` with the first user alone
    // while the columns of the second user are fetched.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> idsOnly: loading [] ⋅ moreColumns: idle []
      -> idsOnly: success [{"id":1},{"id":2}] ⋅ moreColumns: idle []

      >>> more columns are shown

      -> idsOnly: success [{"id":1},{"id":2}] ⋅ moreColumns: loading []
      ┌─
      ⋅ idsOnly: success [{"id":1},{"id":2}]
      ⋅ moreColumns: success [{"id":1,"name":"Ada","age":30},{"id":2,"name":"Grace","age":40}]
      └─
      "
    `);
  });

  test('useMultipleListQueries: adding an entry with more fields for a loaded query shows it loading, not as an empty list', async () => {
    const usersQuery = { tableId: 'users' };
    const env = createEnv({
      storeName: 'lq-wider-fields-multiple-queries',
      sessionKey: 'sess1',
      partialResources: partialResourcesConfig,
      serverData: { users: [{ id: 1, name: 'Ada', age: 30 }] },
    });
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ showMoreColumns }: { showMoreColumns: boolean }) => {
        // Rows holding only `id` cannot be restored from storage (the storage
        // schema requires `name`).
        const [idsOnly, moreColumns] = env.apiStore.useMultipleListQueries([
          { payload: usersQuery, fields: ['id'] },
          ...(showMoreColumns
            ? [{ payload: usersQuery, fields: ['id', 'name', 'age'] }]
            : []),
        ]);

        renders.add({
          idsOnly: `${idsOnly?.status} ${JSON.stringify(idsOnly?.items)}`,
          moreColumns: moreColumns
            ? `${moreColumns.status} (isLoading: ${moreColumns.isLoading}) ${JSON.stringify(moreColumns.items)}`
            : 'not requested',
        });
      },
      { initialProps: { showMoreColumns: false } },
    );
    await flushAllTimers();

    renders.addMark('more columns are shown');
    act(() => {
      rerender({ showMoreColumns: true });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> idsOnly: loading [] ⋅ moreColumns: not requested
      -> idsOnly: success [{"id":1}] ⋅ moreColumns: not requested

      >>> more columns are shown

      -> idsOnly: success [{"id":1}] ⋅ moreColumns: loading (isLoading: true) []
      ┌─
      ⋅ idsOnly: success [{"id":1}]
      ⋅ moreColumns: success (isLoading: false) [{"id":1,"name":"Ada","age":30}]
      └─
      "
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

    // Persist two pages so the reader starts from a 10-item hydrated query
    // instead of a fresh first page.
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

    // The reader should show the restored 10 items immediately, then
    // revalidate exactly that restored window on mount.
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
    // Hydration revalidation should reconcile the same 10-item range that was
    // restored from localStorage.
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 10, offset: 0 }
        returned_items: 10
    `);

    // After hydration revalidation settles, loadMore should continue paging
    // from the restored size rather than refetching the head again.
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

    // Persist only the default first page so the reader can prove a larger
    // hook loadSize expands the hydrated query during revalidation.
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

    // Hydration starts with the cached 5 items, then mount revalidation should
    // refetch from the head using the hook's larger requested size.
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
    // The revalidation request uses limit 10, showing the persisted query did
    // not lock the reader to the original cached page size.
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

    // Persist local-only state changes so the reader can prove manual edits and
    // query membership changes round-trip through localStorage.
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

    // The hook should synchronously hydrate the locally edited query before any
    // mount revalidation has a chance to reconcile with the server.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Edited Alice, …(2 more)]
      "
    `);
    // No request has run yet because this assertion intentionally happens
    // before effects are flushed.
    expect(readerEnv.serverTable.fetchHistory).toMatchInlineSnapshot(`[]`);
    // The local-only item must be available as an item state, not only as a
    // query membership key.
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

  test('when maxQueryBytes is exceeded, the least recently read query is evicted first', async () => {
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
      maxQueryBytes: sumPersistedEntryBytes(
        getLocalListQueryEntrySizeBytes(firstQuery, []),
        getLocalListQueryEntrySizeBytes(thirdQuery, [storeItemKey('third', 1)]),
      ),
      serverData: { first: [], third: [{ id: 1, name: 'Third' }] },
    });

    const renders = createLoggerStore();

    // Reading the older query refreshes its recency before the later third
    // query write forces maxQueryBytes maintenance. Assert the immediate
    // hydrated value before timers run because this test is about persisted read
    // recency, not server reconciliation.
    renderHook(() => {
      const { items, status, hasMore } = env.apiStore.useListQuery(firstQuery, {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, count: items.length, hasMore });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ count: 0 ⋅ hasMore: ❌
      "
    `);

    // Let the read-recency touch flush before writing the third query; the
    // second query should now be the least recently read persisted entry.
    await advanceTime(2100);

    env.scheduleFetch('highPriority', thirdQuery);
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`),
    ).toMatchInlineSnapshot(`['{tableId:"first"}', '{tableId:"third"}']`);
  });

  test('when maxItemBytes is exceeded, the least recently read item is evicted first', async () => {
    const storeName = 'lq-item-lru';
    const sessionKey = 'sess1';
    const oldestPayload = rawItemPayload('users', 1);
    const freshPayload = rawItemPayload('users', 3);
    const oldestItem = { id: 1, name: 'Oldest cached' };
    const freshItem = { id: 3, name: 'Fresh' };

    setCachedItem(storeName, sessionKey, 'users', 1, oldestItem);
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, {
      id: 2,
      name: 'Newer cached',
    });

    const env = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: Math.max(
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(oldestPayload, oldestItem),
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
        ),
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(oldestPayload, oldestItem),
          getLocalListItemEntrySizeBytes(freshPayload, freshItem, {
            loadedFields: fullLoadedFields,
          }),
        ),
        sumPersistedEntryBytes(
          getLocalListItemEntrySizeBytes(rawItemPayload('users', 2), {
            id: 2,
            name: 'Newer cached',
          }),
          getLocalListItemEntrySizeBytes(freshPayload, freshItem, {
            loadedFields: fullLoadedFields,
          }),
        ),
      ),
      serverData: { users: [oldestItem] },
    });

    const renders = createLoggerStore();

    // Reading the oldest item refreshes its recency before a later standalone
    // item write forces maxItemBytes maintenance. Assert the immediate hydrated
    // value before timers run because this test is about persisted read recency,
    // not server reconciliation.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        { disableRefetchOnMount: true, returnRefetchingStatus: true },
      );

      renders.add({ status, data: data ?? null });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Oldest cached}
      "
    `);

    // Wait for the localStorage touch throttle so the recency update is visible
    // to eviction maintenance.
    await advanceTime(2100);

    env.apiStore.addItemToState(freshPayload, freshItem);

    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||1', '"users||3']`);
  });

  test('cold persisted query items are trimmed by recency during unrelated maxItemBytes cleanup', async () => {
    const usersQuery = { tableId: 'users' };
    const storeName = 'lq-cold-query-items';
    const sessionKey = 'sess1';
    const newerPayload = rawItemPayload('users', 2);
    const standalonePayload = rawItemPayload('users', 3);
    const newerItem = { id: 2, name: 'Newer cached' };
    const standaloneItem = { id: 3, name: 'Fresh standalone' };

    setCachedItem(storeName, sessionKey, 'users', 1, {
      id: 1,
      name: 'Older cached',
    });
    await advanceTime(100);
    setCachedItem(storeName, sessionKey, 'users', 2, newerItem);
    setCachedQuery(storeName, sessionKey, usersQuery, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createEnv({
      storeName,
      sessionKey,
      maxItemBytes: sumPersistedEntryBytes(
        getLocalListItemEntrySizeBytes(newerPayload, newerItem),
        getLocalListItemEntrySizeBytes(standalonePayload, standaloneItem),
      ),
    });

    // Write an unrelated standalone item without ever hydrating the cached query.
    env.apiStore.addItemToState(standalonePayload, standaloneItem);

    await advanceTime(1100);
    await flushAllTimers();

    // The cold query stays persisted, but maintenance now keeps the newer
    // cached item and the unrelated standalone item by recency. The trimmed
    // query entry records that it no longer lists every row of the query.
    expect(listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`))
      .toMatchInlineSnapshot(`
        ['{tableId:"users"}']
      `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .listQuery.readQueryEntry(usersQuery).data,
    ).toMatchInlineSnapshot(`
      hasMore: '❌'
      items: ['"users||2']
      missingItems: '✅'
      payload: { tableId: 'users' }
    `);
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`),
    ).toMatchInlineSnapshot(`['"users||2', '"users||3']`);
  });

  test('a cached list that lost some rows to maxItemBytes shows the remaining rows as still loading, then the full list', async () => {
    const storeName = 'lq-evicted-rows-partial';
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName,
      evictedRows: 'User 1',
    });

    // The least recently read row ("User 1") was evicted. The users query is
    // still cached: its entry lists the row that is left and records that it
    // is not the whole list anymore (`m`).
    expect(
      listStoredKeys(`tsdf.sess1.${storeName}.li.`).sort(),
    ).toMatchInlineSnapshot(`['"projects||1', '"projects||2', '"users||2']`);
    expect(
      getParsedLocalStorageValue(
        queryStorageKey(storeName, 'sess1', usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689729530
      i: ['"users||2']
      m: '✅'
      p: { tableId: 'users' }
    `);

    // A cold start mounts the users list again.
    const session = startNextSession();
    const { renders } = mountUsersList(session);
    await flushAllTimers();

    // The cached list is missing a row, so it must not be reported as a
    // complete `success`: the remaining row is available while the list is
    // reported as loading, until the fetch delivers every row.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 2]
      -> status: success ⋅ error: null ⋅ names: [User 1, User 2]
      "
    `);
    expect(
      session.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
    `);

    // The refetched list is cached as a complete list again.
    await advanceTime(1100);
    await flushAllTimers();
    expect(
      getParsedLocalStorageValue(
        queryStorageKey(storeName, 'sess1', usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689732440
      i: ['"users||1', '"users||2']
      p: { tableId: 'users' }
    `);
  });

  test('a cached list that lost all its rows to maxItemBytes shows a loading state instead of an empty list', async () => {
    const storeName = 'lq-evicted-rows-all';
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName,
      evictedRows: 'all',
    });

    // Both user rows were evicted, but the users query is still cached.
    expect(
      listStoredKeys(`tsdf.sess1.${storeName}.li.`).sort(),
    ).toMatchInlineSnapshot(`['"projects||1', '"projects||2']`);
    expect(
      getParsedLocalStorageValue(
        queryStorageKey(storeName, 'sess1', usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689665620
      i: []
      m: '✅'
      p: { tableId: 'users' }
    `);

    // A cold start mounts the users list again.
    const { renders } = mountUsersList(startNextSession());
    await flushAllTimers();

    // None of the cached rows can be restored: an empty `success` list would
    // read as "no records", so the list loads as if it was never cached.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: success ⋅ error: null ⋅ names: [User 1, User 2]
      "
    `);
  });

  test('starting offline with a cached list that lost some rows to maxItemBytes shows the remaining rows next to the offline error', async () => {
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName: 'lq-evicted-rows-partial-offline',
      evictedRows: 'User 1',
      offlineNetwork: network.config,
    });

    // The app starts offline and mounts the users list.
    network.setOffline();
    const session = startNextSession();
    const usersList = mountUsersList(session);
    await flushAllTimers();

    // The cached list is missing "User 1" and cannot be refetched: it must
    // not be presented as the complete list. The remaining row stays
    // available next to the offline error.
    expect(usersList.renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 2]
      -> status: error ⋅ error: offline ⋅ names: [User 2]
      "
    `);

    // Imperative reads do not return the incomplete list as a result.
    expect(
      await resolveAfterAllTimers(
        session.apiStore.awaitListQueryFetch(usersListQuery),
      ),
    ).toMatchInlineSnapshot(`
      error{Error}:
        message: 'Offline'
        name: 'StoreFetchError'
        code: 0
        id: 'offline'
        type: 'fetch'

      hasMore: '❌'
      items: []
    `);
    expect(
      session.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    // The offline session neither drops what is left of the cached list nor
    // turns it into a complete one: the next offline start gets the same
    // rows and error.
    await advanceTime(1100);
    await flushAllTimers();
    usersList.unmount();
    const { renders: nextStartRenders } = mountUsersList(startNextSession());
    await flushAllTimers();

    expect(nextStartRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 2]
      -> status: error ⋅ error: offline ⋅ names: [User 2]
      "
    `);
  });

  test('starting offline with a cached list that lost all its rows to maxItemBytes reports the offline error instead of an empty list', async () => {
    const { startNextSession } = await cacheUsersListAndEvictRows({
      storeName: 'lq-evicted-rows-all-offline',
      evictedRows: 'all',
      offlineNetwork: network.config,
    });

    // The app starts offline and mounts the users list.
    network.setOffline();
    const session = startNextSession();
    const { renders } = mountUsersList(session);
    await flushAllTimers();

    // An empty `success` list would read as "no records": with no row left
    // the list behaves as if it was never cached.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: error ⋅ error: offline ⋅ names: []
      "
    `);
    expect(
      session.serverTable.getRequestHistory('all', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('a cached list with a row the schema no longer accepts shows the remaining rows as still loading, then the full list', async () => {
    const storeName = 'lq-rejected-row';
    const sessionKey = 'sess1';
    const scope = persistentStore.scope(storeName, sessionKey).listQuery;

    // "User 2" was cached by an older version of the app, in a shape the
    // current schema rejects (no `name`), so it is discarded when read.
    scope.seedItem('users', 1, { id: 1, name: 'User 1' });
    scope.seedItem('users', 2, { id: 2, fullName: 'User 2' });
    setCachedQuery(storeName, sessionKey, usersListQuery, [
      storeItemKey('users', 1),
      storeItemKey('users', 2),
    ]);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: {
        users: [
          { id: 1, name: 'User 1' },
          { id: 2, name: 'User 2' },
        ],
      },
    });
    const { renders } = mountUsersList(env);
    await flushAllTimers();

    // Only one of the two cached rows can be restored: the list is not
    // reported as a complete `success` until it is fetched again.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ error: null ⋅ names: []
      -> status: loading ⋅ error: null ⋅ names: [User 1]
      -> status: success ⋅ error: null ⋅ names: [User 1, User 2]
      "
    `);
  });

  test('items and queries are saved per entry and pinned entries survive eviction', async () => {
    const pinnedItemPayload = rawItemPayload('second', 1);
    const pinnedQueryPayload = { tableId: 'second' };
    const env = createEnv({
      storeName: 'lq-evict',
      sessionKey: 'sess1',
      maxItemBytes: getLocalListItemEntrySizeBytes(
        rawItemPayload('second', 1),
        { id: 1, name: 'Second' },
      ),
      maxQueryBytes: getLocalListQueryEntrySizeBytes(pinnedQueryPayload, [
        storeItemKey('second', 1),
      ]),
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

    expect(listStoredKeys('tsdf.sess1.lq-evict.lq.')).toMatchInlineSnapshot(
      `['{tableId:"second"}']`,
    );
    expect(listStoredKeys('tsdf.sess1.lq-evict.li.')).toMatchInlineSnapshot(
      `['"second||1']`,
    );
  });

  test('pinned items survive eviction even when their query is evicted', async () => {
    const env = createEnv({
      storeName: 'lq-pinned-item-only',
      sessionKey: 'sess1',
      maxItemBytes: getLocalListItemEntrySizeBytes(
        rawItemPayload('second', 1),
        { id: 1, name: 'Second' },
      ),
      maxQueryBytes: getLocalListQueryEntrySizeBytes({ tableId: 'first' }, [
        storeItemKey('first', 1),
      ]),
      pinnedItems: [rawItemPayload('second', 1)],
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
      },
    });

    // Load the pinned item first, then make a different query the one that survives maxQueryBytes cleanup.
    env.scheduleFetch('highPriority', { tableId: 'second' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'first' });
    await flushAllTimers();
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredKeys('tsdf.sess1.lq-pinned-item-only.lq.').length,
    ).toMatchInlineSnapshot(`1`);
    expect(
      listStoredKeys('tsdf.sess1.lq-pinned-item-only.li.'),
    ).toMatchInlineSnapshot(`['"second||1']`);
  });

  test('default persistence byte budgets comfortably keep 125 items and 25 queries', async () => {
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
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.lq.`).length,
    ).toMatchInlineSnapshot(`25`);
    expect(
      listStoredKeys(`tsdf.${sessionKey}.${storeName}.li.`).length,
    ).toMatchInlineSnapshot(`125`);
  }, 5_000);

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
    expect(listStoredKeys('tsdf.sess1.lq-max-query-size.li.'))
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

    // Only the truncated query is restored from localStorage; the mount
    // revalidation should fetch the full server list again.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Alice, Bob]
      -> status: refetching ⋅ names: [Alice, Bob]
      -> status: success ⋅ names: [Alice, …(2 more)]
      "
    `);
    // Revalidation can include the evicted third item even though maxQuerySize
    // kept only the first two items persisted.
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

    expect(listStoredKeys('tsdf.sess1.lq-ignore.li.')).toMatchInlineSnapshot(
      `['"users||1']`,
    );
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

    // The ignored item is absent from storage, but a normal mount revalidation
    // should still reconcile the full server response.
    renderHook(() => {
      const { items, status } = readerEnv.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({ status, names: items.map((item) => item.name) });
    });
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ names: [Alice]
      -> status: refetching ⋅ names: [Alice]
      -> status: success ⋅ names: [Alice, Bob]
      "
    `);
    // The fetch proves ignoreItems only limits what is persisted, not what the
    // live query can receive from the server.
    expect(
      readerEnv.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 2
    `);
  });

  test('preload hydrates cached local queries and items without reporting an error', async () => {
    const onPersistentStorageError = vi.fn();
    setCachedItem('lq-preload-local', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });
    setCachedQuery('lq-preload-local', 'sess1', { tableId: 'users' }, [
      storeItemKey('users', 1),
    ]);
    const env = createEnv({
      storeName: 'lq-preload-local',
      sessionKey: 'sess1',
      onPersistentStorageError,
    });

    await expect(env.apiStore.preloadQueryFromStorage({ tableId: 'users' }))
      .resolves.toMatchInlineSnapshot(`
      - payload: { tableId: 'users' }
        preloaded: '✅'
    `);
    await expect(env.apiStore.preloadItemFromStorage('users||1')).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'users||1', preloaded: '✅' }
    `);

    expect(env.apiStore.getQueryState({ tableId: 'users' }))
      .toMatchInlineSnapshot(`
        error: null
        hasMore: '❌'
        items: ['"users||1']
        payload: { tableId: 'users' }
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
      `);
    expect(env.apiStore.getItemState('users||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Cached'
    `);
    expect(onPersistentStorageError).not.toHaveBeenCalled();
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

  test('scheduled maintenance does not clean invalid cached query entries before they are read', async () => {
    const key = setCachedQuery(
      'lq-invalid-maintenance',
      'sess1',
      { tableId: 'users' },
      [storeItemKey('users', 1)],
      false,
      1,
    );

    createEnv({
      storeName: 'lq-invalid-maintenance',
      sessionKey: 'sess1',
      version: 2,
    });

    await advanceTime(2100);
    await flushAllTimers();

    expect(localStorage.getItem(key)).not.toBeNull();
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
    await flushAllTimers();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid cached item payloads are cleaned up only after a direct read', async () => {
    const key = itemStorageKey('lq-invalid-item-payload', 'sess1', 'users', 1);
    persistentStore
      .scope('lq-invalid-item-payload', 'sess1')
      .listQuery.seedItem('users', 1, { id: 1, name: 'Alice' });
    const entry = persistentStore
      .scope('lq-invalid-item-payload', 'sess1')
      .listQuery.readItemEntry<Row>('users', 1);
    localStorage.setItem(
      key,
      JSON.stringify(
        createCompactLocalStorageEntry(
          {
            d: entry.data.data,
            p: true,
            ...(entry.data.loadedFields ? { lf: entry.data.loadedFields } : {}),
          },
          entry.version,
        ),
      ),
    );

    const env = createEnv({
      storeName: 'lq-invalid-item-payload',
      sessionKey: 'sess1',
    });

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(
      env.apiStore.getItemState(rawItemPayload('users', 1)),
    ).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid cached query payloads are cleaned up only after a direct read', async () => {
    const usersQuery = { tableId: 'users' };
    const queryKey = queryStorageKey(
      'lq-invalid-query-payload',
      'sess1',
      usersQuery,
    );
    const scope = persistentStore.scope('lq-invalid-query-payload', 'sess1');
    scope.listQuery.seedItem('users', 1, { id: 1, name: 'Alice' });
    scope.listQuery.seedQuery(usersQuery, [{ tableId: 'users', id: 1 }]);
    const entry = persistentStore.storage.readEntry<{
      a: number;
      i: string[];
      p: unknown;
      h?: true;
      o?: true;
      v?: number;
    }>(queryKey);
    if (entry === null) {
      throw new Error(`Missing seeded entry for ${queryKey}`);
    }
    localStorage.setItem(queryKey, JSON.stringify({ ...entry, p: true }));

    const env = createEnv({
      storeName: 'lq-invalid-query-payload',
      sessionKey: 'sess1',
    });

    expect(localStorage.getItem(queryKey)).not.toBeNull();
    expect(env.apiStore.getQueryState(usersQuery)).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(queryKey)).toBeNull();
  });
});
