import { rc_number, rc_object } from 'runcheck';
import { describe, expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../../src/main';
import { createOfflineSession } from '../../../src/main';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../../src/persistentStorage/asyncStorageAdapter';
import { clearSessionProtectedKeysSnapshot } from '../../../src/persistentStorage/offline/sessionProtectionRegistry';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import {
  advanceTime,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../../utils/networkMock';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import {
  getIndexedDbStructureSnapshot,
  getParsedIndexedDbRecordData,
  getParsedLocalStorageValue,
  startIndexedDbPersistentStorageOperationCapture,
  startPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import {
  createCollectionEnv,
  createDocumentEnv,
  createListQueryEnv,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
  wrappedDocumentSchema,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

type ProtectedDocumentOfflineOperations = {
  markProtected: DocumentOfflineOperationDefinition<
    { value: { name: string; value: number } },
    { input: { value: number } }
  >;
};

describe('indexeddb async storage efficiency: maintenance', () => {
  test('startup cleanup removes expired entries and snapshots the full metadata scan history', async () => {
    const oneWeekAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const expiredDoc = mockAdapter.scope('expired-doc', 'sess1');
    const freshDoc = mockAdapter.scope('fresh-doc', 'sess1');
    const expiredKey = expiredDoc.document.storageKey();
    const freshKey = freshDoc.document.storageKey();

    // Seed one expired entry and one fresh entry so the cleanup pass has work to do.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: oneWeekAgo },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });
    // Startup should only schedule the sweep; it should not perform storage I/O yet.
    const startupReadCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const startupOperations = startupReadCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Once the scheduled sweep runs, snapshot the complete maintenance history.
    const localStorageCapture = startPersistentStorageOperationCapture();
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    expect({
      expiredEntryExists: mockAdapter.has(expiredKey),
      freshEntryExists: mockAdapter.has(freshKey),
    }).toMatchInlineSnapshot(`
      expiredEntryExists: '❌'
      freshEntryExists: '✅'
    `);
    expect(operationsBreakdown).not.toContain('📄 file-open');
    expect(localStorageOperations).toMatchInlineSnapshot(`
      "
      time   |
      2s     | 📖 #1 ❌ tsdf._am.g (async global maintenance)
      2.006s | 📖 #2 ❌ tsdf.sess1._o_.s (entry data)
      2.013s | ✍️ #1 ❌->✅ tsdf._am.g (async global maintenance) | ❌ -> 0.04 kb
      "
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.006s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      2.01s | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      2.01s | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      2.013s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","expired-doc","document"] keys=["document", "@scope"]
      ""
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1735689602013`);
  });

  test('startup cleanup deletes invalid OPFS entries while keeping valid stores', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const expiredDoc = mockAdapter.scope('expired-doc', 'sess1');
    const freshDoc = mockAdapter.scope('fresh-doc', 'sess1');
    const freshKey = freshDoc.document.storageKey();

    // Seed one expired store to prune and one fresh store that must survive.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: staleTimestamp },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });

    // Add invalid junk at multiple levels; cleanup should remove all of it.
    mockAdapter.mockIndexedDbFileView.writeFile('tsdf/root-junk.txt', 'bad');
    mockAdapter.mockIndexedDbFileView.writeFile('tsdf/sess1/session-junk.txt', 'bad');
    mockAdapter.mockIndexedDbFileView.writeFile(
      'tsdf/sess1/expired-doc/store-junk.txt',
      'bad',
    );
    mockAdapter.mockIndexedDbFileView.writeFile(
      'tsdf/sess1/fresh-doc/store-junk.txt',
      'bad',
    );
    mockAdapter.mockIndexedDbFileView.writeFile(
      'tsdf/sess1/invalid-only-store/store-junk.txt',
      'bad',
    );

    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredStoreEntries: mockAdapter.mockIndexedDbFileView.listEntries(
        'tsdf/sess1/expired-doc',
      ),
      freshEntryExists: mockAdapter.has(freshKey),
      freshStoreEntries: mockAdapter.mockIndexedDbFileView.listEntries(
        'tsdf/sess1/fresh-doc',
      ),
      invalidOnlyStoreEntries: mockAdapter.mockIndexedDbFileView.listEntries(
        'tsdf/sess1/invalid-only-store',
      ),
      rootEntries: mockAdapter.mockIndexedDbFileView.listEntries('tsdf'),
      rootJunkExists:
        mockAdapter.mockIndexedDbFileView.fileExists('tsdf/root-junk.txt'),
      sessionEntries: mockAdapter.mockIndexedDbFileView.listEntries('tsdf/sess1'),
      sessionJunkExists: mockAdapter.mockIndexedDbFileView.fileExists(
        'tsdf/sess1/session-junk.txt',
      ),
      storeJunkExists: mockAdapter.mockIndexedDbFileView.fileExists(
        'tsdf/sess1/expired-doc/store-junk.txt',
      ),
      freshStoreJunkExists: mockAdapter.mockIndexedDbFileView.fileExists(
        'tsdf/sess1/fresh-doc/store-junk.txt',
      ),
      invalidOnlyStoreJunkExists: mockAdapter.mockIndexedDbFileView.fileExists(
        'tsdf/sess1/invalid-only-store/store-junk.txt',
      ),
    }).toMatchInlineSnapshot(`
      expiredStoreEntries: ['file:store-junk.txt']
      freshEntryExists: '✅'
      freshStoreEntries: ['file:d._i.r.json', 'file:d.e.p.json', 'file:store-junk.txt']
      freshStoreJunkExists: '✅'
      invalidOnlyStoreEntries: ['file:store-junk.txt']
      invalidOnlyStoreJunkExists: '✅'
      rootEntries: ['dir:sess1', 'file:root-junk.txt']
      rootJunkExists: '✅'
      sessionEntries:
        - 'dir:expired-doc'
        - 'dir:fresh-doc'
        - 'dir:invalid-only-store'
        - 'file:session-junk.txt'
      sessionJunkExists: '✅'
      storeJunkExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      17ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      23ms | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      29ms | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      34ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      40ms | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      46ms | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      51ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      57ms | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      63ms | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      68ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      74ms | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      80ms | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      85ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      91ms | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      97ms | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      2.005s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess1","fresh-doc","document"]]
      2.009s | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      2.009s | 📖 scope-state entries+namespacePolicies scope=["sess1","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      2.012s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","expired-doc","document"] keys=["document", "@scope"]
      ""
    `);
  });

  test('startup cleanup still runs when reading offline status from localStorage throws', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const expiredDoc = mockAdapter.scope('expired-doc', 'sess1');
    const freshDoc = mockAdapter.scope('fresh-doc', 'sess1');
    const expiredKey = expiredDoc.document.storageKey();
    const freshKey = freshDoc.document.storageKey();
    const offlineStatusKey = 'tsdf.sess1._o_.s';

    // Seed one expired store and one healthy sibling so the cleanup pass has to
    // keep sweeping even if the offline-status lookup is unavailable.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: staleTimestamp },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });
    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });

    const originalGetItem = localStorage.getItem.bind(localStorage);
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key: string) => {
        if (key === offlineStatusKey) {
          throw new Error('localStorage blocked');
        }

        return originalGetItem(key);
      });

    try {
      const readCapture =
        startIndexedDbPersistentStorageOperationCapture(mockAdapter);
      await waitForScheduledCleanup();
      const operationsBreakdown = readCapture.finish().timelineString;

      expect({
        expiredEntryExists: mockAdapter.has(expiredKey),
        freshEntryExists: mockAdapter.has(freshKey),
      }).toMatchInlineSnapshot(`
        expiredEntryExists: '❌'
        freshEntryExists: '✅'
      `);
      expect(operationsBreakdown).toContain(
        '🧹 del-dir recursive ✅ tsdf/sess1/expired-doc',
      );
    } finally {
      getItemSpy.mockRestore();
    }
  });

  test('startup cleanup removes malformed namespace indexes together with their entry data files', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const corruptedDoc = mockAdapter.scope('corrupted', 'sess1');
    const triggerDoc = mockAdapter.scope('trigger', 'sess1');
    const corruptedKey = corruptedDoc.document.storageKey();
    const triggerKey = triggerDoc.document.storageKey();
    const corruptedIndexPath = 'tsdf/sess1/corrupted/d._i.r.json';
    const corruptedPayloadPath = 'tsdf/sess1/corrupted/d.e.p.json';

    // Seed a valid document store, then corrupt its namespace index so cleanup
    // has to treat the whole scope as junk and delete the orphaned payload file.
    corruptedDoc.document.seed({ value: { name: 'bad', value: 1 } });
    mockAdapter.mockIndexedDbFileView.writeFile(corruptedIndexPath, '{invalid');

    // Keep a healthy sibling store in the same session so we can verify startup
    // cleanup only prunes the malformed scope.
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });
    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      corruptedExists: mockAdapter.has(corruptedKey),
      corruptedIndexFileExists:
        mockAdapter.mockIndexedDbFileView.fileExists(corruptedIndexPath),
      corruptedPayloadFileExists:
        mockAdapter.mockIndexedDbFileView.fileExists(corruptedPayloadPath),
      triggerExists: mockAdapter.has(triggerKey),
    }).toMatchInlineSnapshot(`
      corruptedExists: '✅'
      corruptedIndexFileExists: '✅'
      corruptedPayloadFileExists: '✅'
      triggerExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      15ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","corrupted","document"], ["sess1","trigger","document"]]
      21ms | 📖 scope-state entries+namespacePolicies scope=["sess1","corrupted","document"] -> keys=1 exists=yes valid=yes
      27ms | 📖 scope-state entries+namespacePolicies scope=["sess1","trigger","document"] -> keys=1 exists=yes valid=yes
      2.005s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","corrupted","document"], ["sess1","trigger","document"]]
      2.009s | 📖 scope-state entries+namespacePolicies scope=["sess1","corrupted","document"] -> keys=1 exists=yes valid=yes
      2.009s | 📖 scope-state entries+namespacePolicies scope=["sess1","trigger","document"] -> keys=1 exists=yes valid=yes
      ""
    `);
  });

  test('startup cleanup checks expiration across multiple sessions', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const sess1ExpiredDoc = mockAdapter.scope('expired-doc', 'sess1');
    const sess2ExpiredDoc = mockAdapter.scope('expired-doc', 'sess2');
    const sess2FreshDoc = mockAdapter.scope('fresh-doc', 'sess2');
    const sess1ExpiredKey = sess1ExpiredDoc.document.storageKey();
    const sess2ExpiredKey = sess2ExpiredDoc.document.storageKey();
    const sess2FreshKey = sess2FreshDoc.document.storageKey();

    // Seed stale entries in two sessions so startup cleanup has to sweep both namespaces.
    sess1ExpiredDoc.document.seed(
      { value: { name: 'sess1-stale', value: 1 } },
      { timestamp: staleTimestamp },
    );
    sess2ExpiredDoc.document.seed(
      { value: { name: 'sess2-stale', value: 2 } },
      { timestamp: staleTimestamp },
    );
    sess2FreshDoc.document.seed({ value: { name: 'sess2-fresh', value: 3 } });

    // A fresh store mount in a third session should still trigger the global cleanup pass.
    createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess-trigger' });

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      sess1ExpiredEntryExists: mockAdapter.has(sess1ExpiredKey),
      sess2ExpiredEntryExists: mockAdapter.has(sess2ExpiredKey),
      sess2FreshEntryExists: mockAdapter.has(sess2FreshKey),
    }).toMatchInlineSnapshot(`
      sess1ExpiredEntryExists: '❌'
      sess2ExpiredEntryExists: '❌'
      sess2FreshEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.007s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","expired-doc","document"], ["sess2","expired-doc","document"], ["sess2","fresh-doc","document"]]
      2.011s | 📖 scope-state entries+namespacePolicies scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes
      2.011s | 📖 scope-state entries+namespacePolicies scope=["sess2","expired-doc","document"] -> keys=1 exists=yes valid=yes
      2.011s | 📖 scope-state entries+namespacePolicies scope=["sess2","fresh-doc","document"] -> keys=1 exists=yes valid=yes
      2.014s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess1","expired-doc","document"] keys=["document", "@scope"]
      2.017s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess2","expired-doc","document"] keys=["document", "@scope"]
      ""
    `);
  });

  test('startup cleanup delete failures do not block sibling deletions and failed scopes retry on the next pass', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const failedDoc = mockAdapter.scope('failed-doc', 'sess-fail');
    const siblingDoc = mockAdapter.scope('sibling-doc', 'sess-sibling');
    const failedKey = failedDoc.document.storageKey();
    const siblingKey = siblingDoc.document.storageKey();

    failedDoc.document.seed(
      { value: { name: 'failed-stale', value: 1 } },
      { timestamp: staleTimestamp },
    );
    siblingDoc.document.seed(
      { value: { name: 'sibling-stale', value: 2 } },
      { timestamp: staleTimestamp },
    );

    mockAdapter.mockIndexedDbFileView.failRemoveEntry('tsdf/sess-fail/failed-doc');

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess-trigger' });

    const firstCleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const firstCleanupOperations = firstCleanupCapture.finish().timelineString;

    expect({
      failedEntryExistsAfterFirstCleanup: mockAdapter.has(failedKey),
      siblingEntryExistsAfterFirstCleanup: mockAdapter.has(siblingKey),
    }).toMatchInlineSnapshot(`
      failedEntryExistsAfterFirstCleanup: '❌'
      siblingEntryExistsAfterFirstCleanup: '❌'
    `);
    expect(firstCleanupOperations).toMatchInlineSnapshot(`
      ""
      2.006s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess-fail","failed-doc","document"], ["sess-sibling","sibling-doc","document"]]
      2.01s | 📖 scope-state entries+namespacePolicies scope=["sess-fail","failed-doc","document"] -> keys=1 exists=yes valid=yes
      2.01s | 📖 scope-state entries+namespacePolicies scope=["sess-sibling","sibling-doc","document"] -> keys=1 exists=yes valid=yes
      2.013s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess-fail","failed-doc","document"] keys=["document", "@scope"]
      2.016s | 🗑️ tx(entries, namespacePolicies).delete scope=["sess-sibling","sibling-doc","document"] keys=["document", "@scope"]
      ""
    `);

    mockAdapter.adapter.resetForTests?.();
    localStorage.removeItem(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY);

    createDocumentEnv({
      storeName: 'retry-trigger-doc',
      sessionKey: 'sess-retry-trigger',
    });

    const retryCleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const retryCleanupOperations = retryCleanupCapture.finish().timelineString;

    expect({
      failedEntryExistsAfterRetryCleanup: mockAdapter.has(failedKey),
      siblingEntryExistsAfterRetryCleanup: mockAdapter.has(siblingKey),
    }).toMatchInlineSnapshot(`
      failedEntryExistsAfterRetryCleanup: '❌'
      siblingEntryExistsAfterRetryCleanup: '❌'
    `);
    expect(retryCleanupOperations).toMatchInlineSnapshot(`"empty"`);
  });

  test('cleanup removes invalid or orphaned async-managed records while preserving valid entries', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const validDoc = mockAdapter.scope('valid-doc', 'sess1');
    const invalidMetadataDoc = mockAdapter.scope('invalid-metadata', 'sess1');
    const missingPayloadDoc = mockAdapter.scope('missing-payload', 'sess1');
    const validKey = validDoc.document.storageKey();
    const invalidMetadataKey = invalidMetadataDoc.document.storageKey();
    const missingPayloadKey = missingPayloadDoc.document.storageKey();

    validDoc.document.seed({ value: { name: 'valid', value: 1 } });
    invalidMetadataDoc.document.setPayload({
      d: { value: { name: 'invalid', value: 2 } },
    });
    invalidMetadataDoc.document.setMetadata({ bad: true });
    missingPayloadDoc.document.setMetadata({
      key: 'document',
      writtenAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      lastAccessAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      version: 1,
      customMetadata: {},
    });
    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      invalidMetadataExists: mockAdapter.has(invalidMetadataKey),
      invalidMetadataStorePresent: mockAdapter.mockIndexedDbFileView
        .listEntries('tsdf/sess1')
        .includes('dir:invalid-metadata'),
      missingPayloadExists: mockAdapter.has(missingPayloadKey),
      missingPayloadStorePresent: mockAdapter.mockIndexedDbFileView
        .listEntries('tsdf/sess1')
        .includes('dir:missing-payload'),
      validEntryExists: mockAdapter.has(validKey),
      validStorePresent: mockAdapter.mockIndexedDbFileView
        .listEntries('tsdf/sess1')
        .includes('dir:valid-doc'),
    }).toMatchInlineSnapshot(`
      invalidMetadataExists: '✅'
      invalidMetadataStorePresent: '✅'
      missingPayloadExists: '❌'
      missingPayloadStorePresent: '❌'
      validEntryExists: '✅'
      validStorePresent: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.006s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","invalid-metadata","document"], ["sess1","valid-doc","document"]]
      2.01s | 📖 scope-state entries+namespacePolicies scope=["sess1","invalid-metadata","document"] -> keys=1 exists=yes valid=yes
      2.01s | 📖 scope-state entries+namespacePolicies scope=["sess1","valid-doc","document"] -> keys=1 exists=yes valid=yes
      ""
    `);
  });

  test('startup cleanup keeps mixed list-query stores on record deletion when only one discovered scope is junk', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const mixedStore = mockAdapter.scope('mixed-list-query', 'sess1');
    const validDoc = mockAdapter.scope('valid-doc', 'sess1');
    const validItem = mixedStore.listQuery.seedItem('projects', 1, {
      id: 1,
      name: 'Project 1',
    });
    const invalidQueryKey = mixedStore.listQuery.seedQuery(
      { tableId: 'projects' },
      [{ tableId: 'projects', id: 1 }],
    );
    const validDocKey = validDoc.document.seed({
      value: { name: 'valid', value: 1 },
    });

    // Corrupt only the query metadata so startup cleanup has to prune the
    // query namespace while preserving the sibling item namespace in the same store.
    mockAdapter.setMetadata(invalidQueryKey, {
      customMetadata: {},
      lastAccessAt: Date.now(),
      version: 1,
    });

    createListQueryEnv({
      serverData: { projects: [{ id: 1, name: 'Project 1' }] },
      sessionKey: 'sess1',
      storeName: 'mixed-list-query',
    });
    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    expect(await getIndexedDbStructureSnapshot(mockAdapter)).toMatchInlineSnapshot(`
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
          rowCount: 3
          rows:
            - key: ['sess1', 'mixed-list-query', 'listQuery.item', '"projects||1']
              value: 'JSON object | 0.4 kb'
            - key: ['sess1', 'mixed-list-query', 'listQuery.query', '{tableId:"projects"}']
              value: 'JSON object | 0.3 kb'
            - key: ['sess1', 'valid-doc', 'document', 'document']
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
          rowCount: 0
          rows: []
      version: 1
    `);

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      mixedStoreEntries: mockAdapter.mockIndexedDbFileView.listEntries(
        'tsdf/sess1/mixed-list-query',
      ),
      mixedStorePresent: mockAdapter.mockIndexedDbFileView
        .listEntries('tsdf/sess1')
        .includes('dir:mixed-list-query'),
      queryExists: mockAdapter.has(invalidQueryKey),
      validDocExists: mockAdapter.has(validDocKey),
      validItemExists: mockAdapter.has(validItem.storageKey),
      validStorePresent: mockAdapter.mockIndexedDbFileView
        .listEntries('tsdf/sess1')
        .includes('dir:valid-doc'),
    }).toMatchInlineSnapshot(`
      mixedStoreEntries:
        - 'file:li._i.r.json'
        - 'file:li.h~2924752681.p.json'
        - 'file:lq._i.r.json'
        - 'file:lq.h~2044383828.p.json'
      mixedStorePresent: '✅'
      queryExists: '✅'
      validDocExists: '✅'
      validItemExists: '✅'
      validStorePresent: '✅'
    `);
    expect(operationsBreakdown).not.toContain(
      'tsdf/sess1/mixed-list-query (store directory)',
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      1.978s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","mixed-list-query","listQuery.item"], ["sess1","mixed-list-query","listQuery.query"], ["sess1","valid-doc","document"]]
      1.979s | 📖 scope-state entries+namespacePolicies scope=["sess1","valid-doc","document"] -> keys=1 exists=yes valid=yes
      1.979s | 📖 scope-state entries+namespacePolicies scope=["sess1","mixed-list-query","listQuery.item"] -> keys=1 exists=yes valid=yes
      1.98s | 📖 scope-state entries+namespacePolicies scope=["sess1","mixed-list-query","listQuery.query"] -> keys=1 exists=yes valid=yes
      ""
    `);
    expect(await getIndexedDbStructureSnapshot(mockAdapter)).toMatchInlineSnapshot(`
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
          rowCount: 3
          rows:
            - key: ['sess1', 'mixed-list-query', 'listQuery.item', '"projects||1']
              value: 'JSON object | 0.4 kb'
            - key: ['sess1', 'mixed-list-query', 'listQuery.query', '{tableId:"projects"}']
              value: 'JSON object | 0.3 kb'
            - key: ['sess1', 'valid-doc', 'document', 'document']
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
          rowCount: 0
          rows: []
      version: 1
    `);
  });

  test('startup cleanup removes collection entry data files that are no longer referenced by the namespace index', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope('orphan-collection', 'sess1');
    const keptItemKey = collectionScope.collection.seedItem('kept-user', {
      value: { id: 'kept-user', name: 'Kept User' },
    });
    const orphanedItemKey = collectionScope.collection.seedItem('orphan-user', {
      value: { id: 'orphan-user', name: 'Orphan User' },
    });

    // Drop one item from the namespace index while leaving its entry data file
    // behind so startup cleanup has to prune the orphaned record.
    mockAdapter.removeMetadata(orphanedItemKey);

    createCollectionEnv({
      storeName: 'orphan-collection',
      sessionKey: 'sess1',
    });

    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      keptPayloadExists: mockAdapter.has(keptItemKey),
      namespaceRecords: (
        await mockAdapter.rawNamespace.listKeys(collectionScope.collection.namespace)
      ).sort(),
      orphanedPayloadFileExists: mockAdapter.mockIndexedDbFileView.fileExists(
        'tsdf/sess1/orphan-collection/ci.%22orphan-user.p.json',
      ),
    }).toMatchInlineSnapshot(`
      keptPayloadExists: '✅'
      namespaceRecords: ['__tsdf_payload__:"kept-user', '_i']
      orphanedPayloadFileExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      2.001s | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess1","orphan-collection","collection.item"]]
      2.003s | 📖 scope-state entries+namespacePolicies scope=["sess1","orphan-collection","collection.item"] -> keys=1 exists=yes valid=yes
      ""
    `);

    expect(await getIndexedDbStructureSnapshot(mockAdapter)).toMatchInlineSnapshot(`
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
            - key: ['sess1', 'orphan-collection', 'collection.item', '"kept-user']
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
      await getParsedIndexedDbRecordData(mockAdapter, {
        key: ['sess1', 'orphan-collection', 'collection.item', collectionScope.collection.itemKey('kept-user')],
        storeName: 'entries',
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689600000

      d:
        d:
          value: { id: 'kept-user', name: 'Kept User' }
        p: 'kept-user'

      k: '"kept-user'
      m: { p: 'kept-user' }
      n: 'orphan-collection'
      o: 0
      s: 'sess1'
      t: 'collection.item'
      v: 1
    `);
  });

  test('offline dotted-session startup cleanup keeps stale cached entries while pruning invalid stray keys', async () => {
    const staleDurationMs = 15 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const offlineNetwork = createOfflineNetworkMock();
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const protectedDoc = mockAdapter.scope('protected-doc', dottedSessionKey);
    const unprotectedDoc = mockAdapter.scope(
      'unprotected-doc',
      dottedSessionKey,
    );
    const invalidStrayDoc = mockAdapter.scope(
      'invalid-stray',
      dottedSessionKey,
    );
    const protectedDocStorageKey = protectedDoc.document.storageKey();
    const unprotectedDocStorageKey = unprotectedDoc.document.storageKey();

    // Seed two cached dotted-session entries through normal store fetch/persist flows.
    const protectedSeedEnv = createDocumentEnv({
      storeName: 'protected-doc',
      sessionKey: dottedSessionKey,
      serverData: { name: 'protected', value: 1 },
    });
    protectedSeedEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    const unprotectedSeedEnv = createDocumentEnv({
      storeName: 'unprotected-doc',
      sessionKey: dottedSessionKey,
      serverData: { name: 'unprotected', value: 2 },
    });
    unprotectedSeedEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Move far enough forward that both cached entries are stale before the real cleanup pass.
    await advanceTime(staleDurationMs);

    // Let a real offline-enabled store register the protected document key for this session.
    offlineNetwork.install();
    offlineNetwork.setOffline();

    const protectedDocEnv = createDocumentStoreTestEnv<
      { name: string; value: number },
      ProtectedDocumentOfflineOperations
    >(
      { name: 'protected', value: 1 },
      {
        id: 'protected-doc',
        getSessionKey: () => dottedSessionKey,
        testScenario: 'loaded',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          adapter: mockAdapter.adapter,
          schema: wrappedDocumentSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => dottedSessionKey,
              config: { network: offlineNetwork.config },
            }),
            operations: {
              markProtected: {
                inputSchema: rc_object({ value: rc_number }),
                kind: 'update',
                execute: ({ input }) => input,
                onSuccessExecute: ({ input }) => {
                  protectedDocEnv.apiStore.updateState((draft) => {
                    draft.value.value = input.value;
                  });
                },
              },
            },
          },
        },
      },
    );

    await Promise.resolve();
    offlineNetwork.goOffline();
    await Promise.resolve();

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const protectMutationResult = await resolveAfterAllTimers(
      protectedDocEnv.apiStore.performMutation({
        mutation: () => Promise.resolve({ name: 'protected', value: 1 }),
        offline: { operation: 'markProtected', input: { value: 1 } },
      }),
    );
    randomSpy.mockRestore();

    invalidStrayDoc.document.setPayload({
      d: { value: { name: 'invalid', value: 99 } },
    });
    invalidStrayDoc.document.setMetadata('{invalid');

    expect(protectMutationResult.ok).toBe(true);

    // Simulate a reload so cleanup must rely on the persisted metadata marker.
    clearSessionProtectedKeysSnapshot(dottedSessionKey);

    // Re-arm the one-off startup cleanup so this same test can trigger a fresh scan after protection is registered.
    resetExpirationScanTracking();

    // A fresh entry in another session triggers the scheduled global cleanup pass.
    const triggerDoc = mockAdapter.scope('trigger-doc', 'sess-trigger');
    const triggerDocEnv = createDocumentStoreTestEnv(
      { name: 'trigger', value: 3 },
      {
        id: 'trigger-doc',
        getSessionKey: () => 'sess-trigger',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          adapter: mockAdapter.adapter,
          schema: wrappedDocumentSchema,
        },
      },
    );
    triggerDocEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Let the trigger store finish its own async persistence before we start
    // capturing, so the timeline only shows the cleanup sweep it scheduled.
    for (let attempt = 0; attempt < 300; attempt++) {
      if (mockAdapter.has(triggerDoc.document.storageKey())) break;
      await advanceTime(10);
    }

    expect(mockAdapter.has(triggerDoc.document.storageKey())).toBe(true);

    // Capture the full sweep so the snapshot shows offline startup preserving
    // the stale cached entries while pruning invalid junk.
    const localStorageCapture = startPersistentStorageOperationCapture();
    const readCapture = startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    // Offline startup should preserve both stale cached documents, while still
    // pruning the unrelated invalid stray store discovered during the sweep.
    expect({
      invalidStrayExists: mockAdapter.has(
        invalidStrayDoc.document.storageKey(),
      ),
      invalidStrayEntries: mockAdapter.mockIndexedDbFileView.listEntries(
        'tsdf/user%40example.com/invalid-stray',
      ),
      protectedEntryExists: mockAdapter.has(protectedDocStorageKey),
      unprotectedEntryExists: mockAdapter.has(unprotectedDocStorageKey),
    }).toMatchInlineSnapshot(`
      invalidStrayEntries: ['file:d._i.r.json', 'file:d.e.p.json']
      invalidStrayExists: '✅'
      protectedEntryExists: '✅'
      unprotectedEntryExists: '✅'
    `);
    expect(localStorageOperations).toMatchInlineSnapshot(`"empty"`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      ""
      8ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess-trigger","trigger-doc","document"], ["user@example.com","invalid-stray","document"], ["user@example.com","protected-doc","document"], ["user@example.com","protected-doc","offline.entity"], ["user@example.com","protected-doc","offline.queue"], ["user@example.com","unprotected-doc","document"]]
      8ms | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=* -> [["sess-trigger","trigger-doc","document"], ["user@example.com","invalid-stray","document"], ["user@example.com","protected-doc","document"], ["user@example.com","protected-doc","offline.entity"], ["user@example.com","protected-doc","offline.queue"], ["user@example.com","unprotected-doc","document"]]
      14ms | 📖 scope-state entries+namespacePolicies scope=["sess-trigger","trigger-doc","document"] -> keys=1 exists=yes valid=yes
      14ms | 📖 scope-state entries+namespacePolicies scope=["sess-trigger","trigger-doc","document"] -> keys=1 exists=yes valid=yes
      20ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","invalid-stray","document"] -> keys=1 exists=yes valid=yes
      20ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","invalid-stray","document"] -> keys=1 exists=yes valid=yes
      26ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","protected-doc","document"] -> keys=1 exists=yes valid=yes
      26ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","protected-doc","document"] -> keys=1 exists=yes valid=yes
      32ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","unprotected-doc","document"] -> keys=1 exists=yes valid=yes
      32ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","unprotected-doc","document"] -> keys=1 exists=yes valid=yes
      38ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","protected-doc","offline.entity"] -> keys=1 exists=yes valid=yes
      38ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","protected-doc","offline.entity"] -> keys=1 exists=yes valid=yes
      44ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","protected-doc","offline.queue"] -> keys=1 exists=yes valid=yes
      44ms | 📖 scope-state entries+namespacePolicies scope=["user@example.com","protected-doc","offline.queue"] -> keys=1 exists=yes valid=yes
      ""
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1735689602008`);
    expect(
      await getParsedIndexedDbRecordData(mockAdapter, {
        key: ['user@example.com', 'protected-doc', 'document', 'document'],
        storeName: 'entries',
      }),
    ).toMatchInlineSnapshot(`
      a: 1735689601871

      d:
        d:
          value: { name: 'protected', value: 1 }

      k: 'document'
      m: { o: '✅' }
      n: 'protected-doc'
      o: 1
      s: 'user@example.com'
      t: 'document'
      v: 1
    `);
  });
});
