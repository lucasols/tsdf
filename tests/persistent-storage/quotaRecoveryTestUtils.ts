import { rc_object, rc_string } from 'runcheck';
import { vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createLocalStoragePersistentTestStore } from '../utils/persistentStorageTestStore';

const wrappedItemSchema = rc_object({
  value: rc_object({ id: rc_string, name: rc_string }),
});

export const persistentStore = createLocalStoragePersistentTestStore();

export const HOUR = 60 * 60 * 1000;

type ItemState = { id: string; name: string };

export function createEnv(options: {
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
export function seedCachedItem(
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

export function getLocalStorageUsedChars(): number {
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

export function simulateLocalStorageQuota(budgetChars: number): void {
  quotaBudgetChars = budgetChars;
}

/** Removes the simulated quota budget (call in `afterEach`). */
export function clearSimulatedLocalStorageQuota(): void {
  quotaBudgetChars = null;
}

export function installQuotaEnforcingSetItem(): void {
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
export function listSurvivingPayloads(
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
