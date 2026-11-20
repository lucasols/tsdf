import { getRemovableStoresAsyncStorage } from './asyncStorageAdapter';
import {
  handleManagedLocalStorageBackgroundError,
  parseManagedLocalStorageManifestOwner,
  readRemovedStoresCleanupMarker,
  writeRemovedStoresCleanupMarker,
  type RemovedStoresCleanupMarker,
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
   * adapter when the store used more than one. Custom async adapters must be
   * created with `createAsyncStorageAdapter` from a driver with a
   * `storageId`.
   */
  readonly adapter: StorageAdapter;
};

/** Marker key of the `'local-sync'` adapter. */
const LOCAL_SYNC_STORAGE_ID = 'local-sync';

type RemovedStoresAdapterCleanup = {
  storageId: string;
  storeNames: Set<string>;
  run: (
    storeNames: ReadonlySet<string>,
  ) => Promise<{ unsentRecordsByStore: Map<string, number>; failure: unknown }>;
};

async function runRemovedStoresCleanup(
  removedStores: readonly RemovedStore[],
  reportError: PersistentStorageErrorHandler,
): Promise<void> {
  let cleanedMarker: RemovedStoresCleanupMarker;
  try {
    cleanedMarker = readRemovedStoresCleanupMarker();
  } catch {
    // `localStorage` is unavailable (e.g. site data blocked), and so is
    // every other storage the removed stores could have used
    return;
  }

  // Each store is cleaned once per adapter: adding an adapter for an id that
  // was already cleaned from another one still cleans the new adapter.
  // Adapters are grouped by storage id, which the marker is keyed by.
  const cleanups = new Map<string, RemovedStoresAdapterCleanup>();
  const unsupportedStoreNames = new Set<string>();
  for (const { adapter, id } of removedStores) {
    const asyncStorage =
      adapter === 'local-sync' ? null : getRemovableStoresAsyncStorage(adapter);
    if (adapter !== 'local-sync' && asyncStorage === null) {
      unsupportedStoreNames.add(id);
      continue;
    }

    const storageId = asyncStorage?.storageId ?? LOCAL_SYNC_STORAGE_ID;
    let cleanup = cleanups.get(storageId);
    if (cleanup === undefined) {
      cleanup = {
        storageId,
        storeNames: new Set(),
        run:
          asyncStorage?.removeStores ??
          ((storeNames) =>
            localPersistentStorage.runLocked(() => ({
              unsentRecordsByStore: removeStoresFromLocalStorage(storeNames),
              failure: null,
            }))),
      };
      cleanups.set(storageId, cleanup);
    }
    cleanup.storeNames.add(id);
  }

  if (unsupportedStoreNames.size > 0) {
    // Nothing can be cleaned or marked as done, so this is reported on every
    // page load until the entry names a supported adapter.
    reportError(
      new Error(
        `[tsdf] Removed store(s) ${formatStoreNames(unsupportedStoreNames)} use an async adapter TSDF cannot clean: it must be created with createAsyncStorageAdapter from a driver that has a storageId.`,
      ),
    );
  }

  // The marker only keeps configured entries, so it never outgrows the config
  const nextMarker: RemovedStoresCleanupMarker = {};
  const pendingCleanups: Array<{
    cleanup: RemovedStoresAdapterCleanup;
    storeNames: Set<string>;
  }> = [];
  for (const cleanup of cleanups.values()) {
    const cleanedStoreNames = new Set(cleanedMarker[cleanup.storageId]);
    const done: string[] = [];
    const pending = new Set<string>();
    for (const storeName of cleanup.storeNames) {
      if (cleanedStoreNames.has(storeName)) done.push(storeName);
      else pending.add(storeName);
    }
    if (done.length > 0) nextMarker[cleanup.storageId] = done;
    if (pending.size > 0)
      pendingCleanups.push({ cleanup, storeNames: pending });
  }
  // `nextMarker` only holds entries of the current marker, so the same count
  // means nothing was dropped.
  let markerChanged =
    countMarkerEntries(nextMarker) !== countMarkerEntries(cleanedMarker);

  for (const { cleanup, storeNames } of pendingCleanups) {
    let result;
    try {
      result = await cleanup.run(storeNames);
    } catch (error) {
      // Nothing is marked, so the next page load retries this adapter
      reportError(error);
      continue;
    }

    // Unsent records already deleted are reported even when other data is
    // left for the next page load to retry, since they cannot be found again.
    for (const [storeName, unsentRecords] of result.unsentRecordsByStore) {
      if (unsentRecords === 0) continue;

      reportError(
        new Error(
          `[tsdf] Removed store "${storeName}" still had ${unsentRecords} unsent offline record(s) (queued mutations or pending resolutions). They were deleted with the rest of its persisted data: no store can replay them anymore.`,
        ),
      );
    }

    if (result.failure !== null) {
      reportError(result.failure);
      continue;
    }

    nextMarker[cleanup.storageId] = [
      ...(nextMarker[cleanup.storageId] ?? []),
      ...storeNames,
    ];
    markerChanged = true;
  }

  if (markerChanged) writeRemovedStoresCleanupMarker(nextMarker);
}

function countMarkerEntries(marker: RemovedStoresCleanupMarker): number {
  let count = 0;
  for (const storeNames of Object.values(marker)) count += storeNames.length;
  return count;
}

function formatStoreNames(storeNames: ReadonlySet<string>): string {
  return [...storeNames].map((storeName) => `"${storeName}"`).join(', ');
}

/**
 * Removes the persisted data of stores deleted from the app, once per store and
 * adapter, during idle time after startup. Every later startup only reads the
 * small marker listing the pairs already handled.
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
