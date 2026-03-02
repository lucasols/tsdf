import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createCollectionStore } from '../../src/collectionStore/collectionStore';
import type {
  PersistedCollectionData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import type { StoreError } from '../../src/utils/storeShared';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

function normalizeError(exception: Error): StoreError {
  return {
    code: 500,
    id: 'error',
    message: exception.message,
  };
}

type ItemState = { id: string; name: string };

const itemSchema = rc_object({ id: rc_string, name: rc_string });

type ItemPayload = string;

function createTestCollectionStore(options: {
  storeName?: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  pinnedItems?: string[];
  fetchDuration?: number;
}) {
  const fetchDuration = options.fetchDuration ?? 800;

  const store = createCollectionStore<ItemState, ItemPayload>({
    fetchFn: async (payload, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fetchDuration);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      });
      return { id: payload, name: `Item ${payload}` };
    },
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs: 10,
    backgroundCoalescingWindowMultiplier: 1,
    blockWindowClose: null,
    persistentStorage: {
      storeName: options.storeName ?? 'test-col',
      backend: 'localStorage',
      schema: itemSchema,
      version: options.version,
      getSessionKey: () => options.sessionKey ?? 'session1',
      maxItems: options.maxItems,
      pinnedItems: options.pinnedItems,
    },
  });

  return store;
}

function setCachedCollectionData(
  storeName: string,
  sessionKey: string,
  items: Record<
    string,
    { data: ItemState; payload: unknown; lastAccessedAt: number }
  >,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<PersistedCollectionData<ItemState>> = {
    data: { items },
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

describe('localStorage: collection store persistence', () => {
  test('multiple items loaded from cache', () => {
    const key1 = getCompositeKey('1');
    const key2 = getCompositeKey('2');

    setCachedCollectionData('col1', 'sess1', {
      [key1]: {
        data: { id: '1', name: 'Alice' },
        payload: '1',
        lastAccessedAt: 1000,
      },
      [key2]: {
        data: { id: '2', name: 'Bob' },
        payload: '2',
        lastAccessedAt: 2000,
      },
    });

    const store = createTestCollectionStore({
      storeName: 'col1',
      sessionKey: 'sess1',
    });

    // Both items should be loaded
    const item1 = store.store.state[key1];
    const item2 = store.store.state[key2];

    expect(item1).toMatchInlineSnapshot(`
      data: { id: '1', name: 'Alice' }
      error: null
      payload: '1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(item2).toMatchInlineSnapshot(`
      data: { id: '2', name: 'Bob' }
      error: null
      payload: '2'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('items loaded as stale with refetchOnMount', () => {
    const keyX = getCompositeKey('x');

    setCachedCollectionData('col2', 'sess1', {
      [keyX]: {
        data: { id: 'x', name: 'Xena' },
        payload: 'x',
        lastAccessedAt: 1000,
      },
    });

    const store = createTestCollectionStore({
      storeName: 'col2',
      sessionKey: 'sess1',
    });

    const item = store.store.state[keyX];
    expect(item?.refetchOnMount).toBe('lowPriority');
    expect(item?.status).toBe('success');
    expect(item?.wasLoaded).toBe(true);
  });

  test('LRU eviction when exceeding maxItems', async () => {
    // Create a store with maxItems=2
    const store = createTestCollectionStore({
      storeName: 'col3',
      sessionKey: 'sess1',
      maxItems: 2,
      fetchDuration: 50,
    });

    // Add 3 items to the store
    store.addItemToState('a', { id: 'a', name: 'A' });
    store.addItemToState('b', { id: 'b', name: 'B' });
    store.addItemToState('c', { id: 'c', name: 'C' });

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.col3');
    expect(cached).not.toBeNull();

    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedCollectionData<ItemState>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedItemKeys = Object.keys(parsed.data.items);

    // Only 2 items should be saved (LRU eviction)
    expect(savedItemKeys.length).toBe(2);
  });

  test('pinned items are never evicted', async () => {
    const keyA = getCompositeKey('a');

    const store = createTestCollectionStore({
      storeName: 'col4',
      sessionKey: 'sess1',
      maxItems: 2,
      pinnedItems: [keyA],
    });

    // Add 3 items
    store.addItemToState('a', { id: 'a', name: 'A' });
    store.addItemToState('b', { id: 'b', name: 'B' });
    store.addItemToState('c', { id: 'c', name: 'C' });

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.col4');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedCollectionData<ItemState>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedItemKeys = Object.keys(parsed.data.items);

    // Pinned item should always be present
    expect(savedItemKeys).toContain(keyA);
    expect(savedItemKeys.length).toBe(2);
  });

  test('version mismatch discards cached data', () => {
    setCachedCollectionData(
      'col5',
      'sess1',
      {
        old: {
          data: { id: 'old', name: 'Old' },
          payload: 'old',
          lastAccessedAt: 1000,
        },
      },
      1,
    );

    const store = createTestCollectionStore({
      storeName: 'col5',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(Object.keys(store.store.state).length).toBe(0);
  });

  test('schema validation failure discards invalid items', () => {
    const key = 'tsdf.sess1.col6';
    const entry: StorageCacheEntry<PersistedCollectionData<unknown>> = {
      data: {
        items: {
          valid: {
            data: { id: 'v', name: 'Valid' },
            payload: 'v',
            lastAccessedAt: 1000,
          },
          invalid: {
            data: { badField: true },
            payload: 'bad',
            lastAccessedAt: 2000,
          },
        },
      },
      timestamp: Date.now(),
      version: 1,
    };
    localStorage.setItem(key, JSON.stringify(entry));

    const store = createTestCollectionStore({
      storeName: 'col6',
      sessionKey: 'sess1',
    });

    // Only valid item should be loaded (keyed by the cache key, not the payload)
    expect(store.store.state['valid']).not.toBeUndefined();
    expect(store.store.state['invalid']).toBeUndefined();
  });

  test('save debouncing - only saves once per debounce window', async () => {
    const store = createTestCollectionStore({
      storeName: 'col7',
      sessionKey: 'sess1',
    });

    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    // Add multiple items rapidly
    store.addItemToState('a', { id: 'a', name: 'A' });
    store.addItemToState('b', { id: 'b', name: 'B' });
    store.addItemToState('c', { id: 'c', name: 'C' });

    // Wait for debounce
    await advanceTime(1100);

    // Count writes to our specific key
    const writeCount = setItemSpy.mock.calls.filter(
      ([key]) => key === 'tsdf.sess1.col7',
    ).length;

    // Should only have written once (debounced)
    expect(writeCount).toBe(1);

    setItemSpy.mockRestore();
  });

  test('session isolation - different sessions do not share data', () => {
    setCachedCollectionData('col8', 'sess-a', {
      x: {
        data: { id: 'x', name: 'Session A' },
        payload: 'x',
        lastAccessedAt: 1000,
      },
    });

    const store = createTestCollectionStore({
      storeName: 'col8',
      sessionKey: 'sess-b',
    });

    expect(Object.keys(store.store.state).length).toBe(0);
  });

  test('reset clears persisted storage', async () => {
    setCachedCollectionData('col9', 'sess1', {
      x: { data: { id: 'x', name: 'X' }, payload: 'x', lastAccessedAt: 1000 },
    });

    const store = createTestCollectionStore({
      storeName: 'col9',
      sessionKey: 'sess1',
    });

    expect(store.store.state['x']).not.toBeNull();

    store.reset();
    await flushAllTimers();

    const cached = localStorage.getItem('tsdf.sess1.col9');
    expect(cached).toBeNull();
  });
});
