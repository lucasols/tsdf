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
  createCollectionEnv,
  createDocumentEnv,
  flushInvalidationPersistence,
  resolveAfterIndexedDbStorage,
  setProtectedKeysSnapshot,
  settleIndexedDbStorage,
  settleIndexedDbStorageCapture,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  waitForIndexedDbCondition,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function readCollectionEntryRow(
  args:
    | {
        key: string;
        mockAdapter: ReturnType<
          typeof createIndexedDbPersistentStorageTestStore
        >;
        sessionKey: string;
        storeName: string;
      }
    | {
        mockAdapter: ReturnType<
          typeof createIndexedDbPersistentStorageTestStore
        >;
        payload: string;
        sessionKey: string;
        storeName: string;
      },
) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [
      args.sessionKey,
      args.storeName,
      'collection.item',
      'key' in args ? args.key : scope.collection.itemKey(args.payload),
    ],
    storeName: 'entries',
  });
}

async function readCollectionNamespacePolicyRow(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  sessionKey: string;
  storeName: string;
}) {
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [args.sessionKey, args.storeName, 'collection.item'],
    storeName: 'namespacePolicies',
  });
}

async function deleteCollectionEntryRow(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  payload: string;
  sessionKey: string;
  storeName: string;
}): Promise<void> {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  const entryKey = [
    args.sessionKey,
    args.storeName,
    'collection.item',
    scope.collection.itemKey(args.payload),
  ] as const;

  await args.mockAdapter.indexedDb.deleteRow('entries', entryKey);
}

