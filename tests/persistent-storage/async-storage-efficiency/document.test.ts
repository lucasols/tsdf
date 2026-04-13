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
  createDocumentEnv,
  flushInvalidationPersistence,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  syncEntriesOfflineProtectedFromSiblingTab,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

describe('async storage efficiency: document', () => {
  test('document hook remount skips the touch write when the cached document is still in the current recency bucket', async () => {
    const storeName = 'doc-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    // Seed with the current fake time so hydration should treat the entry as fresh
    // and skip the follow-up metadata touch.
    documentScope.document.seed({
      value: { name: 'Cached document', value: 7 },
    });

    // Store creation should only queue the startup maintenance pass.
    const startupCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const env = createDocumentEnv({ storeName, sessionKey });
    const startupOperations = startupCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup scan so this capture focuses only on hook mount behavior.
    await settleStartupBackgroundScan(mockAdapter);

    // The first mount must hydrate the cold cached document from persistence,
    // but because the entry is still in the current recency bucket no touch write
    // should be scheduled after the read completes.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useDocument({
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 7 }`,
    );
    // The snapshot ends after the initial entry data+metadata reads, which makes the
    // skipped touch explicit.
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/doc-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/doc-remount-flow/d._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/doc-remount-flow/d._i.r.json
           |    └ (namespace index) | 0.06 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/doc-remount-flow/d.e.p.json
           |    └ (entry data)
      7ms  | 📖 #2 tsdf/sess1/doc-remount-flow/d.e.p.json (entry data) | 0.09 kb
      10ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.30 kb)
      ├ sess1 (0.23 kb)
      │ └ doc-remount-flow (0.22 kb)
      │   ├ d._i.r.json (0.08 kb)
      │   └ d.e.p.json (0.11 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    expect(
      getParsedOpfsFileData('tsdf/sess1/doc-remount-flow/d.e.p.json'),
    ).toMatchInlineSnapshot(`value: { name: 'Cached document', value: 7 }`);

    expect(getParsedOpfsFileData('tsdf/sess1/doc-remount-flow/d._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          - a: 1735689600000
      `);
  });

  test('document hook hydration does not skip the touch write once the cached document falls outside the current recency bucket', async () => {
    const storeName = 'doc-remount-stale-touch';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed(
      { value: { name: 'Cached document', value: 9 } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createDocumentEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture isolates the mounted hydration flow.
    await settleStartupBackgroundScan(mockAdapter);

    // This entry is older than the current recency bucket, so hydration should
    // reread metadata and then write the touched timestamp back.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        render: () =>
          env.apiStore.useDocument({
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 9 }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/doc-remount-stale-touch (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/doc-remount-stale-touch/d._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/doc-remount-stale-touch/d._i.r.json
           |    └ (namespace index) | 0.06 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/doc-remount-stale-touch/d.e.p.json
           |    └ (entry data)
      7ms  | 📖 #2 tsdf/sess1/doc-remount-stale-touch/d.e.p.json
           |    └ (entry data) | 0.09 kb
           ·
      52ms | ✍️ #1 tsdf/sess1/doc-remount-stale-touch/d._i.r.json
           |    └ (namespace index) | 0.06 kb -> 0.06 kb
      54ms | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('document hook cache miss writes the fetched document once and remount stays fully in memory', async () => {
    const storeName = 'doc-remount-no-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();

    const env = createDocumentEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture isolates the mounted hydration flow.
    await settleStartupBackgroundScan(mockAdapter);

    // With no persisted document, the first mount should miss storage, fetch the
    // document, and write it once. The remount should then stay fully in memory.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount({
        mockAdapter,
        settleTimeMs: 4300,
        render: () =>
          env.apiStore.useDocument({
            disableRefetchOnMount: true,
            returnRefetchingStatus: true,
          }),
      });

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'test', value: 42 }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time   |
      0      | 📂 dir-open ❌ tsdf/sess1 (session directory)
             ·
      1.851s | 📂 dir-open ❌ tsdf/sess1 (session directory)
      1.852s | 📁 dir-open-or-create 🆕 tsdf/sess1 (session directory)
      1.853s | 📁 dir-open-or-create 🆕 tsdf/sess1/doc-remount-no-cache
             |    └ (store directory)
      1.854s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/doc-remount-no-cache/d.e.p.json
             |    └ (entry data)
      1.857s | ✍️ #1 tsdf/sess1/doc-remount-no-cache/d.e.p.json
             |    └ (entry data) | 0.00 kb -> 0.07 kb
      1.859s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/doc-remount-no-cache/d._i.r.json
             |    └ (namespace index)
      1.862s | ✍️ #2 tsdf/sess1/doc-remount-no-cache/d._i.r.json
             |    └ (namespace index) | 0.00 kb -> 0.06 kb
      1.864s | end
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('direct store.state reads with short gaps stay fully in memory once the document is hydrated', async () => {
    const storeName = 'doc-direct-state-read';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

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

  test('startup hydration touch preserves an offline marker added by another tab', async () => {
    const storeName = 'doc-startup-touch-offline-marker';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = documentScope.document.storageKey();

    const metadataPath =
      'tsdf/sess1/doc-startup-touch-offline-marker/d._i.r.json';
    const payloadPath =
      'tsdf/sess1/doc-startup-touch-offline-marker/d.e.p.json';

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
    await syncEntriesOfflineProtectedFromSiblingTab(sessionKey, [storageKey]);
    documentScope.document.setMetadata({
      a: Date.now() - 7 * 60 * 60 * 1000,
      o: true,
    });
    expect(getParsedOpfsFileData(metadataPath)).toMatchInlineSnapshot(`
      e:
        - { a: 1735664403022, o: '✅' }
    `);

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await advanceTime(40);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(getParsedOpfsFileData(metadataPath)).toMatchInlineSnapshot(`
      e:
        - { a: 1735689603010, o: '✅' }
    `);
    expect(getParsedOpfsFileData(payloadPath)).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 8 }`,
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      28ms   | 📖 #1 tsdf/sess1/doc-startup-touch-offline-marker/d._i.r.json
             |    └ (namespace index) | 0.08 kb
      33ms   | ✍️ #1 tsdf/sess1/doc-startup-touch-offline-marker/d._i.r.json
             |    └ (namespace index) | 0.08 kb -> 0.08 kb
             ·
      1.03s  | ✍️ #2 tsdf/sess1/doc-startup-touch-offline-marker/d.e.p.json
             |    └ (entry data) | 0.09 kb -> 0.09 kb ⚠️ UNCHANGED
      1.032s | end
      "
    `);
  });

  test('updating a hydrated document writes the mutation without rereading cached entries', async () => {
    const storeName = 'doc-mutation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Hydrate the cached document through a normal mounted hook first.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() => env.apiStore.useDocument({ disableRefetchOnMount: true }));
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated document should only need writes.
    const mutationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateState((draft) => {
        draft.value = { name: 'Edited document', value: 99 };
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      getParsedOpfsFileData('tsdf/sess1/doc-mutation-flow/d.e.p.json'),
    ).toMatchInlineSnapshot(`value: { name: 'Edited document', value: 99 }`);
    expect(getParsedOpfsFileData('tsdf/sess1/doc-mutation-flow/d._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          - a: 1735689600000
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.042s | ✍️ #1 tsdf/sess1/doc-mutation-flow/d.e.p.json
             |    └ (entry data) | 0.09 kb -> 0.09 kb
      1.044s | end
      "
    `);
  });

  test('useDocument invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'doc-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
    });

    const env = createDocumentEnv({ storeName, sessionKey });

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
    const invalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(
      getParsedOpfsFileData('tsdf/sess1/doc-invalidation-flow/d.e.p.json'),
    ).toMatchInlineSnapshot(`value: { name: 'Fresh document', value: 42 }`);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.852s | ✍️ #1 tsdf/sess1/doc-invalidation-flow/d.e.p.json
             |    └ (entry data) | 0.09 kb -> 0.09 kb
      1.854s | end
      "
    `);
  });

  test('repeated invalidations within the debounce window coalesce document persistence writes', async () => {
    const storeName = 'doc-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
    });

    const env = createDocumentEnv({ storeName, sessionKey });

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
    const firstInvalidationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/doc-coalesced-invalidations/d.e.p.json',
      ),
    ).toMatchInlineSnapshot(`value: { name: 'Fresh document 2', value: 42 }`);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.852s | ✍️ #1 tsdf/sess1/doc-coalesced-invalidations/d.e.p.json
             |    └ (entry data) | 0.09 kb -> 0.09 kb
      1.854s | end
      "
    `);
  });

  test('document invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore({});
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = documentScope.document.storageKey();

    documentScope.document.seed({
      value: { name: 'Cached document', value: 8 },
    });

    const env = createDocumentEnv({ storeName, sessionKey });

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
    await syncEntriesOfflineProtectedFromSiblingTab(sessionKey, [storageKey]);

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(
      getParsedOpfsFileData('tsdf/sess1/doc-offline-marker-flow/d._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        - { a: 1735689600000, o: '✅' }
    `);
    expect(
      getParsedOpfsFileData('tsdf/sess1/doc-offline-marker-flow/d.e.p.json'),
    ).toMatchInlineSnapshot(`value: { name: 'Fresh document', value: 42 }`);
  });
});
