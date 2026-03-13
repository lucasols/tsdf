import { rc_number, rc_object, rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  getManagedLocalStorageRootKeyForSingle,
  readManagedLocalStorageRoot,
  upsertManagedLocalStorageSingleEntry,
} from '../../src/persistentStorage/localStorageMetadata';
import { resetExpirationScanTracking } from '../../src/persistentStorage/persistentStorageManager';
import {
  localPersistentStorage,
  opfsPersistentStorage,
} from '../../src/persistentStorage/storageAdapter';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  createLocalStoragePersistentTestStore,
  TEST_MAX_AGE_MS,
} from '../utils/persistentStorageTestStore';

const wrappedSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

async function waitForScheduledCleanup(delayMs = 2100): Promise<void> {
  await advanceTime(delayMs);
  await flushAllTimers();
}

function getSingleRootKey(sessionKey: string, storeName: string): string {
  return getManagedLocalStorageRootKeyForSingle(
    `tsdf.${sessionKey}.${storeName}`,
  );
}

function seedManagedDocumentRoot(args: {
  sessionKey: string;
  storeName: string;
  cleanupIntervalMs?: number;
  lastAccessAt?: number;
}): void {
  upsertManagedLocalStorageSingleEntry({
    sessionKey: args.sessionKey,
    storeName: args.storeName,
    storageKey: `tsdf.${args.sessionKey}.${args.storeName}`,
    cleanupIntervalMs: args.cleanupIntervalMs,
    maxAgeMs: TEST_MAX_AGE_MS,
    lastAccessAt: args.lastAccessAt,
  });
}

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  resetExpirationScanTracking();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

const persistentStore = createLocalStoragePersistentTestStore();

