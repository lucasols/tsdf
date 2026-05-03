/* eslint-disable @ls-stack/no-reexport -- keeps async adapters tree-shakable from the local-sync adapter module */
import {
  clearManagedLocalStorageManifest,
  clearManagedLocalStorageSession,
  directManagedLocalStorageIo,
  getManagedLocalStorageManifestKeyForPrefix,
  getManagedLocalStorageManifestKeyForSingle,
  listManagedLocalStorageKeysSync,
  readManagedLocalStorageManifestEntriesByPrefix,
  readManagedLocalStorageNamespaceEntryByPayload,
  readManagedLocalStorageProtectedKeys,
  readManagedLocalStorageSingleEntryByPayload,
  removeManagedLocalStorageNamespacePayload,
  registerManagedLocalStorageMaintenanceCallback,
  removeManagedLocalStorageSinglePayload,
  runManagedLocalStorageMaintenance,
  syncManagedLocalStorageSessionProtection,
  touchManagedLocalStorageNamespacePayload,
  touchManagedLocalStorageSinglePayload,
  unregisterManagedLocalStorageMaintenanceCallback,
  upsertManagedLocalStorageNamespaceEntry,
  upsertManagedLocalStorageSingleEntry,
  type ManagedLocalStorageIo,
} from './localStorageMetadata';
import {
  getNavigatorLockManager,
  warnIfNavigatorLockUnavailable,
} from './navigatorLocks';
import { serializeJsonForStorage } from './persistenceUtils';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

const MANAGED_LOCAL_STORAGE_LOCK_NAME = 'tsdf-local-storage-metadata';
const MANAGED_LOCAL_STORAGE_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; localPersistentStorage is using unlocked localStorage coordination.';
const managedLocalStorageIoStack: ManagedLocalStorageIo[] = [];

function createCachedManagedLocalStorageIo(): {
  deactivate: () => void;
  io: ManagedLocalStorageIo;
} {
  const VALUE_NOT_LOADED = Symbol('VALUE_NOT_LOADED');
  const cache = new Map<string, string | null | typeof VALUE_NOT_LOADED>();
  const pendingManifestWrites = new Map<string, string | null>();
  let cancelPendingManifestFlush: (() => void) | null = null;
  let active = true;
  let allKeysLoaded = false;

  function loadAllKeys(): void {
    if (allKeysLoaded) return;

    allKeysLoaded = true;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key === null || cache.has(key)) continue;
      cache.set(key, VALUE_NOT_LOADED);
    }
  }

  function flushPendingManifestWrites(): void {
    if (cancelPendingManifestFlush !== null) {
      cancelPendingManifestFlush();
      cancelPendingManifestFlush = null;
    }

    if (pendingManifestWrites.size === 0) return;

    for (const [key, value] of pendingManifestWrites) {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    }

    pendingManifestWrites.clear();
  }

  function schedulePendingManifestFlush(): void {
    if (!active || cancelPendingManifestFlush !== null) return;

    cancelPendingManifestFlush = scheduleIdleCleanup(() => {
      cancelPendingManifestFlush = null;
      flushPendingManifestWrites();
    });
  }

  return {
    deactivate() {
      flushPendingManifestWrites();
      active = false;
      cache.clear();
    },
    io: {
      getItem(key) {
        if (!active) {
          return localStorage.getItem(key);
        }

        if (cache.has(key)) {
          const cachedValue = cache.get(key);
          if (cachedValue !== VALUE_NOT_LOADED) {
            return cachedValue ?? null;
          }
        }

        const raw = localStorage.getItem(key);
        cache.set(key, raw);
        return raw;
      },
      setItem(key, value) {
        if (active) {
          cache.set(key, value);
        }
        localStorage.setItem(key, value);
      },
      removeItem(key) {
        if (active) {
          cache.set(key, null);
        }
        localStorage.removeItem(key);
      },
      listKeys() {
        if (!active) return directManagedLocalStorageIo.listKeys();

        loadAllKeys();
        const keys: string[] = [];

        for (const [key, value] of cache.entries()) {
          if (value !== null) {
            keys.push(key);
          }
        }

        return keys;
      },
      queueManifestWrite(key, value) {
        if (!active) {
          if (value === null) {
            localStorage.removeItem(key);
          } else {
            localStorage.setItem(key, value);
          }
          return;
        }

        cache.set(key, value);
        pendingManifestWrites.set(key, value);
        schedulePendingManifestFlush();
      },
    },
  };
}

