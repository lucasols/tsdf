import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { advanceTime } from '../../utils/genericTestUtils';
import {
  getParsedIndexedDbRecordData,
  startIndexedDbPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  createCollectionEnv,
  flushInvalidationPersistence,
  resolveAfterIndexedDbStorage,
  setProtectedKeysSnapshot,
  settleIndexedDbStorage,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  waitForIndexedDbCondition,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function readCollectionEntryRow(args: {
  key: string;
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [args.sessionKey, args.storeName, 'collection.item', args.key],
    storeName: 'entries',
  });
}

describe('indexeddb async storage efficiency: collection', () => {
  test('useItem invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'col-invalidation-flow';
    const sessionKey = 'sess-invalidation-flow';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    await settleStartupBackgroundScan(mockAdapter);
    await resolveAfterIndexedDbStorage(
      env.apiStore.preloadItemFromStorage('1'),
      mockAdapter,
    );
    const mountedHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await settleIndexedDbStorage();

    const invalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    await waitForIndexedDbCondition(() => {
      return env.apiStore.getItemState('1')?.data?.value?.name === 'Fresh user';
    });
    mountedHook.unmount();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        d:
          value: { id: '1', name: 'Fresh user' }
        p: '1'

      k: '"1'
      m: { p: '1' }
      n: 'col-invalidation-flow'
      o: 0
      s: 'sess-invalidation-flow'
      t: 'collection.item'
      v: 1
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.854s | ✍️ tx(entries, namespacePolicies).commit scope=["sess-invalidation-flow","col-invalidation-flow","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('collection invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'col-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = collectionScope.collection.itemStorageKey('1');

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    await settleStartupBackgroundScan(mockAdapter);
    await resolveAfterIndexedDbStorage(
      env.apiStore.preloadItemFromStorage('1'),
      mockAdapter,
    );
    const mountedHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await settleIndexedDbStorage();

    setProtectedKeysSnapshot(sessionKey, [storageKey]);

    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(3200);
    await settleIndexedDbStorage();
    mountedHook.unmount();

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
  });

  test('repeated invalidations within the debounce window coalesce collection persistence writes', async () => {
    const storeName = 'col-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user 1' } },
    });

    await settleStartupBackgroundScan(mockAdapter);
    await resolveAfterIndexedDbStorage(
      env.apiStore.preloadItemFromStorage('1'),
      mockAdapter,
    );
    const mountedHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await settleIndexedDbStorage();

    const firstInvalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 1' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1100);
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    const secondInvalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 2' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1900);
    await settleIndexedDbStorage();
    await waitForIndexedDbCondition(() => {
      return (
        env.apiStore.getItemState('1')?.data?.value?.name === 'Fresh user 2'
      );
    });
    mountedHook.unmount();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        d:
          value: { id: '1', name: 'Fresh user 2' }
        p: '1'

      k: '"1'
      m: { p: '1' }
      n: 'col-coalesced-invalidations'
      o: 0
      s: 'sess1'
      t: 'collection.item'
      v: 1
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      ""
      1.85s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-coalesced-invalidations","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('hook remount skips the touch write when the cached collection item is still in the current recency bucket', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-remount-flow","collection.item"] keys=["\\"1"] -> ["\\"1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('collection hydration does not skip the touch write once the cached item falls outside the current recency bucket', async () => {
    const storeName = 'col-remount-stale-touch';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem(
      '1',
      { value: { id: '1', name: 'Cached user' } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-remount-stale-touch","collection.item"] keys=["\\"1"] -> ["\\"1"]
      44ms | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-remount-stale-touch","collection.item"] put=[] delete=[] touch=["\\"1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('collection hook cache miss writes the fetched item once and remount stays fully in memory', async () => {
    const storeName = 'col-remount-no-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fetched user' } },
    });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await advanceTime(4300);
    await settleIndexedDbStorage();
    await waitForIndexedDbCondition(() => {
      return (
        env.apiStore.getItemState('1')?.data?.value?.name === 'Fetched user'
      );
    });
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fetched user' }
    `);
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689604851

      d:
        d:
          value: { id: '1', name: 'Fetched user' }
        p: '1'

      k: '"1'
      m: { p: '1' }
      n: 'col-remount-no-cache'
      o: 0
      s: 'sess1'
      t: 'collection.item'
      v: 1
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-remount-no-cache","collection.item"] keys=["\\"1"] -> []
      1.851s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-remount-no-cache","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    collectionScope.collection.seedItem('2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(
      ['1', '2'].map(
        (payload) => env.apiStore.getItemState(payload)?.data?.value,
      ),
    ).toMatchInlineSnapshot(`
      - { id: '1', name: 'Cached user 1' }
      - { id: '2', name: 'Cached user 2' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      2ms | 📖 entries.getMany scope=["sess1","col-multi-remount-flow","collection.item"] keys=["\\"1", "\\"2"] -> ["\\"1", "\\"2"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await settleIndexedDbStorage();
    hook.unmount();

    const getItemStateCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    const getItemStateOperations = getItemStateCapture.finish().timelineString;

    expect(getItemStateOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection preload reads only the requested item entry data', async () => {
    const storeName = 'collection-opfs-efficiency';
    const sessionKey = 'sess1';
    const hotPayload = '1';
    const coldPayload = '2';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({
      initialState: {
        storeName,
        sessionKey,
        collection: [
          {
            payload: hotPayload,
            data: { value: { id: hotPayload, name: 'Hot' } },
          },
          {
            payload: coldPayload,
            data: { value: { id: coldPayload, name: 'Cold' } },
          },
        ],
      },
    });
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const hotKey = collectionScope.collection.itemStorageKey(hotPayload);
    const coldKey = collectionScope.collection.itemStorageKey(coldPayload);
    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","collection-opfs-efficiency","collection.item"] keys=["\\"1"] -> ["\\"1"]
      ""
    `);

    expect(mockAdapter.payloadGetRequests).toContain(hotKey);
    expect(mockAdapter.payloadGetRequests).not.toContain(coldKey);
  });

  test('useMultipleItems batches cold collection preloads through one namespace index read', async () => {
    const storeName = 'collection-opfs-batched-preload';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({
      initialState: {
        storeName,
        sessionKey,
        collection: [
          { payload: '1', data: { value: { id: '1', name: 'One' } } },
          { payload: '2', data: { value: { id: '2', name: 'Two' } } },
        ],
      },
    });
    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const preloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await advanceTime(250);
    await settleIndexedDbStorage();
    hook.unmount();

    const { timelineString } = preloadCapture.finish();
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`
      - - 'tsdf.sess1.collection-opfs-batched-preload.ci."1'
        - 'tsdf.sess1.collection-opfs-batched-preload.ci."2'
    `);
    expect(timelineString).toMatchInlineSnapshot(`
      ""
      2ms | 📖 entries.getMany scope=["sess1","collection-opfs-batched-preload","collection.item"] keys=["\\"1", "\\"2"] -> ["\\"1", "\\"2"]
      ""
    `);
  });

  test('protected snapshot reuse avoids rereading the async protected registry during eviction', async () => {
    const storeName = 'collection-opfs-protected-snapshot';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });

    await settleStartupBackgroundScan(mockAdapter);
    setProtectedKeysSnapshot(sessionKey, [
      collectionScope.collection.itemStorageKey('1'),
    ]);

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'One' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Two' } });
    await advanceTime(1100);
    await settleIndexedDbStorage();
    mockAdapter.clearInstrumentation();

    env.apiStore.addItemToState('3', { value: { id: '3', name: 'Three' } });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.listKeysRequests).toMatchInlineSnapshot(`[]`);
  });
});
