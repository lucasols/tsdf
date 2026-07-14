import { rc_object, rc_string } from 'runcheck';
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
  resetManagedLocalStorageState,
  syncManagedLocalStorageSessionProtection,
} from '../../src/persistentStorage/localStorageMetadata';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});
const persistentStore = createLocalStoragePersistentTestStore();

const HOUR = 60 * 60 * 1000;

type ItemState = { id: string; name: string };

function createEnv(options: {
  storeName: string;
  sessionKey?: string;
  onPersistentStorageError?: (error: unknown) => void;
}) {
  return createCollectionStoreTestEnv<ItemState>(
    {},
    {
      id: options.storeName,
      getSessionKey: () => options.sessionKey ?? 'sess1',
      persistentStorage: {
        adapter: 'local-sync',
        schema: wrappedItemSchema,
        payloadSchema: rc_string,
        onPersistentStorageError: options.onPersistentStorageError,
      },
    },
  );
}

/** Seeds a cached item persisted `ageMs` in the past (older = evicted first). */
function seedCachedItem(
  storeName: string,
  sessionKey: string,
  payload: string,
  name: string,
  ageMs: number,
): string {
  return persistentStore
    .scope(storeName, sessionKey)
    .collection.seedItem(
      payload,
      { value: { id: payload, name } },
      { timestamp: Date.now() - ageMs },
    );
}

function getLocalStorageUsedChars(): number {
  let total = 0;
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key === null) continue;
    total += key.length + (localStorage.getItem(key)?.length ?? 0);
  }
  return total;
}

/**
 * Simulates the browser origin quota: while a budget is set, any `setItem`
 * that would push the total stored chars above it throws a
 * `QuotaExceededError` DOMException, exactly like real browsers do when
 * localStorage is full (e.g. because other parts of the app filled it).
 */
let quotaBudgetChars: number | null = null;

function simulateLocalStorageQuota(budgetChars: number): void {
  quotaBudgetChars = budgetChars;
}

function installQuotaEnforcingSetItem(): void {
  const originalSetItem = Storage.prototype.setItem.bind(localStorage);

  // spying on the instance instead of Storage.prototype is required for the
  // spy to reliably intercept happy-dom's localStorage method lookups; the
  // spy is installed once for the whole file because mock restoration does
  // not reliably detach from happy-dom's localStorage proxy between tests
  vi.spyOn(localStorage, 'setItem').mockImplementation(
    (key: string, value: string) => {
      if (quotaBudgetChars !== null) {
        const existingValue = localStorage.getItem(key);
        const usedCharsDelta =
          existingValue === null
            ? key.length + value.length
            : value.length - existingValue.length;

        if (getLocalStorageUsedChars() + usedCharsDelta > quotaBudgetChars) {
          throw new DOMException(
            `Failed to execute 'setItem' on 'Storage': Setting the value of '${key}' exceeded the quota.`,
            'QuotaExceededError',
          );
        }
      }

      originalSetItem(key, value);
    },
  );
}

/** Returns which of the given seeded payloads are still present in storage. */
function listSurvivingPayloads(
  storeName: string,
  sessionKey: string,
  payloads: string[],
): string[] {
  const scope = persistentStore.scope(storeName, sessionKey);
  return payloads.filter(
    (payload) =>
      localStorage.getItem(scope.collection.itemStorageKey(payload)) !== null,
  );
}

beforeAll(() => {
  vi.useFakeTimers();
  installQuotaEnforcingSetItem();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  quotaBudgetChars = null;
  vi.runOnlyPendingTimers();
  localStorage.clear();
  // clears the quota circuit breaker so tests stay isolated
  resetManagedLocalStorageState();
});

