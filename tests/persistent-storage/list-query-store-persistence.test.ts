import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import {
  rc_number,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
} from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type {
  OffsetPaginationConfig,
  PartialResourcesConfig,
} from '../../src/listQueryStore/types';
import type {
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const rowSchema = rc_object({ id: rc_number, name: rc_string });
const cacheEntryTimestampSchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});
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
  const key = itemStorageKey(storeName, sessionKey, tableId, id);
  const entry: StorageCacheEntry<PersistedListQueryItemData<Row>> = {
    data: {
      data,
      payload: rawItemPayload(tableId, id),
    },
    timestamp: Date.now(),
    version,
  };

  localStorage.setItem(key, JSON.stringify(entry));

  return key;
}

function setCachedQuery(
  storeName: string,
  sessionKey: string,
  params: ListQueryParams,
  items: string[],
  hasMore = false,
  version = 1,
): string {
  const key = queryStorageKey(storeName, sessionKey, params);
  const entry: StorageCacheEntry<PersistedListQueryData> = {
    data: {
      payload: params,
      items,
      hasMore,
    },
    timestamp: Date.now(),
    version,
  };

  localStorage.setItem(key, JSON.stringify(entry));

  return key;
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
  const raw = localStorage.getItem(key);
  if (raw === null) {
    throw new Error(`Missing localStorage entry for ${key}`);
  }

  const parsed = rc_parse_json(raw, cacheEntryTimestampSchema);
  if (!parsed.ok) {
    throw new Error(`Invalid localStorage entry for ${key}`);
  }

  return parsed.value.timestamp;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  maxQueries?: number;
  pinnedItems?: string[];
  pinnedQueries?: string[];
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
    ignoreInitialTimeCheck: true,
    partialResources: options.partialResources,
    offsetPagination: options.offsetPagination,
    defaultQuerySize: options.defaultQuerySize,
    usesRealTimeUpdates: options.usesRealTimeUpdates,
    dynamicRealtimeThrottleMs: options.dynamicRealtimeThrottleMs,
    bindFocusController: options.bindFocusController,
    persistentStorage: {
      storeName: options.storeName,
      backend: 'localStorage',
      schema: rowSchema,
      version: options.version,
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
      onPersistentStorageError: options.onPersistentStorageError,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
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

    const env = createEnv({
      storeName: 'lq-local',
      sessionKey: 'sess1',
    });

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
    expect(env.apiStore.getItemState(() => true).map(({ payload }) => payload))
      .toMatchInlineSnapshot(`
        ['users||1', 'users||2']
      `);
  });

  test('direct item reads lazily hydrate only the requested cached item', () => {
    setCachedItem('lq-item-local', 'sess1', 'users', 1, {
      id: 1,
      name: 'Alice',
    });
    setCachedItem('lq-item-local', 'sess1', 'users', 2, {
      id: 2,
      name: 'Bob',
    });

    const env = createEnv({
      storeName: 'lq-item-local',
      sessionKey: 'sess1',
    });

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
      serverData: {
        users: [{ id: 1, name: 'Fresh' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(
        rawItemPayload('users', 1),
        {
          returnRefetchingStatus: true,
        },
      );

      renders.add({
        status,
        name: data?.name ?? null,
      });
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

    setCachedItem('lq-hook', 'sess1', 'users', 1, {
      id: 1,
      name: 'Cached',
    });
    setCachedQuery('lq-hook', 'sess1', usersQuery, [usersItem]);

    const env = createEnv({
      storeName: 'lq-hook',
      sessionKey: 'sess1',
      serverData: {
        users: [{ id: 1, name: 'Fresh' }],
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { items, status } = env.apiStore.useListQuery(usersQuery, {
        returnRefetchingStatus: true,
      });

      renders.add({
        status,
        names: items.map((item) => item.name),
      });
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


    const env = createEnv({
      storeName: 'lq3',
      sessionKey: 'sess1',
      maxItems: 2,
      serverData: {
        t1: [
          { id: 1, name: 'Referenced 1' },
          { id: 2, name: 'Referenced 2' },
        ],
      },
    });

    // Fetch query — items 1 and 2 become query-referenced
    env.scheduleFetch('highPriority', { tableId: 't1' });
    await flushAllTimers();

    // Add orphan item directly (not part of any query)
    env.apiStore.addItemToState(rawItemKey('t1', 3), { id: 3, name: 'Orphan' });

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq3');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<Row>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedItemKeys = Object.keys(parsed.data.items);

    // Only 2 items saved; query-referenced items prioritized
    expect(savedItemKeys.length).toBe(2);
    expect(savedItemKeys).toContain(ik1);
    expect(savedItemKeys).toContain(ik2);
  });

  test('pinned items and queries are preserved', async () => {
    const firstIk = storeItemKey('first', 1);
    const secondIk = storeItemKey('second', 1);
    const firstQk = queryKey({ tableId: 'first' });
    const secondQk = queryKey({ tableId: 'second' });

    // Pin the SECOND query/item — without pinning, 'first' (fetched first)
    // would be kept by insertion order with maxQueries=1/maxItems=1.
    // With pinning, 'second' survives instead.
    const env = createEnv({
      storeName: 'lq4',
      sessionKey: 'sess1',
      maxQueries: 1,
      maxItems: 1,
      pinnedItems: [secondIk],
      pinnedQueries: [secondQk],
      serverData: {
        first: [{ id: 1, name: 'First' }],
        second: [{ id: 1, name: 'Second' }],
      },
    });

    // Fetch both queries — 'first' is fetched first
    env.scheduleFetch('highPriority', { tableId: 'first' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'second' });
    await flushAllTimers();

    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq4');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<Row>>,
      unknown
    >(JSON.parse(cached ?? ''));

    // Pinned 'second' survives; 'first' is evicted despite being fetched first
    expect(Object.keys(parsed.data.queries)).toEqual([secondQk]);
    expect(Object.keys(parsed.data.items)).toEqual([secondIk]);
  });

  test('version mismatch discards cached data', () => {
    const ik = storeItemKey('t1', 1);

    setCachedData(
      'lq5',
      'sess1',
      {
        items: { [ik]: { id: 1, name: 'Old' } },
        queries: {},
        itemPayloads: {},
      },
      1,
    );

    const env = createEnv({
      storeName: 'lq5',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(Object.keys(env.store.state.items).length).toBe(0);
    expect(Object.keys(env.store.state.queries).length).toBe(0);
  });

  test('schema validation failure discards invalid items', () => {
    const validIk = storeItemKey('t1', 1);
    const invalidIk = storeItemKey('t1', 2);
    const qk = queryKey({ tableId: 't1' });

    const key = 'tsdf.sess1.lq6';
    const entry: StorageCacheEntry<PersistedListQueryData<unknown>> = {
      data: {
        items: {
          [validIk]: { id: 1, name: 'Valid' },
          [invalidIk]: { badField: true },
        },
        queries: {
          [qk]: {
            payload: { tableId: 't1' },
            items: [validIk, invalidIk],
            hasMore: false,
          },
        },
        itemPayloads: {
          [validIk]: rawItemKey('t1', 1),
          [invalidIk]: rawItemKey('t1', 2),
        },
      },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const env = createEnv({ storeName: 'lq6', sessionKey: 'sess1' });

    // Valid item loaded
    expect(env.store.state.items[validIk]).toMatchInlineSnapshot(`
      id: 1
      name: 'Valid'
    `);

    // Invalid item not loaded
    expect(env.store.state.items[invalidIk]).toBeUndefined();

    // Query should only reference valid item
    const query = env.store.state.queries[qk];
    expect(query?.items).toMatchInlineSnapshot(`['"t1||1']`);
  });

  test('session isolation', () => {
    const ik = storeItemKey('t1', 1);

    setCachedData('lq7', 'sess-a', {
      items: { [ik]: { id: 1, name: 'A' } },
      queries: {},
      itemPayloads: {},
    });

    const env = createEnv({ storeName: 'lq7', sessionKey: 'sess-b' });

    expect(Object.keys(env.store.state.items).length).toBe(0);
  });

  test('reset clears persisted storage', async () => {
    const ik = storeItemKey('t1', 1);

    setCachedData('lq8', 'sess1', {
      items: { [ik]: { id: 1, name: 'X' } },
      queries: {},
      itemPayloads: {},
    });

    const env = createEnv({ storeName: 'lq8', sessionKey: 'sess1' });

    expect(Object.keys(env.store.state.items).length).toBe(1);

    env.apiStore.reset();
    await flushAllTimers();

    const cached = localStorage.getItem('tsdf.sess1.lq8');
    expect(cached).toBeNull();
  });

});
