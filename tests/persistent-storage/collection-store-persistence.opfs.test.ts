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
import { resetExpirationScanTracking } from '../../src/persistentStorage/persistentStorageManager';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type {
  PersistedCollectionItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
} from '../utils/persistentStorageOptimizationTestUtils';
import {
  getAsyncCollectionEntrySizeBytes,
  sumPersistedEntryBytes,
} from './persistentStorageByteBudgetTestUtils';

const utf8Encoder = new TextEncoder();

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
  return `tsdf.${sessionKey}.${storeName}.ci.${itemKey(payload)}`;
}

type ItemState = { id: string; name: string };

type PersistedItemState = { value: ItemState };

function getLogicalCollectionEntrySizeBytes(
  payload: string,
  data: PersistedItemState,
): number {
  return utf8Encoder.encode(JSON.stringify({ data, payload })).byteLength;
}

function setCachedCollectionItem(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  storeName: string,
  sessionKey: string,
  payload: string,
  data: PersistedItemState,
  version: number | undefined = undefined,
): string {
  const key = itemStorageKey(storeName, sessionKey, payload);
  const entry: StorageCacheEntry<{ d: PersistedItemState; p: string }> =
    version === undefined
      ? { data: { d: data, p: payload }, timestamp: Date.now() }
      : { data: { d: data, p: payload }, timestamp: Date.now(), version };

  mockAdapter.setValue(key, entry);

  return key;
}

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  ignoreItems?: string[] | ((payload: string) => boolean);
  maxBytes?: number;
  pinnedItems?: string[];
  serverData?: Record<string, ItemState>;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    id: options.storeName,
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      adapter: opfsPersistentStorage,
      schema: wrappedItemSchema,
      payloadSchema: rc_string,
      ignoreItems: options.ignoreItems,
      maxBytes: options.maxBytes,
      pinnedItems: options.pinnedItems,
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
  resetExpirationScanTracking();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
  resetExpirationScanTracking();
});

