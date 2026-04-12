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
  settleIndexedDbStorage,
  settleIndexedDbStorageCapture,
  settleStartupBackgroundScan,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function readCollectionEntryRow(args: {
  mockAdapter: ReturnType<typeof createIndexedDbPersistentStorageTestStore>;
  payload: string;
  sessionKey: string;
  storeName: string;
}) {
  const scope = args.mockAdapter.scope(args.storeName, args.sessionKey);
  return getParsedIndexedDbRecordData(args.mockAdapter, {
    key: [
      args.sessionKey,
      args.storeName,
      'collection.item',
      scope.collection.itemKey(args.payload),
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
      2.007s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","collection-expiration","collection.item"]]
      2.013s | 📖 scope-state entries+namespacePolicies scope=["sess1","collection-expiration","collection.item"] -> keys=3 exists=yes valid=yes
      2.017s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","collection-expiration","collection.item"] keys=["\\"expired-user", "\\"expired-user-2"]
      2.022s | ✍️ tx(entries, namespacePolicies).persistScopeState scope=["sess1","collection-expiration","collection.item"] keys=1
      ""
    `);

    expect(await getIndexedDbStructureSnapshot(mockAdapter))
      .toMatchInlineSnapshot(`
      stores:
        - autoIncrement: '❌'
          indexes:
            - keyPath: ['s', 'n', 't', 'g', 'k']
              multiEntry: '❌'
              name: 'byScopeGroup'
              unique: '❌'
            - keyPath: ['s', 'n', 't', 'a', 'k']
              multiEntry: '❌'
              name: 'byScopeLastAccessAt'
              unique: '❌'
            - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
            - keyPath: ['s', 'o', 'n', 't', 'k']
              multiEntry: '❌'
              name: 'bySessionOfflineProtected'
              unique: '❌'
          keyPath: ['s', 'n', 't', 'k']
          name: 'entries'
          rowCount: 1
          rows:
            - key: ['sess1', 'collection-expiration', 'collection.item', '"fresh-user']
              value: 'JSON object | 0.4 kb'
        - autoIncrement: '❌'
          indexes: []
          keyPath: 'k'
          name: 'meta'
          rowCount: 0
          rows: []
        - autoIncrement: '❌'
          indexes:
            - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
          keyPath: ['s', 'n', 't']
          name: 'namespacePolicies'
          rowCount: 0
          rows: []
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
        d:
          value: { id: 'fresh-user', name: 'Fresh User' }
        p: 'fresh-user'

      k: '"fresh-user'
      m: { p: 'fresh-user' }
      n: 'collection-expiration'
      o: 0
      s: 'sess1'
      t: 'collection.item'
      v: 1
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
      n: 'collection-startup-max-items'
      p: { maxEntries: 2 }
      s: 'sess1'
      t: 'collection.item'
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

    // Adding a fourth item should capture one write plus a two-item cleanup sequence.
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
      1s | 🔎 entries.byScopeLastAccessAt scope=["sess1","col-max-items-metadata","collection.item"] order=lru-desc -> ["\\"c", "\\"b", "\\"a"]
      1.04s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-max-items-metadata","collection.item"] put=["\\"d"] delete=["\\"b", "\\"a"] touch=[] static-policy
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
            - keyPath: ['s', 'n', 't', 'g', 'k']
              multiEntry: '❌'
              name: 'byScopeGroup'
              unique: '❌'
            - keyPath: ['s', 'n', 't', 'a', 'k']
              multiEntry: '❌'
              name: 'byScopeLastAccessAt'
              unique: '❌'
            - { keyPath: 's', multiEntry: '❌', name: 'bySession', unique: '❌' }
            - keyPath: ['s', 'o', 'n', 't', 'k']
              multiEntry: '❌'
              name: 'bySessionOfflineProtected'
              unique: '❌'
          keyPath: ['s', 'n', 't', 'k']
          name: 'entries'
          rowCount: 2
          rows:
            - key: ['sess1', 'col-expired-during-max-items', 'collection.item', '"c']
              value: 'JSON object | 0.4 kb'
            - key: ['sess1', 'col-expired-during-max-items', 'collection.item', '"d']
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
          keyPath: ['s', 'n', 't']
          name: 'namespacePolicies'
          rowCount: 1
          rows:
            - key: ['sess1', 'col-expired-during-max-items', 'collection.item']
              value: 'JSON object | 0.2 kb'
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
        d:
          value: { id: '1', name: 'Edited user' }
        p: '1'

      k: '"1'
      m: { p: '1' }
      n: 'col-mutation-flow'
      o: 0
      s: 'sess1'
      t: 'collection.item'
      v: 1
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      ""
      1.044s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-mutation-flow","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
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
      Object.fromEntries(
        Object.entries(
          (await readCollectionEntryRow({
            mockAdapter,
            payload: '1',
            sessionKey,
            storeName,
          })) ?? {},
        ).filter(([key]) => key !== 'a'),
      ),
    ).toMatchInlineSnapshot(`
      d:
        d:
          value: { id: '1', name: 'Edited after delete' }
        p: '1'

      k: '"1'
      m: { p: '1' }
      n: 'col-mutation-retry-after-delete'
      o: 0
      s: 'sess1'
      t: 'collection.item'
      v: 1
    `);
    expect(mutationOperations).toMatchInlineSnapshot(`
      ""
      1.044s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-mutation-retry-after-delete","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
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
      Object.fromEntries(
        Object.entries(
          (await readCollectionEntryRow({
            mockAdapter,
            payload: '1',
            sessionKey,
            storeName,
          })) ?? {},
        ).filter(([key]) => key !== 'a'),
      ),
    ).toMatchInlineSnapshot(`
        d:
          d:
            value: { id: '1', name: 'Edited during write' }
          p: '1'

        k: '"1'
        m: { p: '1' }
        n: 'col-mutation-retry-during-write'
        o: 0
        s: 'sess1'
        t: 'collection.item'
        v: 1
      `);
    expect(mutationOperations).toMatchInlineSnapshot(`
        ""
        1.044s | ✍️ tx(entries, namespacePolicies).commit scope=["sess1","col-mutation-retry-during-write","collection.item"] put=["\\"1"] delete=[] touch=[] static-policy
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
});
