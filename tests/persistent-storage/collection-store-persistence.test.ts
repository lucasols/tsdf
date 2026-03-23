import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { renderHook } from '@testing-library/react';
import { rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  createCompactLocalStorageEntry,
  parseCompactLocalStorageEntry,
} from '../../src/persistentStorage/compactLocalStorageEntry';
import { readManagedLocalStorageNamespaceEntryByPayload } from '../../src/persistentStorage/localStorageMetadata';
import { SYNC_STORAGE_TOUCH_THROTTLE_MS } from '../../src/persistentStorage/persistentStorageManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});
const persistentStore = createLocalStoragePersistentTestStore();

function itemKey(payload: string): string {
  return getCompositeKey(payload);
}

function itemStorageKey(
  storeName: string,
  sessionKey: string,
  payload: string,
): string {
  return `tsdf.${sessionKey}.${storeName}.ci.${itemKey(payload)}`;
}

function itemStoragePrefix(storeName: string, sessionKey: string): string {
  return `tsdf.${sessionKey}.${storeName}.ci.`;
}

type ItemState = { id: string; name: string };

type PersistedItemState = { value: ItemState };

function setCachedCollectionItem(
  storeName: string,
  sessionKey: string,
  payload: string,
  data: PersistedItemState,
  version: number | undefined = undefined,
  timestamp = Date.now(),
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .collection.seedItem(payload, data, { version, timestamp });
}

function listStoredItemKeys(storeName: string, sessionKey: string): string[] {
  const prefix = `tsdf.${sessionKey}.${storeName}.ci.`;
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
  const prefix = `tsdf.${sessionKey}.${storeName}.ci.`;
  const payloads: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;

    const rawEntry = localStorage.getItem(key);
    if (!rawEntry) continue;

    const parsed = parseCompactLocalStorageEntry(rawEntry);
    if (parsed === null || typeof parsed.value.p !== 'string') continue;

    payloads.push(parsed.value.p);
  }

  return payloads;
}

