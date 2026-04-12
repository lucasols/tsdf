import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object } from 'runcheck';
import { describe, expect, test, vi } from 'vitest';
import type { DocumentOfflineOperationDefinition } from '../../../src/main';
import { createOfflineSession } from '../../../src/main';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../../src/persistentStorage/asyncStorageAdapter';
import { clearSessionProtectedKeysSnapshot } from '../../../src/persistentStorage/offline/sessionProtectionRegistry';
import { resetExpirationScanTracking } from '../../../src/persistentStorage/persistentStorageManager';
import type { AsyncStorageNamespaceScope } from '../../../src/persistentStorage/types';
import { createDocumentStoreTestEnv } from '../../mocks/documentStoreTestEnv';
import { advanceTime } from '../../utils/genericTestUtils';
import {
  getIndexedDbNamespaceSnapshot,
  getIndexedDbStructureSnapshot,
  getParsedIndexedDbRecordData,
  getParsedLocalStorageValue,
  startIndexedDbPersistentStorageOperationCapture,
  startPersistentStorageOperationCapture,
} from '../../utils/indexedDbPersistentStorageOptimizationTestUtils';
import { createIndexedDbPersistentStorageTestStore } from '../../utils/indexedDbPersistentStorageTestStore';
import { createOfflineNetworkMock } from '../../utils/networkMock';
import {
  createCollectionEnv,
  createDocumentEnv,
  createListQueryEnv,
  resolveAfterIndexedDbStorage,
  setupAsyncStorageEfficiencyTestSuite,
  waitForScheduledCleanup,
  wrappedDocumentSchema,
} from './shared';

setupAsyncStorageEfficiencyTestSuite();

async function resolveAfterIndexedDbTimers<T>(promise: Promise<T>): Promise<T> {
  const pendingResult = Symbol('pendingResult');
  let didSettle = false;

  const settledResultPromise = promise.then(
    (value) => {
      didSettle = true;
      return { status: 'resolved' as const, value };
    },
    (error) => {
      didSettle = true;
      return { status: 'rejected' as const, error };
    },
  );

  let stableIdlePasses = 0;
  for (let pass = 0; pass < 200; pass++) {
    if (didSettle && stableIdlePasses >= 2) break;

    if (vi.getTimerCount() > 0) {
      stableIdlePasses = 0;
      await vi.advanceTimersToNextTimerAsync();
    } else {
      await Promise.resolve();
    }

    await vi.advanceTimersByTimeAsync(0);

    if (vi.getTimerCount() === 0) {
      stableIdlePasses += 1;
    } else {
      stableIdlePasses = 0;
    }
  }

  const settledResult = await Promise.race([
    settledResultPromise,
    Promise.resolve(pendingResult),
  ]);

  if (settledResult === pendingResult) {
    throw new Error('Promise did not settle while advancing IndexedDB timers.');
  }

  if (settledResult.status === 'rejected') {
    throw settledResult.error;
  }

  return settledResult.value;
}

const ENTRY_STORE_NAME = 'entries';
const NAMESPACE_POLICY_STORE_NAME = 'namespacePolicies';

function matchesScopeKey(
  rawKey: unknown,
  scope: AsyncStorageNamespaceScope,
): rawKey is [string, string, AsyncStorageNamespaceScope['kind'], string] {
  return (
    Array.isArray(rawKey) &&
    rawKey[0] === scope.sessionKey &&
    rawKey[1] === scope.storeName &&
    rawKey[2] === scope.kind
  );
}

type MockIndexedDbAdapter = ReturnType<
  typeof createIndexedDbPersistentStorageTestStore
>;

async function listScopeEntryRows(
  mockAdapter: MockIndexedDbAdapter,
  scope: AsyncStorageNamespaceScope,
): Promise<Array<{ key: unknown; value: unknown }>> {
  return (await mockAdapter.indexedDb.listRows(ENTRY_STORE_NAME)).filter(
    (row) => matchesScopeKey(row.key, scope),
  );
}