async function withManagedLocalStorageIoCache<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  const cachedIo = createCachedManagedLocalStorageIo();
  managedLocalStorageIoStack.push(cachedIo.io);

  try {
    return await callback();
  } finally {
    cachedIo.deactivate();
    managedLocalStorageIoStack.pop();
  }
}

function getManagedLocalStorageIo(): ManagedLocalStorageIo | undefined {
  return managedLocalStorageIoStack[managedLocalStorageIoStack.length - 1];
}

function getActiveManagedLocalStorageIo(): ManagedLocalStorageIo {
  return getManagedLocalStorageIo() ?? directManagedLocalStorageIo;
}

function getManagedLocalStorageIoWithWarning(): ManagedLocalStorageIo {
  warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
  return getActiveManagedLocalStorageIo();
}

async function runWithManagedLocalStorageLock<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  if (getManagedLocalStorageIo() !== undefined) {
    return await callback();
  }

  const lockManager = getNavigatorLockManager();

  if (lockManager === null) {
    warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
    return await callback();
  }

  return lockManager.request(MANAGED_LOCAL_STORAGE_LOCK_NAME, () =>
    withManagedLocalStorageIoCache(callback),
  );
}

export type LocalStorageMetadataOptions =
  | { metadata: 'single' }
  | { metadata: 'namespace'; namespacePrefix: string };

type LocalPersistentStorage = {
  kind: 'local-sync';
  runLocked<T>(callback: () => T | Promise<T>): Promise<T>;
  readRaw(key: string): string | null;
  write<T>(key: string, value: T): { rawValue: string; sizeBytes: number };
  remove(key: string, options?: LocalStorageMetadataOptions): void;
  removeByPrefix(prefix: string): void;
  listKeys(prefix: string): string[];
  listRawKeys(prefix: string): string[];
  getManifestKeyForSingle(storageKey: string): string;
  getManifestKeyForPrefix(storagePrefix: string): string;
  readSingleEntryMetadataByPayload(
    payloadKey: string,
  ): ReturnType<typeof readManagedLocalStorageSingleEntryByPayload>;
  readNamespaceEntryMetadataByPayload(
    payloadKey: string,
    namespacePrefix: string,
  ): ReturnType<typeof readManagedLocalStorageNamespaceEntryByPayload>;
  listManifestEntries(
    prefix: string,
  ): ReturnType<typeof readManagedLocalStorageManifestEntriesByPrefix>;
  upsertSingleEntry(
    args: Parameters<typeof upsertManagedLocalStorageSingleEntry>[0],
  ): string;
  upsertNamespaceEntry(
    args: Parameters<typeof upsertManagedLocalStorageNamespaceEntry>[0],
  ): string;
  touchSingleEntry(payloadKey: string): boolean;
  touchNamespaceEntry(payloadKey: string, namespacePrefix: string): boolean;
  clearManifest(manifestKey: string): void;
  clearSession(sessionKey: string): void;
  registerMaintenanceCallback(
    manifestKey: string,
    callback: () => Promise<void>,
  ): void;
  unregisterMaintenanceCallback(manifestKey: string): void;
  runMaintenance(forceManifestKeys?: Iterable<string>): Promise<void>;
  readProtectedStorageKeys(sessionKey: string): Set<string>;
  syncSessionProtectedKeys(
    sessionKey: string,
    protectedKeys: Iterable<string>,
  ): void;
};

