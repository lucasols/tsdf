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
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  clearSimulatedLocalStorageQuota,
  createEnv,
  getLocalStorageUsedChars,
  HOUR,
  installQuotaEnforcingSetItem,
  listSurvivingPayloads,
  persistentStore,
  seedCachedItem,
  simulateLocalStorageQuota,
} from './quotaRecoveryTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
  installQuotaEnforcingSetItem();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  clearSimulatedLocalStorageQuota();
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

  test('deleting an item while quota writes are disabled still removes it from storage', async () => {
    const errors: unknown[] = [];

    const env = createEnv({
      storeName: 'quota-col',
      onPersistentStorageError: (error) => errors.push(error),
    });

    // persist an item normally while the quota is still fine
    env.apiStore.addItemToState('keep', {
      value: { id: 'keep', name: 'Keep' },
    });
    await advanceTime(1100);
    await flushAllTimers();

    const keepStorageKey = persistentStore
      .scope('quota-col', 'sess1')
      .collection.itemStorageKey('keep');
    // protect the item so the escalated eviction below cannot remove it —
    // offline-protected data is exactly what survives a failed recovery and
    // could therefore resurrect after being deleted
    syncManagedLocalStorageSessionProtection('sess1', [keepStorageKey]);

    // non-tsdf data fills the quota so the next flush cannot free enough
    // space even after evicting everything unprotected
    localStorage.setItem('other-app-data', 'z'.repeat(3000));
    simulateLocalStorageQuota(getLocalStorageUsedChars() + 10);

    env.apiStore.addItemToState('big', {
      value: { id: 'big', name: 'n'.repeat(600) },
    });
    await advanceTime(1100);
    await flushAllTimers();

    // circuit breaker tripped with a single reported error, and the
    // protected item survived the escalated eviction
    expect(errors.length).toBe(1);
    expect(
      persistentStore
        .scope('quota-col', 'sess1')
        .collection.readItemData('keep'),
    ).not.toBeNull();

    // deleting the item must still remove its persisted entry even though
    // writes are disabled: removals free space instead of consuming quota,
    // and skipping them would resurrect the deleted item on the next load
    env.apiStore.deleteItemState('keep');
    await advanceTime(1100);
    await flushAllTimers();

    expect(
      persistentStore
        .scope('quota-col', 'sess1')
        .collection.readItemData('keep'),
    ).toBeNull();

    // the removal itself cannot hit the quota, so no new error was reported
    expect(errors.length).toBe(1);
  });
});
