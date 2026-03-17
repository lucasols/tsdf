import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { localPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import { flushAllTimers } from '../../utils/genericTestUtils';
import {
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createDocumentEnv,
  flushInvalidationPersistence,
  persistentStore,
  setCachedDocumentData,
  settleStartupBackgroundScan,
  setupSyncStorageEfficiencyTestSuite,
} from './shared';

setupSyncStorageEfficiencyTestSuite();

describe('sync storage efficiency: document', () => {
  test('document hook remount stays fully in memory after the cached document is loaded at startup', async () => {
    const storeName = 'doc-remount-flow';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 7,
    });

    // Store creation should only queue the startup maintenance pass.
    const startupCapture = startPersistentStorageOperationCapture();
    const env = createDocumentEnv({ storeName, sessionKey });
    const startupOperations = startupCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup scan so this capture focuses only on hook mount behavior.
    await settleStartupBackgroundScan();

    // Document local-sync hydration happens during store initialization, so mount should not hit storage twice.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useDocument({
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { name: 'Cached document', value: 7 }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 ✅ #1 tsdf._m.r.s:sess1.doc-remount-flow.m (root, single, manifest) | 0.05 kb
      .    | 📖 ✅ #2 tsdf.sess1.doc-remount-flow (entry) | 0.18 kb
      2s   | 📖 ✅ #1 tsdf._m.r.s:sess1.doc-remount-flow.m (root, single, manifest) | 0.05 kb
      .    | ✍️ ✅->✅ #1 tsdf._m.r.s:sess1.doc-remount-flow.m (root, single, manifest) | 0.05 kb -> 0.05 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('direct store.state reads stay in memory once the document is hydrated', async () => {
    const storeName = 'doc-direct-state-read';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Hydrate once through the public hook, then measure direct synchronous reads only.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useDocument({ disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);
    hook.unmount();

    const readCapture = startPersistentStorageOperationCapture();
    expect(env.apiStore.store.state.data).toMatchInlineSnapshot(`
      value: { name: 'Cached document', value: 8 }
    `);
    expect(env.apiStore.store.state.data).toMatchInlineSnapshot(`
      value: { name: 'Cached document', value: 8 }
    `);
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('startup hydration touch preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-startup-touch-offline-marker';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    // Startup hydration schedules a touch to refresh the cached timestamp.
    const env = createDocumentEnv({ storeName, sessionKey });
    const storageKey = persistentStore
      .scope(storeName, sessionKey)
      .document.storageKey();
    const manifestKey =
      localPersistentStorage.getManifestKeyForSingle(storageKey);

    expect(env.store.state.data).toMatchInlineSnapshot(`
      value: { name: 'Cached document', value: 8 }
    `);

    // Simulate another tab marking the document as offline-protected before the touch runs.
    const currentManifest = getParsedLocalStorageValue<{
      e: Array<{ a: number; m?: unknown }>;
      v: number;
    }>(manifestKey);

    localStorage.setItem(
      manifestKey,
      JSON.stringify({
        ...currentManifest,
        e: currentManifest?.e.map((entry) => ({
          ...entry,
          m: {
            ...(typeof entry.m === 'object' && entry.m !== null ? entry.m : {}),
            o: true,
          },
        })),
      }),
    );

    await flushAllTimers();

    expect(
      localPersistentStorage.readSingleEntryMetadataByPayload(storageKey)?.meta,
    ).toMatchInlineSnapshot(`
      o: '✅'
    `);
    expect(getParsedLocalStorageValue(manifestKey)).toMatchInlineSnapshot(`
      e:
        - { a: 1735689602000, o: '✅' }
    `);
  });

  test('updating a hydrated document writes the mutation without rereading cached entries', async () => {
    const storeName = 'doc-mutation-flow';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Hydrate the cached document through a normal mounted hook first.
    await settleStartupBackgroundScan();
    renderHook(() => env.apiStore.useDocument({ disableRefetchOnMount: true }));
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated document should only need writes plus manifest maintenance.
    const mutationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.apiStore.updateState((draft) => {
        draft.value = { name: 'Edited document', value: 99 };
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .document.readData<{ value: { name: string; value: number } }>(),
    ).toMatchInlineSnapshot(`
      value: { name: 'Edited document', value: 99 }
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time |
      1s   | ✍️ ✅->✅ #1 tsdf.sess1.doc-mutation-flow (entry) | 0.18 kb -> 0.18 kb
      .    | 📖 ✅ #2 tsdf._m.r.s:sess1.doc-mutation-flow.m (root, single, manifest) | 0.05 kb
      .    | ✍️ ✅->✅ #2 tsdf._m.r.s:sess1.doc-mutation-flow.m (root, single, manifest) | 0.05 kb -> 0.05 kb
      "
    `);
  });

  test('useDocument invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'doc-invalidation-flow';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({ storeName, sessionKey });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useDocument({
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted hook, then capture fetch completion plus the debounced save.
    const invalidationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      value: { name: 'Fresh document', value: 42 }
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .document.readData<{ value: { name: string; value: number } }>(),
    ).toMatchInlineSnapshot(`
      value: { name: 'Fresh document', value: 42 }
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | ✍️ ✅->✅ #1 tsdf.sess1.doc-invalidation-flow (entry) | 0.18 kb -> 0.18 kb
      .     | 📖 ✅ #2 tsdf._m.r.s:sess1.doc-invalidation-flow.m (root, single, manifest) | 0.05 kb
      .     | ✍️ ✅->✅ #2 tsdf._m.r.s:sess1.doc-invalidation-flow.m (root, single, manifest) | 0.05 kb -> 0.05 kb
      "
    `);
  });

  test('document invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'doc-offline-marker-flow';
    const sessionKey = 'sess1';

    setCachedDocumentData(storeName, sessionKey, {
      name: 'Cached document',
      value: 8,
    });

    const env = createDocumentEnv({ storeName, sessionKey });
    const storageKey = persistentStore
      .scope(storeName, sessionKey)
      .document.storageKey();
    const manifestKey =
      localPersistentStorage.getManifestKeyForSingle(storageKey);

    // Hydrate cached data first so the later save is a normal invalidation write.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useDocument({
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking this document as offline-protected in the shared manifest.
    const currentManifest = getParsedLocalStorageValue<{
      e: Array<{ a: number; m?: unknown }>;
      v: number;
    }>(manifestKey);

    localStorage.setItem(
      manifestKey,
      JSON.stringify({
        ...currentManifest,
        e: currentManifest?.e.map((entry) => ({
          ...entry,
          m: {
            ...(typeof entry.m === 'object' && entry.m !== null ? entry.m : {}),
            o: true,
          },
        })),
      }),
    );

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.setServerData({ name: 'Fresh document', value: 42 });
      env.apiStore.invalidateData('highPriority');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      value: { name: 'Fresh document', value: 42 }
    `);
    expect(
      localPersistentStorage.readSingleEntryMetadataByPayload(storageKey)?.meta,
    ).toMatchInlineSnapshot(`
      o: '✅'
    `);
    expect(getParsedLocalStorageValue(manifestKey)).toMatchInlineSnapshot(`
      e:
        - { a: 1735689605910, o: '✅' }
    `);
  });
});