describe('indexeddb async storage efficiency: collection', () => {
  test('expiration cleanup removes expired items through namespace manifests only', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-expiration';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createCollectionEnv({ storeName, sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the scan runs, capture the full metadata cleanup history.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredItemExists: await mockAdapter.has(expiredItemKey),
      expiredItem2Exists: await mockAdapter.has(expiredItemKey2),
      freshItemExists: await mockAdapter.has(freshItemKey),
    }).toMatchInlineSnapshot(`
      expiredItem2Exists: '❌'
      expiredItemExists: '❌'
      freshItemExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.008s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","collection-expiration","collection.item"]]
      2.014s | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-expiration","collection.item"] -> keys=3 exists=yes valid=yes
      2.014s | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-expiration","collection.item"] -> keys=3 exists=yes valid=yes
      2.018s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","collection-expiration","collection.item"] keys=["\\"expired-user", "\\"expired-user-2"]
      2.023s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","collection-expiration","collection.item"] keys=1
      ""
    `);

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
              - key: ['["sess1","collection-expiration","collection.item"]', '"fresh-user']
                value: 'JSON object | 0.3 kb'
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
              - key: ['sess1', 'collection-expiration', 'collection.item']
                value: 'JSON object | 0.0 kb'
        version: 1
      `);

    expect(
      await readCollectionEntryRow({
        mockAdapter,
        payload: 'fresh-user',
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        value: { id: 'fresh-user', name: 'Fresh User' }

      i: '["sess1","collection-expiration","collection.item"]'
      p: 'fresh-user'
    `);
  });

  test('startup cleanup enforces maxItems against preloaded persisted entries', async () => {
    const storeName = 'collection-startup-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
    collectionScope.collection.setStaticPolicy({ m: 2 });

    // Startup should only schedule the cleanup work.
    const startupOperationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Once the startup pass runs, it should evict only the oldest persisted item.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(),
    ).toMatchInlineSnapshot(`['b', 'c']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.008s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","collection-startup-max-items","collection.item"]]
      2.014s | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-startup-max-items","collection.item"] -> keys=3 exists=yes valid=yes
      2.017s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","collection-startup-max-items","collection.item"] keys=["\\"a"]
      2.024s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","collection-startup-max-items","collection.item"] keys=2 static-policy
      ""
    `);
    expect(
      await readCollectionNamespacePolicyRow({
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      p: { maxEntries: 2 }
      s: 'sess1'
    `);
  });

  test('cold startup enforces the default collection maxItems policy before the store mounts', async () => {
    const storeName = 'collection-cold-default-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    for (let index = 0; index <= 50; index++) {
      collectionScope.collection.seedItem(String(index), {
        value: { id: String(index), name: `Cached ${index}` },
      });
      await advanceTime(10);
    }

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    await waitForScheduledCleanup();

    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(
        (left, right) => left.localeCompare(right),
      ),
    ).toMatchInlineSnapshot(`
      - '1'
      - '10'
      - '11'
      - '12'
      - '13'
      - '14'
      - '15'
      - '16'
      - '17'
      - '18'
      - '19'
      - '2'
      - '20'
      - '21'
      - '22'
      - '23'
      - '24'
      - '25'
      - '26'
      - '27'
      - '28'
      - '29'
      - '3'
      - '30'
      - '31'
      - '32'
      - '33'
      - '34'
      - '35'
      - '36'
      - '37'
      - '38'
      - '39'
      - '4'
      - '40'
      - '41'
      - '42'
      - '43'
      - '44'
      - '45'
      - '46'
      - '47'
      - '48'
      - '49'
      - '5'
      - '50'
      - '6'
      - '7'
      - '8'
      - '9'
    `);
  });

  test('startup cleanup combines expiration and maxItems trimming in one sweep', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'collection-startup-expiration-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem(
      'a',
      { value: { id: 'a', name: 'Expired oldest' } },
      { timestamp: expiredTimestamp },
    );
    await advanceTime(100);
    collectionScope.collection.seedItem('b', {
      value: { id: 'b', name: 'Older cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('c', {
      value: { id: 'c', name: 'Newer cached' },
    });
    await advanceTime(100);
    collectionScope.collection.seedItem('d', {
      value: { id: 'd', name: 'Newest cached' },
    });
    collectionScope.collection.setStaticPolicy({ m: 2 });

    const startupOperationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    const cleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = cleanupCapture.finish().timelineString;

    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.009s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","collection-startup-expiration-max-items","collection.item"]]
      2.016s | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-startup-expiration-max-items","collection.item"] -> keys=4 exists=yes valid=yes
      2.02s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","collection-startup-expiration-max-items","collection.item"] keys=["\\"a", "\\"b"]
      2.027s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","collection-startup-expiration-max-items","collection.item"] keys=2 static-policy
      ""
    `);
  });

  test('maxItems cleanup snapshots the full manifest history when one flush deletes multiple items', async () => {
    const storeName = 'col-max-items-metadata';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });
    const startupOperationBreakdown =
      startupOperationCapture.finish().timelineString;

    expect(startupOperationBreakdown).toMatchInlineSnapshot(`"empty"`);

    // Drain the startup-scheduled cleanup before capturing the maxItems flush.
    await settleStartupBackgroundScan(mockAdapter);
    let payloadsAfterStartup = (
      await collectionScope.collection.listStoredPayloads()
    ).sort();

    // IndexedDB cleanup can finish a little later than the generic startup helper
    // because fake-indexeddb work drains through queued tasks instead of OPFS file ops.
    for (
      let attempt = 0;
      JSON.stringify(payloadsAfterStartup) !== JSON.stringify(['b', 'c']) &&
      attempt < 10;
      attempt++
    ) {
      await settleIndexedDbStorageCapture(mockAdapter);
      payloadsAfterStartup = (
        await collectionScope.collection.listStoredPayloads()
      ).sort();
    }

    // Startup cleanup should already have enforced maxItems before the later write.
    expect(payloadsAfterStartup).toMatchInlineSnapshot(`['b', 'c']`);

    // Adding a fourth item should now capture one write plus a one-item cleanup sequence.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fresh' } });
    await advanceTime(1100);
    await settleIndexedDbStorageCapture(mockAdapter);
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","col-max-items-metadata","collection.item"] order=lru-desc -> ["\\"c", "\\"b"]
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-max-items-metadata","collection.item"] put=["\\"d"] delete=["\\"b"] touch=[] static-policy
      ""
    `);
  });

  test('maxItems-triggered flush also prunes expired persisted items', async () => {
    const expiredTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const storeName = 'col-expired-during-max-items';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fresh' } });
    await advanceTime(1100);
    await settleIndexedDbStorageCapture(mockAdapter);
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","col-expired-during-max-items","collection.item"] order=lru-desc -> ["\\"c", "\\"b", "\\"a"]
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-expired-during-max-items","collection.item"] put=["\\"d"] delete=["\\"b", "\\"a"] touch=[] static-policy
      ""
    `);

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
            rowCount: 2
            rows:
              - key: ['["sess1","col-expired-during-max-items","collection.item"]', '"c']
                value: 'JSON object | 0.3 kb'
              - key: ['["sess1","col-expired-during-max-items","collection.item"]', '"d']
                value: 'JSON object | 0.3 kb'
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
              - key: ['sess1', 'col-expired-during-max-items', 'collection.item']
                value: 'JSON object | 0.1 kb'
        version: 1
      `);
  });

  test('repeated overflowing collection updates evict inline without scheduling background maintenance', async () => {
    const storeName = 'col-inline-overflow-cleanup';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    // The first overflow should evict the oldest cached item in the same debounced commit.
    env.apiStore.addItemToState('c', { value: { id: 'c', name: 'Third' } });
    await advanceTime(1100);

    // A later overflow should do the same thing again instead of relying on idle cleanup.
    env.apiStore.addItemToState('d', { value: { id: 'd', name: 'Fourth' } });
    await advanceTime(1100);
    // Drain every pending timer; if background maintenance were scheduled, it would show up here.
    await settleIndexedDbStorageCapture(mockAdapter);
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(),
    ).toMatchInlineSnapshot(`['c', 'd']`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","col-inline-overflow-cleanup","collection.item"] order=lru-desc -> ["\\"b", "\\"a"]
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-inline-overflow-cleanup","collection.item"] put=["\\"c"] delete=["\\"a"] touch=[] static-policy
      2.1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","col-inline-overflow-cleanup","collection.item"] order=lru-desc -> ["\\"c", "\\"b"]
      2.14s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-inline-overflow-cleanup","collection.item"] put=["\\"d"] delete=["\\"b"] touch=[] static-policy
      ""
    `);
  });

  test('preloadItemFromStorage hydrates the cached collection item once and keeps later preloads and direct reads in memory', async () => {
    const storeName = 'col-direct-get-item-state';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const preloadPromise = env.apiStore.preloadItemFromStorage('1');
    expect(await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter))
      .toMatchInlineSnapshot(`
        - { payload: '1', preloaded: '✅' }
      `);
    const preloadPromise2 = env.apiStore.preloadItemFromStorage('2');
    expect(
      await resolveAfterIndexedDbStorage(preloadPromise2, mockAdapter),
    ).toMatchInlineSnapshot(`- { payload: '2', preloaded: '✅' }`);

    expect(preloadCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-direct-get-item-state","collection.item"] keys=["\\"1"] -> ["\\"1"]
      3ms | 📖 entries.getMany scope=["sess1","col-direct-get-item-state","collection.item"] keys=["\\"2"] -> ["\\"2"]
      ""
    `);

    // Once preloaded, repeated explicit preload calls should reuse in-memory state without new storage work.
    const repeatedPreloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage('1'),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    await advanceTime(100);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage('1'),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    await advanceTime(100);
    expect(
      await resolveAfterIndexedDbStorage(
        env.apiStore.preloadItemFromStorage('1'),
        mockAdapter,
      ),
    ).toMatchInlineSnapshot(`
      - { payload: '1', preloaded: '✅' }
    `);
    expect(
      repeatedPreloadCapture.finish().timelineString,
    ).toMatchInlineSnapshot(`"empty"`);

    // Repeated direct reads should also reuse in-memory state without new storage work.
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
    await settleIndexedDbStorage();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
  });

  test('updating a hydrated collection item writes the mutation without rereading cached entries', async () => {
    const storeName = 'col-mutation-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item through a normal mounted hook first.
    await settleStartupBackgroundScan(mockAdapter);
    const hydratedHook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Mutating the already-hydrated item should only need writes.
    const mutationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited user';
      });
    });
    await flushInvalidationPersistence();
    hydratedHook.unmount();
    const mutationOperations = mutationCapture.finish().timelineString;
    env.apiStore.dispose();
    await settleIndexedDbStorage();

    expect(
      await readCollectionEntryRow({
        mockAdapter,
        payload: '1',
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        value: { id: '1', name: 'Edited user' }

      i: '["sess1","col-mutation-flow","collection.item"]'
      p: '1'
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      ""
      1.045s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-mutation-flow","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('updating a hydrated collection item recreates a persisted row deleted after hydration without rereading cached entries', async () => {
    const storeName = 'col-mutation-retry-after-delete';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item first so the later write can reuse the in-memory row state.
    await settleStartupBackgroundScan(mockAdapter);
    const hydratedHook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Simulate another tab deleting the persisted row while this tab still holds hydrated state.
    const mutationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await resolveAfterIndexedDbStorage(
      deleteCollectionEntryRow({
        mockAdapter,
        payload: '1',
        sessionKey,
        storeName,
      }),
      mockAdapter,
    );

    // The next mutation should recreate the persisted row through the retry path, not reread storage.
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited after delete';
      });
    });
    await flushInvalidationPersistence();
    hydratedHook.unmount();
    const mutationOperations = mutationCapture.finish().timelineString;
    env.apiStore.dispose();
    await settleIndexedDbStorage();

    expect(
      await readCollectionEntryRow({
        mockAdapter,
        payload: '1',
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689606142

      d:
        value: { id: '1', name: 'Edited after delete' }

      i: '["sess1","col-mutation-retry-after-delete","collection.item"]'
      p: '1'
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      ""
      1.045s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-mutation-retry-after-delete","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('updating a hydrated collection item recreates a persisted row deleted during the write race without rereading cached entries', async () => {
    const storeName = 'col-mutation-retry-during-write';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    // Hydrate the cached item first so the later write can reuse the in-memory row state.
    await settleStartupBackgroundScan(mockAdapter);
    const hydratedHook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await flushInvalidationPersistence(0);

    // Start a normal mutation, then let another tab remove the row directly
    // from IndexedDB after the write has started but before it fully settles.
    const mutationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.apiStore.updateItemState('1', (draft) => {
        draft.value.name = 'Edited during write';
      });
    });
    await advanceTime(500);
    await resolveAfterIndexedDbStorage(
      deleteCollectionEntryRow({
        mockAdapter,
        payload: '1',
        sessionKey,
        storeName,
      }),
      mockAdapter,
    );
    await advanceTime(545);
    await flushInvalidationPersistence(0);
    await settleIndexedDbStorageCapture(mockAdapter);
    let recreatedEntry: Awaited<ReturnType<typeof readCollectionEntryRow>> =
      null;

    for (let attempt = 0; recreatedEntry === null && attempt < 10; attempt++) {
      await settleIndexedDbStorageCapture(mockAdapter);
      recreatedEntry = await readCollectionEntryRow({
        mockAdapter,
        payload: '1',
        sessionKey,
        storeName,
      });
    }
    hydratedHook.unmount();
    const mutationOperations = mutationCapture.finish().timelineString;
    env.apiStore.dispose();
    await settleIndexedDbStorage();

    expect(
      await readCollectionEntryRow({
        mockAdapter,
        payload: '1',
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689606142

      d:
        value: { id: '1', name: 'Edited during write' }

      i: '["sess1","col-mutation-retry-during-write","collection.item"]'
      p: '1'
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      ""
      1.045s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-mutation-retry-during-write","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  }, 5000);

  test('deleteItemState removes the persisted collection entry through the namespace manifest only', async () => {
    const storeName = 'col-delete-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const deletedItemStorageKey =
      collectionScope.collection.itemStorageKey('1');

    const env = createCollectionEnv({ storeName, sessionKey });

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'Alice' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Bob' } });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    // The delete capture should only include the debounced storage cleanup path.
    const deleteCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    env.apiStore.deleteItemState('1');
    await advanceTime(1100);
    await settleIndexedDbStorage();
    const deleteOperations = deleteCapture.finish().timelineString;

    expect(await mockAdapter.has(deletedItemStorageKey)).toBe(false);
    expect(
      (await collectionScope.collection.listStoredPayloads()).sort(),
    ).toMatchInlineSnapshot(`['2']`);
    expect(deleteOperations).toMatchInlineSnapshot(`
      ""
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-delete-flow","collection.item"] put=[] delete=["\\"1"] touch=[] static-policy
      ""
    `);
  });

  test('useItem invalidation snapshots the full persistence timeline through the refetch save', async () => {
    const storeName = 'col-invalidation-flow';
    const sessionKey = 'sess-invalidation-flow';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user' } },
    });

    await settleStartupBackgroundScan(mockAdapter);
    await resolveAfterIndexedDbStorage(
      env.apiStore.preloadItemFromStorage('1'),
      mockAdapter,
    );
    const mountedHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await settleIndexedDbStorage();

    const invalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await flushInvalidationPersistence();
    await waitForIndexedDbCondition(() => {
      const data = env.apiStore.getItemState('1')?.data;
      return data != null && data.value.name === 'Fresh user';
    });
    mountedHook.unmount();
    const invalidationOperations = invalidationCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        value: { id: '1', name: 'Fresh user' }

      i: '["sess-invalidation-flow","col-invalidation-flow","collection.item"]'
      p: '1'
    `);
    expect(invalidationOperations).toMatchInlineSnapshot(`
      ""
      1.855s | ✍️ tx(entries, namespacePolicies).commit scope=["sess-invalidation-flow","col-invalidation-flow","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('collection invalidation preserves an offline marker added by another tab before the manifest update', async () => {
    const storeName = 'col-offline-marker-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
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

    await settleStartupBackgroundScan(mockAdapter);
    await resolveAfterIndexedDbStorage(
      env.apiStore.preloadItemFromStorage('1'),
      mockAdapter,
    );
    const mountedHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await settleIndexedDbStorage();

    setProtectedKeysSnapshot(sessionKey, [storageKey]);

    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(3200);
    await settleIndexedDbStorage();
    mountedHook.unmount();

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user' }`,
    );
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        value: { id: '1', name: 'Fresh user' }

      i: '["sess1","col-offline-marker-flow","collection.item"]'
      o: 1
      p: '1'
    `);
  });

  test('repeated invalidations within the debounce window coalesce collection persistence writes', async () => {
    const storeName = 'col-coalesced-invalidations';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fresh user 1' } },
    });

    await settleStartupBackgroundScan(mockAdapter);
    await resolveAfterIndexedDbStorage(
      env.apiStore.preloadItemFromStorage('1'),
      mockAdapter,
    );
    const mountedHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await settleIndexedDbStorage();

    const firstInvalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 1' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1100);
    const firstInvalidationOperations =
      firstInvalidationCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 1' }`,
    );
    expect(firstInvalidationOperations).toMatchInlineSnapshot(`"empty"`);

    const secondInvalidationCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    act(() => {
      env.serverTable.setItem('1', { id: '1', name: 'Fresh user 2' });
      env.apiStore.invalidateItem('1');
    });
    await advanceTime(1900);
    await settleIndexedDbStorage();
    await waitForIndexedDbCondition(() => {
      const data = env.apiStore.getItemState('1')?.data;
      return data != null && data.value.name === 'Fresh user 2';
    });
    mountedHook.unmount();
    const secondInvalidationOperations =
      secondInvalidationCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Fresh user 2' }`,
    );
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        value: { id: '1', name: 'Fresh user 2' }

      i: '["sess1","col-coalesced-invalidations","collection.item"]'
      p: '1'
    `);
    expect(secondInvalidationOperations).toMatchInlineSnapshot(`
      ""
      1.85s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-coalesced-invalidations","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
  });

  test('hook remount skips the touch write when the cached collection item is still in the current recency bucket', async () => {
    const storeName = 'col-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-remount-flow","collection.item"] keys=["\\"1"] -> ["\\"1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('collection hydration does not skip the touch write once the cached item falls outside the current recency bucket', async () => {
    const storeName = 'col-remount-stale-touch';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem(
      '1',
      { value: { id: '1', name: 'Cached user' } },
      { timestamp: Date.now() - 7 * 60 * 60 * 1000 },
    );

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(
      `value: { id: '1', name: 'Cached user' }`,
    );
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-remount-stale-touch","collection.item"] keys=["\\"1"] -> ["\\"1"]
      46ms | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-remount-stale-touch","collection.item"] put=[] delete=[] touch=["\\"1"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('collection hook cache miss writes the fetched item once and remount stays fully in memory', async () => {
    const storeName = 'col-remount-no-cache';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    const env = createCollectionEnv({
      storeName,
      sessionKey,
      serverData: { '1': { id: '1', name: 'Fetched user' } },
    });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await advanceTime(4300);
    await settleIndexedDbStorage();
    await waitForIndexedDbCondition(() => {
      const data = env.apiStore.getItemState('1')?.data;
      return data != null && data.value.name === 'Fetched user';
    });
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useItem('1', {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(env.apiStore.getItemState('1')?.data).toMatchInlineSnapshot(`
      value: { id: '1', name: 'Fetched user' }
    `);
    expect(
      await readCollectionEntryRow({
        key: collectionScope.collection.itemKey('1'),
        mockAdapter,
        sessionKey,
        storeName,
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689604851

      d:
        value: { id: '1', name: 'Fetched user' }

      i: '["sess1","col-remount-no-cache","collection.item"]'
      p: '1'
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","col-remount-no-cache","collection.item"] keys=["\\"1"] -> []
      1.851s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-remount-no-cache","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('useMultipleItems remount reuses hydrated collection items without touching localStorage again', async () => {
    const storeName = 'col-multi-remount-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user 1' },
    });
    collectionScope.collection.seedItem('2', {
      value: { id: '2', name: 'Cached user 2' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const firstMountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const firstHook = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const firstMountOperations = firstMountCapture.finish().timelineString;
    firstHook.unmount();

    const remountCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const secondHook = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await flushInvalidationPersistence(0);
    const remountOperations = remountCapture.finish().timelineString;

    expect(
      ['1', '2'].map(
        (payload) => env.apiStore.getItemState(payload)?.data?.value,
      ),
    ).toMatchInlineSnapshot(`
      - { id: '1', name: 'Cached user 1' }
      - { id: '2', name: 'Cached user 2' }
    `);
    expect(firstMountOperations).toMatchInlineSnapshot(`
      ""
      2ms | 📖 entries.getMany scope=["sess1","col-multi-remount-flow","collection.item"] keys=["\\"1", "\\"2"] -> ["\\"1", "\\"2"]
      ""
    `);
    expect(remountOperations).toMatchInlineSnapshot(`"empty"`);
    secondHook.unmount();
  });

  test('getItemState stays in memory after a hook has already hydrated the collection item', async () => {
    const storeName = 'col-get-item-state-flow';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({});
    const collectionScope = mockAdapter.scope(storeName, sessionKey);

    collectionScope.collection.seedItem('1', {
      value: { id: '1', name: 'Cached user' },
    });

    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useItem('1', { disableRefetchOnMount: true }),
    );
    await settleIndexedDbStorage();
    hook.unmount();

    const getItemStateCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
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
    const mockAdapter = createIndexedDbPersistentStorageTestStore({
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
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);

    const preloadPromise = env.apiStore.preloadItemFromStorage(hotPayload);
    await resolveAfterIndexedDbStorage(preloadPromise, mockAdapter);

    expect(readCapture.finish().timelineString).toMatchInlineSnapshot(`
      ""
      1ms | 📖 entries.getMany scope=["sess1","collection-opfs-efficiency","collection.item"] keys=["\\"1"] -> ["\\"1"]
      ""
    `);

    expect(mockAdapter.payloadGetRequests).toContain(hotKey);
    expect(mockAdapter.payloadGetRequests).not.toContain(coldKey);
  });

  test('useMultipleItems batches cold collection preloads through one namespace index read', async () => {
    const storeName = 'collection-opfs-batched-preload';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore({
      initialState: {
        storeName,
        sessionKey,
        collection: [
          { payload: '1', data: { value: { id: '1', name: 'One' } } },
          { payload: '2', data: { value: { id: '2', name: 'Two' } } },
        ],
      },
    });
    const env = createCollectionEnv({ storeName, sessionKey });

    await settleStartupBackgroundScan(mockAdapter);

    const preloadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    const hook = renderHook(() =>
      env.apiStore.useMultipleItems([{ payload: '1' }, { payload: '2' }], {
        disableRefetchOnMount: true,
        returnRefetchingStatus: true,
      }),
    );
    await advanceTime(250);
    await settleIndexedDbStorage();
    hook.unmount();

    const { timelineString } = preloadCapture.finish();
    expect(mockAdapter.payloadGetManyRequests).toMatchInlineSnapshot(`
      - - 'tsdf.sess1.collection-opfs-batched-preload.ci."1'
        - 'tsdf.sess1.collection-opfs-batched-preload.ci."2'
    `);
    expect(timelineString).toMatchInlineSnapshot(`
      ""
      2ms | 📖 entries.getMany scope=["sess1","collection-opfs-batched-preload","collection.item"] keys=["\\"1", "\\"2"] -> ["\\"1", "\\"2"]
      ""
    `);
  });

  test('protected snapshot reuse avoids rereading the async protected registry during eviction', async () => {
    const storeName = 'collection-opfs-protected-snapshot';
    const sessionKey = 'sess1';
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope(storeName, sessionKey);
    const env = createCollectionEnv({ storeName, sessionKey, maxItems: 2 });

    await settleStartupBackgroundScan(mockAdapter);
    setProtectedKeysSnapshot(sessionKey, [
      collectionScope.collection.itemStorageKey('1'),
    ]);

    env.apiStore.addItemToState('1', { value: { id: '1', name: 'One' } });
    env.apiStore.addItemToState('2', { value: { id: '2', name: 'Two' } });
    await advanceTime(1100);
    await settleIndexedDbStorage();
    mockAdapter.clearInstrumentation();

    env.apiStore.addItemToState('3', { value: { id: '3', name: 'Three' } });
    await advanceTime(1100);
    await settleIndexedDbStorage();

    expect(mockAdapter.payloadGetRequests).toMatchInlineSnapshot(`[]`);
    expect(mockAdapter.listKeysRequests).toMatchInlineSnapshot(`[]`);
  });
});
