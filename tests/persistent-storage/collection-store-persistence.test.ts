import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_number, rc_object, rc_parse_json, rc_string } from 'runcheck';
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
const cachedCollectionItemEntrySchema = rc_object({
  data: rc_object({
    data: wrappedItemSchema,
    payload: rc_string,
  }),
  timestamp: rc_number,
  version: rc_number,
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

function listStoredItemPayloads(
  storeName: string,
  sessionKey: string,
): string[] {
  const prefix = `tsdf.${sessionKey}.${storeName}.collection.item.`;
  const payloads: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;

    const rawEntry = localStorage.getItem(key);
    if (!rawEntry) continue;

    const parsed = rc_parse_json(rawEntry, cachedCollectionItemEntrySchema);
    if (!parsed.ok) continue;

    payloads.push(parsed.value.data.payload);
  }

  return payloads;
}

function getStoredCollectionItemTimestamp(key: string): number {
  const rawEntry = localStorage.getItem(key);
  if (rawEntry === null) {
    throw new Error(`Missing localStorage entry for ${key}`);
  }

  const parsed = rc_parse_json(rawEntry, cachedCollectionItemEntrySchema);
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
    const key = setCachedCollectionItem('col-hook-no-refetch', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });
    const originalTimestamp = getStoredCollectionItemTimestamp(key);

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
    expect(getStoredCollectionItemTimestamp(key)).toBeGreaterThan(
      originalTimestamp,
    );
  });

  test('items are saved as separate localStorage entries', async () => {
    const env = createEnv({
      storeName: 'col-entries',
      sessionKey: 'sess1',
    });

    env.apiStore.addItemToState('a', { value: { id: 'a', name: 'A' } });
    env.apiStore.addItemToState('b', { value: { id: 'b', name: 'B' } });

    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem('tsdf.sess1.col-entries')).toBeNull();
    expect(listStoredItemKeys('col-entries', 'sess1').sort()).toEqual([
      itemKey('a'),
      itemKey('b'),
    ]);
  });

  test('when maxItems is exceeded, pinnedItems keeps that payload in storage', async () => {
    // Seed distinct timestamps so the kept payloads are easy to understand.
    setCachedCollectionItem('col-max-items', 'sess1', 'a', {
      value: { id: 'a', name: 'Pinned and old' },
    });
    await advanceTime(100);
    setCachedCollectionItem('col-max-items', 'sess1', 'b', {
      value: { id: 'b', name: 'Older' },
    });
    await advanceTime(100);
    setCachedCollectionItem('col-max-items', 'sess1', 'c', {
      value: { id: 'c', name: 'Newest cached' },
    });

    const env = createEnv({
      storeName: 'col-max-items',
      sessionKey: 'sess1',
      maxItems: 2,
      pinnedItems: ['a'],
    });

    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fresh' } });

    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredItemPayloads('col-max-items', 'sess1').sort()).toEqual([
      'a',
      'd',
    ]);
    expect(listStoredItemKeys('col-max-items', 'sess1').sort()).toEqual([
      itemKey('a'),
      itemKey('d'),
    ]);
  });

  test('when maxItems is exceeded, a cached item read by a hook is kept over an unread older entry', async () => {
    setCachedCollectionItem('col-max-items-read', 'sess1', 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem('col-max-items-read', 'sess1', 'b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    const env = createEnv({
      storeName: 'col-max-items-read',
      sessionKey: 'sess1',
      maxItems: 2,
    });

    const renders = createLoggerStore();

    // Mounting the hook for "a" refreshes its cached timestamp before maxItems cleanup runs.
    renderHook(() => {
      const { data, status } = env.apiStore.useItem('a', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:a, name:Oldest cached}
      "
    `);

    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });

    await advanceTime(1100);
    await flushAllTimers();

    expect(
      listStoredItemPayloads('col-max-items-read', 'sess1').sort(),
    ).toEqual(['a', 'c']);
    expect(listStoredItemKeys('col-max-items-read', 'sess1').sort()).toEqual([
      itemKey('a'),
      itemKey('c'),
    ]);
  });

  test('preload reports unavailable async preload through persistent storage error handler', async () => {
    const onPersistentStorageError = vi.fn();
    const env = createEnv({
      storeName: 'col-preload-local',
      sessionKey: 'sess1',
      onPersistentStorageError,
    });

    await env.apiStore.preloadItemFromPersistentStorage('1');

    expect(onPersistentStorageError).toHaveBeenCalledTimes(1);
    expect(onPersistentStorageError.mock.calls[0]?.[0]).toMatchObject({
      message: 'Async preload is not available',
    });
  });

  test('invalid cached entries are cleaned up only after the item is read', async () => {
    const key = setCachedCollectionItem(
      'col-invalid',
      'sess1',
      'bad',
      { value: { id: 'bad', name: 'Old' } },
      1,
    );

    const env = createEnv({
      storeName: 'col-invalid',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(env.apiStore.getItemState('bad')).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('reset clears all persisted item entries for the store', async () => {
    const env = createEnv({
      storeName: 'col-reset',
      sessionKey: 'sess1',
    });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });

    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredItemKeys('col-reset', 'sess1')).toHaveLength(2);

    env.apiStore.reset();
    await flushAllTimers();

    expect(listStoredItemKeys('col-reset', 'sess1')).toHaveLength(0);
  });
});
