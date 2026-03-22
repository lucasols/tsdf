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
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import type {
  PersistedCollectionItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { resetMockBrowserOpfsForTests } from '../mocks/mockBrowserOpfs';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
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
  return `tsdf.${sessionKey}.${storeName}.ci.${itemKey(payload)}`;
}

type ItemState = { id: string; name: string };

type PersistedItemState = { value: ItemState };

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
  serverData?: Record<string, ItemState>;
}) {
  return createCollectionStoreTestEnv(options.serverData ?? {}, {
    getSessionKey: () => options.sessionKey ?? 'session1',
    persistentStorage: {
      storeName: options.storeName,
      adapter: opfsPersistentStorage,
      schema: wrappedItemSchema,
      payloadSchema: rc_string,
      ignoreItems: options.ignoreItems,
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
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
  resetMockBrowserOpfsForTests();
  opfsPersistentStorage.resetForTests?.();
});

describe('opfs: collection store persistence', () => {
  test('first hook read hydrates only the requested cached item and refetches', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 100,
    });
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
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 100,
    });
    setCachedCollectionItem(mockAdapter, 'col-opfs-preload', 'sess1', '1', {
      value: { id: '1', name: 'Cached' },
    });

    const env = createEnv({
      storeName: 'col-opfs-preload',
      sessionKey: 'sess1',
      serverData: { '1': { id: '1', name: 'Fresh' } },
    });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    await advanceTime(100);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
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

  test('invalid cached items are removed during targeted preload', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    await advanceTime(100);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: 'bad', preloaded: '❌' }
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('invalid cached payloads are removed during targeted preload', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    await advanceTime(100);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: 'bad', preloaded: '❌' }
    `);
    await flushAllTimers();

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('ignored cached items are skipped during preload and removed from opfs', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
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
    await advanceTime(50);
    await expect(preloadPromise).resolves.toMatchInlineSnapshot(`
      - { payload: 'secret', preloaded: '❌' }
    `);
    await advanceTime(2100);
    await flushAllTimers();

    expect(env.apiStore.getItemState('secret')).toBeUndefined();
    expect(mockAdapter.has(key)).toBe(false);
  });

  test('stale async preload does not overwrite live state', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 100,
    });
    setCachedCollectionItem(mockAdapter, 'col-opfs-race', 'sess1', '1', {
      value: { id: '1', name: 'Stale' },
    });

    const env = createEnv({ storeName: 'col-opfs-race', sessionKey: 'sess1' });

    const preloadPromise = env.apiStore.preloadItemFromStorage('1');

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Live' } });

    await advanceTime(100);
    await preloadPromise;

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

  test('deleteItemState removes deleted items from persisted storage', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 100,
    });
    const storeName = 'col-opfs-delete-persisted-item';
    const sessionKey = 'sess1';
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
