import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { opfsPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedOpfsEntryFiles,
  startOpfsPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createDocumentEnv,
  flushInvalidationPersistence,
  markEntryOfflineProtected,
  readEntryMetadata,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
} from './shared';
import {
  advanceTime,
  flushAllTimers,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: document', () => {
  test('document hook remount stays fully in memory after the cached document is loaded at startup', async () => {
    const storeName = 'doc-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 7 },
    });

    // Store creation should only queue the startup maintenance pass.
    const startupCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );
    const env = createDocumentEnv({ storeName, sessionKey });
    const startupOperations = startupCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

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
      "
      simplified
      time   |
      3.004s | 📖 tsdf/sess1/doc-remount-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-remount-flow (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/doc-remount-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-remount-flow (metadata)) | 0.23 kb
      3.006s | end

      verbose
      time   |
      3s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.001s | 📂 dir-open ✅ tsdf/sess1/doc-remount-flow (store directory)
      3.002s | 📄 file-open ✅ tsdf/sess1/doc-remount-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-remount-flow (payload))
      .      | 📄 file-open ✅ tsdf/sess1/doc-remount-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-remount-flow (metadata))
      3.004s | 📖 tsdf/sess1/doc-remount-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-remount-flow (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/doc-remount-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-remount-flow (metadata)) | 0.23 kb
      3.006s | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.251s | 📖 tsdf/sess1/doc-remount-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-remount-flow (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/doc-remount-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-remount-flow (metadata)) | 0.23 kb
      3.253s | end

      verbose
      time   |
      3.251s | 📖 tsdf/sess1/doc-remount-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-remount-flow (payload)) | 0.10 kb
      .      | 📖 tsdf/sess1/doc-remount-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-remount-flow (metadata)) | 0.23 kb
      3.253s | end
      "
    `);
  });

  test('direct store.state reads with short gaps stay fully in memory once the document is hydrated', async () => {
    const storeName = 'doc-direct-state-read';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
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
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('startup hydration touch preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-startup-touch-offline-marker';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = documentScope.document.storageKey();

    documentScope.document.seed(
      { value: { name: 'Cached document', value: 8 } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createDocumentEnv({ storeName, sessionKey });

    // Preload the cached document so the async adapter schedules a timestamp touch.
    await settleStartupBackgroundScan(mockAdapter);
    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await resolveAfterAllTimers(preloadPromise);

    // Simulate another tab marking the document as offline-protected before the touch runs.
    markEntryOfflineProtected(mockAdapter, storageKey);
    await advanceTime(40);
    await flushAllTimers();

    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: { o: '✅' }
      key: 'document'
      lastAccessAt: 1735664400000
      payloadRef: '__tsdf_payload__:document'
      sizeBytes: 52
      version: 1
      writtenAt: 1735689604149
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, storageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { o: '✅' }
          key: 'document'
          lastAccessAt: 1735664400000
          sizeBytes: 52
          version: 1
          writtenAt: 1735689604149

        payload:
          d:
            value: { name: 'Cached document', value: 8 }
      `);
  });

  test('updating a hydrated document writes the mutation without rereading cached entries', async () => {
    const storeName = 'doc-mutation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = documentScope.document.storageKey();

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
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
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(documentScope.document.readData()).toMatchInlineSnapshot(
      `value: { name: 'Edited document', value: 99 }`,
    );
    expect(readEntryMetadata(mockAdapter, storageKey)).toMatchInlineSnapshot(`
      customMetadata: {}

      key: 'document'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:document'
      sizeBytes: 53
      version: 1
      writtenAt: 1735689605249
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      5.197s | 📖 tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata)) | 0.23 kb
      5.254s | ✍️ tsdf/sess1/doc-mutation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-mutation-flow (payload)) | 0.10 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata)) | 0.23 kb -> 0.23 kb
      5.256s | end

      verbose
      time   |
      5.197s | 📖 tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata)) | 0.23 kb
      5.249s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      5.25s  | 📁 dir-open-or-create ✅ tsdf/sess1/doc-mutation-flow (store directory)
      5.251s | 📄 file-open-or-create ✅ tsdf/sess1/doc-mutation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-mutation-flow (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata))
      5.254s | ✍️ tsdf/sess1/doc-mutation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-mutation-flow (payload)) | 0.10 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata)) | 0.23 kb -> 0.23 kb
      5.256s | end
      "
    `);
  });

  test('useDocument invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'doc-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
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
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(documentScope.document.readData()).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      6.007s | 📖 tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata)) | 0.23 kb
      6.064s | ✍️ tsdf/sess1/doc-invalidation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-invalidation-flow (payload)) | 0.10 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata)) | 0.23 kb -> 0.23 kb
      6.066s | end

      verbose
      time   |
      6.007s | 📖 tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata)) | 0.23 kb
      6.059s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      6.06s  | 📁 dir-open-or-create ✅ tsdf/sess1/doc-invalidation-flow (store directory)
      6.061s | 📄 file-open-or-create ✅ tsdf/sess1/doc-invalidation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-invalidation-flow (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata))
      6.064s | ✍️ tsdf/sess1/doc-invalidation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-invalidation-flow (payload)) | 0.10 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata)) | 0.23 kb -> 0.23 kb
      6.066s | end
      "
    `);
  });

  test('repeated invalidations within the debounce window coalesce document persistence writes', async () => {
    const storeName = 'doc-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
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
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 1', value: 41 }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

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
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 2', value: 42 }`,
    );
    expect(documentScope.document.readData()).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 2', value: 42 }`,
    );
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      6.907s | 📖 tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata)) | 0.23 kb
      6.964s | ✍️ tsdf/sess1/doc-coalesced-invalidations/d.e.p.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (payload)) | 0.10 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata)) | 0.23 kb -> 0.23 kb
      6.966s | end

      verbose
      time   |
      6.907s | 📖 tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata)) | 0.23 kb
      6.959s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      6.96s  | 📁 dir-open-or-create ✅ tsdf/sess1/doc-coalesced-invalidations (store directory)
      6.961s | 📄 file-open-or-create ✅ tsdf/sess1/doc-coalesced-invalidations/d.e.p.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata))
      6.964s | ✍️ tsdf/sess1/doc-coalesced-invalidations/d.e.p.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (payload)) | 0.10 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata)) | 0.23 kb -> 0.23 kb
      6.966s | end
      "
    `);
  });

  test('document invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({
      readDelayMs: 50,
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = documentScope.document.storageKey();

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
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
      customMetadata: { o: '✅' }
      key: 'document'
      lastAccessAt: 1735689600000
      payloadRef: '__tsdf_payload__:document'
      sizeBytes: 52
      version: 1
      writtenAt: 1735689606059
    `);
    expect(getParsedOpfsEntryFiles(mockAdapter, storageKey))
      .toMatchInlineSnapshot(`
        metadata:
          customMetadata: { o: '✅' }
          key: 'document'
          lastAccessAt: 1735689600000
          sizeBytes: 52
          version: 1
          writtenAt: 1735689606059

        payload:
          d:
            value: { name: 'Fresh document', value: 42 }
      `);
  });

  test('namespace commits coalesce and pending writes flush before reads', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    const entryPromise = namespace.get('document', { touch: 'never' });
    const entry = await resolveAfterAllTimers(entryPromise);
    await Promise.all([firstCommit, secondCommit]);

    expect(entry?.value).toMatchInlineSnapshot(`value: 'second'`);
    expect(
      mockAdapter.operations.flatMap((operation) =>
        operation.type === 'writeFile' && 'record' in operation
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
    `);
  });

  test('live async reads suppress redundant touch commits in the same recency bucket', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const namespace = opfsPersistentStorage.openNamespace<
      { value: string },
      Record<string, never>
    >({ sessionKey: 'sess1', storeName: 'touch-guard-opfs', kind: 'document' });

    const seedCommit = namespace.commit({
      upserts: [{ key: 'document', value: { value: 'cached' }, version: 1 }],
    });
    await resolveAfterAllTimers(seedCommit);
    mockAdapter.clearInstrumentation();
    await advanceTime(6 * 60 * 60 * 1000);

    const firstReadPromise = namespace.get('document', { touch: 'coarse' });
    const firstRead = await resolveAfterAllTimers(firstReadPromise);
    const secondRead = await resolveAfterAllTimers(
      namespace.get('document', { touch: 'coarse' }),
    );

    expect(firstRead?.value).toMatchInlineSnapshot(`value: 'cached'`);
    expect(secondRead?.value).toMatchInlineSnapshot(`value: 'cached'`);
    expect(
      mockAdapter.operations.flatMap((operation) =>
        operation.type === 'writeFile' && 'record' in operation
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
      initialState: {
        storeName,
        sessionKey,
        document: { data: { value: { name: 'cached', value: 1 } } },
      },
    });
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const env = createDocumentEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const readCapture = startOpfsPersistentStorageOperationCapture(
      mockAdapter,
      { storeName, sessionKey },
    );

    const preloadPromise = env.apiStore.preloadPersistentStorage();
    await resolveAfterAllTimers(preloadPromise);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      simplified
      time   |
      3.004s | 📖 tsdf/sess1/doc-opfs-efficiency/d.e.p.json
             |    └ (tsdf.sess1.doc-opfs-efficiency (payload)) | 0.08 kb
      .      | 📖 tsdf/sess1/doc-opfs-efficiency/d.e.m.json
             |    └ (tsdf.sess1.doc-opfs-efficiency (metadata)) | 0.23 kb
      3.056s | end

      verbose
      time   |
      3s     | 📂 dir-open ✅ tsdf/sess1 (session directory)
      3.001s | 📂 dir-open ✅ tsdf/sess1/doc-opfs-efficiency (store directory)
      3.002s | 📄 file-open ✅ tsdf/sess1/doc-opfs-efficiency/d.e.p.json
             |    └ (tsdf.sess1.doc-opfs-efficiency (payload))
      .      | 📄 file-open ✅ tsdf/sess1/doc-opfs-efficiency/d.e.m.json
             |    └ (tsdf.sess1.doc-opfs-efficiency (metadata))
      3.004s | 📖 tsdf/sess1/doc-opfs-efficiency/d.e.p.json
             |    └ (tsdf.sess1.doc-opfs-efficiency (payload)) | 0.08 kb
      .      | 📖 tsdf/sess1/doc-opfs-efficiency/d.e.m.json
             |    └ (tsdf.sess1.doc-opfs-efficiency (metadata)) | 0.23 kb
      3.056s | end
      "
    `);

    expect(mockAdapter.has(documentScope.document.storageKey())).toBe(true);
  });
});
