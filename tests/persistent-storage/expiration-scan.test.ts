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
import { resetExpirationScanTracking } from '../../src/persistentStorage/persistentStorageManager';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedSchema = rc_object({
  value: rc_object({ name: rc_string, value: rc_number }),
});

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
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    // Advance past idle cleanup timeout to trigger the expiration scan
    await advanceTime(2100);
    // Allow async scan operations to complete
    await flushAllTimers();

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
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(2100);
    await flushAllTimers();

    // Both entries should still exist
    expect(localStorage.getItem(keepADoc.document.storageKey())).not.toBeNull();
    expect(localStorage.getItem(keepBDoc.document.storageKey())).not.toBeNull();
  });

  test('entries without valid timestamp are removed', async () => {
    const triggerDoc = persistentStore.scope('trigger', 'sess1');

    // Create an entry with corrupted structure (no timestamp)
    localStorage.setItem(
      'tsdf.sess1.corrupted',
      JSON.stringify({ data: 'bad', version: 1 }),
    );

    // Create a valid entry that triggers the scan
    triggerDoc.document.seed({ value: { name: 'ok', value: 1 } });

    createDocumentStoreTestEnv(
      { name: 'ok', value: 1 },
      {
        getSessionKey: () => 'sess1',
        persistentStorage: {
          storeName: 'trigger',
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(2100);
    await flushAllTimers();

    // Corrupted entry should be removed
    expect(localStorage.getItem('tsdf.sess1.corrupted')).toBeNull();
  });

  test('scan runs only once per backend per session', async () => {
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
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(2100);
    await flushAllTimers();

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
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(2100);
    await flushAllTimers();

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
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(2100);
    await flushAllTimers();

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
          backend: 'localStorage',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(2100);
    await flushAllTimers();

    expect(localStorage.getItem(accountADoc.document.storageKey())).toBeNull();
  });

  test('scan does not run for test adapter overrides', async () => {
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
          backend: 'opfs',
          schema: wrappedSchema,
        },
      },
    );

    await advanceTime(3000);
    await flushAllTimers();

    // Old entry should NOT be removed (scan skipped for adapter overrides)
    expect(mockAdapter.has(key)).toBe(true);
  });
});