async function listScopePolicyRows(
  mockAdapter: MockIndexedDbAdapter,
  scope: AsyncStorageNamespaceScope,
): Promise<Array<{ key: unknown; value: unknown }>> {
  return (
    await mockAdapter.indexedDb.listRows(NAMESPACE_POLICY_STORE_NAME)
  ).filter(
    (row) =>
      Array.isArray(row.key) &&
      row.key[0] === scope.sessionKey &&
      row.key[1] === scope.storeName &&
      row.key[2] === scope.kind,
  );
}

function corruptEntryRow(args: {
  key?: string;
  mockAdapter: MockIndexedDbAdapter;
  scope: AsyncStorageNamespaceScope;
  value?: Record<string, unknown>;
}): void {
  args.mockAdapter.indexedDb.queueMutateRawRow(
    ENTRY_STORE_NAME,
    [
      args.scope.sessionKey,
      args.scope.storeName,
      args.scope.kind,
      args.key ?? 'document',
    ],
    (current) => ({
      ...(typeof current === 'object' && current !== null
        ? __LEGIT_CAST__<Record<string, unknown>, unknown>(current)
        : {}),
      ...(args.value ?? { a: 'bad' }),
    }),
  );
}

function corruptNamespacePolicyRow(args: {
  mockAdapter: MockIndexedDbAdapter;
  scope: AsyncStorageNamespaceScope;
  value?: Record<string, unknown>;
}): void {
  args.mockAdapter.indexedDb.queueMutateRawRow(
    NAMESPACE_POLICY_STORE_NAME,
    [args.scope.sessionKey, args.scope.storeName, args.scope.kind],
    (current) => ({
      ...(typeof current === 'object' && current !== null
        ? __LEGIT_CAST__<Record<string, unknown>, unknown>(current)
        : {}),
      ...(args.value ?? { n: 123 }),
    }),
  );
}

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
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    expect({
      expiredEntryExists: await mockAdapter.has(expiredKey),
      freshEntryExists: await mockAdapter.has(freshKey),
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

  test('startup cleanup deletes invalid IndexedDB rows while keeping valid scopes', async () => {
    const staleTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const expiredDoc = mockAdapter.scope('expired-doc', 'sess1');
    const freshDoc = mockAdapter.scope('fresh-doc', 'sess1');
    const invalidOnlyStore = mockAdapter.scope(
      'invalid-only-list-query',
      'sess1',
    );
    const freshKey = freshDoc.document.storageKey();

    // Seed one expired scope to prune and one fresh sibling that must survive.
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: staleTimestamp },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });
    invalidOnlyStore.listQuery.seedQuery({ tableId: 'cleanup' }, []);
    corruptEntryRow({
      key: invalidOnlyStore.listQuery.queryKey({ tableId: 'cleanup' }),
      mockAdapter,
      scope: invalidOnlyStore.listQuery.queryNamespace,
    });
    await resolveAfterIndexedDbTimers(mockAdapter.flushPendingWrites());

    createDocumentEnv({ storeName: 'fresh-doc', sessionKey: 'sess1' });
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      expiredScopeRows: await listScopeEntryRows(
        mockAdapter,
        expiredDoc.document.namespace,
      ),
      freshEntryExists: await mockAdapter.has(freshKey),
      invalidOnlyPolicyRows: await listScopePolicyRows(
        mockAdapter,
        invalidOnlyStore.listQuery.queryNamespace,
      ),
      invalidOnlyScopeRows: await listScopeEntryRows(
        mockAdapter,
        invalidOnlyStore.listQuery.queryNamespace,
      ),
    }).toMatchInlineSnapshot(`
      expiredScopeRows: []
      freshEntryExists: '✅'
      invalidOnlyPolicyRows: []
      invalidOnlyScopeRows: []
    `);

    expect(operationsBreakdown).toContain(
      'scope=["sess1","invalid-only-list-query","listQuery.query"] -> keys=0 exists=no valid=no',
    );
    expect(operationsBreakdown).toContain(
      'scope=["sess1","expired-doc","document"] -> keys=1 exists=yes valid=yes',
    );
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
              - key: ['sess1', 'fresh-doc', 'document', 'document']
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
        expiredEntryExists: await mockAdapter.has(expiredKey),
        freshEntryExists: await mockAdapter.has(freshKey),
      }).toMatchInlineSnapshot(`
        expiredEntryExists: '❌'
        freshEntryExists: '✅'
      `);
      expect(operationsBreakdown).toContain(
        '🗑️ tx(entries, namespacePolicies).delete scope=["sess1","expired-doc","document"]',
      );
    } finally {
      getItemSpy.mockRestore();
    }
  });

  test('startup cleanup removes malformed namespace state together with its entry rows', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const corruptedStore = mockAdapter.scope('corrupted', 'sess1');
    const triggerDoc = mockAdapter.scope('trigger', 'sess1');
    const corruptedPayload = 'bad-user';
    const corruptedEntryKey =
      corruptedStore.collection.itemKey(corruptedPayload);
    const corruptedKey =
      corruptedStore.collection.itemStorageKey(corruptedPayload);
    const triggerKey = triggerDoc.document.storageKey();

    // Seed a healthy persisted row, then add malformed namespace state for the same scope.
    corruptedStore.collection.seedItem(corruptedPayload, {
      value: { id: corruptedPayload, name: 'Bad User' },
    });
    corruptedStore.collection.setStaticPolicy({ m: 1 });
    corruptNamespacePolicyRow({
      mockAdapter,
      scope: corruptedStore.collection.namespace,
    });
    await resolveAfterIndexedDbTimers(mockAdapter.flushPendingWrites());

    // Keep a healthy sibling scope in the same session so cleanup only prunes the malformed one.
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });
    createDocumentEnv({ storeName: 'trigger', sessionKey: 'sess1' });

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      corruptedEntryRows: await listScopeEntryRows(
        mockAdapter,
        corruptedStore.collection.namespace,
      ),
      corruptedExists: await mockAdapter.has(corruptedKey),
      corruptedPolicyRows: await listScopePolicyRows(
        mockAdapter,
        corruptedStore.collection.namespace,
      ),
      triggerExists: await mockAdapter.has(triggerKey),
    }).toMatchInlineSnapshot(`
      corruptedEntryRows: []
      corruptedExists: '❌'
      corruptedPolicyRows: []
      triggerExists: '✅'
    `);
    expect(operationsBreakdown).toContain(
      'scope=["sess1","corrupted","collection.item"] -> keys=1 exists=yes valid=no',
    );
    expect(operationsBreakdown).toContain(
      '🗑️ tx(entries, namespacePolicies).delete scope=["sess1","corrupted","collection.item"] keys=["\\"bad-user", "@scope"]',
    );
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

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      sess1ExpiredEntryExists: await mockAdapter.has(sess1ExpiredKey),
      sess2ExpiredEntryExists: await mockAdapter.has(sess2ExpiredKey),
      sess2FreshEntryExists: await mockAdapter.has(sess2FreshKey),
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

    mockAdapter.indexedDb.failCleanupRemoveKnownRecords(
      failedDoc.document.namespace,
    );

    createDocumentEnv({ storeName: 'trigger-doc', sessionKey: 'sess-trigger' });

    const firstCleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const firstCleanupOperations = firstCleanupCapture.finish().timelineString;

    expect({
      failedEntryExistsAfterFirstCleanup: await mockAdapter.has(failedKey),
      siblingEntryExistsAfterFirstCleanup: await mockAdapter.has(siblingKey),
    }).toMatchInlineSnapshot(`
      failedEntryExistsAfterFirstCleanup: '✅'
      siblingEntryExistsAfterFirstCleanup: '❌'
    `);
    expect(firstCleanupOperations).toContain(
      'scope=["sess-fail","failed-doc","document"] -> keys=1 exists=yes valid=yes',
    );
    expect(firstCleanupOperations).toContain(
      '🗑️ tx(entries, namespacePolicies).delete scope=["sess-sibling","sibling-doc","document"] keys=["document", "@scope"]',
    );
    expect(firstCleanupOperations).not.toContain(
      '🗑️ tx(entries, namespacePolicies).delete scope=["sess-fail","failed-doc","document"] keys=["document", "@scope"]',
    );

    localStorage.removeItem(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY);
    resetExpirationScanTracking();
    const retryAdapter = createIndexedDbPersistentStorageTestStore({
      databaseName: mockAdapter.databaseName,
    });

    createDocumentEnv({
      storeName: 'retry-trigger-doc',
      sessionKey: 'sess-retry-trigger',
    });

    const retryCleanupCapture =
      startIndexedDbPersistentStorageOperationCapture(retryAdapter);
    await waitForScheduledCleanup();
    const retryCleanupOperations = retryCleanupCapture.finish().timelineString;

    expect({
      failedEntryExistsAfterRetryCleanup: await retryAdapter.has(failedKey),
      siblingEntryExistsAfterRetryCleanup: await retryAdapter.has(siblingKey),
    }).toMatchInlineSnapshot(`
      failedEntryExistsAfterRetryCleanup: '❌'
      siblingEntryExistsAfterRetryCleanup: '❌'
    `);
    expect(retryCleanupOperations).toContain(
      '🗑️ tx(entries, namespacePolicies).delete scope=["sess-fail","failed-doc","document"] keys=["document", "@scope"]',
    );
  });

  test('cleanup removes invalid or orphaned async-managed records while preserving valid entries', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const validDoc = mockAdapter.scope('valid-doc', 'sess1');
    const invalidEntryStore = mockAdapter.scope('invalid-entry', 'sess1');
    const orphanedPolicyStore = mockAdapter.scope('orphaned-policy', 'sess1');
    const validKey = validDoc.document.storageKey();
    const invalidPayload = 'bad-user';
    const invalidEntryRecordKey =
      invalidEntryStore.collection.itemKey(invalidPayload);
    const invalidEntryKey =
      invalidEntryStore.collection.itemStorageKey(invalidPayload);

    validDoc.document.seed({ value: { name: 'valid', value: 1 } });
    invalidEntryStore.collection.seedItem(invalidPayload, {
      value: { id: invalidPayload, name: 'Bad User' },
    });
    corruptEntryRow({
      key: invalidEntryRecordKey,
      mockAdapter,
      scope: invalidEntryStore.collection.namespace,
      value: { a: 'bad' },
    });
    orphanedPolicyStore.collection.setStaticPolicy({ m: 1 });
    corruptNamespacePolicyRow({
      mockAdapter,
      scope: orphanedPolicyStore.collection.namespace,
    });
    await resolveAfterIndexedDbTimers(mockAdapter.flushPendingWrites());
    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      invalidEntryExists: await mockAdapter.has(invalidEntryKey),
      invalidEntryRows: await listScopeEntryRows(
        mockAdapter,
        invalidEntryStore.collection.namespace,
      ),
      orphanedPolicyRows: await listScopePolicyRows(
        mockAdapter,
        orphanedPolicyStore.collection.namespace,
      ),
      validEntryExists: await mockAdapter.has(validKey),
    }).toMatchInlineSnapshot(`
      invalidEntryExists: '❌'
      invalidEntryRows: []
      orphanedPolicyRows: []
      validEntryExists: '✅'
    `);
    expect(operationsBreakdown).toContain(
      'scope=["sess1","invalid-entry","collection.item"] -> keys=0 exists=no valid=no',
    );
    expect(operationsBreakdown).toContain(
      'scope=["sess1","orphaned-policy","collection.item"] -> keys=0 exists=yes valid=no',
    );
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

    // Corrupt only the query row so startup cleanup has to prune the query
    // namespace while preserving the sibling item namespace in the same store.
    corruptEntryRow({
      key: mixedStore.listQuery.queryKey({ tableId: 'projects' }),
      mockAdapter,
      scope: mixedStore.listQuery.queryNamespace,
    });
    await resolveAfterIndexedDbTimers(mockAdapter.flushPendingWrites());

    createListQueryEnv({
      serverData: { projects: [{ id: 1, name: 'Project 1' }] },
      sessionKey: 'sess1',
      storeName: 'mixed-list-query',
    });
    createDocumentEnv({ storeName: 'valid-doc', sessionKey: 'sess1' });

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      itemNamespaceSnapshot: await getIndexedDbNamespaceSnapshot(
        mockAdapter,
        mixedStore.listQuery.itemNamespace,
      ),
      queryExists: await mockAdapter.has(invalidQueryKey),
      queryNamespaceSnapshot: await getIndexedDbNamespaceSnapshot(
        mockAdapter,
        mixedStore.listQuery.queryNamespace,
      ),
      validDocExists: await mockAdapter.has(validDocKey),
      validItemExists: await mockAdapter.has(validItem.storageKey),
    }).toMatchInlineSnapshot(`
      itemNamespaceSnapshot:
        entries:
          "projects||1: { a: 1735689600000, p: 'projects||1' }

      queryExists: '❌'
      queryNamespaceSnapshot: null
      validDocExists: '✅'
      validItemExists: '✅'
    `);
    expect(operationsBreakdown).toContain(
      'scope=["sess1","mixed-list-query","listQuery.query"] -> keys=0 exists=no valid=no',
    );
    expect(operationsBreakdown).not.toContain(
      'scope=["sess1","mixed-list-query","listQuery.item"] -> keys=0 exists=yes valid=no',
    );
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
              - key: ['sess1', 'mixed-list-query', 'listQuery.item', '"projects||1']
                value: 'JSON object | 0.4 kb'
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

  test('startup cleanup deletes malformed collection scopes because IndexedDB rows are the namespace state', async () => {
    const mockAdapter = createIndexedDbPersistentStorageTestStore();
    const collectionScope = mockAdapter.scope('orphan-collection', 'sess1');
    const keptItemKey = collectionScope.collection.seedItem('kept-user', {
      value: { id: 'kept-user', name: 'Kept User' },
    });
    const orphanedItemKey = collectionScope.collection.seedItem('orphan-user', {
      value: { id: 'orphan-user', name: 'Orphan User' },
    });

    // IndexedDB stores collection namespace state inline on the entry rows, so a
    // malformed stray row invalidates the whole scope instead of behaving like an
    // OPFS-style orphaned payload file.
    corruptEntryRow({
      key: collectionScope.collection.itemKey('orphan-user'),
      mockAdapter,
      scope: collectionScope.collection.namespace,
      value: { a: 'bad' },
    });
    await resolveAfterIndexedDbTimers(mockAdapter.flushPendingWrites());

    createDocumentEnv({
      storeName: 'cleanup-trigger',
      sessionKey: 'sess-trigger',
    });

    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(mockAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;

    expect({
      keptPayloadExists: await mockAdapter.has(keptItemKey),
      namespaceSnapshot: await getIndexedDbNamespaceSnapshot(
        mockAdapter,
        collectionScope.collection.namespace,
      ),
      orphanedPayloadExists: await mockAdapter.has(orphanedItemKey),
    }).toMatchInlineSnapshot(`
      keptPayloadExists: '❌'
      namespaceSnapshot: null
      orphanedPayloadExists: '❌'
    `);
    expect(operationsBreakdown).toContain(
      'scope=["sess1","orphan-collection","collection.item"] -> keys=1 exists=yes valid=no',
    );
    expect(operationsBreakdown).toContain(
      '🗑️ tx(entries, namespacePolicies).delete scope=["sess1","orphan-collection","collection.item"]',
    );

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
            rowCount: 0
            rows: []
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
    const invalidStrayStore = mockAdapter.scope(
      'invalid-stray',
      dottedSessionKey,
    );
    const protectedDocStorageKey = protectedDoc.document.storageKey();
    const unprotectedDocStorageKey = unprotectedDoc.document.storageKey();
    const invalidStrayStorageKey = invalidStrayStore.listQuery.queryStorageKey({
      tableId: 'invalid-stray',
    });

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
    const protectMutationResult = await resolveAfterIndexedDbStorage(
      protectedDocEnv.apiStore.performMutation({
        mutation: () => Promise.resolve({ name: 'protected', value: 1 }),
        offline: { operation: 'markProtected', input: { value: 1 } },
      }),
      mockAdapter,
    );
    randomSpy.mockRestore();

    invalidStrayStore.listQuery.seedQuery({ tableId: 'invalid-stray' }, []);
    corruptEntryRow({
      key: invalidStrayStore.listQuery.queryKey({ tableId: 'invalid-stray' }),
      mockAdapter,
      scope: invalidStrayStore.listQuery.queryNamespace,
      value: { a: 'bad' },
    });
    await resolveAfterIndexedDbTimers(mockAdapter.flushPendingWrites());

    expect(protectMutationResult.ok).toBe(true);

    // Simulate a reload so cleanup must rely on the persisted metadata marker.
    clearSessionProtectedKeysSnapshot(dottedSessionKey);

    // Re-arm the one-off startup cleanup so this same test can trigger a fresh scan after protection is registered.
    resetExpirationScanTracking();
    const reloadedAdapter = createIndexedDbPersistentStorageTestStore({
      databaseName: mockAdapter.databaseName,
    });

    // A fresh entry in another session triggers the scheduled global cleanup pass.
    const triggerDoc = reloadedAdapter.scope('trigger-doc', 'sess-trigger');
    const triggerDocEnv = createDocumentStoreTestEnv(
      { name: 'trigger', value: 3 },
      {
        id: 'trigger-doc',
        getSessionKey: () => 'sess-trigger',
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        persistentStorage: {
          adapter: reloadedAdapter.adapter,
          schema: wrappedDocumentSchema,
        },
      },
    );
    triggerDocEnv.scheduleFetch('highPriority');
    await advanceTime(1810);

    // Let the trigger store finish its own async persistence before we start
    // capturing, so the timeline only shows the cleanup sweep it scheduled.
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await reloadedAdapter.has(triggerDoc.document.storageKey())) break;
      await advanceTime(10);
    }

    expect(await reloadedAdapter.has(triggerDoc.document.storageKey())).toBe(
      true,
    );
    await resolveAfterIndexedDbTimers(reloadedAdapter.flushPendingWrites());

    // Capture the full sweep so the snapshot shows offline startup preserving
    // the stale cached entries while pruning invalid junk.
    const localStorageCapture = startPersistentStorageOperationCapture();
    const readCapture =
      startIndexedDbPersistentStorageOperationCapture(reloadedAdapter);
    await waitForScheduledCleanup();
    const operationsBreakdown = readCapture.finish().timelineString;
    const localStorageOperations = localStorageCapture.finish().timelineString;

    // Offline startup should preserve both stale cached documents, while still
    // pruning the unrelated invalid stray store discovered during the sweep.
    expect({
      invalidStrayExists: await reloadedAdapter.has(invalidStrayStorageKey),
      invalidStrayEntries: await listScopeEntryRows(
        reloadedAdapter,
        invalidStrayStore.listQuery.queryNamespace,
      ),
      protectedEntryExists: await reloadedAdapter.has(protectedDocStorageKey),
      unprotectedEntryExists: await reloadedAdapter.has(
        unprotectedDocStorageKey,
      ),
    }).toMatchInlineSnapshot(`
      invalidStrayEntries: []
      invalidStrayExists: '❌'
      protectedEntryExists: '✅'
      unprotectedEntryExists: '✅'
    `);
    expect(localStorageOperations).toMatchInlineSnapshot(`"empty"`);
    expect(operationsBreakdown).toMatchInlineSnapshot(`"empty"`);
    const maintenanceState = getParsedLocalStorageValue<{ lca: number }>(
      ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
    );
    expect(Object.keys(maintenanceState ?? {})).toMatchInlineSnapshot(
      `['lca']`,
    );
    expect(typeof maintenanceState?.lca).toBe('number');
    const protectedDocumentEntry = await getParsedIndexedDbRecordData<{
      a: number;
      d: { d: { value: { name: string; value: number } } };
      k: string;
      m: { o: boolean };
      n: string;
      o: number;
      s: string;
      t: string;
      v: number;
    }>(reloadedAdapter, {
      key: ['user@example.com', 'protected-doc', 'document', 'document'],
      storeName: 'entries',
    });
    expect(typeof protectedDocumentEntry?.a).toBe('number');
    expect({
      d: protectedDocumentEntry?.d,
      k: protectedDocumentEntry?.k,
      m: protectedDocumentEntry?.m,
      n: protectedDocumentEntry?.n,
      o: protectedDocumentEntry?.o,
      s: protectedDocumentEntry?.s,
      t: protectedDocumentEntry?.t,
      v: protectedDocumentEntry?.v,
    }).toMatchInlineSnapshot(`
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
