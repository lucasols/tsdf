import { removeStoresFromAsyncStorage } from './asyncStorageAdapter';
import {
  handleManagedLocalStorageBackgroundError,
  parseManagedLocalStorageManifestOwner,
  readRemovedStoresCleanupMarker,
  writeRemovedStoresCleanupMarker,
} from './localStorageMetadata';
import { removeStoreLeftoversFromLocalStorage } from './persistentStorageManager';
import { scheduleInitialMaintenanceCleanup } from './scheduleIdleCleanup';
import { localPersistentStorage } from './storageAdapter';
import type { PersistentStorageErrorHandler, StorageAdapter } from './types';

/**
 * Removes the stores' data from `localStorage` in every session, found
 * through their manifests. Must run inside the managed `localStorage` lock.
 */
function removeStoresFromLocalStorage(
  storeNames: ReadonlySet<string>,
): Map<string, number> {
  const storeNameByStorageKey = new Map<string, string>();
  for (const key of localPersistentStorage.listRawKeys('tsdf.')) {
    const owner = parseManagedLocalStorageManifestOwner(key);
    if (owner === null || !storeNames.has(owner.storeName)) continue;

    storeNameByStorageKey.set(owner.storageKey, owner.storeName);
  }

  const unsentRecordsByStore = new Map<string, number>();
  for (const [storageKey, storeName] of storeNameByStorageKey) {
    const unsentRecords = removeStoreLeftoversFromLocalStorage(
      storageKey,
      false,
    );
    unsentRecordsByStore.set(
      storeName,
      (unsentRecordsByStore.get(storeName) ?? 0) + unsentRecords,
    );
  }

  return unsentRecordsByStore;
}

/** A store deleted from the app, declared in `createStoreManager({ removedStores })`. */
export type RemovedStore = {
  /** Id the deleted store used. */
  readonly id: string;
  /**
   * Adapter the deleted store persisted its data with. Add one entry per
   * adapter when the store used more than one.
   */
  readonly adapter: StorageAdapter;
};

async function runRemovedStoresCleanup(
  removedStores: readonly RemovedStore[],
  reportError: PersistentStorageErrorHandler,
): Promise<void> {
  let cleanedStoreNames: Set<string>;
  try {
    cleanedStoreNames = readRemovedStoresCleanupMarker();
  } catch {
    // `localStorage` is unavailable (e.g. site data blocked), and so is
    // every other storage the removed stores could have used
    return;
  }

  const removedStoreNames = new Set(removedStores.map(({ id }) => id));
  const pendingStoreNamesByAdapter = new Map<StorageAdapter, Set<string>>();
  for (const { adapter, id } of removedStores) {
    if (cleanedStoreNames.has(id)) continue;

    const storeNames = pendingStoreNamesByAdapter.get(adapter) ?? new Set();
    storeNames.add(id);
    pendingStoreNamesByAdapter.set(adapter, storeNames);
  }

  // Common path once the cleanup ran: nothing pending and the marker already
  // lists exactly the configured ids.
  if (
    pendingStoreNamesByAdapter.size === 0 &&
    cleanedStoreNames.size === removedStoreNames.size
  ) {
    return;
  }

  const unsentRecordsByStore = new Map<string, number>();
  for (const [adapter, storeNames] of pendingStoreNamesByAdapter) {
    const result =
      adapter === 'local-sync'
        ? await localPersistentStorage.runLocked(() =>
            removeStoresFromLocalStorage(storeNames),
          )
        : await removeStoresFromAsyncStorage(adapter, storeNames);

    if (result === null) {
      reportError(
        new Error(
          `[tsdf] Removed store(s) ${formatStoreNames(storeNames)} use an async adapter that was not created with createAsyncStorageAdapter, so TSDF cannot find their data to remove it.`,
        ),
      );
      continue;
    }

    for (const [storeName, unsentRecords] of result) {
      unsentRecordsByStore.set(
        storeName,
        (unsentRecordsByStore.get(storeName) ?? 0) + unsentRecords,
      );
    }
  }

  // Ids no longer configured are dropped, so the marker never outgrows the
  // config.
  writeRemovedStoresCleanupMarker([...removedStoreNames]);

  for (const [storeName, unsentRecords] of unsentRecordsByStore) {
    if (unsentRecords === 0) continue;

    reportError(
      new Error(
        `[tsdf] Removed store "${storeName}" still had ${unsentRecords} unsent offline record(s) (queued mutations or pending resolutions). They were deleted with the rest of its persisted data: no store can replay them anymore.`,
      ),
    );
  }
}

function formatStoreNames(storeNames: ReadonlySet<string>): string {
  return [...storeNames].map((storeName) => `"${storeName}"`).join(', ');
}

/**
 * Removes the persisted data of stores deleted from the app, once, during idle
 * time after startup. Every later startup only reads the small marker listing
 * the ids already handled.
 */
export function scheduleRemovedStoresCleanup(
  removedStores: readonly RemovedStore[],
  onPersistentStorageError: PersistentStorageErrorHandler | undefined,
): void {
  if (removedStores.length === 0) return;

  const reportError =
    onPersistentStorageError ?? handleManagedLocalStorageBackgroundError;
  scheduleInitialMaintenanceCleanup(() => {
    void runRemovedStoresCleanup(removedStores, reportError).catch(reportError);
  });
}
