import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { resetManagedLocalStorageState } from '../../src/persistentStorage/localStorageMetadata';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import {
  clearSimulatedLocalStorageQuota,
  createEnv,
  getLocalStorageUsedChars,
  HOUR,
  installQuotaEnforcingSetItem,
  persistentStore,
  seedCachedItem,
  simulateLocalStorageQuota,
} from './quotaRecoveryTestUtils';

/**
 * Browsers without `navigator.locks` (e.g. insecure contexts) skip the
 * cached/deferred manifest io, so manifest writes go to `localStorage`
 * immediately during a flush — a payload write and the manifest write that
 * registers it are separate `setItem` calls, and the quota can be hit
 * between them. These tests run in a dedicated file so no earlier test can
 * leave behind manifests or pending timers that would mask the quota-recovery
 * ordering under test.
 */
beforeAll(() => {
  vi.useFakeTimers();
  installQuotaEnforcingSetItem();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  // the per-test setup in vitest.setup.ts reinstalls a mock `navigator.locks`
  // before each test, so it must be removed here for every test in this file
  Object.defineProperty(globalThis.navigator, 'locks', {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  clearSimulatedLocalStorageQuota();
  vi.runOnlyPendingTimers();
  localStorage.clear();
  // clears the quota circuit breaker so tests stay isolated
  resetManagedLocalStorageState();
});

test('a freshly persisted item survives the quota recovery triggered by its own manifest write', async () => {
  const errors: unknown[] = [];

  // old cached data from another store fills most of the quota
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

  // measure exactly how many chars the item payload below will occupy by
  // persisting an identical item through a probe store first (same-length
  // store name, so the storage key has the same length too)
  const probeEnv = createEnv({ storeName: 'probe-col' });
  probeEnv.apiStore.addItemToState('new', {
    value: { id: 'new', name: 'n'.repeat(300) },
  });
  await advanceTime(1100);
  await flushAllTimers();
  const probeKey = persistentStore
    .scope('probe-col', 'sess1')
    .collection.itemStorageKey('new');
  const probeValue = localStorage.getItem(probeKey);
  expect(probeValue).not.toBeNull();
  const payloadChars = probeKey.length + (probeValue?.length ?? 0);

  const env = createEnv({
    storeName: 'quota-col',
    onPersistentStorageError: (error) => errors.push(error),
  });

  // leave room for the item payload itself but not for the manifest write
  // that registers it: the quota error then fires *after* the payload
  // reached localStorage but *before* any manifest references it
  simulateLocalStorageQuota(getLocalStorageUsedChars() + payloadChars + 10);

  env.apiStore.addItemToState('new', {
    value: { id: 'new', name: 'n'.repeat(300) },
  });
  await advanceTime(1100);
  await flushAllTimers();

  // recovery is silent and must evict old cached entries — never the
  // payload that the failing manifest write was in the middle of committing
  expect(errors).toMatchInlineSnapshot(`[]`);
  const persisted = persistentStore
    .scope('quota-col', 'sess1')
    .collection.readItemData<{ value: { id: string; name: string } }>('new');
  expect(persisted?.value.id).toBe('new');
  expect(persisted?.value.name).toBe('n'.repeat(300));
});
