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
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/doc-remount-flow (store directory)
      2ms  | 📄 file-open ✅ tsdf/sess1/doc-remount-flow/d.e.p.json
           |    └ (tsdf.sess1.doc-remount-flow (payload))
      .    | 📄 file-open ✅ tsdf/sess1/doc-remount-flow/d.e.m.json
           |    └ (tsdf.sess1.doc-remount-flow (metadata))
      4ms  | 📖 tsdf/sess1/doc-remount-flow/d.e.p.json
           |    └ (tsdf.sess1.doc-remount-flow (payload)) | 0.10 kb
      .    | 📖 tsdf/sess1/doc-remount-flow/d.e.m.json
           |    └ (tsdf.sess1.doc-remount-flow (metadata)) | 0.05 kb
      6ms  | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`
      "
      time |
      1ms  | 📖 tsdf/sess1/doc-remount-flow/d.e.p.json
           |    └ (tsdf.sess1.doc-remount-flow (payload)) | 0.10 kb
      .    | 📖 tsdf/sess1/doc-remount-flow/d.e.m.json
           |    └ (tsdf.sess1.doc-remount-flow (metadata)) | 0.05 kb
      3ms  | end
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
      lastAccessAt: 1735689604149
      payloadRef: '__tsdf_payload__:document'
      version: 1
      writtenAt: 1735689604149
    `);
    expect(
      getParsedOpfsEntryFiles(documentScope.document.namespace, 'document'),
    ).toMatchInlineSnapshot(`
      metadata: { a: 1735689604149, o: '✅', v: 1 }
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
      lastAccessAt: 1735689605249
      payloadRef: '__tsdf_payload__:document'
      version: 1
      writtenAt: 1735689605249
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.041s | 📖 tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata)) | 0.05 kb
      1.093s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.094s | 📁 dir-open-or-create ✅ tsdf/sess1/doc-mutation-flow (store directory)
      1.095s | 📄 file-open-or-create ✅ tsdf/sess1/doc-mutation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-mutation-flow (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata))
      1.098s | ✍️ tsdf/sess1/doc-mutation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-mutation-flow (payload)) | 0.10 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/doc-mutation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-mutation-flow (metadata)) | 0.05 kb -> 0.05 kb
      1.1s   | end
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
      time   |
      1.851s | 📖 tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata)) | 0.05 kb
      1.903s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.904s | 📁 dir-open-or-create ✅ tsdf/sess1/doc-invalidation-flow (store directory)
      1.905s | 📄 file-open-or-create ✅ tsdf/sess1/doc-invalidation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-invalidation-flow (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata))
      1.908s | ✍️ tsdf/sess1/doc-invalidation-flow/d.e.p.json
             |    └ (tsdf.sess1.doc-invalidation-flow (payload)) | 0.10 kb -> 0.10 kb
      .      | ✍️ tsdf/sess1/doc-invalidation-flow/d.e.m.json
             |    └ (tsdf.sess1.doc-invalidation-flow (metadata)) | 0.05 kb -> 0.05 kb
      1.91s  | end
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
      time   |
      1.851s | 📖 tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata)) | 0.05 kb
      1.903s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.904s | 📁 dir-open-or-create ✅ tsdf/sess1/doc-coalesced-invalidations (store directory)
      1.905s | 📄 file-open-or-create ✅ tsdf/sess1/doc-coalesced-invalidations/d.e.p.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (payload))
      .      | 📄 file-open-or-create ✅ tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata))
      1.908s | ✍️ tsdf/sess1/doc-coalesced-invalidations/d.e.p.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (payload)) | 0.10 kb -> 0.11 kb
      .      | ✍️ tsdf/sess1/doc-coalesced-invalidations/d.e.m.json
             |    └ (tsdf.sess1.doc-coalesced-invalidations (metadata)) | 0.05 kb -> 0.05 kb
      1.91s  | end
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
      lastAccessAt: 1735689606059
      payloadRef: '__tsdf_payload__:document'
      version: 1
      writtenAt: 1735689606059
    `);
    expect(
      getParsedOpfsEntryFiles(documentScope.document.namespace, 'document'),
    ).toMatchInlineSnapshot(`
      metadata: { a: 1735689606059, o: '✅', v: 1 }
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
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/doc-opfs-efficiency (store directory)
      2ms  | 📄 file-open ✅ tsdf/sess1/doc-opfs-efficiency/d.e.p.json
           |    └ (tsdf.sess1.doc-opfs-efficiency (payload))
      .    | 📄 file-open ✅ tsdf/sess1/doc-opfs-efficiency/d.e.m.json
           |    └ (tsdf.sess1.doc-opfs-efficiency (metadata))
      4ms  | 📖 tsdf/sess1/doc-opfs-efficiency/d.e.p.json
           |    └ (tsdf.sess1.doc-opfs-efficiency (payload)) | 0.08 kb
      .    | 📖 tsdf/sess1/doc-opfs-efficiency/d.e.m.json
           |    └ (tsdf.sess1.doc-opfs-efficiency (metadata)) | 0.05 kb
      56ms | end
      "
    `);

    expect(mockAdapter.has(documentScope.document.storageKey())).toBe(true);
  });
});