function getStoredCollectionItemTimestamp(key: string): number {
  const [_, sessionKey = '', storeName = ''] = key.split('.');
  const entry = readManagedLocalStorageNamespaceEntryByPayload(
    key,
    itemStoragePrefix(storeName, sessionKey),
  );
  if (entry === null) {
    throw new Error(`Missing managed localStorage metadata for ${key}`);
  }

  return entry.lastAccessAt;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  version?: number;
  maxItems?: number;
  pinnedItems?: string[];
  ignoreItems?: string[] | ((payload: string) => boolean);
  serverData?: Record<string, ItemState>;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      storeName: options.storeName,
      adapter: 'local-sync',
      schema: wrappedItemSchema,
      payloadSchema: rc_string,
      version: options.version,
      maxItems: options.maxItems,
      pinnedItems: options.pinnedItems,
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

describe('localStorage: collection store persistence', () => {
  test('dev-only check rejects store ids containing dots', () => {
    expect(() =>
      createEnv({ storeName: 'collection.with-dot', sessionKey: 'sess1' }),
    ).toThrowError(
      '[tsdf] persistentStorage.storeName "collection.with-dot" must not contain ".".',
    );
  });

  test('direct key reads lazily hydrate only the requested cached items', () => {
    setCachedCollectionItem('col-local', 'sess1', '1', {
      value: { id: '1', name: 'Alice' },
    });
    setCachedCollectionItem('col-local', 'sess1', '2', {
      value: { id: '2', name: 'Bob' },
    });

    const env = createEnv({ storeName: 'col-local', sessionKey: 'sess1' });

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

  test('direct cold key reads materialize state and stop consulting localStorage', () => {
    const storeName = 'col-external-overwrite';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached v1' },
    });

    const env = createEnv({ storeName, sessionKey });

    // First cold read hydrates from the persisted entry.
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached v1' }
    `);
    expect(env.store.state[itemKey('1')]?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached v1' }
    `);

    // Once the cached entry is read through into state, later storage changes
    // should not silently replace the in-memory source of truth.
    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached v2' },
    });

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Cached v1' }
    `);
  });

  test('filter-based reads stay in-memory only and do not scan cold persisted items', () => {
    setCachedCollectionItem('col-filter', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });

    const env = createEnv({ storeName: 'col-filter', sessionKey: 'sess1' });

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
      serverData: { '1': { id: '1', name: 'Fresh' } },
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
    const originalTimestamp = Date.now() - SYNC_STORAGE_TOUCH_THROTTLE_MS - 1;
    const key = setCachedCollectionItem(
      'col-hook-no-refetch',
      'sess1',
      '1',
      { value: { id: '1', name: 'Cached' } },
      undefined,
      originalTimestamp,
    );

    const env = createEnv({
      storeName: 'col-hook-no-refetch',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
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
    const env = createEnv({ storeName: 'col-entries', sessionKey: 'sess1' });

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

  test('ignoreItems predicate skips matching payloads and removes stale cached entries on flush', async () => {
    setCachedCollectionItem('col-ignore', 'sess1', 'skip:cached', {
      value: { id: 'skip:cached', name: 'Skip cached' },
    });
    setCachedCollectionItem('col-ignore', 'sess1', 'keep:cached', {
      value: { id: 'keep:cached', name: 'Keep cached' },
    });

    const env = createEnv({
      storeName: 'col-ignore',
      sessionKey: 'sess1',
      ignoreItems: (payload) => payload.startsWith('skip:'),
    });

    env.apiStore.addItemToState('skip:live', {
      value: { id: 'skip:live', name: 'Skip live' },
    });
    env.apiStore.addItemToState('keep:live', {
      value: { id: 'keep:live', name: 'Keep live' },
    });

    await advanceTime(1100);
    await flushAllTimers();

    expect(listStoredItemPayloads('col-ignore', 'sess1').sort()).toEqual([
      'keep:cached',
      'keep:live',
    ]);
    expect(listStoredItemKeys('col-ignore', 'sess1').sort()).toEqual([
      itemKey('keep:cached'),
      itemKey('keep:live'),
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

  test('preload hydrates cached local items without reporting an error', async () => {
    const onPersistentStorageError = vi.fn();
    setCachedCollectionItem('col-preload-local', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });
    const env = createEnv({
      storeName: 'col-preload-local',
      sessionKey: 'sess1',
      onPersistentStorageError,
    });

    await expect(env.apiStore.preloadItemFromStorage('1')).resolves
      .toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);

    expect(env.apiStore.getItemState('1')).toMatchInlineSnapshot(`
      data:
        value: { id: '1', name: 'Cached' }

      error: null
      payload: '1'
      refetchOnMount: 'lowPriority'
      status: 'success'
      wasLoaded: '✅'
    `);
    expect(onPersistentStorageError).not.toHaveBeenCalled();
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

  test('scheduled maintenance does not clean invalid cached entries before they are read', async () => {
    const key = setCachedCollectionItem(
      'col-invalid-maintenance',
      'sess1',
      'bad',
      { value: { id: 'bad', name: 'Old' } },
      1,
    );

    createEnv({
      storeName: 'col-invalid-maintenance',
      sessionKey: 'sess1',
      version: 2,
    });

    await advanceTime(2100);
    await flushAllTimers();

    expect(localStorage.getItem(key)).not.toBeNull();
  });

  test('invalid cached entries are also cleaned up after a hook read', async () => {
    const key = setCachedCollectionItem(
      'col-invalid-hook',
      'sess1',
      'bad',
      { value: { id: 'bad', name: 'Old' } },
      1,
    );

    const env = createEnv({
      storeName: 'col-invalid-hook',
      sessionKey: 'sess1',
      version: 2,
    });

    expect(localStorage.getItem(key)).not.toBeNull();

    renderHook(() => {
      env.apiStore.useItem('bad', {
        // The hook should trigger the same lazy read path as UI consumers
        // without starting a fetch that could obscure the cleanup effect.
        isOffScreen: true,
      });
    });

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('invalid cached payloads are cleaned up only after the item is read', async () => {
    const key = itemStorageKey('col-invalid-payload', 'sess1', 'bad');
    setCachedCollectionItem('col-invalid-payload', 'sess1', 'bad', {
      value: { id: 'bad', name: 'Old' },
    });
    const entry = persistentStore
      .scope('col-invalid-payload', 'sess1')
      .collection.readItemEntry<PersistedItemState>('bad');
    localStorage.setItem(
      key,
      JSON.stringify(
        createCompactLocalStorageEntry(
          { d: entry.data.data, p: true },
          entry.version,
        ),
      ),
    );

    const env = createEnv({
      storeName: 'col-invalid-payload',
      sessionKey: 'sess1',
    });

    expect(localStorage.getItem(key)).not.toBeNull();
    expect(env.apiStore.getItemState('bad')).toBeUndefined();

    await advanceTime(2100);

    expect(localStorage.getItem(key)).toBeNull();
  });

  test('deleteItemState removes deleted items from persisted storage', async () => {
    const storeName = 'col-delete-persisted-item';
    const sessionKey = 'sess1';
    const deletedItemStorageKey = itemStorageKey(storeName, sessionKey, '1');

    const env = createEnv({ storeName, sessionKey });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });

    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem(deletedItemStorageKey)).not.toBeNull();
    expect(listStoredItemPayloads(storeName, sessionKey))
      .toMatchInlineSnapshot(`
        ['1', '2']
      `);

    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await flushAllTimers();

    expect(localStorage.getItem(deletedItemStorageKey)).toBeNull();
    expect(listStoredItemPayloads(storeName, sessionKey))
      .toMatchInlineSnapshot(`
        ['2']
      `);
  });

  test('reset clears all persisted item entries for the store', async () => {
    const env = createEnv({ storeName: 'col-reset', sessionKey: 'sess1' });

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
