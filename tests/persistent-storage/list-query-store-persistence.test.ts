import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type {
  PersistedListQueryData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';

const rowSchema = rc_object({ id: rc_number, name: rc_string });

// --- Key helpers matching the test env's internal format ---

function rawItemKey(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

function storeItemKey(tableId: string, id: number): string {
  return getCompositeKey(rawItemKey(tableId, id));
}

function queryKey(params: ListQueryParams): string {
  return getCompositeKey(params);
}

// --- localStorage helpers ---

function setCachedData(
  storeName: string,
  sessionKey: string,
  data: PersistedListQueryData<Row>,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedListQueryData<Row>> = {
    data,
    timestamp: Date.now(),
    version,
  };
  localStorage.setItem(key, JSON.stringify(entry));
}

function createEnv(options: {
  storeName?: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  maxQueries?: number;
  pinnedItems?: string[];
  pinnedQueries?: string[];
  serverData?: Tables<Row>;
}) {
  const storeName = options.storeName ?? 'test-lq';
  return createListQueryStoreTestEnv(
    options.serverData ?? {},
    {
      id: storeName,
      getSessionKey: () => options.sessionKey ?? 'test-session',
      ignoreInitialTimeCheck: true,
      persistentStorage: {
        storeName,
        backend: 'localStorage',
        schema: rowSchema,
        version: options.version,
        maxItems: options.maxItems,
        maxQueries: options.maxQueries,
        pinnedItems: options.pinnedItems,
        pinnedQueries: options.pinnedQueries,
      },
    },
  );
}

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

describe('localStorage: list query store persistence', () => {
  test('items and queries loaded from cache', () => {
    const ik1 = storeItemKey('t1', 1);
    const ik2 = storeItemKey('t1', 2);
    const qk = queryKey({ tableId: 't1' });

    setCachedData('lq1', 'sess1', {
      items: {
        [ik1]: { id: 1, name: 'First' },
        [ik2]: { id: 2, name: 'Second' },
      },
      queries: {
        [qk]: {
          payload: { tableId: 't1' },
          items: [ik1, ik2],
          hasMore: true,
        },
      },
      itemPayloads: {
        [ik1]: rawItemKey('t1', 1),
        [ik2]: rawItemKey('t1', 2),
      },
    });

    const env = createEnv({ storeName: 'lq1', sessionKey: 'sess1' });

    // Items should be loaded
    expect(env.store.state.items[ik1]).toMatchInlineSnapshot(`
      id: 1
      name: 'First'
    `);
    expect(env.store.state.items[ik2]).toMatchInlineSnapshot(`
      id: 2
      name: 'Second'
    `);

    // Query should be loaded
    const query = env.store.state.queries[qk];
    expect(query).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items: ['"t1||1', '"t1||2']
      payload: { tableId: 't1' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Item queries should be reconstructed
    expect(env.store.state.itemQueries[ik1]).toMatchInlineSnapshot(`
      error: null
      payload: 't1||1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Fields should start empty
    expect(env.store.state.itemLoadedFields).toMatchInlineSnapshot(`{}`);
    expect(env.store.state.itemFieldInvalidationFields).toMatchInlineSnapshot(
      `{}`,
    );
  });

  test('query limit enforcement', async () => {
    const env = createEnv({
      storeName: 'lq2',
      sessionKey: 'sess1',
      maxQueries: 2,
      serverData: {
        a: [{ id: 1, name: 'Item 1' }],
        b: [{ id: 1, name: 'Item 2' }],
        c: [{ id: 1, name: 'Item 3' }],
      },
    });

    // Populate 3 queries via fetches
    env.scheduleFetch('highPriority', { tableId: 'a' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'b' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'c' });
    await flushAllTimers();

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq2');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<Row>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedQueryKeys = Object.keys(parsed.data.queries);

    // Only 2 queries should be saved
    expect(savedQueryKeys.length).toBe(2);
  });

  test('item limit with query-reference prioritization', async () => {
    const ik1 = storeItemKey('t1', 1);
    const ik2 = storeItemKey('t1', 2);

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
    const pinnedIk = storeItemKey('pinned', 1);
    const pinnedQk = queryKey({ tableId: 'pinned' });

    const env = createEnv({
      storeName: 'lq4',
      sessionKey: 'sess1',
      maxQueries: 1,
      maxItems: 1,
      pinnedItems: [pinnedIk],
      pinnedQueries: [pinnedQk],
      serverData: {
        pinned: [{ id: 1, name: 'Pinned' }],
        other: [{ id: 1, name: 'Other' }],
      },
    });

    // Fetch both queries
    env.scheduleFetch('highPriority', { tableId: 'pinned' });
    await flushAllTimers();
    env.scheduleFetch('highPriority', { tableId: 'other' });
    await flushAllTimers();

    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq4');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<Row>>,
      unknown
    >(JSON.parse(cached ?? ''));

    expect(Object.keys(parsed.data.queries)).toContain(pinnedQk);
    expect(Object.keys(parsed.data.items)).toContain(pinnedIk);
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

  test('itemLoadedFields starts empty after hydration', () => {
    const ik = storeItemKey('t1', 1);
    const qk = queryKey({ tableId: 't1' });

    setCachedData('lq9', 'sess1', {
      items: { [ik]: { id: 1, name: 'Item' } },
      queries: {
        [qk]: {
          payload: { tableId: 't1' },
          items: [ik],
          hasMore: false,
        },
      },
      itemPayloads: { [ik]: rawItemKey('t1', 1) },
    });

    const env = createEnv({ storeName: 'lq9', sessionKey: 'sess1' });

    // Items should be loaded
    expect(env.store.state.items[ik]).not.toBeNull();

    // But fields should be empty (repopulated on refetch)
    expect(env.store.state.itemLoadedFields).toMatchInlineSnapshot(`{}`);
    expect(env.store.state.itemFieldInvalidationFields).toMatchInlineSnapshot(
      `{}`,
    );
  });
});
