import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { opfsPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import { startOpfsPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createDocumentEnv,
  documentStorageKey,
  flushInvalidationPersistence,
  isEmptyOperationSummary,
  markEntryOfflineProtected,
  readEntryMetadata,
  setCachedDocumentData,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
} from './shared';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: document', () => {
  test('document hook remount stays fully in memory after the cached document is loaded at startup', async () => {
    const storeName = 'doc-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
    });

    setCachedDocumentData(mockAdapter, storeName, sessionKey, {
      name: 'Cached document',
      value: 7,
    });

    // Store creation should only queue the startup maintenance pass.
    const startupCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    const env = createDocumentEnv({ storeName, sessionKey });
    const startupOperations = startupCapture.finish();

    expect(startupOperations).toMatchInlineSnapshot(`
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

    // Drain the startup scan so this capture focuses only on hook mount behavior.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached document from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useDocument({
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
        sessionKey,
        storeName,
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 7 }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads:
          - ['document payload']
        scopedPayloadReads: ['document payload']

      operations:
        - '📂 open ✅ tsdf/sess1/doc-remount-flow/document (scope directory)'
        - '📄 open ✅ tsdf/sess1/doc-remount-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-remount-flow (payload))'
        - '📄 open ✅ tsdf/sess1/doc-remount-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-remount-flow (metadata))'
        - '📖 tsdf/sess1/doc-remount-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-remount-flow (payload))'
        - '📖 tsdf/sess1/doc-remount-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-remount-flow (metadata))'
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads:
          - ['document payload']
        scopedPayloadReads: ['document payload']

      operations:
        - '📂 open ✅ tsdf/sess1/doc-remount-flow/document (scope directory)'
        - '📄 open ✅ tsdf/sess1/doc-remount-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-remount-flow (payload))'
        - '📄 open ✅ tsdf/sess1/doc-remount-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-remount-flow (metadata))'
        - '📖 tsdf/sess1/doc-remount-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-remount-flow (payload))'
        - '📖 tsdf/sess1/doc-remount-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-remount-flow (metadata))'
    `);
  });

  test('direct store.state reads with short gaps stay fully in memory once the document is hydrated', async () => {
    const storeName = 'doc-direct-state-read';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedDocumentData(mockAdapter, storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Hydrate once through the public hook, then measure repeated direct reads only.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useDocument({ disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);
    hook.unmount();

    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    // Repeated direct reads with small gaps should stay fully in memory.
    expect(env.apiStore.store.state.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 8 }`,
    );
    await advanceTime(100);
    expect(env.apiStore.store.state.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 8 }`,
    );
    await advanceTime(100);
    expect(env.apiStore.store.state.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 8 }`,
    );
    const operationsBreakdown = readCapture.finish();

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
    expect(isEmptyOperationSummary(operationsBreakdown)).toBe(true);
  });

  test('startup hydration touch preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-startup-touch-offline-marker';
    const sessionKey = 'sess1';
    const storageKey = documentStorageKey(storeName, sessionKey);
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    mockAdapter.setValue(storageKey, {
      data: { d: { value: { name: 'Cached document', value: 8 } } },
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
      version: 1,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Preload the cached document so the async adapter schedules a timestamp touch.
    await settleStartupBackgroundScan(mockAdapter);
    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await advanceTime(50);
    await preloadPromise;

    // Simulate another tab marking the document as offline-protected before the touch runs.
    markEntryOfflineProtected(mockAdapter, storageKey);
    await advanceTime(40);
    await flushAllTimers();

    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: {}

      key: 'document'
      lastAccessAt: 1735664400000
      payloadRef: '__tsdf_payload__:document'
      sizeBytes: 52
      version: 1
      writtenAt: 1735689604140
    `);
  });

  test('updating a hydrated document writes the mutation without rereading cached entries', async () => {
    const storeName = 'doc-mutation-flow';
    const sessionKey = 'sess1';
    const storageKey = documentStorageKey(storeName, sessionKey);
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedDocumentData(mockAdapter, storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Hydrate the cached document through a normal mounted hook first.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() => env.apiStore.useDocument({ disableRefetchOnMount: true }));
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated document should only need writes.
    const mutationCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    act(() => {
      env.apiStore.updateState((draft) => {
        draft.value = { name: 'Edited document', value: 99 };
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish();

    expect(mockAdapter.document.readData()).toMatchInlineSnapshot(
      `value: { name: 'Edited document', value: 99 }`,
    );
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: {}

      key: 'document'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:document'
      sizeBytes: 53
      version: 1
      writtenAt: 1735689605230
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/doc-mutation-flow/document (scope directory)'
        - '📄 open ✅ tsdf/sess1/doc-mutation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-mutation-flow (metadata))'
        - '📖 tsdf/sess1/doc-mutation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-mutation-flow (metadata))'
        - '📁 ensure ✅ tsdf/sess1/doc-mutation-flow/document (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/doc-mutation-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-mutation-flow (payload))'
        - '📄 ensure ✅ tsdf/sess1/doc-mutation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-mutation-flow (metadata))'
        - '✍️ tsdf/sess1/doc-mutation-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-mutation-flow (payload))'
        - '✍️ tsdf/sess1/doc-mutation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-mutation-flow (metadata))'
    `);
  });

  test('useDocument invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'doc-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedDocumentData(mockAdapter, storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({
      storeName,
      sessionKey,
      serverData: { name: 'Fresh document', value: 42 },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useDocument({
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
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(mockAdapter.document.readData()).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(invalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/doc-invalidation-flow/document (scope directory)'
        - '📄 open ✅ tsdf/sess1/doc-invalidation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-invalidation-flow (metadata))'
        - '📖 tsdf/sess1/doc-invalidation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-invalidation-flow (metadata))'
        - '📁 ensure ✅ tsdf/sess1/doc-invalidation-flow/document (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/doc-invalidation-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-invalidation-flow (payload))'
        - '📄 ensure ✅ tsdf/sess1/doc-invalidation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-invalidation-flow (metadata))'
        - '✍️ tsdf/sess1/doc-invalidation-flow/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-invalidation-flow (payload))'
        - '✍️ tsdf/sess1/doc-invalidation-flow/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-invalidation-flow (metadata))'
    `);
  });

  test('repeated invalidations within the debounce window coalesce document persistence writes', async () => {
    const storeName = 'doc-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedDocumentData(mockAdapter, storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({
      storeName,
      sessionKey,
      serverData: { name: 'Fresh document 1', value: 41 },
    });

    // Hydrate cached data first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useDocument({
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
      env.setServerData({ name: 'Fresh document 1', value: 41 });
      env.apiStore.invalidateData('highPriority');
    });
    await advanceTime(900);
    const firstInvalidationOperations = firstInvalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 1', value: 41 }`,
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
      env.setServerData({ name: 'Fresh document 2', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondInvalidationOperations = secondInvalidationCapture.finish();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 2', value: 42 }`,
    );
    expect(mockAdapter.document.readData()).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 2', value: 42 }`,
    );
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads: []
        scopedPayloadReads: []

      operations:
        - '📂 open ✅ tsdf/sess1/doc-coalesced-invalidations/document (scope directory)'
        - '📄 open ✅ tsdf/sess1/doc-coalesced-invalidations/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-coalesced-invalidations (metadata))'
        - '📖 tsdf/sess1/doc-coalesced-invalidations/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-coalesced-invalidations (metadata))'
        - '📁 ensure ✅ tsdf/sess1/doc-coalesced-invalidations/document (scope directory)'
        - '📄 ensure ✅ tsdf/sess1/doc-coalesced-invalidations/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-coalesced-invalidations (payload))'
        - '📄 ensure ✅ tsdf/sess1/doc-coalesced-invalidations/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-coalesced-invalidations (metadata))'
        - '✍️ tsdf/sess1/doc-coalesced-invalidations/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-coalesced-invalidations (payload))'
        - '✍️ tsdf/sess1/doc-coalesced-invalidations/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-coalesced-invalidations (metadata))'
    `);
  });

  test('document invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-offline-marker-flow';
    const sessionKey = 'sess1';
    const storageKey = documentStorageKey(storeName, sessionKey);
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName,
      sessionKey,
      readDelayMs: 50,
    });

    setCachedDocumentData(mockAdapter, storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({
      storeName,
      sessionKey,
      serverData: { name: 'Fresh document', value: 42 },
    });

    // Hydrate cached data first so the later save is a normal invalidation write.
    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useDocument({
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking this document as offline-protected.
    markEntryOfflineProtected(mockAdapter, storageKey);

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: {}

      key: 'document'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:document'
      sizeBytes: 52
      version: 1
      writtenAt: 1735689606040
    `);
  });

  test('namespace commits coalesce and pending writes flush before reads', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName: 'coalesced-opfs',
      sessionKey: 'sess1',
    });
    const namespace = opfsPersistentStorage.openNamespace<
      { value: string },
      Record<string, never>
    >({ sessionKey: 'sess1', storeName: 'coalesced-opfs', kind: 'document' });

    const firstCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'first' }, version: 1 }],
    });
    const secondCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'second' }, version: 1 }],
    });

    await advanceTime(39);
    expect(
      mockAdapter.operations.filter(
        (operation) => operation.type === 'writeFile',
      ),
    ).toMatchInlineSnapshot(`[]`);

    const entry = await namespace.get('document', { touch: 'never' });
    await Promise.all([firstCommit, secondCommit]);

    expect(entry?.value).toMatchInlineSnapshot(`value: 'second'`);
    expect(
      mockAdapter.operations.flatMap((operation) =>
        operation.type === 'writeFile'
          ? [
              {
                scope: operation.scope,
                key: operation.record.key,
                kind: operation.record.recordKind,
              },
            ]
          : [],
      ),
    ).toMatchInlineSnapshot(`
      - key: '__tsdf_payload__:document'
        kind: 'payload'
        scope: { kind: 'document', sessionKey: 'sess1', storeName: 'coalesced-opfs' }
      - key: '__tsdf_meta__:document'
        kind: 'metadata'
        scope: { kind: 'document', sessionKey: 'sess1', storeName: 'coalesced-opfs' }
      - key: 'registry'
        kind: 'internal'
        scope:
          kind: '__internal.protected'
          sessionKey: '__tsdf_async__'
          storeName: '__tsdf_async__'
    `);
  });

  test('live async reads suppress redundant touch commits in the same recency bucket', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore({
      storeName: 'touch-guard-opfs',
      sessionKey: 'sess1',
    });
    const namespace = opfsPersistentStorage.openNamespace<
      { value: string },
      Record<string, never>
    >({ sessionKey: 'sess1', storeName: 'touch-guard-opfs', kind: 'document' });

    const seedCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'cached' }, version: 1 }],
    });
    await advanceTime(40);
    await seedCommit;
    mockAdapter.clearInstrumentation();
    await advanceTime(6 * 60 * 60 * 1000);

    const firstReadPromise = namespace.get('document', { touch: 'coarse' });
    await advanceTime(40);
    const firstRead = await firstReadPromise;
    const secondRead = await namespace.get('document', { touch: 'coarse' });

    expect(firstRead?.value).toMatchInlineSnapshot(`value: 'cached'`);
    expect(secondRead?.value).toMatchInlineSnapshot(`value: 'cached'`);
    expect(
      mockAdapter.operations.flatMap((operation) =>
        operation.type === 'writeFile'
          ? [
              {
                scope: operation.scope,
                key: operation.record.key,
                kind: operation.record.recordKind,
              },
            ]
          : [],
      ),
    ).toMatchInlineSnapshot(`
      - key: '__tsdf_meta__:document'
        kind: 'metadata'
        scope: { kind: 'document', sessionKey: 'sess1', storeName: 'touch-guard-opfs' }
    `);
  });

  test('document preload performs one targeted payload read without metadata scans', async () => {
    const storeName = 'doc-opfs-efficiency';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
      storeName,
      sessionKey,
      initialState: {
        document: { data: { value: { name: 'cached', value: 1 } } },
      },
    });
    const env = createDocumentEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await advanceTime(50);
    await preloadPromise;

    expect(readCapture.finish()).toMatchInlineSnapshot(`
      breakdown:
        externalPayloadReads: []
        legacyFallbackReads: []
        listKeyScans: []
        metadataBatchReads:
          - ['document metadata']
        metadataReads: ['document metadata']
        payloadBatchReads:
          - ['document payload']
        scopedPayloadReads: ['document payload']

      operations:
        - '📂 open ✅ tsdf/sess1/doc-opfs-efficiency/document (scope directory)'
        - '📄 open ✅ tsdf/sess1/doc-opfs-efficiency/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-opfs-efficiency (payload))'
        - '📄 open ✅ tsdf/sess1/doc-opfs-efficiency/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-opfs-efficiency (metadata))'
        - '📖 tsdf/sess1/doc-opfs-efficiency/document/__tsdf_payload__%3Adocument.json (tsdf.sess1.doc-opfs-efficiency (payload))'
        - '📖 tsdf/sess1/doc-opfs-efficiency/document/__tsdf_meta__%3Adocument.json (tsdf.sess1.doc-opfs-efficiency (metadata))'
    `);

    expect(mockAdapter.has(documentStorageKey(storeName, sessionKey))).toBe(
      true,
    );
  });
});
