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

async function getCollectionPayloadDeleteTarget(args: {
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}): Promise<{ fileName: string; storeDir: FileSystemDirectoryHandle }> {
  const fileName = args.mockAdapter.mockBrowserOpfs
    .listEntries(`tsdf/${args.sessionKey}/${args.storeName}`)
    .flatMap((entry) =>
      entry.startsWith('file:') && entry !== 'file:ci._i.r.json'
        ? [entry.slice('file:'.length)]
        : [],
    )[0];

  if (fileName === undefined) {
    throw new Error('Expected a persisted collection payload file.');
  }

  const rootDir = await resolveAfterAllTimers(navigator.storage.getDirectory());
  const tsdfDir = await resolveAfterAllTimers(
    rootDir.getDirectoryHandle('tsdf'),
  );
  const sessionDir = await resolveAfterAllTimers(
    tsdfDir.getDirectoryHandle(args.sessionKey),
  );
  const storeDir = await resolveAfterAllTimers(
    sessionDir.getDirectoryHandle(args.storeName),
  );

  return { fileName, storeDir };
}

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
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:collection-expiration"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/collection-expiration
             |    └ (store directory) entries=["file:ci._i.r.json","file:ci.h~135684128.p.json","file:ci.h~1699496642.p.json","file:ci.h~2755408287.p.json"]
      2.005s | 📖 #1 tsdf/sess1/collection-expiration/ci._i.r.json
             |    └ (namespace index) | 0.34 kb
      2.008s | 🗑️ #2 ✅ tsdf/sess1/collection-expiration/ci.h~2755408287.p.json
             |    └ (entry data, <"expired-user>)
      .      | 🗑️ #3 ✅ tsdf/sess1/collection-expiration/ci.h~1699496642.p.json
             |    └ (entry data, <"expired-user-2>)
      2.011s | ✍️ #1 tsdf/sess1/collection-expiration/ci._i.r.json
             |    └ (namespace index) | 0.34 kb -> 0.12 kb
      2.013s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.44 kb)
      ├ sess1 (0.37 kb)
      │ └ collection-expiration (0.36 kb)
      │   ├ ci._i.r.json (0.14 kb)
      │   └ ci.h~135684128.p.json (0.18 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);

    expect(
      getParsedOpfsFileData('tsdf/sess1/collection-expiration/ci._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "fresh-user: { a: 1735689600000, p: 'fresh-user' }
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/collection-expiration/ci.<"fresh-user>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: 'fresh-user', name: 'Fresh User' }

      p: 'fresh-user'
    `);
  });

  test('startup cleanup enforces maxItems against preloaded persisted entries', async () => {
    const storeName = 'collection-startup-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    // Seed an over-limit cache so the startup maintenance pass has to trim it.
    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Older cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('c', {
      value: { id: 'c', name: 'Newest cached' },
    });

    // Startup should only schedule the cleanup work.
    const startupOperationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createCollectionEnv({ storeName, sessionKey, maxItems: 2 });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted item.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      .      | 📂 dir-open ✅ tsdf/sess1 (session directory)
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:collection-startup-max-items"]
      .      | 📂 dir-open ✅ tsdf/sess1/collection-startup-max-items
             |    └ (store directory)
      2.004s | 🗂️ list-dir-entries tsdf/sess1/collection-startup-max-items
             |    └ (store directory) entries=["file:ci._i.r.json","file:ci.h~1374750182.p.json","file:ci.h~3986551515.p.json","file:ci.h~3994120284.p.json"]
      .      | 👁️ #1 file-open ✅ tsdf/sess1/collection-startup-max-items/ci._i.r.json
             |    └ (namespace index)
      2.005s | 📖 #1 tsdf/sess1/collection-startup-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb
      .      | 📖 #1 tsdf/sess1/collection-startup-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb ⚠️ REPEATED READ <10ms UNCHANGED
             ·
      2.048s | 📖 #1 tsdf/sess1/collection-startup-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb
      2.051s | 🗑️ #2 ✅ tsdf/sess1/collection-startup-max-items/ci.h~3986551515.p.json
             |    └ (entry data, <"a>)
      2.054s | ✍️ #1 tsdf/sess1/collection-startup-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb -> 0.15 kb
      2.056s | end
      "
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/collection-startup-max-items/ci._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "b: { a: 1735689600100, p: 'b' }
        "c: { a: 1735689600200, p: 'c' }
    `);
  });

  test('maxItems cleanup snapshots the full manifest history when one flush deletes multiple items', async () => {
    const storeName = 'col-max-items-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('a', {
      value: { id: 'a', name: 'Oldest cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Older cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('c', {
      value: { id: 'c', name: 'Newer cached' },
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

    // Adding a fourth item should capture one write plus a two-item cleanup sequence.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fresh' } });
    await advanceTime(1100);
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📖 #1 tsdf/sess1/col-max-items-metadata/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
             ·
      1.043s | 📖 #1 tsdf/sess1/col-max-items-metadata/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
      1.046s | 🗑️ #2 ✅ tsdf/sess1/col-max-items-metadata/ci.h~1374750182.p.json
             |    └ (entry data, <"b>)
      .      | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/col-max-items-metadata/ci.h~2103001283.p.json
             |    └ (entry data, <"d>)
      1.049s | ✍️ #3 tsdf/sess1/col-max-items-metadata/ci.h~2103001283.p.json
             |    └ (entry data, <"d>) | 0.00 kb -> 0.10 kb
      1.053s | ✍️ #1 tsdf/sess1/col-max-items-metadata/ci._i.r.json
             |    └ (namespace index) | 0.15 kb -> 0.15 kb
      1.055s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.58 kb)
      ├ sess1 (0.51 kb)
      │ └ col-max-items-metadata (0.50 kb)
      │   ├ ci._i.r.json (0.17 kb)
      │   ├ ci.h~2103001283.p.json (0.14 kb)
      │   └ ci.h~3994120284.p.json (0.15 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
  });

  test('maxItems-triggered flush also prunes expired persisted items', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'col-expired-during-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 3 });

    // Drain startup cleanup first so the later expiration removal is attributable to the maxItems path.
    await settleStartupBackgroundScan(mockAdapter);

    collectionScope.collection.seedItem(
      'a',
      { value: { id: 'a', name: 'Expired oldest' } },
      { timestamp: expiredTimestamp },
    );
    await advanceTime(100);
    collectionScope.collection.seedItem(
      'b',
      { value: { id: 'b', name: 'Expired newer' } },
      { timestamp: expiredTimestamp },
    );
    await advanceTime(100);
    collectionScope.collection.seedItem('c', {
      value: { id: 'c', name: 'Fresh cached' },
    });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fresh' } });
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
      1.001s | 📂 dir-open ✅ tsdf/sess1/col-expired-during-max-items
             |    └ (store directory)
      1.002s | 👁️ #1 file-open ✅ tsdf/sess1/col-expired-during-max-items/ci._i.r.json
             |    └ (namespace index)
      1.003s | 📖 #1 tsdf/sess1/col-expired-during-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb
             ·
      1.046s | 📖 #1 tsdf/sess1/col-expired-during-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb
      1.049s | 🗑️ #2 ✅ tsdf/sess1/col-expired-during-max-items/ci.h~3986551515.p.json
             |    └ (entry data, <"a>)
      .      | 🗑️ #3 ✅ tsdf/sess1/col-expired-during-max-items/ci.h~1374750182.p.json
             |    └ (entry data, <"b>)
      .      | 👁️ #4 file-open-or-create 🆕 tsdf/sess1/col-expired-during-max-items/ci.h~2103001283.p.json
             |    └ (entry data, <"d>)
      1.052s | ✍️ #4 tsdf/sess1/col-expired-during-max-items/ci.h~2103001283.p.json
             |    └ (entry data, <"d>) | 0.00 kb -> 0.10 kb
      1.056s | ✍️ #1 tsdf/sess1/col-expired-during-max-items/ci._i.r.json
             |    └ (namespace index) | 0.21 kb -> 0.15 kb
      1.058s | end
      "
    `);
  });

  test('repeated overflowing collection updates evict inline without scheduling background maintenance', async () => {
    const storeName = 'col-inline-overflow-cleanup';
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

    // Drain the startup maintenance so the capture only covers the repeated inline overflow path.
    await settleStartupBackgroundScan(mockAdapter);

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);

    // The first overflow should evict the oldest cached item in the same debounced commit.
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Third' } });
    await advanceTime(1100);

    // A later overflow should do the same thing again instead of relying on idle cleanup.
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fourth' } });
    await advanceTime(1100);
    // Drain every pending timer; if background maintenance were scheduled, it would show up here.
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      collectionScope.collection.listStoredPayloads().sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      1s     | 📖 #1 tsdf/sess1/col-inline-overflow-cleanup/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
             ·
      1.043s | 📖 #1 tsdf/sess1/col-inline-overflow-cleanup/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
      1.046s | 🗑️ #2 ✅ tsdf/sess1/col-inline-overflow-cleanup/ci.h~3986551515.p.json
             |    └ (entry data, <"a>)
      .      | 👁️ #3 file-open-or-create 🆕 tsdf/sess1/col-inline-overflow-cleanup/ci.h~3994120284.p.json
             |    └ (entry data, <"c>)
      1.049s | ✍️ #3 tsdf/sess1/col-inline-overflow-cleanup/ci.h~3994120284.p.json
             |    └ (entry data, <"c>) | 0.00 kb -> 0.10 kb
      1.053s | ✍️ #1 tsdf/sess1/col-inline-overflow-cleanup/ci._i.r.json
             |    └ (namespace index) | 0.15 kb -> 0.15 kb
             ·
      2.1s   | 📖 #1 tsdf/sess1/col-inline-overflow-cleanup/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
             ·
      2.143s | 📖 #1 tsdf/sess1/col-inline-overflow-cleanup/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
      2.146s | 🗑️ #4 ✅ tsdf/sess1/col-inline-overflow-cleanup/ci.h~1374750182.p.json
             |    └ (entry data, <"b>)
      .      | 👁️ #5 file-open-or-create 🆕 tsdf/sess1/col-inline-overflow-cleanup/ci.h~2103001283.p.json
             |    └ (entry data, <"d>)
      2.149s | ✍️ #5 tsdf/sess1/col-inline-overflow-cleanup/ci.h~2103001283.p.json
             |    └ (entry data, <"d>) | 0.00 kb -> 0.10 kb
      2.153s | ✍️ #1 tsdf/sess1/col-inline-overflow-cleanup/ci._i.r.json
             |    └ (namespace index) | 0.15 kb -> 0.15 kb
      2.155s | end
      "
    `);
  });

  test('preloadItemFromStorage hydrates the cached collection item once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });
    collectionScope.collection.seedItem('2', {
      value: { id: '2', name: 'Another cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Drain the startup scan so the capture only measures explicit preload behavior.
    await settleStartupBackgroundScan(mockAdapter);

    // Preload should materialize the cached item into store state through the async path.
    const preloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    expect(await resolveAfterAllTimers(preloadPromise)).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    const preloadPromise2 = env.apiStore.preloadItemFromStorage('2');
    expect(await resolveAfterAllTimers(preloadPromise2)).toMatchInlineSnapshot(
      `- { payload: '2', preloaded: '✅' }`,
    );

    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/col-direct-get-item-state (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/col-direct-get-item-state/ci._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/col-direct-get-item-state/ci._i.r.json
           |    └ (namespace index) | 0.15 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/col-direct-get-item-state/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      7ms  | 📖 #2 tsdf/sess1/col-direct-get-item-state/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.11 kb
      10ms | 📖 #1 tsdf/sess1/col-direct-get-item-state/ci._i.r.json
           |    └ (namespace index) | 0.15 kb ⚠️ REPEATED READ <10ms UNCHANGED
      13ms | 👁️ #3 file-open ✅ tsdf/sess1/col-direct-get-item-state/ci.h~1409323532.p.json
           |    └ (entry data, <"2>)
      14ms | 📖 #3 tsdf/sess1/col-direct-get-item-state/ci.h~1409323532.p.json
           |    └ (entry data, <"2>) | 0.12 kb
      17ms | end
      "
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterAllTimers(env.apiStore.preloadItemFromStorage('1')),
    ).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(env.apiStore.preloadItemFromStorage('1')),
    ).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    await advanceTime(100);
    expect(
      await resolveAfterAllTimers(env.apiStore.preloadItemFromStorage('1')),
    ).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory state without new storage work.
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    await flushAllTimers();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
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

    expect(getParsedOpfsFileData('tsdf/sess1/col-mutation-flow/ci.<"1>.p.json'))
      .toMatchInlineSnapshot(`
        d:
          value: { id: '1', name: 'Edited user' }

        p: '1'
      `);
    expect(getParsedOpfsFileData('tsdf/sess1/col-mutation-flow/ci._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "1: { a: 1735689600000, p: '1' }
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.04s  | 📖 #1 tsdf/sess1/col-mutation-flow/ci._i.r.json
             |    └ (namespace index) | 0.08 kb
      1.045s | ✍️ #2 tsdf/sess1/col-mutation-flow/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      1.047s | end
      "
    `);
  });

  test('updating a hydrated collection item recreates a payload file deleted after hydration without rereading cached entries', async () => {
    const storeName = 'col-mutation-retry-after-delete';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item first so the later write reuses a cached OPFS file handle.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    const deleteTarget = await getCollectionPayloadDeleteTarget({
      mockAdapter,
      sessionKey,
      storeName,
    });

    // Simulate another tab deleting the payload file while this tab still holds the old handle.
    const mutationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    await resolveAfterAllTimers(
      deleteTarget.storeDir.removeEntry(deleteTarget.fileName),
    );

    // The next mutation should recreate the payload file through the retry path, not reread storage.
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited after delete';
      });
    });
    await flushInvalidationPersistence();
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-mutation-retry-after-delete/ci.<"1>.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: '1', name: 'Edited after delete' }

      p: '1'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-mutation-retry-after-delete/ci._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "1: { a: 1735689600000, p: '1' }
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      0      | 🗑️ #1 ✅ tsdf/sess1/col-mutation-retry-after-delete/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
             ·
      1.041s | 📖 #2 tsdf/sess1/col-mutation-retry-after-delete/ci._i.r.json
             |    └ (namespace index) | 0.08 kb
      1.044s | ✍️ #1 ❌ retryable-createWritable tsdf/sess1/col-mutation-retry-after-delete/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | NotFoundError
      1.045s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.046s | 📁 dir-open-or-create ✅ tsdf/sess1/col-mutation-retry-after-delete
             |    └ (store directory)
      1.047s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/col-mutation-retry-after-delete/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
      1.05s  | ✍️ #1 tsdf/sess1/col-mutation-retry-after-delete/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.00 kb -> 0.12 kb
      1.052s | end
      "
    `);
  });

  test('updating a hydrated collection item recreates a payload file deleted during the write race without rereading cached entries', async () => {
    const storeName = 'col-mutation-retry-during-write';
    const sessionKey = 'sess1';
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item first so the later write reuses a cached OPFS file handle.
    await settleStartupBackgroundScan(mockAdapter);
    renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    const deleteTarget = await getCollectionPayloadDeleteTarget({
      mockAdapter,
      sessionKey,
      storeName,
    });

    // Start a normal mutation, then let another tab remove the file after the write begins but before close().
    const mutationCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited during write';
      });
    });
    await advanceTime(1045);
    const deletePromise = deleteTarget.storeDir.removeEntry(
      deleteTarget.fileName,
    );
    await advanceTime(1);
    await deletePromise;
    await flushInvalidationPersistence(0);
    const mutationOperations = mutationCapture.finish().timelineString;

    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-mutation-retry-during-write/ci.%221.p.json',
      ),
    ).toMatchInlineSnapshot(`
      d:
        value: { id: '1', name: 'Edited during write' }

      p: '1'
    `);
    expect(
      getParsedOpfsFileData(
        'tsdf/sess1/col-mutation-retry-during-write/ci._i.r.json',
      ),
    ).toMatchInlineSnapshot(`
      e:
        "1: { a: 1735689600000, p: '1' }
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      "
      time   |
      1.04s  | 📖 #1 tsdf/sess1/col-mutation-retry-during-write/ci._i.r.json
             |    └ (namespace index) | 0.08 kb
      1.045s | 🗑️ #2 ✅ tsdf/sess1/col-mutation-retry-during-write/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
      .      | ✍️ #2 ❌ retryable-close tsdf/sess1/col-mutation-retry-during-write/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | NotFoundError
      1.047s | 📁 dir-open-or-create ✅ tsdf/sess1 (session directory)
      1.048s | 📁 dir-open-or-create ✅ tsdf/sess1/col-mutation-retry-during-write
             |    └ (store directory)
      1.049s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/col-mutation-retry-during-write/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
      1.052s | ✍️ #2 tsdf/sess1/col-mutation-retry-during-write/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.00 kb -> 0.12 kb
      1.054s | end
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
      1.04s  | 📖 #1 tsdf/sess1/col-delete-flow/ci._i.r.json
             |    └ (namespace index) | 0.15 kb
      1.043s | 🗑️ #2 ✅ tsdf/sess1/col-delete-flow/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
      1.046s | ✍️ #1 tsdf/sess1/col-delete-flow/ci._i.r.json
             |    └ (namespace index) | 0.15 kb -> 0.08 kb
      1.048s | end
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
      1.85s  | 📖 #1 tsdf/sess1/col-invalidation-flow/ci._i.r.json
             |    └ (namespace index) | 0.08 kb
      1.855s | ✍️ #2 tsdf/sess1/col-invalidation-flow/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      1.857s | end
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
      getParsedOpfsFileData('tsdf/sess1/col-offline-marker-flow/ci._i.r.json'),
    ).toMatchInlineSnapshot(`
      e:
        "1: { a: 1735689600000, o: '✅', p: '1' }
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
      1.85s  | 📖 #1 tsdf/sess1/col-coalesced-invalidations/ci._i.r.json
             |    └ (namespace index) | 0.08 kb
      1.855s | ✍️ #2 tsdf/sess1/col-coalesced-invalidations/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.11 kb -> 0.11 kb
      1.857s | end
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
    // The snapshot ends after the initial entry data+metadata reads, which makes the
    // skipped touch explicit.
    expect(firstMountOperations).toMatchInlineSnapshot(`
      "
      time |
      0    | 📂 dir-open ✅ tsdf/sess1 (session directory)
      1ms  | 📂 dir-open ✅ tsdf/sess1/col-remount-flow (store directory)
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/col-remount-flow/ci._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/col-remount-flow/ci._i.r.json
           |    └ (namespace index) | 0.08 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/col-remount-flow/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      7ms  | 📖 #2 tsdf/sess1/col-remount-flow/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.11 kb
      10ms | end
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
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index) | 0.08 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/col-remount-stale-touch/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      7ms  | 📖 #2 tsdf/sess1/col-remount-stale-touch/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.11 kb
           ·
      50ms | 📖 #1 tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index) | 0.08 kb
      55ms | ✍️ #1 tsdf/sess1/col-remount-stale-touch/ci._i.r.json
           |    └ (namespace index) | 0.08 kb -> 0.08 kb
      57ms | end
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
        settleTimeMs: 4300,
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
             ·
      1.851s | 📂 dir-open ❌ tsdf/sess1 (session directory) ⚠️ DUPLICATE OPEN
      1.852s | 📁 dir-open-or-create 🆕 tsdf/sess1
             |    └ (session directory) ⚠️ DUPLICATE OPEN
      1.853s | 📁 dir-open-or-create 🆕 tsdf/sess1/col-remount-no-cache
             |    └ (store directory)
      1.854s | 👁️ #1 file-open-or-create 🆕 tsdf/sess1/col-remount-no-cache/ci.h~3574006234.p.json
             |    └ (entry data, <"1>)
      1.857s | ✍️ #1 tsdf/sess1/col-remount-no-cache/ci.h~3574006234.p.json
             |    └ (entry data, <"1>) | 0.00 kb -> 0.11 kb
      1.859s | 👁️ #2 file-open-or-create 🆕 tsdf/sess1/col-remount-no-cache/ci._i.r.json
             |    └ (namespace index)
      1.862s | ✍️ #2 tsdf/sess1/col-remount-no-cache/ci._i.r.json
             |    └ (namespace index) | 0.00 kb -> 0.08 kb
      1.864s | end
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
      .    | 📂 dir-open ✅ tsdf/sess1 (session directory) ⚠️ DUPLICATE OPEN
      1ms  | 📂 dir-open ✅ tsdf/sess1/col-multi-remount-flow (store directory)
      .    | 📂 dir-open ✅ tsdf/sess1/col-multi-remount-flow
           |    └ (store directory) ⚠️ DUPLICATE OPEN
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci._i.r.json
           |    └ (namespace index)
      .    | 👁️ #1 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci._i.r.json
           |    └ (namespace index) ⚠️ DUPLICATE OPEN
      3ms  | 📖 #1 tsdf/sess1/col-multi-remount-flow/ci._i.r.json
           |    └ (namespace index) | 0.15 kb
      .    | 📖 #1 tsdf/sess1/col-multi-remount-flow/ci._i.r.json
           |    └ (namespace index) | 0.15 kb ⚠️ REPEATED READ <10ms UNCHANGED
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      .    | 👁️ #3 file-open ✅ tsdf/sess1/col-multi-remount-flow/ci.h~1409323532.p.json
           |    └ (entry data, <"2>)
      7ms  | 📖 #2 tsdf/sess1/col-multi-remount-flow/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.11 kb
      .    | 📖 #3 tsdf/sess1/col-multi-remount-flow/ci.h~1409323532.p.json
           |    └ (entry data, <"2>) | 0.11 kb
      10ms | end
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

  test('collection preload reads only the requested item entry data', async () => {
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
      2ms  | 👁️ #1 file-open ✅ tsdf/sess1/collection-opfs-efficiency/ci._i.r.json
           |    └ (namespace index)
      3ms  | 📖 #1 tsdf/sess1/collection-opfs-efficiency/ci._i.r.json
           |    └ (namespace index) | 0.15 kb
      6ms  | 👁️ #2 file-open ✅ tsdf/sess1/collection-opfs-efficiency/ci.h~3574006234.p.json
           |    └ (entry data, <"1>)
      7ms  | 📖 #2 tsdf/sess1/collection-opfs-efficiency/ci.h~3574006234.p.json
           |    └ (entry data, <"1>) | 0.09 kb
      10ms | end
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
    expect(mockAdapter.listKeysRequests).toMatchInlineSnapshot(`[]`);
  });
});
