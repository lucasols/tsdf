import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type {
  PersistedCollectionData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import type { CollectionTestItem } from '../mocks/collectionStoreTestEnv';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const wrappedItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

type ItemState = { id: string; name: string };

function setCachedCollectionData(
  storeName: string,
  sessionKey: string,
  items: Record<
    string,
    {
      data: CollectionTestItem<ItemState>;
      payload: unknown;
      lastAccessedAt: number;
    }
  >,
  version = 1,
) {
  const key = `tsdf.${sessionKey}.${storeName}`;
  const entry: StorageCacheEntry<
    PersistedCollectionData<CollectionTestItem<ItemState>>
  > = {
    data: { items },
    timestamp: Date.now(),
    version,
  };
  localStorage.setItem(key, JSON.stringify(entry));
}

function createColPersistenceEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  pinnedItems?: string[];
}) {
  const getSessionKey = () => options.sessionKey ?? 'session1';

  return createCollectionStoreTestEnv(
    {},
    {
      ignoreInitialTimeCheck: true,
      getSessionKey,
      persistentStorage: {
        storeName: options.storeName,
        backend: 'localStorage',
        schema: wrappedItemSchema,
        version: options.version,
        maxItems: options.maxItems,
        pinnedItems: options.pinnedItems,
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

describe('localStorage: collection store persistence', () => {
  test('multiple items loaded from cache', () => {
    const key1 = getCompositeKey('1');
    const key2 = getCompositeKey('2');

    setCachedCollectionData('col1', 'sess1', {
      [key1]: {
        data: { value: { id: '1', name: 'Alice' } },
        payload: '1',
        lastAccessedAt: 1000,
      },
      [key2]: {
        data: { value: { id: '2', name: 'Bob' } },
        payload: '2',
        lastAccessedAt: 2000,
      },
    });

    const env = createColPersistenceEnv({
      storeName: 'col1',
      sessionKey: 'sess1',
    });

    // Both items should be loaded
    const item1 = env.store.state[key1];
    const item2 = env.store.state[key2];

    expect(item1).toMatchInlineSnapshot(`
      data:
        value: { id: '1', name: 'Alice' }

      error: null
      payload: '1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(item2).toMatchInlineSnapshot(`
      data:
        value: { id: '2', name: 'Bob' }

      error: null
      payload: '2'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('LRU eviction when exceeding maxItems', async () => {
    const keyA = getCompositeKey('a');
    const keyB = getCompositeKey('b');
    const keyC = getCompositeKey('c');

    // Create a store with maxItems=2
    const env = createColPersistenceEnv({
      storeName: 'col3',
      sessionKey: 'sess1',
      maxItems: 2,
    });

    // Add 3 items to the store
    env.apiStore.addItemToState('a', { value: { id: 'a', name: 'A' } });
    env.apiStore.addItemToState('b', { value: { id: 'b', name: 'B' } });
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'C' } });

    // Wait for save debounce
    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.col3');
    expect(cached).not.toBeNull();

    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedCollectionData<CollectionTestItem<ItemState>>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedItemKeys = Object.keys(parsed.data.items);

    // Only 2 items should be saved — last item evicted (all have equal
    // lastAccessedAt since they were saved together, so insertion order decides)
    expect(savedItemKeys).toContain(keyA);
    expect(savedItemKeys).toContain(keyB);
    expect(savedItemKeys).not.toContain(keyC);
  });

  test('pinned items are never evicted', async () => {
    const keyA = getCompositeKey('a');
    const keyB = getCompositeKey('b');
    const keyC = getCompositeKey('c');

    // Pin 'c' — without pinning, 'c' would be evicted (added last, equal
    // lastAccessedAt, maxItems=2 keeps only first 2 by insertion order).
    // With pinning, 'c' is forced to the front and survives.
    const env = createColPersistenceEnv({
      storeName: 'col4',
      sessionKey: 'sess1',
      maxItems: 2,
      pinnedItems: [keyC],
    });

    env.apiStore.addItemToState('a', { value: { id: 'a', name: 'A' } });
    env.apiStore.addItemToState('b', { value: { id: 'b', name: 'B' } });
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'C' } });

    await advanceTime(1100);

    const cached = localStorage.getItem('tsdf.sess1.col4');
    const parsed = __LEGIT_CAST__<
      StorageCacheEntry<PersistedCollectionData<CollectionTestItem<ItemState>>>,
      unknown
    >(JSON.parse(cached ?? ''));
    const savedItemKeys = Object.keys(parsed.data.items);

    // Pinned 'c' survives despite being last; 'a' survives by insertion order; 'b' evicted
    expect(savedItemKeys).toContain(keyC);
    expect(savedItemKeys).toContain(keyA);
    expect(savedItemKeys).not.toContain(keyB);
  });

  test('version mismatch discards cached data', () => {
    setCachedCollectionData(
      'col5',
      'sess1',
      {
        old: {
          data: { value: { id: 'old', name: 'Old' } },
          payload: 'old',
          lastAccessedAt: 1000,
        },
      },
      1,
    );

    const env = createColPersistenceEnv({
      storeName: 'col5',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(Object.keys(env.store.state).length).toBe(0);
  });

  test('schema validation failure discards invalid items', () => {
    const key = 'tsdf.sess1.col6';
    const entry: StorageCacheEntry<PersistedCollectionData<unknown>> = {
      data: {
        items: {
          valid: {
            data: { value: { id: 'v', name: 'Valid' } },
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

    const env = createColPersistenceEnv({
      storeName: 'col6',
      sessionKey: 'sess1',
    });

    // Only valid item should be loaded (keyed by the cache key, not the payload)
    expect(env.store.state['valid']).toMatchInlineSnapshot(`
      data:
        value: { id: 'v', name: 'Valid' }

      error: null
      payload: 'v'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(env.store.state['invalid']).toBeUndefined();
  });

  test('save debouncing - only saves once per debounce window', async () => {
    const env = createColPersistenceEnv({
      storeName: 'col7',
      sessionKey: 'sess1',
    });

    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    // Add multiple items rapidly
    env.apiStore.addItemToState('a', { value: { id: 'a', name: 'A' } });
    env.apiStore.addItemToState('b', { value: { id: 'b', name: 'B' } });
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'C' } });

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
        data: { value: { id: 'x', name: 'Session A' } },
        payload: 'x',
        lastAccessedAt: 1000,
      },
    });

    const env = createColPersistenceEnv({
      storeName: 'col8',
      sessionKey: 'sess-b',
    });

    expect(Object.keys(env.store.state).length).toBe(0);
  });

  test('reset clears persisted storage', async () => {
    setCachedCollectionData('col9', 'sess1', {
      x: {
        data: { value: { id: 'x', name: 'X' } },
        payload: 'x',
        lastAccessedAt: 1000,
      },
    });

    const env = createColPersistenceEnv({
      storeName: 'col9',
      sessionKey: 'sess1',
    });

    expect(env.store.state['x']).not.toBeNull();

    env.apiStore.reset();
    await flushAllTimers();

    const cached = localStorage.getItem('tsdf.sess1.col9');
    expect(cached).toBeNull();
  });
});
