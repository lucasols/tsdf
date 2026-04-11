import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { advanceTime } from '../../utils/genericTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  getParsedIndexedDbRecordData,
  startIndexedDbPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createCollectionEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
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
      1.813s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess-invalidation-flow","col-invalidation-flow","collection.item"]]
      1.817s | 📖 scope-state entries+namespacePolicies scope=["sess-invalidation-flow","col-invalidation-flow","collection.item"] -> keys=1 exists=yes valid=yes
      1.861s | ✍️ tx(entries, namespacePolicies).commit scope=["sess-invalidation-flow","col-invalidation-flow","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      1.864s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess-invalidation-flow","col-invalidation-flow","collection.item"]]
      1.868s | 📖 scope-state entries+namespacePolicies scope=["sess-invalidation-flow","col-invalidation-flow","collection.item"] -> keys=1 exists=yes valid=yes
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

    await markEntryOfflineProtected(mockAdapter, storageKey);

    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    await waitForIndexedDbCondition(() => {
      return env.apiStore.getItemState('1')?.data?.value?.name === 'Fresh user';
    });
    mountedHook.unmount();

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
      customMetadata:
        o: true
        p: '1'
      group: 'all'
      key: '"1'
      kind: 'collection.item'
      lastAccessAt: 1735689600000
      offlineProtected: 1
      sessionKey: 'sess1'
      storeName: 'col-offline-marker-flow'
      value:
        d:
          value: { id: '1', name: 'Fresh user' }
        p: '1'
      version: 1
    `);
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
    await advanceTime(900);
    await waitForIndexedDbCondition(() => {
      return env.apiStore.getItemState('1')?.data?.value?.name === 'Fresh user 1';
    });
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
      return env.apiStore.getItemState('1')?.data?.value?.name === 'Fresh user 2';
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
      customMetadata:
        p: '1'
      group: 'all'
      key: '"1'
      kind: 'collection.item'
      lastAccessAt: 1735689602805
      offlineProtected: 0
      sessionKey: 'sess1'
      storeName: 'col-coalesced-invalidations'
      value:
        d:
          value: { id: '1', name: 'Fresh user 2' }
        p: '1'
      version: 1
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.85s  | 📖 #1 tsdf/sess1/col-coalesced-invalidations/ci._i.r.json
             |    └ (namespace index) | 0.08 kb
      1.855s | ✍️ #2 tsdf/sess1/col-coalesced-invalidations/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      1.857s | end
      "
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

    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        isReady: (result) => result?.data?.value?.name === 'Cached user',
        mockAdapter,
        render: () =>
          env.apiStore.useItem('1', {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      253ms | 🗂️ scopes -> ["[\\"sess1\\",\\"col-remount-flow\\",\\"collection.item\\"]"]
      257ms | 📖 tsdf/sess1/col-remount-flow/ci._i.r.json keys=1 exists=yes valid=yes
      258ms | 📖 entries sess1/col-remount-flow/collection.item keys=["\\"1"] -> ["\\"1"]
      261ms | 🗂️ scopes -> ["[\\"sess1\\",\\"col-remount-flow\\",\\"collection.item\\"]"]
      265ms | 📖 tsdf/sess1/col-remount-flow/ci._i.r.json keys=1 exists=yes valid=yes
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
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

    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        isReady: (result) => result?.data?.value?.name === 'Cached user',
        mockAdapter,
        render: () =>
          env.apiStore.useItem('1', {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/col-remount-stale-touch (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index) | 0.08 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/col-remount-stale-touch/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      7ms  | 📖 #2 tsdf/sess1/col-remount-stale-touch/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.11 kb
           ·
      50ms | 📖 #1 tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index) | 0.08 kb
      55ms | ✍️ #1 tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index) | 0.08 kb -> 0.08 kb
      57ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection hook cache miss writes the fetched item once and remount stays fully in memory', async () => {
    const storeName = 'col-remount-no-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fetched user' } },
    });

    await settleStartupBackgroundScan(mockAdapter);

    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        isReady: (result) => result?.data?.value?.name === 'Fetched user',
        mockAdapter,
        settleTimeMs: 4300,
        render: () =>
          env.apiStore.useItem('1', {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fetched user' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time   |
      0      | 📂 dir-open ❌ tsdf/sess1 (session directory)
             ·
      1.851s | 📂 dir-open ❌ tsdf/sess1 (session directory) ⚠️ DUPLICATE OPEN
      1.852s | 📁 dir-open-or-create 🆕 tsdf/sess1
             |    └ (session directory) ⚠️ DUPLICATE OPEN
      1.853s | 📁 dir-open-or-create 🆕 tsdf/sess1/col-remount-no-cache
             |    └ (store directory)
      1.854s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/col-remount-no-cache/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
      1.857s | ✍️ #1 tsdf/sess1/col-remount-no-cache/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.00 kb -> 0.11 kb
      1.859s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/col-remount-no-cache/ci._i.r.json
             |    └ (namespace index)
      1.862s | ✍️ #2 tsdf/sess1/col-remount-no-cache/ci._i.r.json
             |    └ (namespace index) | 0.00 kb -> 0.08 kb
      1.864s | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
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

    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        isReady: (result) =>
          Array.isArray(result) &&
          result.every((item) => item?.data?.value != null),
        mockAdapter,
        render: () =>
          env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.map((item) => item.data?.value))
      .toMatchInlineSnapshot(`
        - { id: '1', name: 'Cached user 1' }
        - { id: '2', name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/col-multi-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/col-multi-remount-flow/ci._i.r.json
           |    └ (namespace index) | 0.15 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      .    | 👁️ #3 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.h~1409323532.p.json
           |    └ (entry data, <"2>)
      7ms  | 📖 #2 tsdf/sess1/col-multi-remount-flow/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.11 kb
      .    | 📖 #3 tsdf/sess1/col-multi-remount-flow/ci.h~1409323532.p.json
           |    └ (entry data, <"2>) | 0.11 kb
      10ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
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
      `undefined`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
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
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      4ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","collection-opfs-efficiency","collection.item"]]
      10ms | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-opfs-efficiency","collection.item"] -> keys=2 exists=yes valid=yes
      11ms | 📖 entries.getMany scope=["sess1","collection-opfs-efficiency","collection.item"] keys=["\\"1"] -> ["\\"1"]
      15ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","collection-opfs-efficiency","collection.item"]]
      21ms | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-opfs-efficiency","collection.item"] -> keys=2 exists=yes valid=yes
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
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`[]`);
    expect(timelineString).toMatchInlineSnapshot(`"empty"`);
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
