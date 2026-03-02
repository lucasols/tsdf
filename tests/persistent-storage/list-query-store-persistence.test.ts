import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createListQueryStore } from '../../src/listQueryStore/listQueryStore';
import type {
  PersistedListQueryData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_object, rc_string } from 'runcheck';
import type { StoreError } from '../../src/utils/storeShared';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

function normalizeError(exception: Error): StoreError {
  return {
    code: 500,
    id: 'error',
    message: exception.message,
  };
}

type QueryPayload = { filter: string };
type ItemPayload = string;

type ItemState = { id: string; title: string };

const itemSchema = rc_object({ id: rc_string, title: rc_string });

function createTestListQueryStore(options: {
  storeName?: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  maxQueries?: number;
  pinnedItems?: string[];
  pinnedQueries?: string[];
  fetchDuration?: number;
}) {
  const fetchDuration = options.fetchDuration ?? 800;

  const store = createListQueryStore<ItemState, QueryPayload, ItemPayload>({
    fetchListFn: async (payload, size, { signal }) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fetchDuration);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return {
        items: [
          {
            itemPayload: '1',
            data: { id: '1', title: `Result for ${payload.filter}` },
          },
        ],
        hasMore: false,
      };
    },
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs: 10,
    backgroundCoalescingWindowMultiplier: 1,
    blockWindowClose: null,
    persistentStorage: {
      storeName: options.storeName ?? 'test-lq',
      backend: 'localStorage',
      schema: itemSchema,
      version: options.version,
      getSessionKey: () => options.sessionKey ?? 'session1',
      maxItems: options.maxItems,
      maxQueries: options.maxQueries,
      pinnedItems: options.pinnedItems,
      pinnedQueries: options.pinnedQueries,
    },
  });

  return store;
}