describe('localStorage quota exceeded recovery', () => {
  test('quota error during a flush evicts least recently used entries and the write succeeds without reporting an error', async () => {
    const errors: unknown[] = [];

    // another tsdf store already holds old cached data, oldest first
    const seededPayloads = ['a', 'b', 'c', 'd'];
    for (const [index, payload] of seededPayloads.entries()) {
      seedCachedItem(
        'old-col',
        'sess1',
        payload,
        'x'.repeat(200),
        (4 - index) * HOUR,
      );
    }

    // data from other (non-tsdf) parts of the app also occupies the quota
    localStorage.setItem('other-app-data', 'z'.repeat(80));

    const env = createEnv({
      storeName: 'quota-col',
      onPersistentStorageError: (error) => errors.push(error),
    });

    // leave less free space than the next persisted entry needs, so the next
    // flush hits the browser quota
    simulateLocalStorageQuota(getLocalStorageUsedChars() + 40);

    env.apiStore.addItemToState('new', {
      value: { id: 'new', name: 'New item' },
    });
    await advanceTime(1100);
    await flushAllTimers();

    // recovery is silent: the quota error never reaches the app
    expect(errors).toMatchInlineSnapshot(`[]`);

    // the new item was persisted after eviction freed space
    expect(
      persistentStore
        .scope('quota-col', 'sess1')
        .collection.readItemData('new'),
    ).toMatchInlineSnapshot(`
      value: { id: 'new', name: 'New item' }
    `);

    // only the least recently used half was evicted; fresher entries survive
    expect(
      listSurvivingPayloads('old-col', 'sess1', seededPayloads),
    ).toMatchInlineSnapshot(`['c', 'd']`);

    // non-tsdf data is never touched by the eviction
    expect(localStorage.getItem('other-app-data')).toBe('z'.repeat(80));
  });

  test('entries persisted by other sessions are also evicted to recover space', async () => {
    const errors: unknown[] = [];

    // cached data left behind by a previous session (different sessionKey)
    const seededPayloads = ['a', 'b', 'c'];
    for (const [index, payload] of seededPayloads.entries()) {
      seedCachedItem(
        'old-col',
        'old-sess',
        payload,
        'x'.repeat(200),
        (3 - index) * HOUR,
      );
    }

    const env = createEnv({
      storeName: 'quota-col',
      sessionKey: 'sess1',
      onPersistentStorageError: (error) => errors.push(error),
    });

    simulateLocalStorageQuota(getLocalStorageUsedChars() + 40);

    env.apiStore.addItemToState('new', {
      value: { id: 'new', name: 'New item' },
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(errors).toMatchInlineSnapshot(`[]`);

    // the current session's write succeeded
    expect(
      persistentStore
        .scope('quota-col', 'sess1')
        .collection.readItemData('new'),
    ).toMatchInlineSnapshot(`
      value: { id: 'new', name: 'New item' }
    `);

    // the other session's oldest entries were evicted to make room
    expect(
      listSurvivingPayloads('old-col', 'old-sess', seededPayloads),
    ).toMatchInlineSnapshot(`['c']`);
  });

  test('offline-protected entries survive even when eviction escalates to all unprotected entries', async () => {
    const errors: unknown[] = [];

    // three unprotected entries plus one offline-protected entry
    const seededPayloads = ['a', 'b', 'c'];
    for (const [index, payload] of seededPayloads.entries()) {
      seedCachedItem(
        'old-col',
        'sess1',
        payload,
        'x'.repeat(120),
        (4 - index) * HOUR,
      );
    }
    const protectedKey = seedCachedItem(
      'old-col',
      'sess1',
      'protected',
      'x'.repeat(120),
      10 * HOUR, // oldest of all: would be evicted first if not protected
    );
    // real production path used to protect offline session data
    syncManagedLocalStorageSessionProtection('sess1', [protectedKey]);

    const env = createEnv({
      storeName: 'quota-col',
      onPersistentStorageError: (error) => errors.push(error),
    });

    simulateLocalStorageQuota(getLocalStorageUsedChars() + 10);

    // this entry needs more space than the LRU-half pass frees, forcing the
    // escalation to evict all unprotected entries
    env.apiStore.addItemToState('new', {
      value: { id: 'new', name: 'n'.repeat(400) },
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(errors).toMatchInlineSnapshot(`[]`);

    // the escalated eviction removed every unprotected entry
    expect(
      listSurvivingPayloads('old-col', 'sess1', seededPayloads),
    ).toMatchInlineSnapshot(`[]`);

    // but the offline-protected entry was never touched
    expect(
      persistentStore
        .scope('old-col', 'sess1')
        .collection.readItemData('protected'),
    ).not.toBeNull();

    // and the new write succeeded
    expect(
      persistentStore
        .scope('quota-col', 'sess1')
        .collection.readItemData('new'),
    ).not.toBeNull();
  });

  test('when eviction cannot free enough space the error is reported once and later flushes are silently skipped', async () => {
    const errors: unknown[] = [];

    // one small tsdf entry, while non-tsdf data occupies most of the quota
    seedCachedItem('old-col', 'sess1', 'a', 'x'.repeat(50), HOUR);
    localStorage.setItem('other-app-data', 'z'.repeat(3000));

    const env = createEnv({
      storeName: 'quota-col',
      onPersistentStorageError: (error) => errors.push(error),
    });

    simulateLocalStorageQuota(getLocalStorageUsedChars() + 10);

    // even evicting every tsdf entry cannot free enough space for this write
    env.apiStore.addItemToState('big', {
      value: { id: 'big', name: 'n'.repeat(600) },
    });
    await advanceTime(1100);
    await flushAllTimers();

    // a single descriptive error reaches the app, with the original
    // QuotaExceededError preserved as its cause
    expect(errors.length).toBe(1);
    const reportedError = errors[0];
    expect(reportedError).toBeInstanceOf(Error);
    if (reportedError instanceof Error) {
      expect(reportedError.message).toMatchInlineSnapshot(
        `"[TSDF] localStorage quota exceeded and evicting stored entries did not free enough space; persistence writes are disabled until the next page load"`,
      );
      expect(reportedError.cause).toBeInstanceOf(DOMException);
    }

    // non-tsdf data was never touched, even by the escalated eviction
    expect(localStorage.getItem('other-app-data')).toBe('z'.repeat(3000));

    // later flushes are skipped silently instead of erroring on every save
    env.apiStore.addItemToState('later', {
      value: { id: 'later', name: 'Later item' },
    });
    await advanceTime(1100);
    await flushAllTimers();

    expect(errors.length).toBe(1);
    // nothing new was persisted while the quota circuit breaker is active
    expect(
      persistentStore
        .scope('quota-col', 'sess1')
        .collection.readItemData('later'),
    ).toBeNull();
  });
});
