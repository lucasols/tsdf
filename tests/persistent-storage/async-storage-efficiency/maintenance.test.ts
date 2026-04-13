import { rc_number, rc_object } from 'runcheck';
import { describe, expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../../src/main';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../../src/persistentStorage/asyncStorageAdapter';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../../src/persistentStorage/documentEntryKey';
import { clearSessionProtectedKeysSnapshot } from '../../../src/persistentStorage/offline/sessionProtectionRegistry';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import { opfsPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../../src/storeManager';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import { normalizeError } from '../../mocks/testEnvUtils';
import {
  advanceTime,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getOpfsDirTree,
  getParsedLocalStorageValue,
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
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

describe('async storage efficiency: maintenance', () => {
  test('startup cleanup removes expired entries and snapshots the full metadata scan history', async () => {
    const oneWeekAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const startupOperations = startupReadCapture.finish().timelineString;

    expect(startupOperations).toMatchInlineSnapshot(`"empty"`);

    // Once the scheduled sweep runs, snapshot the complete maintenance history.
    const localStorageCapture = startPersistentStorageOperationCapture();
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      2.005s | 📖 #2 ❌ tsdf.sess1._o_.s (entry data)
      2.009s | ✍️ #1 ❌->✅ tsdf._am.g (async global maintenance) | ❌ -> 0.04 kb
      "
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:expired-doc","dir:fresh-doc"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/expired-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      .      | 🗂️ list-dir-entries tsdf/sess1/fresh-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 📖 #1 tsdf/sess1/expired-doc/d._i.r.json (namespace index) | 0.06 kb
      .      | 📖 #2 tsdf/sess1/fresh-doc/d._i.r.json (namespace index) | 0.06 kb
      2.008s | 🧹 del-dir recursive ✅ tsdf/sess1/expired-doc (store directory)
      2.009s | end
      "
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1735689602009`);
  });

  test('startup cleanup deletes invalid OPFS entries while keeping valid stores', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
    mockAdapter.mockBrowserOpfs.writeFile('tsdf/root-junk.txt', 'bad');
    mockAdapter.mockBrowserOpfs.writeFile('tsdf/sess1/session-junk.txt', 'bad');
    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/expired-doc/store-junk.txt',
      'bad',
    );
    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/fresh-doc/store-junk.txt',
      'bad',
    );
    mockAdapter.mockBrowserOpfs.writeFile(
      'tsdf/sess1/invalid-only-store/store-junk.txt',
      'bad',
    );

    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredStoreEntries: mockAdapter.mockBrowserOpfs.listEntries(
        'tsdf/sess1/expired-doc',
      ),
      freshEntryExists: mockAdapter.has(freshKey),
      freshStoreEntries: mockAdapter.mockBrowserOpfs.listEntries(
        'tsdf/sess1/fresh-doc',
      ),
      invalidOnlyStoreEntries: mockAdapter.mockBrowserOpfs.listEntries(
        'tsdf/sess1/invalid-only-store',
      ),
      rootEntries: mockAdapter.mockBrowserOpfs.listEntries('tsdf'),
      rootJunkExists:
        mockAdapter.mockBrowserOpfs.fileExists('tsdf/root-junk.txt'),
      sessionEntries: mockAdapter.mockBrowserOpfs.listEntries('tsdf/sess1'),
      sessionJunkExists: mockAdapter.mockBrowserOpfs.fileExists(
        'tsdf/sess1/session-junk.txt',
      ),
      storeJunkExists: mockAdapter.mockBrowserOpfs.fileExists(
        'tsdf/sess1/expired-doc/store-junk.txt',
      ),
      freshStoreJunkExists: mockAdapter.mockBrowserOpfs.fileExists(
        'tsdf/sess1/fresh-doc/store-junk.txt',
      ),
      invalidOnlyStoreJunkExists: mockAdapter.mockBrowserOpfs.fileExists(
        'tsdf/sess1/invalid-only-store/store-junk.txt',
      ),
    }).toMatchInlineSnapshot(`
      expiredStoreEntries: []
      freshEntryExists: '✅'
      freshStoreEntries: ['file:d._i.r.json', 'file:d.e.p.json']
      freshStoreJunkExists: '❌'
      invalidOnlyStoreEntries: []
      invalidOnlyStoreJunkExists: '❌'
      rootEntries: ['dir:sess1']
      rootJunkExists: '❌'
      sessionEntries: ['dir:fresh-doc']
      sessionJunkExists: '❌'
      storeJunkExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf
             |    └ (root directory) entries=["dir:sess1","file:root-junk.txt"]
      2.003s | 🗑️ #1 ✅ tsdf/root-junk.txt (untracked root file)
      2.004s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:expired-doc","dir:fresh-doc","dir:invalid-only-store","file:session-junk.txt"]
      2.005s | 🗑️ #2 ✅ tsdf/sess1/session-junk.txt (untracked session file)
      2.006s | 🗂️ list-dir-entries tsdf/sess1/expired-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json","file:store-junk.txt"]
      .      | 🗂️ list-dir-entries tsdf/sess1/fresh-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json","file:store-junk.txt"]
      .      | 🗂️ list-dir-entries tsdf/sess1/invalid-only-store
             |    └ (store directory) entries=["file:store-junk.txt"]
      2.007s | 🗑️ #3 ✅ tsdf/sess1/expired-doc/store-junk.txt
             |    └ (untracked store file)
      2.008s | 🗑️ #4 ✅ tsdf/sess1/fresh-doc/store-junk.txt (untracked store file)
      2.009s | 🗑️ #5 ✅ tsdf/sess1/invalid-only-store/store-junk.txt
             |    └ (untracked store file)
      2.01s  | 🧹 del-dir recursive ✅ tsdf/sess1/invalid-only-store
             |    └ (store directory)
      2.011s | 📖 #6 tsdf/sess1/expired-doc/d._i.r.json (namespace index) | 0.06 kb
      .      | 📖 #7 tsdf/sess1/fresh-doc/d._i.r.json (namespace index) | 0.06 kb
      2.014s | 🧹 del-dir recursive ✅ tsdf/sess1/expired-doc (store directory)
      2.015s | end
      "
    `);
  });

  test('startup cleanup still runs when reading offline status from localStorage throws', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
        startOpfsPersistentStorageOperationCapture(mockAdapter);
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
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const corruptedDoc = mockAdapter.scope('corrupted', 'sess1');
    const triggerDoc = mockAdapter.scope('trigger', 'sess1');
    const corruptedKey = corruptedDoc.document.storageKey();
    const triggerKey = triggerDoc.document.storageKey();
    const corruptedIndexPath = 'tsdf/sess1/corrupted/d._i.r.json';
    const corruptedPayloadPath = 'tsdf/sess1/corrupted/d.e.p.json';

    // Seed a valid document store, then corrupt its namespace index so cleanup
    // has to treat the whole scope as junk and delete the orphaned payload file.
    corruptedDoc.document.seed({ value: { name: 'bad', value: 1 } });
    mockAdapter.mockBrowserOpfs.writeFile(corruptedIndexPath, '{invalid');

    // Keep a healthy sibling store in the same session so we can verify startup
    // cleanup only prunes the malformed scope.
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });
    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      corruptedExists: mockAdapter.has(corruptedKey),
      corruptedIndexFileExists:
        mockAdapter.mockBrowserOpfs.fileExists(corruptedIndexPath),
      corruptedPayloadFileExists:
        mockAdapter.mockBrowserOpfs.fileExists(corruptedPayloadPath),
      triggerExists: mockAdapter.has(triggerKey),
    }).toMatchInlineSnapshot(`
      corruptedExists: '❌'
      corruptedIndexFileExists: '❌'
      corruptedPayloadFileExists: '❌'
      triggerExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:corrupted","dir:trigger"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/corrupted
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      .      | 🗂️ list-dir-entries tsdf/sess1/trigger
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 📖 #1 tsdf/sess1/corrupted/d._i.r.json (namespace index) | 0.02 kb
      .      | 📖 #2 tsdf/sess1/trigger/d._i.r.json (namespace index) | 0.06 kb
      2.008s | 🧹 del-dir recursive ✅ tsdf/sess1/corrupted (store directory)
      2.009s | end
      "
    `);
  });

  test('startup cleanup checks expiration across multiple sessions', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
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
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf
             |    └ (root directory) entries=["dir:sess1","dir:sess2"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:expired-doc"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/expired-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 🗂️ list-dir-values tsdf/sess2
             |    └ (session directory) entries=["dir:expired-doc","dir:fresh-doc"]
      2.006s | 🗂️ list-dir-entries tsdf/sess2/expired-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      .      | 🗂️ list-dir-entries tsdf/sess2/fresh-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.007s | 📖 #1 tsdf/sess1/expired-doc/d._i.r.json (namespace index) | 0.06 kb
      .      | 📖 #2 tsdf/sess2/expired-doc/d._i.r.json (namespace index) | 0.06 kb
      .      | 📖 #3 tsdf/sess2/fresh-doc/d._i.r.json (namespace index) | 0.06 kb
      2.01s  | 🧹 del-dir recursive ✅ tsdf/sess1/expired-doc (store directory)
      .      | 🧹 del-dir recursive ✅ tsdf/sess2/expired-doc (store directory)
      2.011s | 🧹 del-dir recursive ✅ tsdf/sess1 (session directory)
      2.012s | end
      "
    `);
  });

  test('startup cleanup delete failures do not block sibling deletions and failed scopes retry on the next pass', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    mockAdapter.mockBrowserOpfs.failRemoveEntry('tsdf/sess-fail/failed-doc');

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess-trigger' });

    const firstCleanupCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const firstCleanupOperations = firstCleanupCapture.finish().timelineString;

    expect({
      failedEntryExistsAfterFirstCleanup: mockAdapter.has(failedKey),
      siblingEntryExistsAfterFirstCleanup: mockAdapter.has(siblingKey),
    }).toMatchInlineSnapshot(`
      failedEntryExistsAfterFirstCleanup: '✅'
      siblingEntryExistsAfterFirstCleanup: '❌'
    `);
    expect(firstCleanupOperations).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf
             |    └ (root directory) entries=["dir:sess-fail","dir:sess-sibling"]
      2.003s | 🗂️ list-dir-values tsdf/sess-fail
             |    └ (session directory) entries=["dir:failed-doc"]
      2.004s | 🗂️ list-dir-entries tsdf/sess-fail/failed-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 🗂️ list-dir-values tsdf/sess-sibling
             |    └ (session directory) entries=["dir:sibling-doc"]
      2.006s | 🗂️ list-dir-entries tsdf/sess-sibling/sibling-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.007s | 📖 #1 tsdf/sess-fail/failed-doc/d._i.r.json
             |    └ (namespace index) | 0.06 kb
      .      | 📖 #2 tsdf/sess-sibling/sibling-doc/d._i.r.json
             |    └ (namespace index) | 0.06 kb
      2.01s  | 🧹 del-dir recursive ❌ tsdf/sess-fail/failed-doc (store directory)
      .      | 🧹 del-dir recursive ✅ tsdf/sess-sibling/sibling-doc
             |    └ (store directory)
      2.011s | 🧹 del-dir recursive ✅ tsdf/sess-sibling (session directory)
      2.012s | end
      "
    `);

    opfsPersistentStorage.resetForTests?.();
    localStorage.removeItem(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY);

    createDocumentEnv({
      storeName: 'retry-trigger-doc',
      sessionKey: 'sess-retry-trigger',
    });

    const retryCleanupCapture =
      startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const retryCleanupOperations = retryCleanupCapture.finish().timelineString;

    expect({
      failedEntryExistsAfterRetryCleanup: mockAdapter.has(failedKey),
      siblingEntryExistsAfterRetryCleanup: mockAdapter.has(siblingKey),
    }).toMatchInlineSnapshot(`
      failedEntryExistsAfterRetryCleanup: '❌'
      siblingEntryExistsAfterRetryCleanup: '❌'
    `);
    expect(retryCleanupOperations).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess-fail"]
      2.003s | 🗂️ list-dir-values tsdf/sess-fail
             |    └ (session directory) entries=["dir:failed-doc"]
      2.004s | 🗂️ list-dir-entries tsdf/sess-fail/failed-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 📖 #1 tsdf/sess-fail/failed-doc/d._i.r.json
             |    └ (namespace index) | 0.06 kb
      2.008s | 🧹 del-dir recursive ✅ tsdf/sess-fail/failed-doc (store directory)
      2.009s | 🧹 del-dir recursive ✅ tsdf/sess-fail (session directory)
      2.01s  | end
      "
    `);
  });

  test('cleanup removes invalid or orphaned async-managed records while preserving valid entries', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
      key: DOCUMENT_PERSISTED_ENTRY_KEY,
      writtenAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      lastAccessAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
      version: 1,
      customMetadata: {},
    });
    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      invalidMetadataExists: mockAdapter.has(invalidMetadataKey),
      invalidMetadataStorePresent: mockAdapter.mockBrowserOpfs
        .listEntries('tsdf/sess1')
        .includes('dir:invalid-metadata'),
      missingPayloadExists: mockAdapter.has(missingPayloadKey),
      missingPayloadStorePresent: mockAdapter.mockBrowserOpfs
        .listEntries('tsdf/sess1')
        .includes('dir:missing-payload'),
      validEntryExists: mockAdapter.has(validKey),
      validStorePresent: mockAdapter.mockBrowserOpfs
        .listEntries('tsdf/sess1')
        .includes('dir:valid-doc'),
    }).toMatchInlineSnapshot(`
      invalidMetadataExists: '❌'
      invalidMetadataStorePresent: '❌'
      missingPayloadExists: '❌'
      missingPayloadStorePresent: '❌'
      validEntryExists: '✅'
      validStorePresent: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:invalid-metadata","dir:missing-payload","dir:valid-doc"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/invalid-metadata
             |    └ (store directory) entries=["file:d.e.p.json"]
      .      | 🗂️ list-dir-entries tsdf/sess1/missing-payload
             |    └ (store directory) entries=["file:d._i.r.json"]
      .      | 🗂️ list-dir-entries tsdf/sess1/valid-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 📖 #1 tsdf/sess1/missing-payload/d._i.r.json
             |    └ (namespace index) | 0.06 kb
      .      | 📖 #2 tsdf/sess1/valid-doc/d._i.r.json (namespace index) | 0.06 kb
      2.008s | 🧹 del-dir recursive ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 🧹 del-dir recursive ✅ tsdf/sess1/missing-payload (store directory)
      2.009s | end
      "
    `);
  });

  test('startup cleanup keeps mixed list-query stores on record deletion when only one discovered scope is junk', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.69 kb)
      └ sess1 (0.68 kb)
        ├ mixed-list-query (0.48 kb)
        │ ├ li._i.r.json (0.16 kb)
        │ ├ li.h~2924752681.p.json (0.10 kb)
        │ ├ lq._i.r.json (0.13 kb)
        │ └ lq.h~2044383828.p.json (0.08 kb)
        └ valid-doc (0.19 kb)
          ├ d._i.r.json (0.08 kb)
          └ d.e.p.json (0.09 kb)"
    `);

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      mixedStoreEntries: mockAdapter.mockBrowserOpfs.listEntries(
        'tsdf/sess1/mixed-list-query',
      ),
      mixedStorePresent: mockAdapter.mockBrowserOpfs
        .listEntries('tsdf/sess1')
        .includes('dir:mixed-list-query'),
      queryExists: mockAdapter.has(invalidQueryKey),
      validDocExists: mockAdapter.has(validDocKey),
      validItemExists: mockAdapter.has(validItem.storageKey),
      validStorePresent: mockAdapter.mockBrowserOpfs
        .listEntries('tsdf/sess1')
        .includes('dir:valid-doc'),
    }).toMatchInlineSnapshot(`
      mixedStoreEntries: ['file:li._i.r.json', 'file:li.h~2924752681.p.json']
      mixedStorePresent: '✅'
      queryExists: '❌'
      validDocExists: '✅'
      validItemExists: '✅'
      validStorePresent: '✅'
    `);
    expect(operationsBreakdown).not.toContain(
      'tsdf/sess1/mixed-list-query (store directory)',
    );
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:mixed-list-query","dir:valid-doc"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/mixed-list-query
             |    └ (store directory) entries=["file:li._i.r.json","file:li.h~2924752681.p.json","file:lq._i.r.json","file:lq.h~2044383828.p.json"]
      .      | 🗂️ list-dir-entries tsdf/sess1/valid-doc
             |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      2.005s | 📖 #1 tsdf/sess1/mixed-list-query/li._i.r.json
             |    └ (items index) | 0.13 kb
      2.008s | 📖 #2 tsdf/sess1/mixed-list-query/lq._i.r.json
             |    └ (queries index) | 0.10 kb
      2.011s | 📖 #3 tsdf/sess1/valid-doc/d._i.r.json (namespace index) | 0.06 kb
      2.014s | 🗑️ #4 ✅ tsdf/sess1/mixed-list-query/lq.h~2044383828.p.json
             |    └ (query data, <{tableId:"projects"}>)
      .      | 🗑️ #2 ✅ tsdf/sess1/mixed-list-query/lq._i.r.json (queries index)
      2.015s | end
      "
    `);
    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.55 kb)
      ├ sess1 (0.48 kb)
      │ ├ mixed-list-query (0.28 kb)
      │ │ ├ li._i.r.json (0.16 kb)
      │ │ └ li.h~2924752681.p.json (0.10 kb)
      │ └ valid-doc (0.19 kb)
      │   ├ d._i.r.json (0.08 kb)
      │   └ d.e.p.json (0.09 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
  });

  test('startup cleanup removes collection entry data files that are no longer referenced by the namespace index', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
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

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      keptPayloadExists: mockAdapter.has(keptItemKey),
      namespaceRecords: mockAdapter.rawNamespace
        .listKeys(collectionScope.collection.namespace)
        .sort(),
      orphanedPayloadFileExists: mockAdapter.mockBrowserOpfs.fileExists(
        'tsdf/sess1/orphan-collection/ci.%22orphan-user.p.json',
      ),
    }).toMatchInlineSnapshot(`
      keptPayloadExists: '✅'
      namespaceRecords: ['_i']
      orphanedPayloadFileExists: '❌'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir-values tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir-values tsdf/sess1
             |    └ (session directory) entries=["dir:orphan-collection"]
      2.004s | 🗂️ list-dir-entries tsdf/sess1/orphan-collection
             |    └ (store directory) entries=["file:ci._i.r.json","file:ci.h~1706329294.p.json","file:ci.h~2293725328.p.json"]
      2.005s | 📖 #1 tsdf/sess1/orphan-collection/ci._i.r.json
             |    └ (namespace index) | 0.13 kb
      2.008s | 🗑️ #2 ✅ tsdf/sess1/orphan-collection/ci.h~2293725328.p.json
             |    └ (entry data)
      2.009s | end
      "
    `);

    expect(getOpfsDirTree(mockAdapter)).toMatchInlineSnapshot(`
      "tsdf (0.40 kb)
      ├ sess1 (0.33 kb)
      │ └ orphan-collection (0.32 kb)
      │   ├ ci._i.r.json (0.15 kb)
      │   └ ci.h~1706329294.p.json (0.13 kb)
      └ tsdf._am.g* (0.06 kb)"
    `);
    expect(getParsedOpfsFileData('tsdf/sess1/orphan-collection/ci._i.r.json'))
      .toMatchInlineSnapshot(`
        e:
          "kept-user: { a: 1735689600000, p: 'kept-user', z: 82 }
      `);
  });

  test('offline dotted-session startup cleanup keeps stale cached entries while pruning invalid stray keys', async () => {
    const staleDurationMs = 15 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const offlineNetwork = createOfflineNetworkMock();
    const mockAdapter = createOpfsPersistentStorageTestStore();
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
        storeManager: createStoreManager({
          errorNormalizer: normalizeError,
          getSessionKey: () => dottedSessionKey,
          offlineSession: { network: offlineNetwork.config },
        }),
        testScenario: 'loaded',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          adapter: opfsPersistentStorage,
          schema: wrappedDocumentSchema,
          offline: {
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
          adapter: opfsPersistentStorage,
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
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    // Offline startup should preserve both stale cached documents, while still
    // pruning the unrelated invalid stray store discovered during the sweep.
    expect({
      invalidStrayExists: mockAdapter.has(
        invalidStrayDoc.document.storageKey(),
      ),
      invalidStrayEntries: mockAdapter.mockBrowserOpfs.listEntries(
        'tsdf/user%40example.com/invalid-stray',
      ),
      protectedEntryExists: mockAdapter.has(protectedDocStorageKey),
      unprotectedEntryExists: mockAdapter.has(unprotectedDocStorageKey),
    }).toMatchInlineSnapshot(`
      invalidStrayEntries: []
      invalidStrayExists: '❌'
      protectedEntryExists: '✅'
      unprotectedEntryExists: '✅'
    `);
    expect(localStorageOperations).toMatchInlineSnapshot(`
      "
      time  |
      130ms | 📖 #1 ✅ tsdf._am.g (async global maintenance) | 0.04 kb
      135ms | 📖 #2 ❌ tsdf.sess-trigger._o_.s (entry data)
      .     | 📖 #3 ✅ tsdf.user@example.com._o_.s (entry data) | 0.08 kb
      139ms | ✍️ #1 ✅->✅ tsdf._am.g
            |    └ (async global maintenance) | 0.04 kb -> 0.04 kb
      "
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      130ms | 🗂️ list-dir-values tsdf
            |    └ (root directory) entries=["dir:sess-trigger","dir:user%40example.com"]
      131ms | 🗂️ list-dir-values tsdf/sess-trigger
            |    └ (session directory) entries=["dir:trigger-doc"]
      132ms | 🗂️ list-dir-entries tsdf/sess-trigger/trigger-doc
            |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      133ms | 🗂️ list-dir-values tsdf/user%40example.com
            |    └ (session directory) entries=["dir:invalid-stray","dir:protected-doc","dir:unprotected-doc"]
      134ms | 🗂️ list-dir-entries tsdf/user%40example.com/invalid-stray
            |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      .     | 🗂️ list-dir-entries tsdf/user%40example.com/protected-doc
            |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json","file:oe._i.r.json","file:oe.document.p.json","file:oq._i.r.json","file:oq.protected-doc%3A1736985603621%3A4fzzzxjy.p.json"]
      .     | 🗂️ list-dir-entries tsdf/user%40example.com/unprotected-doc
            |    └ (store directory) entries=["file:d._i.r.json","file:d.e.p.json"]
      135ms | 📖 #1 tsdf/sess-trigger/trigger-doc/d._i.r.json
            |    └ (namespace index) | 0.06 kb
      .     | 📖 #2 tsdf/user%40example.com/invalid-stray/d._i.r.json
            |    └ (namespace index) | 0.02 kb
      .     | 📖 #3 tsdf/user%40example.com/protected-doc/d._i.r.json
            |    └ (namespace index) | 0.08 kb
      .     | 📖 #4 tsdf/user%40example.com/protected-doc/oe._i.r.json
            |    └ (namespace index) | 0.09 kb
      .     | 📖 #5 tsdf/user%40example.com/protected-doc/oq._i.r.json
            |    └ (namespace index) | 0.14 kb
      .     | 📖 #6 tsdf/user%40example.com/unprotected-doc/d._i.r.json
            |    └ (namespace index) | 0.06 kb
      138ms | 🧹 del-dir recursive ✅ tsdf/user%40example.com/invalid-stray
            |    └ (store directory)
      139ms | end
      "
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1736985605681`);
    expect(
      getParsedOpfsFileData('tsdf/user%40example.com/protected-doc/d.e.p.json'),
    ).toMatchInlineSnapshot(`value: { name: 'protected', value: 1 }`);
  });
});
