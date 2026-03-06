import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type {
  PersistedCollectionItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

const wrappedItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

function itemKey(payload: string): string {
  return getCompositeKey(payload);
}

function itemStorageKey(
  storeName: string,
  sessionKey: string,
  payload: string,
): string {
  return `tsdf.${sessionKey}.${storeName}.collection.item.${itemKey(payload)}`;
}

type ItemState = { id: string; name: string };

type PersistedItemState = { value: ItemState };

function setCachedCollectionItem(
  storeName: string,
  sessionKey: string,
  payload: string,
  data: PersistedItemState,
  version = 1,
): string {
  const key = itemStorageKey(storeName, sessionKey, payload);
  const entry: StorageCacheEntry<
    PersistedCollectionItemData<PersistedItemState>
  > = {
    data: { data, payload },
    timestamp: Date.now(),
    version,
  };

  localStorage.setItem(key, JSON.stringify(entry));

  return key;
}

function listStoredItemKeys(storeName: string, sessionKey: string): string[] {
  const prefix = `tsdf.${sessionKey}.${storeName}.collection.item.`;
  const keys: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keys.push(key.slice(prefix.length));
    }
  }

  return keys;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  pinnedItems?: string[];
  serverData?: Record<string, ItemState>;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    ignoreInitialTimeCheck: true,
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      storeName: options.storeName,
      backend: 'localStorage',
      schema: wrappedItemSchema,
      version: options.version,
      maxItems: options.maxItems,
      pinnedItems: options.pinnedItems,
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

describe('localStorage: collection store persistence', () => {
  test('direct key reads lazily hydrate only the requested cached items', () => {
    setCachedCollectionItem('col-local', 'sess1', '1', {
      value: { id: '1', name: 'Alice' },
    });
    setCachedCollectionItem('col-local', 'sess1', '2', {
      value: { id: '2', name: 'Bob' },
    });

    const env = createEnv({
      storeName: 'col-local',
      sessionKey: 'sess1',
    });

    expect(env.store.isInitialized).toBe(false);
    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);

    expect(env.apiStore.getItemState('1')).toMatchInlineSnapshot(`
      data:
        value: { id: '1', name: 'Alice' }

      error: null
      payload: '1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);

    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`
      - data:
          value: { id: '1', name: 'Alice' }
        error: null
        payload: '1'
        refetchOnMount: 'lowPriority'
        status: 'success'
        wasLoaded: '✅'
    `);

    expect(env.apiStore.getItemState('2')?.data).toMatchInlineSnapshot(`
      value: { id: '2', name: 'Bob' }
    `);
  });

  test('filter-based reads stay in-memory only and do not scan cold persisted items', () => {
    setCachedCollectionItem('col-filter', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });

    const env = createEnv({
      storeName: 'col-filter',
      sessionKey: 'sess1',
    });

    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);
    expect(env.store.isInitialized).toBe(true);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached' }
    `);
  });

  test('first hook read returns cached data then refetches', async () => {
    setCachedCollectionItem('col-hook', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });

    const env = createEnv({
      storeName: 'col-hook',
      sessionKey: 'sess1',
      serverData: {
        '1': { id: '1', name: 'Fresh' },
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem('1', {
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Cached}
      -> status: refetching ⋅ data: {id:1, name:Cached}
      -> status: success ⋅ data: {id:1, name:Fresh}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('disableRefetchOnMount keeps cached data without refetching', async () => {
    setCachedCollectionItem('col-hook-no-refetch', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });

    const env = createEnv({
      storeName: 'col-hook-no-refetch',
      sessionKey: 'sess1',
      serverData: {
        '1': { id: '1', name: 'Fresh' },
      },
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem('1', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:Cached}
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

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
