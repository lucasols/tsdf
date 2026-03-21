import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { createMockOpfsStorageAdapter } from '../../mocks/mockOpfsStorageAdapter';
import { startOpfsPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  collectionStorageKey,
  createCollectionEnv,
  flushInvalidationPersistence,
  isEmptyOperationSummary,
  listStoredCollectionItemPayloads,
  markEntryOfflineProtected,
  readEntryMetadata,
  registerAsyncNamespace,
  setCachedCollectionItem,
  setProtectedKeysSnapshot,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: collection', () => {
  test('expiration cleanup removes expired items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-expiration';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

    // Seed one expired item and one fresh item so cleanup has a meaningful choice.
    const expiredItemKey = setCachedCollectionItem(
      mockAdapter,
      storeName,
      sessionKey,
      'expired-user',
      { value: { id: 'expired-user', name: 'Expired User' } },
      expiredTimestamp,
    );
    const expiredItemKey2 = setCachedCollectionItem(
      mockAdapter,
      storeName,
      sessionKey,
      'expired-user-2',
      { value: { id: 'expired-user-2', name: 'Expired User 2' } },
      expiredTimestamp,
    );
    const freshItemKey = setCachedCollectionItem(
      mockAdapter,
      storeName,
      sessionKey,
      'fresh-user',
      { value: { id: 'fresh-user', name: 'Fresh User' } },
    );
    registerAsyncNamespace(mockAdapter, {
      sessionKey,
      storeName,
      kind: 'collection.item',
    });

    // Startup should only queue the background scan.
    const startupOperationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });
    const startupOperationBreakdown = startupOperationCapture.finish();

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);

    // Once the scan runs, capture the full metadata cleanup history.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish();

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
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/collection-expiration/collection.item'
          - 'sess1/collection-expiration/collection.item'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - - 'ci."expired-user (metadata)'
            - 'ci."expired-user-2 (metadata)'
            - 'ci."fresh-user (metadata)'
        metadataReads:
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'ci."expired-user (metadata)'
          - 'ci."expired-user-2 (metadata)'
          - 'ci."fresh-user (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '📖 ❌ <internal:record>'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📖 ✅ <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/collection-expiration/collection.item keys=["__tsdf_meta__:\\"expired-user","__tsdf_meta__:\\"expired-user-2","__tsdf_meta__:\\"fresh-user","__tsdf_payload__:\\"expired-user","__tsdf_payload__:\\"expired-user-2","__tsdf_payload__:\\"fresh-user"]'
        - '📚 sess1/collection-expiration/collection.item hits=3/3 ["ci.\\"expired-user (metadata)","ci.\\"expired-user-2 (metadata)","ci.\\"fresh-user (metadata)"]'
        - '🗑️ sess1/collection-expiration/collection.item ["ci.\\"expired-user (payload)","ci.\\"expired-user (metadata)","ci.\\"expired-user-2 (payload)","ci.\\"expired-user-2 (metadata)"]'
        - '🗂️ sess1/collection-expiration/collection.item keys=["__tsdf_meta__:\\"fresh-user","__tsdf_payload__:\\"fresh-user"]'
        - '📖 ✅ <internal:record>'
        - '📖 ✅ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
    `);
  });

  test('maxItems cleanup snapshots the full manifest history', async () => {
    const storeName = 'col-max-items-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem(mockAdapter, storeName, sessionKey, 'b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    // Startup should only queue the background scan.
    const startupOperationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    const env = createCollectionEnv({
      storeName,
      sessionKey,
      maxItems: 2,
      storageAdapter: mockAdapter.adapter,
    });
    const startupOperationBreakdown = startupOperationCapture.finish();

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);

    // Drain the startup-scheduled cleanup before capturing the maxItems flush.
    await settleStartupBackgroundScan(mockAdapter);

    // Adding a third item should capture the write path plus the cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredCollectionItemPayloads(
        mockAdapter,
        storeName,
        sessionKey,
      ).sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/col-max-items-metadata/collection.item'
          - 'sess1/col-max-items-metadata/collection.item'
          - 'sess1/col-max-items-metadata/collection.item'
        metadataBatchReads:
          - ['ci."c (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['ci."a (metadata)', 'ci."b (metadata)', 'ci."c (metadata)']
        metadataReads:
          - 'ci."c (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'ci."a (metadata)'
          - 'ci."b (metadata)'
          - 'ci."c (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/col-max-items-metadata/collection.item keys=["__tsdf_meta__:\\"a","__tsdf_meta__:\\"b","__tsdf_payload__:\\"a","__tsdf_payload__:\\"b"]'
        - '📚 sess1/col-max-items-metadata/collection.item hits=0/1 ["ci.\\"c (metadata)"]'
        - '✍️ sess1/col-max-items-metadata/collection.item ["ci.\\"c (payload)","ci.\\"c (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/col-max-items-metadata/collection.item keys=["__tsdf_meta__:\\"a","__tsdf_meta__:\\"b","__tsdf_meta__:\\"c","__tsdf_payload__:\\"a","__tsdf_payload__:\\"b","__tsdf_payload__:\\"c"]'
        - '📚 sess1/col-max-items-metadata/collection.item hits=3/3 ["ci.\\"a (metadata)","ci.\\"b (metadata)","ci.\\"c (metadata)"]'
        - '🗑️ sess1/col-max-items-metadata/collection.item ["ci.\\"a (payload)","ci.\\"a (metadata)"]'
        - '🗂️ sess1/col-max-items-metadata/collection.item keys=["__tsdf_meta__:\\"b","__tsdf_meta__:\\"c","__tsdf_payload__:\\"b","__tsdf_payload__:\\"c"]'
    `);
  });

  test('multiple overflowing collection updates before idle maintenance trigger a single cleanup pass', async () => {
    const storeName = 'col-coalesced-maintenance';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem(mockAdapter, storeName, sessionKey, 'b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      maxItems: 2,
      storageAdapter: mockAdapter.adapter,
    });

    // Drain the startup maintenance so the capture only covers the coalesced overflow path.
    await settleStartupBackgroundScan(mockAdapter);

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    // First overflow schedules maintenance, but does not run it yet.
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Third' } });
    await advanceTime(1100);

    // A second overflow lands before cleanup fires and should reuse that same pass.
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fourth' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish();

    expect(
      listStoredCollectionItemPayloads(
        mockAdapter,
        storeName,
        sessionKey,
      ).sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/col-coalesced-maintenance/collection.item'
          - 'sess1/col-coalesced-maintenance/collection.item'
          - 'sess1/col-coalesced-maintenance/collection.item'
        metadataBatchReads:
          - ['ci."c (metadata)']
          - ['ci."d (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['ci."a (metadata)', 'ci."b (metadata)', 'ci."c (metadata)', 'ci."d (metadata)']
        metadataReads:
          - 'ci."c (metadata)'
          - 'ci."d (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'ci."a (metadata)'
          - 'ci."b (metadata)'
          - 'ci."c (metadata)'
          - 'ci."d (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/col-coalesced-maintenance/collection.item keys=["__tsdf_meta__:\\"a","__tsdf_meta__:\\"b","__tsdf_payload__:\\"a","__tsdf_payload__:\\"b"]'
        - '📚 sess1/col-coalesced-maintenance/collection.item hits=0/1 ["ci.\\"c (metadata)"]'
        - '✍️ sess1/col-coalesced-maintenance/collection.item ["ci.\\"c (payload)","ci.\\"c (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/col-coalesced-maintenance/collection.item hits=0/1 ["ci.\\"d (metadata)"]'
        - '✍️ sess1/col-coalesced-maintenance/collection.item ["ci.\\"d (payload)","ci.\\"d (metadata)"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/col-coalesced-maintenance/collection.item keys=["__tsdf_meta__:\\"a","__tsdf_meta__:\\"b","__tsdf_meta__:\\"c","__tsdf_meta__:\\"d","__tsdf_payload__:\\"a","__tsdf_payload__:\\"b","__tsdf_payload__:\\"c","__tsdf_payload__:\\"d"]'
        - '📚 sess1/col-coalesced-maintenance/collection.item hits=4/4 ["ci.\\"a (metadata)","ci.\\"b (metadata)","ci.\\"c (metadata)","ci.\\"d (metadata)"]'
        - '🗑️ sess1/col-coalesced-maintenance/collection.item ["ci.\\"b (payload)","ci.\\"b (metadata)","ci.\\"a (payload)","ci.\\"a (metadata)"]'
        - '🗂️ sess1/col-coalesced-maintenance/collection.item keys=["__tsdf_meta__:\\"c","__tsdf_meta__:\\"d","__tsdf_payload__:\\"c","__tsdf_payload__:\\"d"]'
    `);
  });

  test('direct getItemState reads the cached collection item multiple times with short gaps and promotes it once', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    // Drain the startup scan so this capture only measures the direct read path.
    await settleStartupBackgroundScan(mockAdapter);

    // Repeated direct reads with short gaps should hydrate once, then reuse in-memory state.
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
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
    const operationsBreakdown = readCapture.finish();

    expect(env.store.state).toMatchInlineSnapshot(`{}`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
  });

  test('direct getItemState touch preserves an offline marker added by another tab before the batched manifest update', async () => {
    const storeName = 'col-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const storageKey = collectionStorageKey(storeName, sessionKey, '1');
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    mockAdapter.setValue(storageKey, {
      data: { d: { value: { id: '1', name: 'Cached user' } }, p: '1' },
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
      version: 1,
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

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

    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { o: '✅', p: '1' }
      key: '"1'
      lastAccessAt: 1735664400000
      payloadRef: '__tsdf_payload__:"1'
      sizeBytes: 55
      version: 1
      writtenAt: 1735664400000
    `);
  });

  test('updating a hydrated collection item writes the mutation without rereading cached entries', async () => {
    const storeName = 'col-mutation-flow';
    const sessionKey = 'sess1';
    const storageKey = collectionStorageKey(storeName, sessionKey, '1');
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    // Hydrate the cached item through a normal mounted hook first.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited user';
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish();

    expect(mockAdapter.collection.readItemData('1')).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Edited user' }`,
    );
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { p: '1' }
      key: '"1'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:"1'
      sizeBytes: 55
      version: 1
      writtenAt: 1735689604090
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/col-mutation-flow/collection.item'
          - 'sess1/col-mutation-flow/collection.item'
        metadataBatchReads:
          - ['ci."1 (metadata)']
          - ['ci."1 (metadata)']
        metadataReads: ['ci."1 (metadata)', 'ci."1 (metadata)']
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/col-mutation-flow/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_payload__:\\"1"]'
        - '📚 sess1/col-mutation-flow/collection.item hits=1/1 ["ci.\\"1 (metadata)"]'
        - '✍️ sess1/col-mutation-flow/collection.item ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '🗂️ sess1/col-mutation-flow/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_payload__:\\"1"]'
        - '📚 sess1/col-mutation-flow/collection.item hits=1/1 ["ci.\\"1 (metadata)"]'
    `);
  });

  test('deleteItemState removes the persisted collection entry through the namespace manifest only', async () => {
    const storeName = 'col-delete-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });
    const deletedItemStorageKey = collectionStorageKey(
      storeName,
      sessionKey,
      '1',
    );

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });
    await advanceTime(1100);
    await flushAllTimers();

    // The delete capture should only include the debounced storage cleanup path.
    const deleteCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish();

    expect(mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      listStoredCollectionItemPayloads(
        mockAdapter,
        storeName,
        sessionKey,
      ).sort(),
    ).toMatchInlineSnapshot(`['2']`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/col-delete-flow/collection.item'
          - 'sess1/col-delete-flow/collection.item'
        metadataBatchReads:
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['ci."2 (metadata)']
        metadataReads: ['tsdf.sess1._o_.p (protected registry metadata)', 'ci."2 (metadata)']
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗑️ sess1/col-delete-flow/collection.item ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
        - '🗂️ sess1/col-delete-flow/collection.item keys=["__tsdf_meta__:\\"2","__tsdf_payload__:\\"2"]'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/col-delete-flow/collection.item keys=["__tsdf_meta__:\\"2","__tsdf_payload__:\\"2"]'
        - '📚 sess1/col-delete-flow/collection.item hits=1/1 ["ci.\\"2 (metadata)"]'
    `);
  });

  test('useItem invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'col-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
      storageAdapter: mockAdapter.adapter,
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
    const invalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(mockAdapter.collection.readItemData('1')).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(invalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/col-invalidation-flow/collection.item'
          - 'sess1/col-invalidation-flow/collection.item'
        metadataBatchReads:
          - ['ci."1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['ci."1 (metadata)']
        metadataReads:
          - 'ci."1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'ci."1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/col-invalidation-flow/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_payload__:\\"1"]'
        - '📚 sess1/col-invalidation-flow/collection.item hits=1/1 ["ci.\\"1 (metadata)"]'
        - '✍️ sess1/col-invalidation-flow/collection.item ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/col-invalidation-flow/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_payload__:\\"1"]'
        - '📚 sess1/col-invalidation-flow/collection.item hits=1/1 ["ci.\\"1 (metadata)"]'
    `);
  });

  test('collection invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'col-offline-marker-flow';
    const sessionKey = 'sess1';
    const storageKey = collectionStorageKey(storeName, sessionKey, '1');
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
      storageAdapter: mockAdapter.adapter,
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
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { p: '1' }
      key: '"1'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:"1'
      sizeBytes: 54
      version: 1
      writtenAt: 1735689604900
    `);
  });

  test('repeated invalidations within the debounce window coalesce collection persistence writes', async () => {
    const storeName = 'col-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user 1' } },
      storageAdapter: mockAdapter.adapter,
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
    const firstInvalidationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 1' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(900);
    const firstInvalidationOperations = firstInvalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);

    // A second invalidation before the first debounce flush should replace the pending save.
    const secondInvalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter, {
        storeName,
        sessionKey,
      });
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 2' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondInvalidationOperations = secondInvalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(mockAdapter.collection.readItemData('1')).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: ['tsdf.sess1._o_.p (protected registry payload)']
        legacyFallbackReads: []
        listKeyScans:
          - 'sess1/col-coalesced-invalidations/collection.item'
          - 'sess1/col-coalesced-invalidations/collection.item'
        metadataBatchReads:
          - ['ci."1 (metadata)']
          - ['tsdf.sess1._o_.p (protected registry metadata)']
          - ['ci."1 (metadata)']
        metadataReads:
          - 'ci."1 (metadata)'
          - 'tsdf.sess1._o_.p (protected registry metadata)'
          - 'ci."1 (metadata)'
        payloadBatchReads:
          - ['tsdf.sess1._o_.p (protected registry payload)']
        scopedPayloadReads: []

      operations:
        - '🗂️ sess1/col-coalesced-invalidations/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_payload__:\\"1"]'
        - '📚 sess1/col-coalesced-invalidations/collection.item hits=1/1 ["ci.\\"1 (metadata)"]'
        - '✍️ sess1/col-coalesced-invalidations/collection.item ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
        - '📖 ❌ <internal:record>'
        - '✍️ __tsdf_async__/__tsdf_async__/__internal.protected <internal:record>'
        - '📚 sess1/_o_.p/document hits=0/2 ["tsdf.sess1._o_.p (protected registry payload)","tsdf.sess1._o_.p (protected registry metadata)"]'
        - '🗂️ sess1/col-coalesced-invalidations/collection.item keys=["__tsdf_meta__:\\"1","__tsdf_payload__:\\"1"]'
        - '📚 sess1/col-coalesced-invalidations/collection.item hits=1/1 ["ci.\\"1 (metadata)"]'
    `);
  });

  test('hook remount reuses hydrated collection state without touching localStorage again', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    // Drain the startup scan so the capture focuses on the UI mount path only.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useItem('1', {
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['ci."1 (metadata)']
        metadataReads: ['ci."1 (metadata)']
        payloadBatchReads:
          - ['ci."1 (payload)']
        scopedPayloadReads: ['ci."1 (payload)']

      operations:
        - '📚 sess1/col-remount-flow/collection.item hits=2/2 ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(remountOperations)).toBe(true);
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

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
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.map((item) => item.data?.value))
      .toMatchInlineSnapshot(`
        - { id: '1', name: 'Cached user 1' }
        - { id: '2', name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['ci."1 (metadata)']
          - ['ci."2 (metadata)']
        metadataReads: ['ci."1 (metadata)', 'ci."2 (metadata)']
        payloadBatchReads:
          - ['ci."1 (payload)']
          - ['ci."2 (payload)']
        scopedPayloadReads: ['ci."1 (payload)', 'ci."2 (payload)']

      operations:
        - '📚 sess1/col-multi-remount-flow/collection.item hits=2/2 ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
        - '📚 sess1/col-multi-remount-flow/collection.item hits=2/2 ["ci.\\"2 (payload)","ci.\\"2 (metadata)"]'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(remountOperations)).toBe(true);
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedCollectionItem(mockAdapter, storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    // Hydrate the item through a realistic UI mount first.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushAllTimers();
    hook.unmount();

    // Direct imperative reads should now hit the materialized store state only.
    const getItemStateCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    const getItemStateOperations = getItemStateCapture.finish();

    expect(getItemStateOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads: []
        metadataReads: []
        payloadBatchReads: []
        scopedPayloadReads: []

      operations: []
    `);
    expect(isEmptyOperationSummary(getItemStateOperations)).toBe(true);
  });

  test('collection preload reads only the requested item payload', async () => {
    const storeName = 'collection-opfs-efficiency';
    const sessionKey = 'sess1';
    const hotPayload = '1';
    const coldPayload = '2';
    const hotKey = collectionStorageKey(storeName, sessionKey, hotPayload);
    const coldKey = collectionStorageKey(storeName, sessionKey, coldPayload);
    const mockAdapter = createMockOpfsStorageAdapter({
      readDelayMs: 50,
      storeName,
      sessionKey,
      initialState: {
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
    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
    });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await advanceTime(50);
    await preloadPromise;

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['ci."1 (metadata)']
        metadataReads: ['ci."1 (metadata)']
        payloadBatchReads:
          - ['ci."1 (payload)']
        scopedPayloadReads: ['ci."1 (payload)']

      operations:
        - '📚 sess1/collection-opfs-efficiency/collection.item hits=2/2 ["ci.\\"1 (payload)","ci.\\"1 (metadata)"]'
    `);

    expect(mockAdapter.payloadGetManyRequests.flat()).toContain(hotKey);
    expect(mockAdapter.payloadGetManyRequests.flat()).not.toContain(coldKey);
  });

  test('protected snapshot reuse avoids rereading the async protected registry during eviction', async () => {
    const storeName = 'collection-opfs-protected-snapshot';
    const sessionKey = 'sess1';
    const mockAdapter = createMockOpfsStorageAdapter({ storeName, sessionKey });
    const env = createCollectionEnv({
      storeName,
      sessionKey,
      storageAdapter: mockAdapter.adapter,
      maxItems: 2,
    });

    await settleStartupBackgroundScan(mockAdapter);
    setProtectedKeysSnapshot(sessionKey, [
      collectionStorageKey(storeName, sessionKey, '1'),
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