describe('expiration scan', () => {
  test('entries older than maxAge are removed', async () => {
    const oneWeekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    const expiredDoc = persistentStore.scope('expired-doc', 'sess1');
    const freshDoc = persistentStore.scope('fresh-doc', 'sess1');

    // Create an expired entry
    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: oneWeekAgo },
    );

    // Create a fresh entry that triggers the expiration scan
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });

    // Create the store — triggers load → schedules expiration scan
    createDocumentStoreTestEnv(
      { name: 'fresh', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'fresh-doc',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );
    // Advance past idle cleanup timeout to trigger the expiration scan
    // Allow async scan operations to complete
    await waitForScheduledCleanup();

    // Expired entry should be removed
    expect(localStorage.getItem(expiredDoc.document.storageKey())).toBeNull();

    // Fresh entry should still exist (it was refreshed by the load)
    expect(localStorage.getItem(freshDoc.document.storageKey())).not.toBeNull();
  });

  test('entries with recent timestamps are kept', async () => {
    const keepADoc = persistentStore.scope('keep-a', 'sess1');
    const keepBDoc = persistentStore.scope('keep-b', 'sess1');

    // Both entries are fresh
    keepADoc.document.seed({ value: { name: 'a', value: 1 } });
    keepBDoc.document.seed({ value: { name: 'b', value: 2 } });

    createDocumentStoreTestEnv(
      { name: 'a', value: 1 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'keep-a',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );

    await waitForScheduledCleanup();

    // Both entries should still exist
    expect(localStorage.getItem(keepADoc.document.storageKey())).not.toBeNull();
    expect(localStorage.getItem(keepBDoc.document.storageKey())).not.toBeNull();
  });

  test('scan runs only once per adapter per session', async () => {
    const scanOnceA = persistentStore.scope('scan-once-a', 'sess1');
    const scanOnceB = persistentStore.scope('scan-once-b', 'sess1');
    const shouldStay = persistentStore.scope('should-stay', 'sess1');

    scanOnceA.document.seed({ value: { name: 'a', value: 1 } });
    scanOnceB.document.seed({ value: { name: 'b', value: 2 } });

    const removeItemSpy = vi.spyOn(localStorage, 'removeItem');

    // First store creation — triggers scan
    createDocumentStoreTestEnv(
      { name: 'a', value: 1 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'scan-once-a',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );

    await waitForScheduledCleanup();

    const firstScanRemoveCalls = removeItemSpy.mock.calls.length;

    // Add an expired entry between scans
    const twoWeeksAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
    shouldStay.document.seed(
      { value: { name: 'stale', value: 99 } },
      { timestamp: twoWeeksAgo },
    );

    // Second store creation — should NOT trigger another scan
    createDocumentStoreTestEnv(
      { name: 'b', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'scan-once-b',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );

    await waitForScheduledCleanup();

    // The expired entry should still be there (second scan didn't run)
    expect(
      localStorage.getItem(shouldStay.document.storageKey()),
    ).not.toBeNull();

    // No additional remove calls from a second scan
    expect(removeItemSpy.mock.calls.length).toBe(firstScanRemoveCalls);

    removeItemSpy.mockRestore();
  });

  test('expired entries from previous sessions are cleaned on the next app runtime', async () => {
    const initialTime = new Date('2026-01-01T12:00:00Z');
    vi.setSystemTime(initialTime);
    const accountADoc = persistentStore.scope('account-a-doc', 'sess-a');

    accountADoc.document.seed({ value: { name: 'account-a', value: 1 } });

    createDocumentStoreTestEnv(
      { name: 'account-a', value: 1 },
      {
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        getSessionKey: () => 'sess-a',
        persistentStorage: {
          storeName: 'account-a-doc',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );

    await waitForScheduledCleanup();

    expect(
      localStorage.getItem(accountADoc.document.storageKey()),
    ).not.toBeNull();

    // Simulate closing and reopening the app in a different session.
    resetExpirationScanTracking();
    vi.setSystemTime(initialTime.getTime() + 8 * 24 * 60 * 60 * 1000);

    createDocumentStoreTestEnv(
      { name: 'account-b', value: 2 },
      {
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        getSessionKey: () => 'sess-b',
        persistentStorage: {
          storeName: 'account-b-doc',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );

    await waitForScheduledCleanup();

    expect(localStorage.getItem(accountADoc.document.storageKey())).toBeNull();
  });

  test('protected entries are preserved for dotted session keys while sibling stale entries are cleaned', async () => {
    const staleTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const dottedSessionKey = 'user@example.com';
    const protectedDoc = persistentStore.scope(
      'protected-doc',
      dottedSessionKey,
    );
    const unprotectedDoc = persistentStore.scope(
      'unprotected-doc',
      dottedSessionKey,
    );
    const triggerDoc = persistentStore.scope('trigger-doc', 'sess-trigger');
    const protectedKeysStorageKey = `tsdf.${dottedSessionKey}.__offline__.protected`;
    const protectedRootKey = getManagedLocalStorageRootKeyForSingle(
      protectedKeysStorageKey,
    );

    // Seed two stale entries for the dotted session so the scan has to decide
    // which one to keep based on the protected-keys manifest.
    protectedDoc.document.seed(
      { value: { name: 'protected', value: 1 } },
      { timestamp: staleTimestamp },
    );
    unprotectedDoc.document.seed(
      { value: { name: 'unprotected', value: 2 } },
      { timestamp: staleTimestamp },
    );

    persistentStore.storage.writeValue(protectedKeysStorageKey, {
      data: { keys: [protectedDoc.document.storageKey()] },
      timestamp: Date.now(),
      version: 1,
    });

    // The managed metadata must keep the full dotted session key so cleanup
    // can match protected keys back to the correct session.
    expect(readManagedLocalStorageRoot(protectedRootKey)?.sessionKey).toBe(
      dottedSessionKey,
    );

    // Trigger cleanup from another session to mirror a later app runtime.
    triggerDoc.document.seed({ value: { name: 'trigger', value: 3 } });

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 3 },
      {
        getSessionKey: () => 'sess-trigger',
        persistentStorage: {
          storeName: 'trigger-doc',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );
    await waitForScheduledCleanup();

    expect({
      protectedEntryExists:
        localStorage.getItem(protectedDoc.document.storageKey()) !== null,
      unprotectedEntryExists:
        localStorage.getItem(unprotectedDoc.document.storageKey()) !== null,
      protectedRootSession:
        readManagedLocalStorageRoot(protectedRootKey)?.sessionKey,
    }).toMatchInlineSnapshot(`
      protectedEntryExists: '✅'
      protectedRootSession: 'user@example.com'
      unprotectedEntryExists: '❌'
    `);
  });

  test('scan runs for explicit injected async adapters', async () => {
    const oldTimestamp = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const key = 'tsdf.sess1.old-entry';
    const mockAdapter = createMockOpfsStorageAdapter({
      storeName: 'adapter-test',
      sessionKey: 'sess1',
      initialState: {
        rawEntries: {
          [key]: {
            data: { data: { value: { name: 'old', value: 1 } } },
            timestamp: oldTimestamp,
            version: 1,
          },
        },
        document: { data: { value: { name: 'ok', value: 1 } } },
      },
    });

    createDocumentStoreTestEnv(
      { name: 'ok', value: 1 },
      {
        getSessionKey: () => 'sess1',
        storageAdapter: mockAdapter.adapter,
        persistentStorage: {
          storeName: 'adapter-test',
          adapter: opfsPersistentStorage,
          schema: wrappedSchema,
        },
      },
    );

    await waitForScheduledCleanup(3000);

    expect(mockAdapter.has(key)).toBe(false);
  });

  test('automatic cleanup is throttled by cleanupIntervalMs until the interval elapses', async () => {
    const cleanupIntervalMs = 24 * 60 * 60 * 1000;
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const staleDoc = persistentStore.scope('throttle-stale', 'sess1');
    const triggerRootKey = getSingleRootKey('sess1', 'throttle-trigger');

    // First eligible init should clean the stale entry immediately and stamp the root.
    staleDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: expiredTimestamp },
    );
    seedManagedDocumentRoot({
      sessionKey: 'sess1',
      storeName: 'throttle-trigger',
      cleanupIntervalMs,
    });

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'throttle-trigger',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
          cleanupIntervalMs,
        },
      },
    );

    await waitForScheduledCleanup();

    const firstCleanupAt =
      readManagedLocalStorageRoot(triggerRootKey)?.lastCleanupAt;

    expect({
      staleEntryExists:
        localStorage.getItem(staleDoc.document.storageKey()) !== null,
      triggerCleanupIntervalMs:
        readManagedLocalStorageRoot(triggerRootKey)?.cleanupIntervalMs,
      triggerLastCleanupRecorded: firstCleanupAt != null,
    }).toMatchInlineSnapshot(`
      staleEntryExists: '❌'
      triggerCleanupIntervalMs: 86400000
      triggerLastCleanupRecorded: '✅'
    `);

    // Re-add stale data, then re-open the app before the interval has elapsed.
    // Cleanup should stay throttled, so the stale entry should still be present and
    // the root should keep the previous cleanup timestamp.
    staleDoc.document.seed(
      { value: { name: 'old-again', value: 3 } },
      { timestamp: expiredTimestamp },
    );

    resetExpirationScanTracking();
    await advanceTime(60 * 60 * 1000);

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'throttle-trigger',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
          cleanupIntervalMs,
        },
      },
    );

    await waitForScheduledCleanup();

    const throttledCleanupAt =
      readManagedLocalStorageRoot(triggerRootKey)?.lastCleanupAt;

    expect({
      cleanupRanAgain: throttledCleanupAt !== firstCleanupAt,
      staleEntryExists:
        localStorage.getItem(staleDoc.document.storageKey()) !== null,
    }).toMatchInlineSnapshot(`
      cleanupRanAgain: '❌'
      staleEntryExists: '✅'
    `);

    // Once the full interval has passed, the next eligible init should clean again.
    resetExpirationScanTracking();
    await advanceTime(cleanupIntervalMs);

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 2 },
      {
        __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: true,
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'throttle-trigger',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
          cleanupIntervalMs,
        },
      },
    );

    await waitForScheduledCleanup();

    const finalCleanupAt =
      readManagedLocalStorageRoot(triggerRootKey)?.lastCleanupAt;

    expect({
      cleanupRanAgain:
        finalCleanupAt != null &&
        throttledCleanupAt != null &&
        finalCleanupAt !== throttledCleanupAt,
      staleEntryExists:
        localStorage.getItem(staleDoc.document.storageKey()) !== null,
    }).toMatchInlineSnapshot(`
      cleanupRanAgain: '✅'
      staleEntryExists: '❌'
    `);
  });

  test('cleanupIntervalMs 0 allows cleanup on every eligible init', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const staleDoc = persistentStore.scope('eager-stale', 'sess1');
    const triggerRootKey = getSingleRootKey('sess1', 'eager-trigger');

    // The first eligible init should remove stale data immediately.
    staleDoc.document.seed(
      { value: { name: 'first', value: 1 } },
      { timestamp: expiredTimestamp },
    );
    upsertManagedLocalStorageSingleEntry({
      sessionKey: 'sess1',
      storeName: 'eager-stale',
      storageKey: staleDoc.document.storageKey(),
      cleanupIntervalMs: 0,
      maxAgeMs: TEST_MAX_AGE_MS,
      lastAccessAt: expiredTimestamp,
    });
    seedManagedDocumentRoot({
      sessionKey: 'sess1',
      storeName: 'eager-trigger',
      cleanupIntervalMs: 0,
    });

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'eager-trigger',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
          cleanupIntervalMs: 0,
        },
      },
    );

    await waitForScheduledCleanup();

    const firstCleanupAt =
      readManagedLocalStorageRoot(triggerRootKey)?.lastCleanupAt;

    expect({
      cleanupIntervalMs:
        readManagedLocalStorageRoot(triggerRootKey)?.cleanupIntervalMs,
      staleEntryExists:
        localStorage.getItem(staleDoc.document.storageKey()) !== null,
      triggerLastCleanupRecorded: firstCleanupAt != null,
    }).toMatchInlineSnapshot(`
      cleanupIntervalMs: 0
      staleEntryExists: '❌'
      triggerLastCleanupRecorded: '✅'
    `);

    // Re-add stale data and re-open immediately. With interval 0, cleanup should
    // run again on the very next eligible init.
    staleDoc.document.seed(
      { value: { name: 'second', value: 2 } },
      { timestamp: expiredTimestamp },
    );
    upsertManagedLocalStorageSingleEntry({
      sessionKey: 'sess1',
      storeName: 'eager-stale',
      storageKey: staleDoc.document.storageKey(),
      cleanupIntervalMs: 0,
      maxAgeMs: TEST_MAX_AGE_MS,
      lastAccessAt: expiredTimestamp,
    });

    resetExpirationScanTracking();
    await advanceTime(1);

    createDocumentStoreTestEnv(
      { name: 'trigger', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'eager-trigger',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
          cleanupIntervalMs: 0,
        },
      },
    );

    await waitForScheduledCleanup();

    const secondCleanupAt =
      readManagedLocalStorageRoot(triggerRootKey)?.lastCleanupAt;

    expect({
      cleanupRanAgain:
        secondCleanupAt != null &&
        firstCleanupAt != null &&
        secondCleanupAt !== firstCleanupAt,
      staleEntryExists:
        localStorage.getItem(staleDoc.document.storageKey()) !== null,
    }).toMatchInlineSnapshot(`
      cleanupRanAgain: '✅'
      staleEntryExists: '❌'
    `);
  });

  test('cleanup interval config is stored lazily when root metadata exists', () => {
    const rootKey = getSingleRootKey('sess1', 'interval-config');

    createDocumentStoreTestEnv(
      { name: 'config', value: 1 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'interval-config',
          adapter: localPersistentStorage,
          schema: wrappedSchema,
          cleanupIntervalMs: 1_000,
        },
      },
    );

    // Store initialization alone should not create managed metadata for an unused sync root.
    expect({
      rootExistsAfterInit: readManagedLocalStorageRoot(rootKey) !== null,
      rootKeyUsesManagedPrefix: rootKey.startsWith('tsdf._m.r.'),
      rootKeyUsesLegacyPrefix: rootKey.includes('__localStorageMeta__'),
    }).toMatchInlineSnapshot(`
      rootExistsAfterInit: '❌'
      rootKeyUsesLegacyPrefix: '❌'
      rootKeyUsesManagedPrefix: '✅'
    `);

    seedManagedDocumentRoot({
      sessionKey: 'sess1',
      storeName: 'interval-config',
      cleanupIntervalMs: 5_000,
      lastAccessAt: Date.now(),
    });

    expect(readManagedLocalStorageRoot(rootKey)).toMatchInlineSnapshot(`
      cleanupIntervalMs: 5000
      lastCleanupAt: null
      maxAgeMs: 604800000
      mode: 'single'
      needsMaintenance: '❌'
      sessionKey: 'sess1'
      storageKey: 'tsdf.sess1.interval-config'
      storagePrefix: null
      storeName: 'interval-config'
      version: 1
    `);
  });

  test('cleanup interval config can be updated for an existing managed root', () => {
    const rootKey = getSingleRootKey('sess1', 'interval-config');

    seedManagedDocumentRoot({
      sessionKey: 'sess1',
      storeName: 'interval-config',
      cleanupIntervalMs: 1_000,
      lastAccessAt: Date.now(),
    });

    seedManagedDocumentRoot({
      sessionKey: 'sess1',
      storeName: 'interval-config',
      cleanupIntervalMs: 5_000,
      lastAccessAt: Date.now(),
    });

    expect({
      cleanupIntervalMs:
        readManagedLocalStorageRoot(rootKey)?.cleanupIntervalMs,
      sessionKey: readManagedLocalStorageRoot(rootKey)?.sessionKey,
      storeName: readManagedLocalStorageRoot(rootKey)?.storeName,
    }).toMatchInlineSnapshot(`
      cleanupIntervalMs: 5000
      sessionKey: 'sess1'
      storeName: 'interval-config'
    `);
  });
});