export const localPersistentStorage: LocalPersistentStorage = {
  /** Identifier for adapter type and sync runtime behavior. */
  kind: 'local-sync' as const,
  runLocked<T>(callback: () => T | Promise<T>): Promise<T> {
    return runWithManagedLocalStorageLock(callback);
  },
  readRaw(key: string): string | null {
    return getManagedLocalStorageIoWithWarning().getItem(key);
  },
  /**
   * Stores a value in `localStorage` using `JSON.stringify` for persistence.
   */
  write<T>(key: string, value: T): { rawValue: string; sizeBytes: number } {
    const serialized = serializeJsonForStorage(value);
    getManagedLocalStorageIoWithWarning().setItem(key, serialized.rawValue);
    return serialized;
  },

  /**
   * Removes a single cache entry from `localStorage`.
   */
  remove(key: string, options?: LocalStorageMetadataOptions): void {
    const io = getManagedLocalStorageIoWithWarning();
    io.removeItem(key);
    if (options?.metadata === 'single') {
      removeManagedLocalStorageSinglePayload(key, io);
      return;
    }
    if (options?.metadata === 'namespace') {
      removeManagedLocalStorageNamespacePayload(
        key,
        options.namespacePrefix,
        io,
      );
    }
  },

  /**
   * Removes all manifest-managed keys for the provided namespace prefix.
   */
  removeByPrefix(prefix: string): void {
    const io = getManagedLocalStorageIoWithWarning();
    const manifestKey = getManagedLocalStorageManifestKeyForPrefix(prefix);
    if (io.getItem(manifestKey) === null) return;

    clearManagedLocalStorageManifest(manifestKey, io);
  },

  /**
   * Returns all manifest-managed keys for the provided namespace prefix.
   */
  listKeys(prefix: string): string[] {
    const io = getManagedLocalStorageIoWithWarning();
    const managedKeys = listManagedLocalStorageKeysSync(prefix, io);
    return managedKeys ?? [];
  },
  listRawKeys(prefix: string): string[] {
    const io = getManagedLocalStorageIoWithWarning();
    return io.listKeys().filter((key) => key.startsWith(prefix));
  },
  getManifestKeyForSingle(storageKey: string): string {
    return getManagedLocalStorageManifestKeyForSingle(storageKey);
  },
  getManifestKeyForPrefix(storagePrefix: string): string {
    return getManagedLocalStorageManifestKeyForPrefix(storagePrefix);
  },
  readSingleEntryMetadataByPayload(payloadKey: string) {
    return readManagedLocalStorageSingleEntryByPayload(
      payloadKey,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  readNamespaceEntryMetadataByPayload(
    payloadKey: string,
    namespacePrefix: string,
  ) {
    return readManagedLocalStorageNamespaceEntryByPayload(
      payloadKey,
      namespacePrefix,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  listManifestEntries(prefix: string) {
    return readManagedLocalStorageManifestEntriesByPrefix(
      prefix,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  upsertSingleEntry(
    args: Parameters<typeof upsertManagedLocalStorageSingleEntry>[0],
  ): string {
    return upsertManagedLocalStorageSingleEntry(
      args,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  upsertNamespaceEntry(
    args: Parameters<typeof upsertManagedLocalStorageNamespaceEntry>[0],
  ): string {
    return upsertManagedLocalStorageNamespaceEntry(
      args,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  touchSingleEntry(payloadKey: string): boolean {
    return touchManagedLocalStorageSinglePayload(
      payloadKey,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  touchNamespaceEntry(payloadKey: string, namespacePrefix: string): boolean {
    return touchManagedLocalStorageNamespacePayload(
      payloadKey,
      namespacePrefix,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  clearManifest(manifestKey: string): void {
    clearManagedLocalStorageManifest(
      manifestKey,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  clearSession(sessionKey: string): void {
    clearManagedLocalStorageSession(
      sessionKey,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  registerMaintenanceCallback(
    manifestKey: string,
    callback: () => Promise<void>,
  ): void {
    warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
    registerManagedLocalStorageMaintenanceCallback(manifestKey, callback);
  },
  unregisterMaintenanceCallback(manifestKey: string): void {
    warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
    unregisterManagedLocalStorageMaintenanceCallback(manifestKey);
  },
  runMaintenance(forceManifestKeys?: Iterable<string>): Promise<void> {
    return runWithManagedLocalStorageLock(() =>
      runManagedLocalStorageMaintenance(getManagedLocalStorageIoWithWarning(), {
        forceManifestKeys,
      }),
    );
  },
  readProtectedStorageKeys(sessionKey: string): Set<string> {
    return readManagedLocalStorageProtectedKeys(
      sessionKey,
      getManagedLocalStorageIoWithWarning(),
    );
  },
  syncSessionProtectedKeys(
    sessionKey: string,
    protectedKeys: Iterable<string>,
  ): void {
    syncManagedLocalStorageSessionProtection(
      sessionKey,
      protectedKeys,
      getManagedLocalStorageIoWithWarning(),
    );
  },
};

export { opfsPersistentStorage } from './opfsPersistentStorage';