describe('opfs: collection store persistence', () => {
  test('first hook read hydrates only the requested cached item and refetches', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    setCachedCollectionItem(mockAdapter, 'col-opfs-hook', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });
    setCachedCollectionItem(mockAdapter, 'col-opfs-hook', 'sess1', '2', {
      value: { id: '2', name: 'Cold' },
    });

    const env = createEnv({
      storeName: 'col-opfs-hook',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
    });

    await advanceTime(2100);
    await flushAllTimers();

    // Startup cleanup may scan persisted payloads to resolve hashed OPFS files.
    // Reset the capture so the assertions below only reflect hook-triggered hydration.
    mockAdapter.clearReadRequests();

    expect(env.apiStore.getItemState(() => true)).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getItemState('1')).toBeUndefined();
    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem('1', {
        returnRefetchingStatus: true,
      });

      renders.add({ status, data: data?.value ?? null });
    });

    await flushAllTimers();

    expect(mockAdapter.payloadGetRequests).toContain(
      'tsdf.sess1.col-opfs-hook.ci."1',
    );
    expect(mockAdapter.payloadGetRequests).not.toContain(
      'tsdf.sess1.col-opfs-hook.ci."2',
    );

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:Cached}
      -> status: refetching ⋅ data: {id:1, name:Cached}
      -> status: success ⋅ data: {id:1, name:Fresh}
      "
    `);

    expect(env.apiStore.getItemState(() => true).map((item) => item.payload))
      .toMatchInlineSnapshot(`
        ['1']
      `);
  });

  test('explicit preload hydrates cached data before mount', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    setCachedCollectionItem(mockAdapter, 'col-opfs-preload', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });

    const env = createEnv({
      storeName: 'col-opfs-preload',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);

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
  });

  test('missing collection item preloads still recheck storage on later retries', async () => {
    const storeName = 'col-opfs-missing-item-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const env = createEnv({ storeName, sessionKey });

    await advanceTime(2100);
    await flushAllTimers();

    const firstCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const firstPreloadPromise = env.apiStore.preloadItemFromStorage('1');
    await expect(resolveAfterAllTimers(firstPreloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '❌' }
    `);
    const firstOperations = firstCapture.finish().timelineString;

    expect(firstOperations).not.toBe('empty');

    const secondCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const secondPreloadPromise = env.apiStore.preloadItemFromStorage('1');
    await expect(resolveAfterAllTimers(secondPreloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '❌' }
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

  test('persisted collection maxBytes policy is enforced on cold startup before the store mounts', async () => {
    const storeName = 'col-opfs-cold-policy-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const keptOlderItem = { value: { id: 'b', name: 'Older kept' } };
    const keptNewestItem = { value: { id: 'c', name: 'Newest kept' } };

    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Older cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', keptOlderItem);
    await advanceTime(100);
    collectionScope.collection.seedItem('c', keptNewestItem);
    collectionScope.collection.setStaticPolicy({
      b: sumPersistedEntryBytes(
        getAsyncCollectionEntrySizeBytes('b', keptOlderItem),
        getAsyncCollectionEntrySizeBytes('c', keptNewestItem),
      ),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-collection', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(collectionScope.collection.listStoredPayloads())
      .toMatchInlineSnapshot(`
        ['b', 'c']
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-opfs-cold-policy-max-items/ci._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "b: { a: 1735689600100, p: 'b', z: 67 }
        "c: { a: 1735689600200, p: 'c', z: 68 }

      s: { b: 135 }
    `);
  });

  test('persisted pinned collection keys survive cold startup cleanup', async () => {
    const storeName = 'col-opfs-cold-policy-pinned';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('pinned', {
      value: { id: 'pinned', name: 'Pinned older' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('other', {
      value: { id: 'other', name: 'Newer other' },
    });
    collectionScope.collection.setStaticPolicy({
      k: [itemKey('pinned')],
      b: getAsyncCollectionEntrySizeBytes('pinned', {
        value: { id: 'pinned', name: 'Pinned older' },
      }),
    });

    opfsPersistentStorage.resetForTests?.();
    createEnv({ storeName: 'trigger-collection', sessionKey });
    await advanceTime(2100);
    await flushAllTimers();

    expect(collectionScope.collection.listStoredPayloads())
      .toMatchInlineSnapshot(`
        ['pinned']
      `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-opfs-cold-policy-pinned/ci._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "pinned: { a: 1735689600000, p: 'pinned', z: 79 }

      s:
        b: 79
        k: ['"pinned']
    `);
  });

  test('large collection payloads use hashed OPFS filenames and still hydrate correctly', async () => {
    const storeName = 'col-opfs-large-payload';
    const sessionKey = 'sess1';
    const longPayload = `payload-${'x'.repeat(320)}`;
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    setCachedCollectionItem(mockAdapter, storeName, sessionKey, longPayload, {
      value: { id: '1', name: 'Cached' },
    });

    // The physical OPFS file should stay short even when the logical payload is huge.
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
      storeEntries: ['file:ci._i.r.json', 'file:ci.h~4228899405.p.json']
    `);

    const env = createEnv({
      storeName,
      sessionKey,
      serverData: { [longPayload]: { id: '1', name: 'Fresh' } },
    });

    // Preload should still resolve the logical payload key and hydrate normally.
    const preloadPromise = env.apiStore.preloadItemFromStorage(longPayload);
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - payload: 'payload-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
        preloaded: '✅'
    `);

    const renders = createLoggerStore();

    renderHook(() => {
      const { data, status } = env.apiStore.useItem(longPayload, {
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
  });

  test('invalid cached items are removed during targeted preload', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const key = itemStorageKey('col-opfs-invalid', 'sess1', 'bad');
    const entry: StorageCacheEntry<PersistedCollectionItemData<{ bad: true }>> =
      {
        data: { data: { bad: true }, payload: 'bad' },
        timestamp: Date.now(),
        version: 1,
      };
    mockAdapter.setValue(key, entry);

    const env = createEnv({
      storeName: 'col-opfs-invalid',
      sessionKey: 'sess1',
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('bad');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'bad', preloaded: '❌' }
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('invalid cached payloads are removed during targeted preload', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const key = itemStorageKey('col-opfs-invalid-payload', 'sess1', 'bad');
    const entry: StorageCacheEntry<
      PersistedCollectionItemData<PersistedItemState> & { payload: boolean }
    > = {
      data: { data: { value: { id: 'bad', name: 'Old' } }, payload: true },
      timestamp: Date.now(),
      version: 1,
    };
    mockAdapter.setValue(key, entry);

    const env = createEnv({
      storeName: 'col-opfs-invalid-payload',
      sessionKey: 'sess1',
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('bad');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'bad', preloaded: '❌' }
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('ignored cached items are skipped during preload and removed from opfs', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const key = setCachedCollectionItem(
      mockAdapter,
      'col-opfs-ignore',
      'sess1',
      'secret',
      { value: { id: 'secret', name: 'Cached secret' } },
    );

    const env = createEnv({
      storeName: 'col-opfs-ignore',
      sessionKey: 'sess1',
      ignoreItems: ['secret'],
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('secret');
    await expect(resolveAfterAllTimers(preloadPromise)).resolves
      .toMatchInlineSnapshot(`
      - { payload: 'secret', preloaded: '❌' }
    `);
    await advanceTime(2100);
    await flushAllTimers();

    expect(env.apiStore.getItemState('secret')).toBeUndefined();
    expect(mockAdapter.has(key)).toBe(false);
  });

  test('stale async preload does not overwrite live state', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    setCachedCollectionItem(mockAdapter, 'col-opfs-race', 'sess1', '1', {
      value: { id: '1', name: 'Stale' },
    });

    const env = createEnv({ storeName: 'col-opfs-race', sessionKey: 'sess1' });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Live' } });

    await resolveAfterAllTimers(preloadPromise);

    expect(env.apiStore.getItemState('1')).toMatchInlineSnapshot(`
      data:
        value: { id: '1', name: 'Live' }

      error: null
      payload: '1'
      refetchOnMount: '❌'
      status: 'success'
      wasLoaded: '✅'
    `);
  });

  test('async maxBytes eviction rewrites surviving items after a newer item is removed', async () => {
    const storeName = 'col-opfs-rewrite-after-byte-eviction';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const olderItem = { value: { id: '1', name: 'Older kept later' } };
    const newerItem = { value: { id: '2', name: 'Newer evicted later' } };
    const maxBytes = sumPersistedEntryBytes(
      getAsyncCollectionEntrySizeBytes('1', olderItem),
      getLogicalCollectionEntrySizeBytes('2', newerItem),
    );

    expect(maxBytes).toBeLessThan(
      sumPersistedEntryBytes(
        getAsyncCollectionEntrySizeBytes('1', olderItem),
        getAsyncCollectionEntrySizeBytes('2', newerItem),
      ),
    );

    const env = createEnv({ storeName, sessionKey, maxBytes });

    env.apiStore.addItemToState('1', olderItem);
    await advanceTime(1100);
    await flushAllTimers();

    env.apiStore.addItemToState('2', newerItem);
    await advanceTime(1100);
    await flushAllTimers();

    expect(collectionScope.collection.listStoredPayloads())
      .toMatchInlineSnapshot(`
        ['2']
      `);

    env.apiStore.deleteItemState('2');
    await advanceTime(1100);
    await flushAllTimers();

    expect(collectionScope.collection.listStoredPayloads())
      .toMatchInlineSnapshot(`
        ['1']
      `);

    opfsPersistentStorage.resetForTests?.();
    const readerEnv = createEnv({ storeName, sessionKey });

    await expect(
      resolveAfterAllTimers(readerEnv.apiStore.preloadItemFromStorage('1')),
    ).resolves.toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
  });

  test('async maxBytes eviction skips a newer entry that cannot fit by itself', async () => {
    const storeName = 'col-opfs-skip-oversized-hot-entry';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const keptItem = { value: { id: '1', name: 'Fits' } };
    const oversizedItem = {
      value: {
        id: '2',
        name: 'This cached value is intentionally much larger than the budget',
      },
    };
    const maxBytes = getAsyncCollectionEntrySizeBytes('1', keptItem);

    expect(
      getAsyncCollectionEntrySizeBytes('2', oversizedItem),
    ).toBeGreaterThan(maxBytes);

    const env = createEnv({ storeName, sessionKey, maxBytes });

    env.apiStore.addItemToState('1', keptItem);
    await advanceTime(1100);
    await flushAllTimers();

    // Persist an oversized hot entry next. The byte budget should keep the
    // older small entry instead of leaving storage above budget.
    env.apiStore.addItemToState('2', oversizedItem);
    await advanceTime(1100);
    await flushAllTimers();

    expect(collectionScope.collection.listStoredPayloads())
      .toMatchInlineSnapshot(`
        ['1']
      `);
  });

  test('deleteItemState removes deleted items from persisted storage', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const storeName = 'col-opfs-delete-persisted-item';
    const sessionKey = 'sess-delete';
    const deletedItemStorageKey = itemStorageKey(storeName, sessionKey, '1');
    const keptItemStorageKey = itemStorageKey(storeName, sessionKey, '2');

    const env = createEnv({ storeName, sessionKey });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });

    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(true);
    expect(mockAdapter.has(keptItemStorageKey)).toBe(true);

    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(mockAdapter.has(keptItemStorageKey)).toBe(true);
  });
});
