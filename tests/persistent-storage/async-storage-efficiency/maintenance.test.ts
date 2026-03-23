import { rc_number, rc_object } from 'runcheck';
import { describe, expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../../src/main';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../../src/persistentStorage/asyncStorageAdapter';
import { clearSessionProtectedKeysSnapshot } from '../../../src/persistentStorage/offline/sessionProtectionRegistry';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import { opfsPersistentStorage } from '../../../src/persistentStorage/storageAdapter';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import {
  advanceTime,
  resolveAfterAllTimers,
} from '../../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../../utils/networkMock';
import { createOpfsPersistentStorageTestStore } from '../../utils/opfsPersistentStorageTestStore';
import {
  getParsedLocalStorageValue,
  getParsedOpfsFileData,
  startOpfsPersistentStorageOperationCapture,
  startPersistentStorageOperationCapture,
} from '../../utils/persistentStorageOptimizationTestUtils';
import {
  createDocumentEnv,
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
    expect(localStorageOperations).toMatchInlineSnapshot(`
      "
      time   |
      2s     | 📖 ❌ #1 tsdf._am.g (async global maintenance)
      2.011s | ✍️ ❌->✅ #1 tsdf._am.g (async global maintenance) | ❌ -> 0.04 kb
      "
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:expired-doc","dir:fresh-doc"]
      2.004s | 🗂️ list-dir tsdf/sess1/expired-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      .      | 🗂️ list-dir tsdf/sess1/fresh-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      2.005s | 📄 file-open ✅ #1 tsdf/sess1/expired-doc/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #2 tsdf/sess1/fresh-doc/d.e.m.json (metadata)
      2.007s | 📖 #1 tsdf/sess1/expired-doc/d.e.m.json (metadata) | 0.05 kb
      .      | 📖 #2 tsdf/sess1/fresh-doc/d.e.m.json (metadata) | 0.05 kb
      2.009s | 🗑️ ✅ #3 tsdf/sess1/expired-doc/d.e.p.json (payload)
      .      | 🗑️ ✅ #1 tsdf/sess1/expired-doc/d.e.m.json (metadata)
      2.01s  | 🧹 del-dir ✅ tsdf/sess1/expired-doc (store directory)
      2.011s | end
      "
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1735689602011`);
  });

  test('startup cleanup removes malformed metadata entries together with their payload files', async () => {
    const mockAdapter = createOpfsPersistentStorageTestStore();
    const corruptedDoc = mockAdapter.scope('corrupted', 'sess1');
    const triggerDoc = mockAdapter.scope('trigger', 'sess1');
    const corruptedKey = corruptedDoc.document.storageKey();
    const triggerKey = triggerDoc.document.storageKey();
    const corruptedMetadataPath = 'tsdf/sess1/corrupted/d.e.m.json';
    const corruptedPayloadPath = 'tsdf/sess1/corrupted/d.e.p.json';

    // Seed a broken metadata record and its payload. Cleanup should treat the
    // pair as orphaned data and delete both files in one pass.
    corruptedDoc.document.setPayload({
      d: { value: { name: 'bad', value: 1 } },
    });
    corruptedDoc.document.setMetadata('{invalid');

    // Seed a valid store in the same session so startup cleanup discovers the
    // namespace and we can verify healthy entries are preserved.
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });
    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      corruptedExists: mockAdapter.has(corruptedKey),
      corruptedMetadataFileExists: mockAdapter.mockBrowserOpfs.fileExists(
        corruptedMetadataPath,
      ),
      corruptedPayloadFileExists:
        mockAdapter.mockBrowserOpfs.fileExists(corruptedPayloadPath),
      triggerExists: mockAdapter.has(triggerKey),
    }).toMatchInlineSnapshot(`
      corruptedExists: '❌'
      corruptedMetadataFileExists: '❌'
      corruptedPayloadFileExists: '❌'
      triggerExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:corrupted","dir:trigger"]
      2.004s | 🗂️ list-dir tsdf/sess1/corrupted
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      .      | 🗂️ list-dir tsdf/sess1/trigger
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      2.005s | 📄 file-open ✅ #1 tsdf/sess1/corrupted/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #2 tsdf/sess1/trigger/d.e.m.json (metadata)
      2.007s | 📖 #1 tsdf/sess1/corrupted/d.e.m.json (metadata) | 0.02 kb
      .      | 📖 #2 tsdf/sess1/trigger/d.e.m.json (metadata) | 0.05 kb
      2.009s | 🗑️ ✅ #3 tsdf/sess1/corrupted/d.e.p.json (payload)
      .      | 🗑️ ✅ #1 tsdf/sess1/corrupted/d.e.m.json (metadata)
      2.01s  | 🧹 del-dir ✅ tsdf/sess1/corrupted (store directory)
      2.011s | end
      "
    `);
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
      freshStoreEntries: ['file:d.e.m.json', 'file:d.e.p.json']
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
      2.002s | 🗂️ list-dir tsdf
             |    └ (root directory) entries=["dir:sess1","file:root-junk.txt"]
      2.003s | 🗑️ ✅ #1 tsdf/root-junk.txt (untracked root file)
      2.004s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:expired-doc","dir:fresh-doc","dir:invalid-only-store","file:session-junk.txt"]
      2.005s | 🗑️ ✅ #2 tsdf/sess1/session-junk.txt (untracked session file)
      2.006s | 🗂️ list-dir tsdf/sess1/expired-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json","file:store-junk.txt"]
      .      | 🗂️ list-dir tsdf/sess1/fresh-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json","file:store-junk.txt"]
      .      | 🗂️ list-dir tsdf/sess1/invalid-only-store
             |    └ (store directory) entries=["file:store-junk.txt"]
      2.007s | 🗑️ ✅ #3 tsdf/sess1/expired-doc/store-junk.txt
             |    └ (untracked store file)
      2.008s | 🗑️ ✅ #4 tsdf/sess1/fresh-doc/store-junk.txt (untracked store file)
      2.009s | 🗑️ ✅ #5 tsdf/sess1/invalid-only-store/store-junk.txt
             |    └ (untracked store file)
      2.01s  | 🧹 del-dir ✅ tsdf/sess1/invalid-only-store (store directory)
      2.011s | 📄 file-open ✅ #6 tsdf/sess1/expired-doc/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #7 tsdf/sess1/fresh-doc/d.e.m.json (metadata)
      2.013s | 📖 #6 tsdf/sess1/expired-doc/d.e.m.json (metadata) | 0.05 kb
      .      | 📖 #7 tsdf/sess1/fresh-doc/d.e.m.json (metadata) | 0.05 kb
      2.015s | 🗑️ ✅ #8 tsdf/sess1/expired-doc/d.e.p.json (payload)
      .      | 🗑️ ✅ #6 tsdf/sess1/expired-doc/d.e.m.json (metadata)
      2.016s | 🧹 del-dir ✅ tsdf/sess1/expired-doc (store directory)
      2.017s | end
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
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1","dir:sess2"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:expired-doc"]
      2.004s | 🗂️ list-dir tsdf/sess1/expired-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      2.005s | 🗂️ list-dir tsdf/sess2
             |    └ (session directory) entries=["dir:expired-doc","dir:fresh-doc"]
      2.006s | 🗂️ list-dir tsdf/sess2/expired-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      .      | 🗂️ list-dir tsdf/sess2/fresh-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      2.007s | 📄 file-open ✅ #1 tsdf/sess1/expired-doc/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #2 tsdf/sess2/expired-doc/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #3 tsdf/sess2/fresh-doc/d.e.m.json (metadata)
      2.009s | 📖 #1 tsdf/sess1/expired-doc/d.e.m.json (metadata) | 0.05 kb
      .      | 📖 #2 tsdf/sess2/expired-doc/d.e.m.json (metadata) | 0.05 kb
      .      | 📖 #3 tsdf/sess2/fresh-doc/d.e.m.json (metadata) | 0.05 kb
      2.011s | 🗑️ ✅ #4 tsdf/sess1/expired-doc/d.e.p.json (payload)
      .      | 🗑️ ✅ #1 tsdf/sess1/expired-doc/d.e.m.json (metadata)
      .      | 🗑️ ✅ #5 tsdf/sess2/expired-doc/d.e.p.json (payload)
      .      | 🗑️ ✅ #2 tsdf/sess2/expired-doc/d.e.m.json (metadata)
      2.012s | 🧹 del-dir ✅ tsdf/sess1/expired-doc (store directory)
      .      | 🧹 del-dir ✅ tsdf/sess2/expired-doc (store directory)
      2.013s | 🧹 del-dir ✅ tsdf/sess1 (session directory)
      2.014s | end
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
      key: 'document',
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
      missingPayloadExists: mockAdapter.has(missingPayloadKey),
      validEntryExists: mockAdapter.has(validKey),
    }).toMatchInlineSnapshot(`
      invalidMetadataExists: '❌'
      missingPayloadExists: '❌'
      validEntryExists: '✅'
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time   |
      2.001s | 📁 dir-open-or-create ✅ tsdf (root directory)
      2.002s | 🗂️ list-dir tsdf (root directory) entries=["dir:sess1"]
      2.003s | 🗂️ list-dir tsdf/sess1
             |    └ (session directory) entries=["dir:invalid-metadata","dir:missing-payload","dir:valid-doc"]
      2.004s | 🗂️ list-dir tsdf/sess1/invalid-metadata
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      .      | 🗂️ list-dir tsdf/sess1/missing-payload
             |    └ (store directory) entries=["file:d.e.m.json"]
      .      | 🗂️ list-dir tsdf/sess1/valid-doc
             |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      2.005s | 📄 file-open ✅ #1 tsdf/sess1/invalid-metadata/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #2 tsdf/sess1/missing-payload/d.e.m.json (metadata)
      .      | 📄 file-open ✅ #3 tsdf/sess1/valid-doc/d.e.m.json (metadata)
      2.007s | 📖 #1 tsdf/sess1/invalid-metadata/d.e.m.json (metadata) | 0.02 kb
      .      | 📖 #2 tsdf/sess1/missing-payload/d.e.m.json (metadata) | 0.05 kb
      .      | 📖 #3 tsdf/sess1/valid-doc/d.e.m.json (metadata) | 0.05 kb
      2.009s | 🗑️ ✅ #4 tsdf/sess1/invalid-metadata/d.e.p.json (payload)
      .      | 🗑️ ✅ #1 tsdf/sess1/invalid-metadata/d.e.m.json (metadata)
      .      | 🧹 del-dir ❌ tsdf/sess1/missing-payload/d.e.p.json (scope directory)
      .      | 🗑️ ✅ #2 tsdf/sess1/missing-payload/d.e.m.json (metadata)
      2.01s  | 🧹 del-dir ✅ tsdf/sess1/invalid-metadata (store directory)
      .      | 🧹 del-dir ✅ tsdf/sess1/missing-payload (store directory)
      2.011s | end
      "
    `);
  });

  test('protected dotted-session cleanup keeps the protected entry and snapshots the full metadata scan history', async () => {
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
        getSessionKey: () => dottedSessionKey,
        testScenario: 'loaded',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          storeName: 'protected-doc',
          adapter: opfsPersistentStorage,
          schema: wrappedDocumentSchema,
          offlineMode: {
            network: offlineNetwork.config,
            operations: {
              markProtected: {
                inputSchema: rc_object({ value: rc_number }),
                execute: ({ input }) => input,
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
        getSessionKey: () => 'sess-trigger',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          storeName: 'trigger-doc',
          adapter: opfsPersistentStorage,
          schema: wrappedDocumentSchema,
        },
      },
    );
    triggerDocEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Let the trigger store finish its own async persistence before we start
    // capturing, so the timeline only shows the cleanup sweep it scheduled.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (mockAdapter.has(triggerDoc.document.storageKey())) break;
      await advanceTime(10);
    }

    expect(mockAdapter.has(triggerDoc.document.storageKey())).toBe(true);

    // Capture the full sweep so the snapshot shows stale-entry removal.
    const localStorageCapture = startPersistentStorageOperationCapture();
    const readCapture = startOpfsPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    // The protected dotted-session entry should survive, while the unprotected stale entry is discarded.
    expect({
      invalidStrayExists: mockAdapter.has(
        invalidStrayDoc.document.storageKey(),
      ),
      protectedEntryExists: mockAdapter.has(protectedDocStorageKey),
      unprotectedEntryExists: mockAdapter.has(unprotectedDocStorageKey),
    }).toMatchInlineSnapshot(`
      invalidStrayExists: '❌'
      protectedEntryExists: '✅'
      unprotectedEntryExists: '❌'
    `);
    expect(localStorageOperations).toMatchInlineSnapshot(`
      "
      time  |
      140ms | 📖 ✅ #1 tsdf._am.g (async global maintenance) | 0.04 kb
      151ms | ✍️ ✅->✅ #1 tsdf._am.g
            |    └ (async global maintenance) | 0.04 kb -> 0.04 kb
      "
    `);
    expect(operationsBreakdown).toMatchInlineSnapshot(`
      "
      time  |
      140ms | 🗂️ list-dir tsdf
            |    └ (root directory) entries=["dir:sess-trigger","dir:user%40example.com"]
      141ms | 🗂️ list-dir tsdf/sess-trigger
            |    └ (session directory) entries=["dir:trigger-doc"]
      142ms | 🗂️ list-dir tsdf/sess-trigger/trigger-doc
            |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      143ms | 🗂️ list-dir tsdf/user%40example.com
            |    └ (session directory) entries=["dir:_o_.s","dir:invalid-stray","dir:protected-doc","dir:unprotected-doc"]
      144ms | 🗂️ list-dir tsdf/user%40example.com/_o_.s
            |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      .     | 🗂️ list-dir tsdf/user%40example.com/invalid-stray
            |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      .     | 🗂️ list-dir tsdf/user%40example.com/protected-doc
            |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json","file:oe.document.m.json","file:oe.document.p.json","file:oq.protected-doc%3A1736985603621%3A4fzzzxjy.m.json","file:oq.protected-doc%3A1736985603621%3A4fzzzxjy.p.json"]
      .     | 🗂️ list-dir tsdf/user%40example.com/unprotected-doc
            |    └ (store directory) entries=["file:d.e.m.json","file:d.e.p.json"]
      145ms | 📄 file-open ✅ #1 tsdf/user%40example.com/_o_.s/d.e.m.json
            |    └ (metadata)
      .     | 📄 file-open ✅ #2 tsdf/user%40example.com/invalid-stray/d.e.m.json
            |    └ (metadata)
      .     | 📄 file-open ✅ #3 tsdf/user%40example.com/protected-doc/d.e.m.json
            |    └ (metadata)
      .     | 📄 file-open ✅ #4 tsdf/user%40example.com/protected-doc/oq.protected-doc%3A1736985603621%3A4fzzzxjy.m.json
            |    └ ([queueKey: protected-doc:1736985603621:4fzzzxjy], metadata)
      .     | 📄 file-open ✅ #5 tsdf/user%40example.com/unprotected-doc/d.e.m.json
            |    └ (metadata)
      146ms | 📖 #6 tsdf/sess-trigger/trigger-doc/d.e.m.json (metadata) | 0.05 kb
      .     | 📖 #7 tsdf/user%40example.com/protected-doc/oe.document.m.json
            |    └ ([entityKey: document], metadata) | 0.05 kb
      147ms | 📖 #1 tsdf/user%40example.com/_o_.s/d.e.m.json (metadata) | 0.05 kb
      .     | 📖 #2 tsdf/user%40example.com/invalid-stray/d.e.m.json
            |    └ (metadata) | 0.02 kb
      .     | 📖 #3 tsdf/user%40example.com/protected-doc/d.e.m.json
            |    └ (metadata) | 0.07 kb
      .     | 📖 #4 tsdf/user%40example.com/protected-doc/oq.protected-doc%3A1736985603621%3A4fzzzxjy.m.json
            |    └ ([queueKey: protected-doc:1736985603621:4fzzzxjy], metadata) | 0.05 kb
      .     | 📖 #5 tsdf/user%40example.com/unprotected-doc/d.e.m.json
            |    └ (metadata) | 0.05 kb
      149ms | 🗑️ ✅ #8 tsdf/user%40example.com/invalid-stray/d.e.p.json (payload)
      .     | 🗑️ ✅ #2 tsdf/user%40example.com/invalid-stray/d.e.m.json (metadata)
      .     | 🗑️ ✅ #9 tsdf/user%40example.com/unprotected-doc/d.e.p.json
            |    └ (payload)
      .     | 🗑️ ✅ #5 tsdf/user%40example.com/unprotected-doc/d.e.m.json
            |    └ (metadata)
      150ms | 🧹 del-dir ✅ tsdf/user%40example.com/invalid-stray (store directory)
      .     | 🧹 del-dir ✅ tsdf/user%40example.com/unprotected-doc
            |    └ (store directory)
      151ms | end
      "
    `);
    expect(
      getParsedLocalStorageValue(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY),
    ).toMatchInlineSnapshot(`lca: 1736985605678`);
    expect(
      getParsedOpfsFileData('tsdf/user%40example.com/protected-doc/d.e.m.json'),
    ).toMatchInlineSnapshot(`
      a: 1735689601853
      o: '✅'
      v: 1
    `);
    expect(
      getParsedOpfsFileData('tsdf/user%40example.com/protected-doc/d.e.p.json'),
    ).toMatchInlineSnapshot(`
      d:
        value: { name: 'protected', value: 1 }
    `);
  });
});
