import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getOpfsDirTree,
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createCollectionEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
  setProtectedKeysSnapshot,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: collection', () => {
  test('expiration cleanup removes expired items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-expiration';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    // Seed one expired item and one fresh item so cleanup has a meaningful choice.
    const expiredItemKey = collectionScope.collection.seedItem(
      'expired-user',
      { value: { id: 'expired-user', name: 'Expired User' } },
      { timestamp: expiredTimestamp },
    );
    const expiredItemKey2 = collectionScope.collection.seedItem(
      'expired-user-2',
      { value: { id: 'expired-user-2', name: 'Expired User 2' } },
      { timestamp: expiredTimestamp },
    );
    const freshItemKey = collectionScope.collection.seedItem('fresh-user', {
      value: { id: 'fresh-user', name: 'Fresh User' },
    });
    // Startup should only queue the background scan.
    const startupOperationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createCollectionEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the full metadata cleanup history.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: mockAdapter.has(expiredItemKey),
      expiredItem2Exists: mockAdapter.has(expiredItemKey2),
      freshItemExists: mockAdapter.has(freshItemKey),
    }).toMatchInlineSnapshot(`
      expiredItem2Exists: '❌'
      expiredItemExists: '❌'
      freshItemExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:collection-expiration"]
      2.004s | 🗂️ list-dir tsdf/sess1/collection-expiration
             |    └ (store directory) entries=["file:ci.%22expired-user-2.m.json","file:ci.%22expired-user-2.p.json","file:ci.%22expired-user.m.json","file:ci.%22expired-user.p.json","file:ci.%22fresh-user.m.json","file:ci.%22fresh-user.p.json"]
      2.005s | 📄 file-open ✅ #1 tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ ([itemKey: "expired-user], metadata)
      .      | 📄 file-open ✅ #2 tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ ([itemKey: "expired-user-2], metadata)
      .      | 📄 file-open ✅ #3 tsdf/sess1/collection-expiration/ci.%22fresh-user.m.json
             |    └ ([itemKey: "fresh-user], metadata)
      2.007s | 📖 #1 tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ ([itemKey: "expired-user], metadata) | 0.07 kb
      .      | 📖 #2 tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ ([itemKey: "expired-user-2], metadata) | 0.08 kb
      .      | 📖 #3 tsdf/sess1/collection-expiration/ci.%22fresh-user.m.json
             |    └ ([itemKey: "fresh-user], metadata) | 0.07 kb
      2.009s | 🗑️ ✅ #4 tsdf/sess1/collection-expiration/ci.%22expired-user.p.json
             |    └ ([itemKey: "expired-user], payload)
      .      | 🗑️ ✅ #1 tsdf/sess1/collection-expiration/ci.%22expired-user.m.json
             |    └ ([itemKey: "expired-user], metadata)
      .      | 🗑️ ✅ #5 tsdf/sess1/collection-expiration/ci.%22expired-user-2.p.json
             |    └ ([itemKey: "expired-user-2], payload)
      .      | 🗑️ ✅ #2 tsdf/sess1/collection-expiration/ci.%22expired-user-2.m.json
             |    └ ([itemKey: "expired-user-2], metadata)
      2.01s  | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.42 kb)
      ├ sess1 (0.35 kb)
      │ └ collection-expiration (0.34 kb)
      │   ├ ci.%22fresh-user.m.json (0.12 kb)
      │   └ ci.%22fresh-user.p.json (0.19 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/collection-expiration/ci.%22fresh-user.m.json',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689600000
      p: 'fresh-user'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/collection-expiration/ci.%22fresh-user.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: 'fresh-user', name: 'Fresh User' }

      p: 'fresh-user'
    `);
  });

  test('maxItems cleanup snapshots the full manifest history', async () => {
    const storeName = 'col-max-items-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    // Startup should only queue the background scan.
    const startupOperationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup-scheduled cleanup before capturing the maxItems flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Adding a third item should capture the write path plus the cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.001s | 📂 dir-open ✅ tsdf/sess1/col-max-items-metadata (store directory)
      1.002s | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json"]
      1.043s | 📄 file-open ❌ #1 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata)
      1.044s | 📄 file-open-or-create 🆕 #2 tsdf/sess1/col-max-items-metadata/ci.%22c.p.json
             |    └ ([itemKey: "c], payload)
      .      | 📄 file-open-or-create 🆕 #1 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata)
      1.047s | ✍️ #2 tsdf/sess1/col-max-items-metadata/ci.%22c.p.json
             |    └ ([itemKey: "c], payload) | 0.00 kb -> 0.10 kb
      .      | ✍️ #1 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata) | 0.00 kb -> 0.05 kb
      3.049s | 🗂️ list-dir tsdf/sess1/col-max-items-metadata
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json"]
      3.05s  | 📄 file-open ✅ #3 tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ ([itemKey: "a], metadata)
      .      | 📄 file-open ✅ #4 tsdf/sess1/col-max-items-metadata/ci.%22b.m.json
             |    └ ([itemKey: "b], metadata)
      3.051s | 📖 #1 tsdf/sess1/col-max-items-metadata/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata) | 0.05 kb
      3.052s | 📖 #3 tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ ([itemKey: "a], metadata) | 0.05 kb
      .      | 📖 #4 tsdf/sess1/col-max-items-metadata/ci.%22b.m.json
             |    └ ([itemKey: "b], metadata) | 0.05 kb
      3.094s | 🗑️ ✅ #5 tsdf/sess1/col-max-items-metadata/ci.%22a.p.json
             |    └ ([itemKey: "a], payload)
      .      | 🗑️ ✅ #3 tsdf/sess1/col-max-items-metadata/ci.%22a.m.json
             |    └ ([itemKey: "a], metadata)
      3.095s | 🧹 del-dir ❌ tsdf/sess1/col-max-items-metadata (store directory)
      3.096s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.54 kb)
      ├ sess1 (0.47 kb)
      │ └ col-max-items-metadata (0.46 kb)
      │   ├ ci.%22b.m.json (0.08 kb)
      │   ├ ci.%22b.p.json (0.14 kb)
      │   ├ ci.%22c.m.json (0.08 kb)
      │   └ ci.%22c.p.json (0.12 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
  });

  test('multiple overflowing collection updates before idle maintenance trigger a single cleanup pass', async () => {
    const storeName = 'col-coalesced-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });

    // Drain the startup maintenance so the capture only covers the coalesced overflow path.
    await settleStartupBackgroundScan(mockAdapter);

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    // First overflow schedules maintenance, but does not run it yet.
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Third' } });
    await advanceTime(1100);

    // A second overflow lands before cleanup fires and should reuse that same pass.
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fourth' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1.001s | 📂 dir-open ✅ tsdf/sess1/col-coalesced-maintenance (store directory)
      1.002s | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json"]
      1.043s | 📄 file-open ❌ #1 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata)
      1.044s | 📄 file-open-or-create 🆕 #2 tsdf/sess1/col-coalesced-maintenance/ci.%22c.p.json
             |    └ ([itemKey: "c], payload)
      .      | 📄 file-open-or-create 🆕 #1 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata)
      1.047s | ✍️ #2 tsdf/sess1/col-coalesced-maintenance/ci.%22c.p.json
             |    └ ([itemKey: "c], payload) | 0.00 kb -> 0.10 kb
      .      | ✍️ #1 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata) | 0.00 kb -> 0.05 kb
      2.14s  | 📄 file-open ❌ #3 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ ([itemKey: "d], metadata)
      2.141s | 📄 file-open-or-create 🆕 #4 tsdf/sess1/col-coalesced-maintenance/ci.%22d.p.json
             |    └ ([itemKey: "d], payload)
      .      | 📄 file-open-or-create 🆕 #3 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ ([itemKey: "d], metadata)
      2.144s | ✍️ #4 tsdf/sess1/col-coalesced-maintenance/ci.%22d.p.json
             |    └ ([itemKey: "d], payload) | 0.00 kb -> 0.10 kb
      .      | ✍️ #3 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ ([itemKey: "d], metadata) | 0.00 kb -> 0.05 kb
      3.049s | 🗂️ list-dir tsdf/sess1/col-coalesced-maintenance
             |    └ (store directory) entries=["file:ci.%22a.m.json","file:ci.%22a.p.json","file:ci.%22b.m.json","file:ci.%22b.p.json","file:ci.%22c.m.json","file:ci.%22c.p.json","file:ci.%22d.m.json","file:ci.%22d.p.json"]
      3.05s  | 📄 file-open ✅ #5 tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ ([itemKey: "a], metadata)
      .      | 📄 file-open ✅ #6 tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ ([itemKey: "b], metadata)
      3.051s | 📖 #1 tsdf/sess1/col-coalesced-maintenance/ci.%22c.m.json
             |    └ ([itemKey: "c], metadata) | 0.05 kb
      .      | 📖 #3 tsdf/sess1/col-coalesced-maintenance/ci.%22d.m.json
             |    └ ([itemKey: "d], metadata) | 0.05 kb
      3.052s | 📖 #5 tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ ([itemKey: "a], metadata) | 0.05 kb
      .      | 📖 #6 tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ ([itemKey: "b], metadata) | 0.05 kb
      3.094s | 🗑️ ✅ #7 tsdf/sess1/col-coalesced-maintenance/ci.%22b.p.json
             |    └ ([itemKey: "b], payload)
      .      | 🗑️ ✅ #6 tsdf/sess1/col-coalesced-maintenance/ci.%22b.m.json
             |    └ ([itemKey: "b], metadata)
      .      | 🗑️ ✅ #8 tsdf/sess1/col-coalesced-maintenance/ci.%22a.p.json
             |    └ ([itemKey: "a], payload)
      .      | 🗑️ ✅ #5 tsdf/sess1/col-coalesced-maintenance/ci.%22a.m.json
             |    └ ([itemKey: "a], metadata)
      3.095s | 🧹 del-dir ❌ tsdf/sess1/col-coalesced-maintenance (store directory)
      3.096s | end
      "
    `);
  });

  test('direct getItemState reads the cached collection item multiple times with short gaps and promotes it once', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read path.
    await settleStartupBackgroundScan(mockAdapter);

    // Repeated direct reads with short gaps should hydrate once, then reuse in-memory state.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );
    await advanceTime(100);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );
    await advanceTime(100);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(env.store.state).toMatchInlineSnapshot(`{}`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('direct getItemState touch preserves an offline marker added by another tab before the batched manifest update', async () => {
    const storeName = 'col-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = collectionScope.collection.itemStorageKey('1');

    collectionScope.collection.seedItem(
      '1',
      { value: { id: '1', name: 'Cached user' } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the later touch only comes from the direct read path.
    await settleStartupBackgroundScan(mockAdapter);

    // The direct read schedules a timestamp touch for the cached item.
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `undefined`,
    );

    // Simulate another tab marking the item as offline-protected before the touch runs.
    markEntryOfflineProtected(mockAdapter, storageKey);
    await advanceTime(40);
    await flushAllTimers();

    const metadataPath =
      'tsdf/sess1/col-direct-touch-offline-marker/ci.%221.m.json';
    const payloadPath =
      'tsdf/sess1/col-direct-touch-offline-marker/ci.%221.p.json';

    expect(getParsedOpfsFileData(metadataPath)).toMatchInlineSnapshot(`
      a: 1735664400000
      o: '✅'
      p: '1'
    `);
    expect(getParsedOpfsFileData(payloadPath)).toMatchInlineSnapshot(`
      d:
        value: { id: '1', name: 'Cached user' }

      p: '1'
    `);
  });

  test('updating a hydrated collection item writes the mutation without rereading cached entries', async () => {
    const storeName = 'col-mutation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item through a normal mounted hook first.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited user';
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(getParsedOpfsFileData('tsdf/sess1/col-mutation-flow/ci.%221.p.json'))
      .toMatchInlineSnapshot(`
        d:
          value: { id: '1', name: 'Edited user' }

        p: '1'
      `);
    expect(getParsedOpfsFileData('tsdf/sess1/col-mutation-flow/ci.%221.m.json'))
      .toMatchInlineSnapshot(`
        a: 1735689604050
        p: '1'
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 🗂️ list-dir tsdf/sess1/col-mutation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      1.042s | 📖 #1 tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.05 kb
      1.046s | ✍️ #2 tsdf/sess1/col-mutation-flow/ci.%221.p.json
             |    └ ([itemKey: "1], payload) | 0.11 kb -> 0.11 kb
      .      | ✍️ #1 tsdf/sess1/col-mutation-flow/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.05 kb -> 0.05 kb
      1.048s | end
      "
    `);
  });

  test('deleteItemState removes the persisted collection entry through the namespace manifest only', async () => {
    const storeName = 'col-delete-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const deletedItemStorageKey =
      collectionScope.collection.itemStorageKey('1');

    const env = createCollectionEnv({ storeName, sessionKey });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });
    await advanceTime(1100);
    await flushAllTimers();

    // The delete capture should only include the debounced storage cleanup path.
    const deleteCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['2']`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.04s  | 🗑️ ✅ #1 tsdf/sess1/col-delete-flow/ci.%221.p.json
             |    └ ([itemKey: "1], payload)
      .      | 🗑️ ✅ #2 tsdf/sess1/col-delete-flow/ci.%221.m.json
             |    └ ([itemKey: "1], metadata)
      1.041s | 🧹 del-dir ❌ tsdf/sess1/col-delete-flow (store directory)
      1.042s | end
      "
    `);
  });

  test('useItem invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'col-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted hook, then capture fetch completion plus the debounced save.
    const invalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(
      getParsedOpfsFileData('tsdf/sess1/col-invalidation-flow/ci.%221.p.json'),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: '1', name: 'Fresh user' }

      p: '1'
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 🗂️ list-dir tsdf/sess1/col-invalidation-flow
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      1.852s | 📖 #1 tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.05 kb
      1.856s | ✍️ #2 tsdf/sess1/col-invalidation-flow/ci.%221.p.json
             |    └ ([itemKey: "1], payload) | 0.11 kb -> 0.11 kb
      .      | ✍️ #1 tsdf/sess1/col-invalidation-flow/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.05 kb -> 0.05 kb
      1.858s | end
      "
    `);
  });

  test('collection invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'col-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    // Hydrate cached data first so the later save is a normal invalidation write.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking this cached item as offline-protected.
    markEntryOfflineProtected(mockAdapter, storageKey);

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-offline-marker-flow/ci.%221.m.json',
      ),
    ).toMatchInlineSnapshot(`
      a: 1735689604860
      o: '✅'
      p: '1'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-offline-marker-flow/ci.%221.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: '1', name: 'Fresh user' }

      p: '1'
    `);
  });

  test('repeated invalidations within the debounce window coalesce collection persistence writes', async () => {
    const storeName = 'col-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user 1' } },
    });

    // Hydrate cached data first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstInvalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 1' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(900);
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    // A second invalidation before the first debounce flush should replace the pending save.
    const secondInvalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 2' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-coalesced-invalidations/ci.%221.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: '1', name: 'Fresh user 2' }

      p: '1'
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.81s  | 🗂️ list-dir tsdf/sess1/col-coalesced-invalidations
             |    └ (store directory) entries=["file:ci.%221.m.json","file:ci.%221.p.json"]
      1.852s | 📖 #1 tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.05 kb
      1.856s | ✍️ #2 tsdf/sess1/col-coalesced-invalidations/ci.%221.p.json
             |    └ ([itemKey: "1], payload) | 0.11 kb -> 0.11 kb
      .      | ✍️ #1 tsdf/sess1/col-coalesced-invalidations/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.05 kb -> 0.05 kb
      1.858s | end
      "
    `);
  });

  test('hook remount skips the touch write when the cached collection item is still in the current recency bucket', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    // Seed with the current fake time so hydration should treat the entry as fresh
    // and skip the follow-up metadata touch.
    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the UI mount path only.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached item from persistence,
    // but because the entry is still in the current recency bucket no touch write
    // should be scheduled after the read completes.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
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
    // The snapshot ends after the initial payload+metadata reads, which makes the
    // skipped touch explicit.
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/col-remount-flow (store directory)
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/col-remount-flow/ci.%221.p.json
           |    └ ([itemKey: "1], payload)
      .    | 📄 file-open ✅ #2 tsdf/sess1/col-remount-flow/ci.%221.m.json
           |    └ ([itemKey: "1], metadata)
      4ms  | 📖 #1 tsdf/sess1/col-remount-flow/ci.%221.p.json
           |    └ ([itemKey: "1], payload) | 0.11 kb
      .    | 📖 #2 tsdf/sess1/col-remount-flow/ci.%221.m.json
           |    └ ([itemKey: "1], metadata) | 0.05 kb
      6ms  | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection hydration does not skip the touch write once the cached item falls outside the current recency bucket', async () => {
    const storeName = 'col-remount-stale-touch';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem(
      '1',
      { value: { id: '1', name: 'Cached user' } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture isolates the mounted hydration flow.
    await settleStartupBackgroundScan(mockAdapter);

    // This entry is older than the current recency bucket, so hydration should
    // reread metadata and then write the touched timestamp back.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
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
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/col-remount-stale-touch/ci.%221.p.json
           |    └ ([itemKey: "1], payload)
      .    | 📄 file-open ✅ #2 tsdf/sess1/col-remount-stale-touch/ci.%221.m.json
           |    └ ([itemKey: "1], metadata)
      4ms  | 📖 #1 tsdf/sess1/col-remount-stale-touch/ci.%221.p.json
           |    └ ([itemKey: "1], payload) | 0.11 kb
      .    | 📖 #2 tsdf/sess1/col-remount-stale-touch/ci.%221.m.json
           |    └ ([itemKey: "1], metadata) | 0.05 kb
      47ms | 📖 #2 tsdf/sess1/col-remount-stale-touch/ci.%221.m.json
           |    └ ([itemKey: "1], metadata) | 0.05 kb
      51ms | ✍️ #2 tsdf/sess1/col-remount-stale-touch/ci.%221.m.json
           |    └ ([itemKey: "1], metadata) | 0.05 kb -> 0.05 kb
      53ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection hook cache miss writes the fetched item once and remount stays fully in memory', async () => {
    const storeName = 'col-remount-no-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fetched user' } },
    });

    // Drain the startup scan so this capture isolates the mounted hydration flow.
    await settleStartupBackgroundScan(mockAdapter);

    // With no persisted item, the first mount should miss storage, fetch the
    // item, and write it once. The remount should then stay fully in memory.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        settleTimeMs: 2200,
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
      1.851s | 📁 dir-open-or-create 🆕 tsdf/sess1 (session directory)
      1.852s | 📁 dir-open-or-create 🆕 tsdf/sess1/col-remount-no-cache
             |    └ (store directory)
      1.853s | 📄 file-open-or-create 🆕 #1 tsdf/sess1/col-remount-no-cache/ci.%221.p.json
             |    └ ([itemKey: "1], payload)
      .      | 📄 file-open-or-create 🆕 #2 tsdf/sess1/col-remount-no-cache/ci.%221.m.json
             |    └ ([itemKey: "1], metadata)
      1.856s | ✍️ #1 tsdf/sess1/col-remount-no-cache/ci.%221.p.json
             |    └ ([itemKey: "1], payload) | 0.00 kb -> 0.11 kb
      .      | ✍️ #2 tsdf/sess1/col-remount-no-cache/ci.%221.m.json
             |    └ ([itemKey: "1], metadata) | 0.00 kb -> 0.05 kb
      1.858s | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    collectionScope.collection.seedItem('2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the hook mount path only.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
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
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/col-multi-remount-flow/ci.%221.p.json
           |    └ ([itemKey: "1], payload)
      .    | 📄 file-open ✅ #2 tsdf/sess1/col-multi-remount-flow/ci.%221.m.json
           |    └ ([itemKey: "1], metadata)
      .    | 📄 file-open ✅ #3 tsdf/sess1/col-multi-remount-flow/ci.%222.p.json
           |    └ ([itemKey: "2], payload)
      .    | 📄 file-open ✅ #4 tsdf/sess1/col-multi-remount-flow/ci.%222.m.json
           |    └ ([itemKey: "2], metadata)
      4ms  | 📖 #1 tsdf/sess1/col-multi-remount-flow/ci.%221.p.json
           |    └ ([itemKey: "1], payload) | 0.11 kb
      .    | 📖 #2 tsdf/sess1/col-multi-remount-flow/ci.%221.m.json
           |    └ ([itemKey: "1], metadata) | 0.05 kb
      .    | 📖 #3 tsdf/sess1/col-multi-remount-flow/ci.%222.p.json
           |    └ ([itemKey: "2], payload) | 0.11 kb
      .    | 📖 #4 tsdf/sess1/col-multi-remount-flow/ci.%222.m.json
           |    └ ([itemKey: "2], metadata) | 0.05 kb
      6ms  | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the item through a realistic UI mount first.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushAllTimers();
    hook.unmount();

    // Direct imperative reads should now hit the materialized store state only.
    const getItemStateCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    const getItemStateOperations = getItemStateCapture.finish().timelineString;

    expect(getItemStateOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection preload reads only the requested item payload', async () => {
    const storeName = 'collection-opfs-efficiency';
    const sessionKey = 'sess1';
    const hotPayload = '1';
    const coldPayload = '2';
    const mockAdapter = createOpfsPersistentStorageTestStore({
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
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await resolveAfterAllTimers(preloadPromise);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/collection-opfs-efficiency
           |    └ (store directory)
      2ms  | 📄 file-open ✅ #1 tsdf/sess1/collection-opfs-efficiency/ci.%221.p.json
           |    └ ([itemKey: "1], payload)
      .    | 📄 file-open ✅ #2 tsdf/sess1/collection-opfs-efficiency/ci.%221.m.json
           |    └ ([itemKey: "1], metadata)
      4ms  | 📖 #1 tsdf/sess1/collection-opfs-efficiency/ci.%221.p.json
           |    └ ([itemKey: "1], payload) | 0.09 kb
      .    | 📖 #2 tsdf/sess1/collection-opfs-efficiency/ci.%221.m.json
           |    └ ([itemKey: "1], metadata) | 0.05 kb
      6ms  | end
      "
    `);

    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(hotKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(coldKey);
  });

  test('protected snapshot reuse avoids rereading the async protected registry during eviction', async () => {
    const storeName = 'collection-opfs-protected-snapshot';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });

    await settleStartupBackgroundScan(mockAdapter);
    setProtectedKeysSnapshot(sessionKey, [
      collectionScope.collection.itemStorageKey('1'),
    ]);

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'One' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Two' } });
    await advanceTime(1100);
    await flushAllTimers();
    mockAdapter.clearInstrumentation();

    env.apiStore.addItemToState('3', { value: { id: '3', name: 'Three' } });
    await advanceTime(1100);
    await flushAllTimers();

    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.listKeysRequests).toMatchInlineSnapshot(`
      - kind: 'collection.item'
        sessionKey: 'sess1'
        storeName: 'collection-opfs-protected-snapshot'
    `);
  });
});
