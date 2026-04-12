import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { getDefaultMaxBytesForScope } from '../../../src/persistentStorage/persistentStorageDefaults';
import { localPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import { TEST_INITIAL_TIME } from '../../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../../utils/genericTestUtils';
import {
  getLocalStorageTree,
  getParsedLocalStorageValue,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  captureHookRemount,
  createCollectionEnv,
  getLocalCollectionEntrySizeBytes,
  flushInvalidationPersistence,
  listStoredCollectionItemPayloads,
  persistentStore,
  setCachedCollectionItem,
  settleStartupBackgroundScan,
  sumPersistedEntryBytes,
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
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.collection-expiration.ci."expired-user
           |    └ (entry data, <"expired-user>)
      .    | 🔑[1] #3 ✅ tsdf._m.r.n:sess1.collection-expiration.ci.m
           |    └ (namespace index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.collection-expiration.ci."expired-user-2
           |    └ (entry data, <"expired-user-2>)
      .    | 🔑[3] #5 ✅ tsdf.sess1.collection-expiration.ci."fresh-user
           |    └ (entry data, <"fresh-user>)
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.collection-expiration.ci.m
           |    └ (namespace index) | 0.38 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.collection-expiration.ci."expired-user
           |    └ (entry data, <"expired-user>)
      .    | 🗑️ #4 ✅->❌ tsdf.sess1.collection-expiration.ci."expired-user-2
           |    └ (entry data, <"expired-user-2>)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:sess1.collection-expiration.ci.m
           |    └ (namespace index) | 0.38 kb -> 0.13 kb
      "
    `);

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.46 kb)
      ├ _m (0.24 kb)
      │ ├ g (0.04 kb)
      │ └ r.n:sess1.collection-expiration.ci.m (0.19 kb)
      └ sess1.collection-expiration.ci."fresh-user (0.22 kb)"
    `);

    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:sess1.collection-expiration.ci.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "fresh-user: { a: 1735689600000, p: 'fresh-user', z: 72 }
    `);

    expect(getParsedLocalStorageValue(freshItemKey)).toMatchInlineSnapshot(`
      d:
        value: { id: 'fresh-user', name: 'Fresh User' }

      p: 'fresh-user'
    `);
  });

  test('startup cleanup enforces maxBytes against preloaded persisted entries', async () => {
    const storeName = 'collection-startup-max-items';
    const sessionKey = 'sess1';
    const olderKeptItem = { value: { id: 'b', name: 'Older cached' } };
    const newestKeptItem = { value: { id: 'c', name: 'Newest cached' } };

    // Seed an over-limit cache so the startup maintenance pass has to trim it.
    setCachedCollectionItem(storeName, sessionKey, 'a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    setCachedCollectionItem(storeName, sessionKey, 'b', olderKeptItem);
    await advanceTime(100);
    setCachedCollectionItem(storeName, sessionKey, 'c', newestKeptItem);

    // Startup should only schedule the cleanup work.
    const startupOperationCapture = startPersistentStorageOperationCapture();
    createCollectionEnv({
      storeName,
      sessionKey,
      maxBytes: sumPersistedEntryBytes(
        getLocalCollectionEntrySizeBytes('b', olderKeptItem),
        getLocalCollectionEntrySizeBytes('c', newestKeptItem),
      ),
    });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted item.
    const readCapture = startPersistentStorageOperationCapture();
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredCollectionItemPayloads(storeName, sessionKey).sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      2s   | 📖 #1 ❌ tsdf._m.g (global maintenance)
      .    | 🔑[0] #2 ✅ tsdf.sess1.collection-startup-max-items.ci."a
           |    └ (entry data, <"a>)
      .    | 🔑[1] #3 ✅ tsdf._m.r.n:sess1.collection-startup-max-items.ci.m
           |    └ (namespace index)
      .    | 🔑[2] #4 ✅ tsdf.sess1.collection-startup-max-items.ci."b
           |    └ (entry data, <"b>)
      .    | 🔑[3] #5 ✅ tsdf.sess1.collection-startup-max-items.ci."c
           |    └ (entry data, <"c>)
      .    | 📖 #3 ✅ tsdf._m.r.n:sess1.collection-startup-max-items.ci.m
           |    └ (namespace index) | 0.25 kb
      .    | 🗑️ #2 ✅->❌ tsdf.sess1.collection-startup-max-items.ci."a
           |    └ (entry data, <"a>)
      .    | ✍️ #1 ❌->✅ tsdf._m.g (global maintenance) | ❌ -> 0.04 kb
      .    | ✍️ #3 ✅->✅ tsdf._m.r.n:sess1.collection-startup-max-items.ci.m
           |    └ (namespace index) | 0.25 kb -> 0.17 kb
      "
    `);
    expect(
      getParsedLocalStorageValue(
        'tsdf._m.r.n:sess1.collection-startup-max-items.ci.m',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "b: { a: 1735689600100, p: 'b', z: 56 }
        "c: { a: 1735689600200, p: 'c', z: 57 }
    `);
  });

  test('cold startup enforces the local-sync default collection maxBytes policy before the store mounts', async () => {
    const storeName = 'collection-cold-default-max-items-sync';
    const sessionKey = 'sess1';
    const collectionScope = persistentStore.scope(storeName, sessionKey);
    const defaultMaxBytes = getDefaultMaxBytesForScope({
      adapter: 'local-sync',
      scopeKind: 'collection.item',
    });
    const largeNameSuffix = 'x'.repeat(4_096);
    const getPayload = (index: number) =>
      `user-${String(index).padStart(4, '0')}`;
    const getItem = (index: number) => ({
      value: {
        id: getPayload(index),
        name: `${largeNameSuffix}-${getPayload(index)}`,
      },
    });
    const entrySizeBytes = getLocalCollectionEntrySizeBytes(
      getPayload(0),
      getItem(0),
    );
    const keptEntryCount = Math.floor(defaultMaxBytes / entrySizeBytes);
    const totalEntries = keptEntryCount + 1;

    for (let index = 0; index < totalEntries; index++) {
      collectionScope.collection.seedItem(getPayload(index), getItem(index), {
        timestamp: TEST_INITIAL_TIME.valueOf() + index,
      });
    }

    createCollectionEnv({ storeName, sessionKey });
    await waitForScheduledCleanup();

    const storedPayloads = listStoredCollectionItemPayloads(
      storeName,
      sessionKey,
    );

    expect(storedPayloads).toHaveLength(keptEntryCount);
    expect(storedPayloads).not.toContain(getPayload(0));
    expect(storedPayloads).toContain(getPayload(totalEntries - 1));
  });

  test('maxBytes cleanup snapshots the full manifest history', async () => {
    const oldestItem = { value: { id: 'a', name: 'Oldest cached' } };
    const newerItem = { value: { id: 'b', name: 'Newer cached' } };
    const freshItem = { value: { id: 'c', name: 'Fresh' } };

    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'a', oldestItem);
    await advanceTime(100);
    setCachedCollectionItem('col-max-items-metadata', 'sess1', 'b', newerItem);

    // Startup should only queue the background scan.
    const startupOperationCapture = startPersistentStorageOperationCapture();
    const env = createCollectionEnv({
      storeName: 'col-max-items-metadata',
      sessionKey: 'sess1',
      maxBytes: Math.max(
        sumPersistedEntryBytes(
          getLocalCollectionEntrySizeBytes('a', oldestItem),
          getLocalCollectionEntrySizeBytes('b', newerItem),
        ),
        sumPersistedEntryBytes(
          getLocalCollectionEntrySizeBytes('b', newerItem),
          getLocalCollectionEntrySizeBytes('c', freshItem),
        ),
      ),
    });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup-scheduled global scan before capturing the maxBytes flush.
    await settleStartupBackgroundScan();

    // Adding a third item should capture the write path plus the idle-scheduled cleanup sequence.
    const readCapture = startPersistentStorageOperationCapture();
    env.apiStore.addItemToState('c', freshItem);
    await advanceTime(1100);
    await flushAllTimers();
    await waitForScheduledCleanup();
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
      1s   | ✍️ #1 ❌->✅ tsdf.sess1.col-max-items-metadata.ci."c
           |    └ (entry data, <"c>) | ❌ -> 0.10 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m
           |    └ (namespace index) | 0.17 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m
           |    └ (namespace index) | 0.17 kb -> 0.25 kb
           ·
      3s   | 📖 #2 ✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m
           |    └ (namespace index) | 0.25 kb
      .    | 🗑️ #3 ✅->❌ tsdf.sess1.col-max-items-metadata.ci."a
           |    └ (entry data, <"a>)
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-max-items-metadata.ci.m
           |    └ (namespace index) | 0.25 kb -> 0.17 kb
      "
    `);

    expect(getLocalStorageTree()).toMatchInlineSnapshot(`
      "tsdf (0.56 kb)
      ├ _m (0.29 kb)
      │ ├ g (0.04 kb)
      │ └ r.n:sess1.col-max-items-metadata.ci.m (0.24 kb)
      └ sess1.col-max-items-metadata.ci (0.27 kb)
        ├ "b (0.11 kb)
        └ "c (0.10 kb)"
    `);
  });

  test('multiple overflowing collection updates before idle maintenance trigger a single cleanup pass', async () => {
    const oldestItem = { value: { id: 'a', name: 'Oldest cached' } };
    const newerItem = { value: { id: 'b', name: 'Newer cached' } };
    const thirdItem = { value: { id: 'c', name: 'Third' } };
    const fourthItem = { value: { id: 'd', name: 'Fourth' } };

    setCachedCollectionItem(
      'col-coalesced-maintenance',
      'sess1',
      'a',
      oldestItem,
    );
    await advanceTime(100);
    setCachedCollectionItem(
      'col-coalesced-maintenance',
      'sess1',
      'b',
      newerItem,
    );

    const env = createCollectionEnv({
      storeName: 'col-coalesced-maintenance',
      sessionKey: 'sess1',
      maxBytes: Math.max(
        sumPersistedEntryBytes(
          getLocalCollectionEntrySizeBytes('a', oldestItem),
          getLocalCollectionEntrySizeBytes('b', newerItem),
        ),
        sumPersistedEntryBytes(
          getLocalCollectionEntrySizeBytes('c', thirdItem),
          getLocalCollectionEntrySizeBytes('d', fourthItem),
        ),
      ),
    });

    // Drain the startup maintenance so the capture only covers the coalesced overflow path.
    await settleStartupBackgroundScan();

    const readCapture = startPersistentStorageOperationCapture();

    // First overflow schedules idle maintenance, but does not run it yet.
    env.apiStore.addItemToState('c', thirdItem);
    await advanceTime(1100);

    // A second overflow lands before the idle callback fires and should reuse that same cleanup.
    env.apiStore.addItemToState('d', fourthItem);
    await advanceTime(1100);

    // Advance just far enough to fire the already-scheduled idle maintenance once.
    await advanceTime(900);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      listStoredCollectionItemPayloads(
        'col-coalesced-maintenance',
        'sess1',
      ).sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      1s   | ✍️ #1 ❌->✅ tsdf.sess1.col-coalesced-maintenance.ci."c
           |    └ (entry data, <"c>) | ❌ -> 0.10 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.col-coalesced-maintenance.ci.m
           |    └ (namespace index) | 0.17 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-coalesced-maintenance.ci.m
           |    └ (namespace index) | 0.17 kb -> 0.25 kb
           ·
      2.1s | ✍️ #3 ❌->✅ tsdf.sess1.col-coalesced-maintenance.ci."d
           |    └ (entry data, <"d>) | ❌ -> 0.10 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.col-coalesced-maintenance.ci.m
           |    └ (namespace index) | 0.25 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-coalesced-maintenance.ci.m
           |    └ (namespace index) | 0.25 kb -> 0.33 kb
           ·
      3s   | 📖 #2 ✅ tsdf._m.r.n:sess1.col-coalesced-maintenance.ci.m
           |    └ (namespace index) | 0.33 kb
      .    | 🗑️ #4 ✅->❌ tsdf.sess1.col-coalesced-maintenance.ci."a
           |    └ (entry data, <"a>)
      .    | 🗑️ #5 ✅->❌ tsdf.sess1.col-coalesced-maintenance.ci."b
           |    └ (entry data, <"b>)
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-coalesced-maintenance.ci.m
           |    └ (namespace index) | 0.33 kb -> 0.17 kb
      "
    `);
  });

  test('direct getItemState reads the cached collection item multiple times with short gaps and promotes it once', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so this capture only measures the direct read path.
    await settleStartupBackgroundScan();

    // Repeated direct reads with short gaps should hydrate from storage once, then reuse in-memory state.
    const readCapture = startPersistentStorageOperationCapture();
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    await advanceTime(100);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    await advanceTime(100);
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(env.store.state[getCompositeKey('1')]?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time |
      0    | 📖 #1 ✅ tsdf._m.r.n:sess1.col-direct-get-item-state.ci.m
           |    └ (namespace index) | 0.09 kb
      .    | 📖 #2 ✅ tsdf.sess1.col-direct-get-item-state.ci."1
           |    └ (entry data, <"1>) | 0.11 kb
           ·
      2s   | 📖 #1 ✅ tsdf._m.r.n:sess1.col-direct-get-item-state.ci.m
           |    └ (namespace index) | 0.09 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.col-direct-get-item-state.ci.m
           |    └ (namespace index) | 0.09 kb -> 0.09 kb
      "
    `);
  });

  test('direct getItemState touch preserves an offline marker added by another tab before the batched manifest update', async () => {
    const storeName = 'col-direct-touch-offline-marker';
    const sessionKey = 'sess1';
    const storageKey = persistentStore
      .scope(storeName, sessionKey)
      .collection.itemStorageKey('1');
    const manifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.ci.`,
    );

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the later touch only comes from the direct read path.
    await settleStartupBackgroundScan();

    // The direct read schedules a batched timestamp touch for the cached item.
    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );

    // Simulate another tab marking the item as offline-protected before the touch runs.
    const currentManifest = getParsedLocalStorageValue<{
      e: Record<string, Record<string, unknown>>;
      v: number;
    }>(manifestKey);
    if (currentManifest === null) {
      throw new Error(`Missing localStorage manifest for ${manifestKey}`);
    }

    const entryKey = persistentStore
      .scope(storeName, sessionKey)
      .collection.itemKey('1');
    const currentEntry = currentManifest.e[entryKey];
    if (currentEntry === undefined) {
      throw new Error(`Missing collection manifest entry for ${manifestKey}`);
    }

    localStorage.setItem(
      manifestKey,
      JSON.stringify({
        ...currentManifest,
        e: { ...currentManifest.e, [entryKey]: { ...currentEntry, o: true } },
      }),
    );

    await flushAllTimers();

    expect(
      localPersistentStorage.readNamespaceEntryMetadataByPayload(
        storageKey,
        `tsdf.${sessionKey}.${storeName}.ci.`,
      )?.meta,
    ).toMatchInlineSnapshot(`
      o: '✅'
      p: '1'
    `);
    expect(getParsedLocalStorageValue(manifestKey)).toMatchInlineSnapshot(`
      e:
        "1: { a: 1735689604100, o: '✅', p: '1', z: 55 }
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
      1s   | ✍️ #1 ✅->✅ tsdf.sess1.col-mutation-flow.ci."1
           |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.col-mutation-flow.ci.m
           |    └ (namespace index) | 0.09 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-mutation-flow.ci.m
           |    └ (namespace index) | 0.09 kb -> 0.09 kb
           ·
      3s   | 📖 #2 ✅ tsdf._m.r.n:sess1.col-mutation-flow.ci.m
           |    └ (namespace index) | 0.09 kb
      "
    `);
  });

  test('deleteItemState removes the persisted collection entry through the namespace manifest only', async () => {
    const storeName = 'col-delete-flow';
    const sessionKey = 'sess1';
    const collectionScope = persistentStore.scope(storeName, sessionKey);
    const deletedItemStorageKey =
      collectionScope.collection.itemStorageKey('1');

    const env = createCollectionEnv({ storeName, sessionKey });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });
    await advanceTime(1100);
    await flushAllTimers();

    // The delete capture should only include the debounced storage cleanup path.
    const deleteCapture = startPersistentStorageOperationCapture();
    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await flushAllTimers();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(localStorage.getItem(deletedItemStorageKey)).toBeNull();
    expect(listStoredCollectionItemPayloads(storeName, sessionKey).sort())
      .toMatchInlineSnapshot(`
        ['2']
      `);
    expect(deleteOperations).toMatchInlineSnapshot(`
      "
      time |
      1s   | 🗑️ #1 ✅->❌ tsdf.sess1.col-delete-flow.ci."1 (entry data, <"1>)
      .    | 📖 #2 ✅ tsdf._m.r.n:sess1.col-delete-flow.ci.m
           |    └ (namespace index) | 0.17 kb
      .    | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-delete-flow.ci.m
           |    └ (namespace index) | 0.17 kb -> 0.09 kb
           ·
      3s   | 📖 #2 ✅ tsdf._m.r.n:sess1.col-delete-flow.ci.m
           |    └ (namespace index) | 0.09 kb
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
      1.81s | ✍️ #1 ✅->✅ tsdf.sess1.col-invalidation-flow.ci."1
            |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      .     | 📖 #2 ✅ tsdf._m.r.n:sess1.col-invalidation-flow.ci.m
            |    └ (namespace index) | 0.09 kb
      .     | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-invalidation-flow.ci.m
            |    └ (namespace index) | 0.09 kb -> 0.09 kb
            ·
      3.81s | 📖 #2 ✅ tsdf._m.r.n:sess1.col-invalidation-flow.ci.m
            |    └ (namespace index) | 0.09 kb
      "
    `);
  });

  test('collection invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'col-offline-marker-flow';
    const sessionKey = 'sess1';
    const collectionScope = persistentStore.scope(storeName, sessionKey);
    const storageKey = collectionScope.collection.itemStorageKey('1');
    const manifestKey = localPersistentStorage.getManifestKeyForPrefix(
      `tsdf.${sessionKey}.${storeName}.ci.`,
    );

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    // Hydrate cached data first so the later save is a normal invalidation write.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab marking this cached item as offline-protected in the shared manifest.
    const currentManifest = getParsedLocalStorageValue<{
      e: Record<string, Record<string, unknown>>;
      v: number;
    }>(manifestKey);
    if (currentManifest === null) {
      throw new Error(`Missing localStorage manifest for ${manifestKey}`);
    }

    const entryKey = persistentStore
      .scope(storeName, sessionKey)
      .collection.itemKey('1');
    const currentEntry = currentManifest.e[entryKey];
    if (currentEntry === undefined) {
      throw new Error(`Missing collection manifest entry for ${manifestKey}`);
    }

    localStorage.setItem(
      manifestKey,
      JSON.stringify({
        ...currentManifest,
        e: { ...currentManifest.e, [entryKey]: { ...currentEntry, o: true } },
      }),
    );

    // A normal invalidation save should keep the externally-added offline marker.
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fresh user' }
    `);
    expect(
      localPersistentStorage.readNamespaceEntryMetadataByPayload(
        storageKey,
        `tsdf.${sessionKey}.${storeName}.ci.`,
      )?.meta,
    ).toMatchInlineSnapshot(`
      o: '✅'
      p: '1'
    `);
    expect(getParsedLocalStorageValue(manifestKey)).toMatchInlineSnapshot(`
      e:
        "1: { a: 1735689605910, o: '✅', p: '1', z: 54 }
    `);
  });

  test('repeated invalidations within the debounce window coalesce collection persistence writes', async () => {
    const storeName = 'col-coalesced-invalidations';
    const sessionKey = 'sess1';

    setCachedCollectionItem(storeName, sessionKey, '1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user 1' } },
    });

    // Hydrate cached data first so only the invalidation writes are counted below.
    await settleStartupBackgroundScan();
    const hook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);

    // Let the first refetch finish, but stay inside the debounced persistence window.
    const firstInvalidationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 1' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(900);
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fresh user 1' }
    `);
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    // A second invalidation before the first debounce flush should replace the pending save.
    const secondInvalidationCapture = startPersistentStorageOperationCapture();
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 2' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1900);
    await flushAllTimers();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(hook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fresh user 2' }
    `);
    expect(
      persistentStore
        .scope(storeName, sessionKey)
        .collection.readItemData<{ value: { id: string; name: string } }>('1'),
    ).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fresh user 2' }
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      "
      time  |
      1.81s | ✍️ #1 ✅->✅ tsdf.sess1.col-coalesced-invalidations.ci."1
            |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      .     | 📖 #2 ✅ tsdf._m.r.n:sess1.col-coalesced-invalidations.ci.m
            |    └ (namespace index) | 0.09 kb
      .     | ✍️ #2 ✅->✅ tsdf._m.r.n:sess1.col-coalesced-invalidations.ci.m
            |    └ (namespace index) | 0.09 kb -> 0.09 kb
            ·
      3.81s | 📖 #2 ✅ tsdf._m.r.n:sess1.col-coalesced-invalidations.ci.m
            |    └ (namespace index) | 0.09 kb
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
      0    | 📖 #1 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m
           |    └ (namespace index) | 0.09 kb
      .    | 📖 #2 ✅ tsdf.sess1.col-remount-flow.ci."1
           |    └ (entry data, <"1>) | 0.11 kb
           ·
      2s   | 📖 #1 ✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m
           |    └ (namespace index) | 0.09 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.col-remount-flow.ci.m
           |    └ (namespace index) | 0.09 kb -> 0.09 kb
      "
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('collection hook cache miss writes the fetched item once and remount stays fully in memory', async () => {
    const storeName = 'col-remount-no-cache';
    const sessionKey = 'sess1';

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fetched user' } },
    });

    // Drain the startup scan so the capture focuses on the UI mount path only.
    await settleStartupBackgroundScan();

    // With no persisted item, the first mount should miss storage, fetch the
    // item, and write it once. The remount should then stay fully in memory.
    const { secondHook, firstMountOperations, remountOperations } =
      await captureHookRemount(() =>
        env.apiStore.useItem('1', {
          disableRefetchOnMount: true,
          returnRefetchingStatus: true,
        }),
      );

    expect(secondHook.result.current.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fetched user' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time  |
      0     | 📖 #1 ❌ tsdf._m.r.n:sess1.col-remount-no-cache.ci.m
            |    └ (namespace index)
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.col-remount-no-cache.ci.m
            |    └ (namespace index)
      .     | 📖 #1 ❌ tsdf._m.r.n:sess1.col-remount-no-cache.ci.m
            |    └ (namespace index)
            ·
      1.81s | 📖 #1 ❌ tsdf._m.r.n:sess1.col-remount-no-cache.ci.m
            |    └ (namespace index)
      .     | ✍️ #2 ❌->✅ tsdf.sess1.col-remount-no-cache.ci."1
            |    └ (entry data, <"1>) | ❌ -> 0.11 kb
      .     | ✍️ #1 ❌->✅ tsdf._m.r.n:sess1.col-remount-no-cache.ci.m
            |    └ (namespace index) | ❌ -> 0.09 kb
            ·
      3.81s | 📖 #1 ✅ tsdf._m.r.n:sess1.col-remount-no-cache.ci.m
            |    └ (namespace index) | 0.09 kb
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
      0    | 📖 #1 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m
           |    └ (namespace index) | 0.17 kb
      .    | 📖 #2 ✅ tsdf.sess1.col-multi-remount-flow.ci."1
           |    └ (entry data, <"1>) | 0.11 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m
           |    └ (namespace index) | 0.17 kb ⚠️ REPEATED READ <10ms UNCHANGED
      .    | 📖 #3 ✅ tsdf.sess1.col-multi-remount-flow.ci."2
           |    └ (entry data, <"2>) | 0.11 kb
           ·
      2s   | 📖 #1 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m
           |    └ (namespace index) | 0.17 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m
           |    └ (namespace index) | 0.17 kb -> 0.17 kb
      .    | 📖 #1 ✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m
           |    └ (namespace index) | 0.17 kb
      .    | ✍️ #1 ✅->✅ tsdf._m.r.n:sess1.col-multi-remount-flow.ci.m
           |    └ (namespace index) | 0.17 kb -> 0.17 kb
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
