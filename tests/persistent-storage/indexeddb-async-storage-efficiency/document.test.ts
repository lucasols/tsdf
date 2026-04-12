import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { advanceTime } from '../../utils/genericTestUtils';
import {
  getIndexedDbStructureSnapshot,
  getParsedIndexedDbRecordData,
  startIndexedDbPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  captureHookRemount,
  createDocumentEnv,
  flushInvalidationPersistence,
  setProtectedKeysSnapshot,
  settleIndexedDbStorage,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function readDocumentEntryRow(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [args.sessionKey, args.storeName, 'document', 'document'],
    storeName: 'entries',
  });
}

describe('indexeddb async storage efficiency: document', () => {
  test('document hook remount skips the touch write when the cached document is still in the current recency bucket', async () => {
    const storeName = 'doc-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);

    // Seed with the current fake time so hydration should treat the entry as fresh
    // and skip the follow-up metadata touch.
    documentScope.document.seed({
      value: { name: 'Cached document', value: 7 },
    });

    // Store creation should only queue the startup maintenance pass.
    const startupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      ""
      1ms | 📖 entries.getMany scope=["sess1","doc-remount-flow","document"] keys=["document"] -> ["document"]
      1.046s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-remount-flow","document"] put=["document"] delete=[] touch=[]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);

    expect(await getIndexedDbStructureSnapshot(mockAdapter))
      .toMatchInlineSnapshot(`
        stores:
          - autoIncrement: '❌'
            indexes:
              - keyPath: ['i', 'g']
                multiEntry: '❌'
                name: 'byScopeGroup'
                unique: '❌'
              - keyPath: ['i', 'a']
                multiEntry: '❌'
                name: 'byScopeLastAccessAt'
                unique: '❌'
              - keyPath: ['i', 'o']
                multiEntry: '❌'
                name: 'byScopeOfflineProtected'
                unique: '❌'
            keyPath: null
            name: 'entries'
            rowCount: 1
            rows:
              - key: ['["sess1","doc-remount-flow","document"]', 'document']
                value: 'JSON object | 0.2 kb'
          - autoIncrement: '❌'
            indexes: []
            keyPath: 'k'
            name: 'meta'
            rowCount: 0
            rows: []
          - autoIncrement: '❌'
            indexes:
              - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
            keyPath: null
            name: 'namespacePolicies'
            rowCount: 1
            rows:
              - key: ['sess1', 'doc-remount-flow', 'document']
                value: 'JSON object | 0.0 kb'
        version: 1
      `);

    expect(await readDocumentEntryRow({ mockAdapter, sessionKey, storeName }))
      .toMatchInlineSnapshot(`
        a: 1735689600000

        d:
          value: { name: 'Cached document', value: 7 }

        i: '["sess1","doc-remount-flow","document"]'
      `);
  });

  test('document hook hydration does not skip the touch write once the cached document falls outside the current recency bucket', async () => {
    const storeName = 'doc-remount-stale-touch';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
      ""
      1ms | 📖 entries.getMany scope=["sess1","doc-remount-stale-touch","document"] keys=["document"] -> ["document"]
      47ms | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-remount-stale-touch","document"] put=[] delete=[] touch=["document"]
      1.046s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-remount-stale-touch","document"] put=["document"] delete=[] touch=[]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('document hook cache miss writes the fetched document once and remount stays fully in memory', async () => {
    const storeName = 'doc-remount-no-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();

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
      ""
      1ms | 📖 entries.getMany scope=["sess1","doc-remount-no-cache","document"] keys=["document"] -> []
      1.851s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-remount-no-cache","document"] put=["document"] delete=[] touch=[]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('direct store.state reads with short gaps stay fully in memory once the document is hydrated', async () => {
    const storeName = 'doc-direct-state-read';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

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
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const documentScope = mockAdapter.scope(storeName, sessionKey);
    const storageKey = documentScope.document.storageKey();

    documentScope.document.seed(
      { value: { name: 'Cached document', value: 8 } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createDocumentEnv({ storeName, sessionKey });

    // Simulate another tab marking the document as offline-protected before the touch runs.
    setProtectedKeysSnapshot(sessionKey, [storageKey]);

    // Mount the stale cached document so hydration schedules a metadata touch.
    await settleStartupBackgroundScan(mockAdapter);
    const touchCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useDocument({
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await advanceTime(250);
    await settleIndexedDbStorage();
    const operationsBreakdown = touchCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 8 }`,
    );
    expect(await readDocumentEntryRow({ mockAdapter, sessionKey, storeName }))
      .toMatchInlineSnapshot(`
        a: 1735689603001

        d:
          value: { name: 'Cached document', value: 8 }

        i: '["sess1","doc-startup-touch-offline-marker","document"]'
      `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","doc-startup-touch-offline-marker","document"] keys=["document"] -> ["document"]
      47ms | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-startup-touch-offline-marker","document"] put=[] delete=[] touch=["document"]
      1.046s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-startup-touch-offline-marker","document"] put=["document"] delete=[] touch=[]
      ""
    `);
  });

  test('updating a hydrated document writes the mutation without rereading cached entries', async () => {
    const storeName = 'doc-mutation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateState((draft) => {
        draft.value = { name: 'Edited document', value: 99 };
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(await readDocumentEntryRow({ mockAdapter, sessionKey, storeName }))
      .toMatchInlineSnapshot(`
        a: 1735689600000

        d:
          value: { name: 'Edited document', value: 99 }

        i: '["sess1","doc-mutation-flow","document"]'
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      ""
      1.045s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-mutation-flow","document"] put=["document"] delete=[] touch=[]
      ""
    `);
  });

  test('useDocument invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'doc-invalidation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(await readDocumentEntryRow({ mockAdapter, sessionKey, storeName }))
      .toMatchInlineSnapshot(`
        a: 1735689600000

        d:
          value: { name: 'Fresh document', value: 42 }

        i: '["sess1","doc-invalidation-flow","document"]'
      `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.855s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-invalidation-flow","document"] put=["document"] delete=[] touch=[]
      ""
    `);
  });

  test('repeated invalidations within the debounce window coalesce document persistence writes', async () => {
    const storeName = 'doc-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.setServerData({ name: 'Fresh document 2', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await advanceTime(1900);
    await settleIndexedDbStorage();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document 2', value: 42 }`,
    );
    expect(await readDocumentEntryRow({ mockAdapter, sessionKey, storeName }))
      .toMatchInlineSnapshot(`
        a: 1735689600000

        d:
          value: { name: 'Fresh document 2', value: 42 }

        i: '["sess1","doc-coalesced-invalidations","document"]'
      `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      ""
      1.85s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","doc-coalesced-invalidations","document"] put=["document"] delete=[] touch=[]
      ""
    `);
  });

  test('document invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
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
    setProtectedKeysSnapshot(sessionKey, [storageKey]);

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Fresh document', value: 42 }`,
    );
    expect(await readDocumentEntryRow({ mockAdapter, sessionKey, storeName }))
      .toMatchInlineSnapshot(`
        a: 1735689600000

        d:
          value: { name: 'Fresh document', value: 42 }

        i: '["sess1","doc-offline-marker-flow","document"]'
        o: 1
      `);
  });
});
