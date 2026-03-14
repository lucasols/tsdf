import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import { startPersistentStorageOperationCapture } from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createCollectionEnv,
  flushInvalidationPersistence,
  listStoredCollectionItemPayloads,
  persistentStore,
  setCachedCollectionItem,
  settleStartupBackgroundScan,
  setupSyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';

setupSyncStorageEfficiencyTestSuite();

describe('sync storage efficiency: collection', () => {
  test('expiration cleanup removes expired items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-expiration';
    const sessionKey = 'sess1';
    const collectionScope = persistentStore.scope(storeName, sessionKey);

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
    const startupOperationCapture = startPersistentStorageOperationCapture();
    createCollectionEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the full manifest and payload history.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: localStorage.getItem(expiredItemKey) !== null,
      expiredItem2Exists: localStorage.getItem(expiredItemKey2) !== null,
      freshItemExists: localStorage.getItem(freshItemKey) !== null,
    }).toMatchInlineSnapshot(`
      expiredItem2Exists: '❌'
      expiredItemExists: '❌'
      freshItemExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] ✅ tsdf.sess1.collection-expiration.ci."expired-user (entry)
      .    | 🔑[1] ✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest)
      .    | 🔑[2] ✅ tsdf.sess1.collection-expiration.ci."expired-user-2 (entry)
      .    | 🔑[3] ✅ tsdf.sess1.collection-expiration.ci."fresh-user (entry)
      .    | 📖 ✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest) | 0.59 kb
      .    | 📖 ✅ tsdf.sess1.collection-expiration.ci."expired-user (entry) | 0.26 kb
      .    | 🗑️ ✅->❌ tsdf.sess1.collection-expiration.ci."expired-user (entry)
      .    | 📖 ✅ tsdf.sess1.collection-expiration.ci."expired-user-2 (entry) | 0.27 kb
      .    | 🗑️ ✅->❌ tsdf.sess1.collection-expiration.ci."expired-user-2 (entry)
      .    | 📖 ✅ tsdf.sess1.collection-expiration.ci."fresh-user (entry) | 0.25 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.collection-expiration.ci.m (root, namespace, manifest) | 0.59 kb -> 0.22 kb
      .    | 📖 ❌ tsdf.sess1._o_.p (entry)
      .    | ✍️ ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.05 kb
      "
    `);
  });

  test('maxItems cleanup snapshots the full manifest history', async () => {
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'b', {
      value: { id: 'b', name: 'Newer cached' },
    });

    // Startup should only queue the background scan.
    const startupOperationCapture = startPersistentStorageOperationCapture();
    const env = createCollectionEnv({
      storeName: 'col-max-items-metadata',
      sessionKey: 'sess1',
      maxItems: 2,
    });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup-scheduled global scan before capturing the maxItems flush.
    await settleStartupBackgroundScan();

    // Adding a third item should capture the complete write and cleanup sequence.
    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredCollectionItemPayloads(
        'col-max-items-metadata',
        'sess1',
      ).sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      1s   | 📖 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb
      .    | ✍️ ❌->✅ tsdf.sess1.col-max-items-metadata.ci."c (entry) | ❌ -> 0.21 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.33 kb -> 0.46 kb
      .    | 🔑[0] ✅ tsdf.sess1.col-max-items-metadata.ci."a (entry)
      .    | 🔑[1] ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest)
      .    | 🔑[2] ✅ tsdf.sess1.col-max-items-metadata.ci."b (entry)
      .    | 🔑[3] ✅ tsdf._m.g (global maintenance)
      .    | 🔑[4] ✅ tsdf.sess1.col-max-items-metadata.ci."c (entry)
      .    | 📖 ✅ tsdf.sess1.col-max-items-metadata.ci."a (entry) | 0.22 kb
      .    | 📖 ✅ tsdf.sess1.col-max-items-metadata.ci."b (entry) | 0.22 kb
      .    | 📖 ❌ tsdf.sess1._o_.p (entry)
      .    | 🗑️ ✅->❌ tsdf.sess1.col-max-items-metadata.ci."a (entry)
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m (root, namespace, manifest) | 0.46 kb -> 0.33 kb
      "
    `);
  });

  test('direct getItemState reads the cached collection item once and promotes it into state', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read path.
    await settleStartupBackgroundScan();

    // The first direct read should hydrate from storage and the second one should reuse state.
    const readCapture = startPersistentStorageOperationCapture();
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(env.store.state[getCompositeKey('1')]?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 ✅ tsdf._m.r.n:sess1.col-direct-get-item-state.ci.m (root, namespace, manifest) | 0.19 kb
      .    | 📖 ✅ tsdf.sess1.col-direct-get-item-state.ci."1 (entry) | 0.22 kb
      "
    `);
  });

  test('updating a hydrated collection item writes the mutation without rereading cached entries', async () => {
    const storeName = 'col-mutation-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item through a normal mounted hook first.
    await settleStartupBackgroundScan();
    renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated item should only need writes plus manifest maintenance.
    const mutationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited user';
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .collection.readItemData<{ value: { id: string; name: string } }>('1'),
    ).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Edited user' }
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time |
      1s   | ✍️ ✅->✅ tsdf.sess1.col-mutation-flow.ci."1 (entry) | 0.22 kb -> 0.22 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.col-mutation-flow.ci.m (root, namespace, manifest) | 0.19 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-mutation-flow.ci.m (root, namespace, manifest) | 0.19 kb -> 0.19 kb
      "
    `);
  });

  test('useItem invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'col-invalidation-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    // Hydrate cached data first without a mount refetch so the invalidation path stays isolated.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Update the server copy, invalidate the mounted hook, then capture fetch completion plus the debounced save.
    const invalidationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fresh user' }
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .collection.readItemData<{ value: { id: string; name: string } }>('1'),
    ).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fresh user' }
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | ✍️ ✅->✅ tsdf.sess1.col-invalidation-flow.ci."1 (entry) | 0.22 kb -> 0.21 kb
      .     | 📖 ✅ tsdf._m.r.n:sess1.col-invalidation-flow.ci.m (root, namespace, manifest) | 0.19 kb
      .     | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-invalidation-flow.ci.m (root, namespace, manifest) | 0.19 kb -> 0.19 kb
      "
    `);
  });

  test('hook remount reuses hydrated collection state without touching localStorage again', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the UI mount path only.
    await settleStartupBackgroundScan();

    // The first mount must hydrate the cold cached item from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useItem('1', {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb
      .    | 📖 ✅ tsdf.sess1.col-remount-flow.ci."1 (entry) | 0.22 kb
      1s   | 📖 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb
      2s   | 📖 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m (root, namespace, manifest) | 0.19 kb -> 0.19 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    setCachedCollectionItem(storeName, sessionKey, '2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture focuses on the hook mount path only.
    await settleStartupBackgroundScan();

    // The first mount must hydrate both cold cached items from persistence.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.map((item) => item.data?.value))
      .toMatchInlineSnapshot(`
        - { id: '1', name: 'Cached user 1' }
        - { id: '2', name: 'Cached user 2' }
      `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb
      .    | 📖 ✅ tsdf.sess1.col-multi-remount-flow.ci."1 (entry) | 0.22 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb
      .    | 📖 ✅ tsdf.sess1.col-multi-remount-flow.ci."2 (entry) | 0.22 kb
      1s   | 📖 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb
      2s   | 📖 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb -> 0.33 kb
      .    | 📖 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb
      .    | ✍️ ✅->✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m (root, namespace, manifest) | 0.33 kb -> 0.33 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the item through a realistic UI mount first.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushAllTimers();
    hook.unmount();

    // Direct imperative reads should now hit the materialized store state only.
    const getItemStateCapture = startPersistentStorageOperationCapture();
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    const getItemStateOperations = getItemStateCapture.finish().timelineString;

    expect(getItemStateOperations).toMatchInlineSnapshot(`"empty"`);
  });
});