function setCachedListQueryData(
  storeName: string,
  sessionKey: string,
  data: PersistedListQueryData<ItemState>,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedListQueryData<ItemState>> = {
    data,
    timestamp: Date.now(),
    version,
  };
  localStorage.setItem(key, JSON.stringify(entry));
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
    setCachedListQueryData('lq1', 'sess1', {
      items: {
        '1': { id: '1', title: 'First' },
        '2': { id: '2', title: 'Second' },
      },
      queries: {
        'query-key-1': {
          payload: { filter: 'all' },
          items: ['1', '2'],
          hasMore: true,
        },
      },
      itemPayloads: {
        '1': '1',
        '2': '2',
      },
    });

    const store = createTestListQueryStore({
      storeName: 'lq1',
      sessionKey: 'sess1',
    });

    // Items should be loaded
    expect(store.store.state.items['1']).toMatchInlineSnapshot(`
      id: '1'
      title: 'First'
    `);
    expect(store.store.state.items['2']).toMatchInlineSnapshot(`
      id: '2'
      title: 'Second'
    `);

    // Query should be loaded
    const query = store.store.state.queries['query-key-1'];
    expect(query).toMatchInlineSnapshot(`
      error: null
      hasMore: '✅'
      items: ['1', '2']
      payload: { filter: 'all' }
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Item queries should be reconstructed
    expect(store.store.state.itemQueries['1']).toMatchInlineSnapshot(`
      error: null
      payload: '1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    // Fields should start empty
    expect(store.store.state.itemLoadedFields).toMatchInlineSnapshot(`{}`);
    expect(store.store.state.itemFieldInvalidationFields).toMatchInlineSnapshot(
      `{}`,
    );
  });

  test('query limit enforcement', async () => {
    const store = createTestListQueryStore({
      storeName: 'lq2',
      sessionKey: 'sess1',
      maxQueries: 2,
    });

    // Manually populate the store with 3 queries
    store.store.setPartialState(
      {
        items: {
          '1': { id: '1', title: 'Item 1' },
          '2': { id: '2', title: 'Item 2' },
          '3': { id: '3', title: 'Item 3' },
        },
        queries: {
          q1: {
            payload: { filter: 'a' },
            items: ['1'],
            hasMore: false,
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
          q2: {
            payload: { filter: 'b' },
            items: ['2'],
            hasMore: false,
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
          q3: {
            payload: { filter: 'c' },
            items: ['3'],
            hasMore: false,
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
        },
        itemQueries: {},
      },
      { action: 'test-setup' },
    );

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq2');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<ItemState>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedQueryKeys = Object.keys(parsed.data.queries);

    // Only 2 queries should be saved
    expect(savedQueryKeys.length).toBe(2);
  });

  test('item limit with query-reference prioritization', async () => {
    const store = createTestListQueryStore({
      storeName: 'lq3',
      sessionKey: 'sess1',
      maxItems: 2,
    });

    // 3 items, only 2 referenced by query
    store.store.setPartialState(
      {
        items: {
          '1': { id: '1', title: 'Referenced 1' },
          '2': { id: '2', title: 'Referenced 2' },
          '3': { id: '3', title: 'Orphan' },
        },
        queries: {
          q1: {
            payload: { filter: 'x' },
            items: ['1', '2'],
            hasMore: false,
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
        },
        itemQueries: {
          '1': {
            payload: '1',
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
          '2': {
            payload: '2',
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
          '3': {
            payload: '3',
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
        },
      },
      { action: 'test-setup' },
    );

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq3');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<ItemState>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedItemKeys = Object.keys(parsed.data.items);

    // Only 2 items saved; query-referenced items prioritized
    expect(savedItemKeys.length).toBe(2);
    expect(savedItemKeys).toContain('1');
    expect(savedItemKeys).toContain('2');
  });

  test('pinned items and queries are preserved', async () => {
    const store = createTestListQueryStore({
      storeName: 'lq4',
      sessionKey: 'sess1',
      maxQueries: 1,
      maxItems: 1,
      pinnedItems: ['pinned-item'],
      pinnedQueries: ['pinned-query'],
    });

    store.store.setPartialState(
      {
        items: {
          'pinned-item': { id: 'p', title: 'Pinned' },
          other: { id: 'o', title: 'Other' },
        },
        queries: {
          'pinned-query': {
            payload: { filter: 'pinned' },
            items: ['pinned-item'],
            hasMore: false,
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
          'other-query': {
            payload: { filter: 'other' },
            items: ['other'],
            hasMore: false,
            status: 'success',
            error: null,
            wasLoaded: true,
            refetchOnMount: false,
          },
        },
        itemQueries: {},
      },
      { action: 'test-setup' },
    );

    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.lq4');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedListQueryData<ItemState>>,
      unknown
    >(JSON.parse(cached ?? ''));

    expect(Object.keys(parsed.data.queries)).toContain('pinned-query');
    expect(Object.keys(parsed.data.items)).toContain('pinned-item');
  });

  test('version mismatch discards cached data', () => {
    setCachedListQueryData(
      'lq5',
      'sess1',
      {
        items: { '1': { id: '1', title: 'Old' } },
        queries: {},
        itemPayloads: {},
      },
      1,
    );

    const store = createTestListQueryStore({
      storeName: 'lq5',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(Object.keys(store.store.state.items).length).toBe(0);
    expect(Object.keys(store.store.state.queries).length).toBe(0);
  });

  test('schema validation failure discards invalid items', () => {
    const key = 'tsdf.sess1.lq6';
    const entry: StorageCacheEntry<PersistedListQueryData<unknown>> = {
      data: {
        items: {
          valid: { id: 'v', title: 'Valid' },
          invalid: { badField: true },
        },
        queries: {
          q1: {
            payload: { filter: 'test' },
            items: ['valid', 'invalid'],
            hasMore: false,
          },
        },
        itemPayloads: { valid: 'v', invalid: 'bad' },
      },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const store = createTestListQueryStore({
      storeName: 'lq6',
      sessionKey: 'sess1',
    });

    // Valid item loaded
    expect(store.store.state.items['valid']).toMatchInlineSnapshot(`
      id: 'v'
      title: 'Valid'
    `);

    // Invalid item not loaded
    expect(store.store.state.items['invalid']).toBeUndefined();

    // Query should only reference valid item
    const query = store.store.state.queries['q1'];
    expect(query?.items).toMatchInlineSnapshot(`['valid']`);
  });

  test('session isolation', () => {
    setCachedListQueryData('lq7', 'sess-a', {
      items: { '1': { id: '1', title: 'A' } },
      queries: {},
      itemPayloads: {},
    });

    const store = createTestListQueryStore({
      storeName: 'lq7',
      sessionKey: 'sess-b',
    });

    expect(Object.keys(store.store.state.items).length).toBe(0);
  });

  test('reset clears persisted storage', async () => {
    setCachedListQueryData('lq8', 'sess1', {
      items: { '1': { id: '1', title: 'X' } },
      queries: {},
      itemPayloads: {},
    });

    const store = createTestListQueryStore({
      storeName: 'lq8',
      sessionKey: 'sess1',
    });

    expect(Object.keys(store.store.state.items).length).toBe(1);

    store.reset();
    await flushAllTimers();

    const cached = localStorage.getItem('tsdf.sess1.lq8');
    expect(cached).toBeNull();
  });

  test('itemLoadedFields starts empty after hydration', () => {
    setCachedListQueryData('lq9', 'sess1', {
      items: { '1': { id: '1', title: 'Item' } },
      queries: {
        q1: {
          payload: { filter: 'all' },
          items: ['1'],
          hasMore: false,
        },
      },
      itemPayloads: { '1': '1' },
    });

    const store = createTestListQueryStore({
      storeName: 'lq9',
      sessionKey: 'sess1',
    });

    // Items should be loaded
    expect(store.store.state.items['1']).not.toBeNull();

    // But fields should be empty (repopulated on refetch)
    expect(store.store.state.itemLoadedFields).toMatchInlineSnapshot(`{}`);
    expect(store.store.state.itemFieldInvalidationFields).toMatchInlineSnapshot(
      `{}`,
    );
  });
});
