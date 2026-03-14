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
  getManagedLocalStorageManifestKeyForSingle,
  resetManagedLocalStorageState,
  setManagedLocalStorageRuntimeConfigForTests,
} from '../../src/persistentStorage/localStorageMetadata';
import { resetExpirationScanTracking } from '../../src/persistentStorage/persistentStorageManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  waitForScheduledCleanup,
} from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

const persistentStore = createLocalStoragePersistentTestStore();

function readGlobalLastCleanupAt(): number | null {
  return (
    persistentStore.storage.getGlobalMaintenanceRaw()?.lastCleanupAt ?? null
  );
}

function createTriggerEnv(
  storeName = 'trigger-doc',
  sessionKey = 'sess-trigger',
  ignoreInitialTimeCheck = false,
) {
  return createDocumentStoreTestEnv(
    { name: 'trigger', value: 1 },
    {
      __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__: ignoreInitialTimeCheck,
      getSessionKey: () => sessionKey,
      persistentStorage: {
        storeName,
        adapter: 'local-sync',
        schema: wrappedSchema,
      },
    },
  );
}

async function runTriggerCleanup(
  options: {
    storeName?: string;
    sessionKey?: string;
    ignoreInitialTimeCheck?: boolean;
    cleanupIntervalMs?: number;
  } = {},
): Promise<void> {
  if (options.cleanupIntervalMs !== undefined) {
    setManagedLocalStorageRuntimeConfigForTests({
      cleanupIntervalMs: options.cleanupIntervalMs,
    });
  }

  createTriggerEnv(
    options.storeName,
    options.sessionKey,
    options.ignoreInitialTimeCheck,
  );
  await waitForScheduledCleanup();
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
  resetManagedLocalStorageState();
});

describe('expiration scan', () => {
  test('global sweep removes expired entries, keeps fresh entries, and records one global timestamp', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const expiredDoc = persistentStore.scope('expired-doc', 'sess1');
    const freshDoc = persistentStore.scope('fresh-doc', 'sess1');

    expiredDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: expiredTimestamp },
    );
    freshDoc.document.seed({ value: { name: 'fresh', value: 2 } });

    createTriggerEnv();
    await waitForScheduledCleanup();

    expect({
      expiredEntryExists:
        localStorage.getItem(expiredDoc.document.storageKey()) !== null,
      freshEntryExists:
        localStorage.getItem(freshDoc.document.storageKey()) !== null,
      globalMaintenance: persistentStore.storage.getGlobalMaintenanceRaw(),
    }).toMatchInlineSnapshot(`
      expiredEntryExists: '❌'
      freshEntryExists: '✅'
      globalMaintenance: { lastCleanupAt: 1735689602000, version: 1 }
    `);
  });

  test('protected dotted-session entries survive the sweep without protected manifests', async () => {
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
    const protectedKeysStorageKey = `tsdf.${dottedSessionKey}._o_.p`;

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

    expect(
      localStorage.getItem(
        getManagedLocalStorageManifestKeyForSingle(protectedKeysStorageKey),
      ),
    ).toBeNull();

    createTriggerEnv();
    await waitForScheduledCleanup();

    expect({
      protectedEntryExists:
        localStorage.getItem(protectedDoc.document.storageKey()) !== null,
      unprotectedEntryExists:
        localStorage.getItem(unprotectedDoc.document.storageKey()) !== null,
      globalLastCleanupAt: readGlobalLastCleanupAt(),
    }).toMatchInlineSnapshot(`
      globalLastCleanupAt: 1735689602000
      protectedEntryExists: '✅'
      unprotectedEntryExists: '❌'
    `);
  });

  test('global maintenance is throttled by the shared cleanup timestamp until the interval elapses', async () => {
    const cleanupIntervalMs = 24 * 60 * 60 * 1000;
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const staleDoc = persistentStore.scope('throttle-stale', 'sess1');

    staleDoc.document.seed(
      { value: { name: 'old', value: 1 } },
      { timestamp: expiredTimestamp },
    );

    await runTriggerCleanup({
      cleanupIntervalMs,
      storeName: 'throttle-trigger',
      sessionKey: 'sess1',
    });

    const firstCleanupAt = readGlobalLastCleanupAt();

    staleDoc.document.seed(
      { value: { name: 'old-again', value: 3 } },
      { timestamp: expiredTimestamp },
    );

    resetExpirationScanTracking();
    await advanceTime(60 * 60 * 1000);

    await runTriggerCleanup({
      cleanupIntervalMs,
      storeName: 'throttle-trigger',
      sessionKey: 'sess1',
      ignoreInitialTimeCheck: true,
    });

    const throttledCleanupAt = readGlobalLastCleanupAt();

    expect({
      cleanupRanAgain: throttledCleanupAt !== firstCleanupAt,
      staleEntryExists:
        localStorage.getItem(staleDoc.document.storageKey()) !== null,
    }).toMatchInlineSnapshot(`
      cleanupRanAgain: '❌'
      staleEntryExists: '✅'
    `);

    resetExpirationScanTracking();
    await advanceTime(cleanupIntervalMs);

    await runTriggerCleanup({
      cleanupIntervalMs,
      storeName: 'throttle-trigger',
      sessionKey: 'sess1',
      ignoreInitialTimeCheck: true,
    });

    const finalCleanupAt = readGlobalLastCleanupAt();

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

  test('cleanup interval 0 runs on every eligible init', async () => {
    const expiredTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const staleDoc = persistentStore.scope('eager-stale', 'sess1');

    staleDoc.document.seed(
      { value: { name: 'first', value: 1 } },
      { timestamp: expiredTimestamp },
    );

    await runTriggerCleanup({
      cleanupIntervalMs: 0,
      storeName: 'eager-trigger',
      sessionKey: 'sess1',
    });

    const firstCleanupAt = readGlobalLastCleanupAt();

    staleDoc.document.seed(
      { value: { name: 'second', value: 2 } },
      { timestamp: expiredTimestamp },
    );

    resetExpirationScanTracking();
    await advanceTime(1);

    await runTriggerCleanup({
      cleanupIntervalMs: 0,
      storeName: 'eager-trigger',
      sessionKey: 'sess1',
      ignoreInitialTimeCheck: true,
    });

    const secondCleanupAt = readGlobalLastCleanupAt();

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

  test('targeted discard cleanup removes bad data without mutating the global maintenance timestamp', async () => {
    const badDoc = persistentStore.scope('bad-doc', 'sess1');
    const storageKey = badDoc.document.seed({
      value: { name: 'cached', value: 1 },
    });
    const manifestKey = getManagedLocalStorageManifestKeyForSingle(storageKey);

    createTriggerEnv();
    await waitForScheduledCleanup();

    const cleanupBeforeTargetedRemoval = readGlobalLastCleanupAt();

    localStorage.setItem(storageKey, '{invalid');

    const env = createDocumentStoreTestEnv(
      { name: 'server', value: 2 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'bad-doc',
          adapter: 'local-sync',
          schema: wrappedSchema,
        },
      },
    );
    expect(env.store.state.status).toBe('idle');

    await waitForScheduledCleanup();

    expect({
      globalCleanupUnchanged:
        readGlobalLastCleanupAt() === cleanupBeforeTargetedRemoval,
      manifestExists: localStorage.getItem(manifestKey) !== null,
      payloadExists: localStorage.getItem(storageKey) !== null,
    }).toMatchInlineSnapshot(`
      globalCleanupUnchanged: '✅'
      manifestExists: '❌'
      payloadExists: '❌'
    `);
  });
});
