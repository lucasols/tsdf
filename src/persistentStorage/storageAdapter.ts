/* eslint-disable @ls-stack/no-reexport -- keeps async adapters tree-shakable from the local-sync adapter module */
import {
  addManagedLocalStorageMutationListener,
  clearManagedLocalStorageManifest,
  clearManagedLocalStorageSession,
  directManagedLocalStorageIo,
  handleManagedLocalStorageBackgroundError,
  isLocalStorageQuotaWritesDisabled,
  trackManagedLocalStorageMutationWrites,
  getManagedLocalStorageManifestKeyForPrefix,
  getManagedLocalStorageManifestKeyForSingle,
  listManagedLocalStorageKeysSync,
  readManagedLocalStorageManifestEntriesByPrefix,
  readManagedLocalStorageNamespaceEntryByPayload,
  readManagedLocalStorageProtectedKeys,
  readManagedLocalStorageSingleEntryByPayload,
  removeManagedLocalStorageNamespaceEntriesIfUnchanged,
  removeManagedLocalStorageNamespacePayload,
  registerManagedLocalStorageMaintenanceCallback,
  removeManagedLocalStorageSinglePayload,
  runManagedLocalStorageMaintenance,
  syncManagedLocalStorageSessionProtection,
  touchManagedLocalStorageNamespacePayload,
  touchManagedLocalStorageSinglePayload,
  setManagedLocalStorageItemWithQuotaRecovery,
  unregisterManagedLocalStorageMaintenanceCallback,
  upsertManagedLocalStorageNamespaceEntry,
  upsertManagedLocalStorageSingleEntry,
  type ManagedLocalStorageIo,
  type ManagedLocalStorageNamespaceRemovalCandidate,
  type ManagedLocalStorageNamespaceRemovalResult,
} from './localStorageMetadata';
import {
  getNavigatorLockManager,
  warnIfNavigatorLockUnavailable,
} from './navigatorLocks';
import { serializeJsonForStorage } from './persistenceUtils';
import {
  scheduleIdleCleanup,
  type IdleCleanupContext,
} from './scheduleIdleCleanup';

const MANAGED_LOCAL_STORAGE_LOCK_NAME = 'tsdf-local-storage-metadata';
const MANAGED_LOCAL_STORAGE_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; localPersistentStorage is using unlocked localStorage coordination.';
const managedLocalStorageIoStack: ManagedLocalStorageIo[] = [];

// Sync hydration can read several entries from one namespace in the same
// microtask. Share its manifest read, but never retain it past that microtask;
// observed local and cross-tab mutations invalidate it even sooner.
const sharedManifestRawCache = new Map<string, string | null>();
let sharedManifestCacheClearScheduled = false;

function isManagedLocalStorageManifestCacheKey(key: string): boolean {
  return key.startsWith('tsdf._m.r.');
}

function rememberSharedManifestRaw(key: string, raw: string | null): void {
  sharedManifestRawCache.set(key, raw);
  if (sharedManifestCacheClearScheduled) return;

  sharedManifestCacheClearScheduled = true;
  queueMicrotask(() => {
    sharedManifestCacheClearScheduled = false;
    sharedManifestRawCache.clear();
  });
}

const sharedDirectManagedLocalStorageIo: ManagedLocalStorageIo = {
  getItem(key) {
    if (!isManagedLocalStorageManifestCacheKey(key)) {
      return directManagedLocalStorageIo.getItem(key);
    }

    ensureManagedStorageInvalidationListener();
    if (sharedManifestRawCache.has(key)) {
      return sharedManifestRawCache.get(key) ?? null;
    }

    const raw = directManagedLocalStorageIo.getItem(key);
    rememberSharedManifestRaw(key, raw);
    return raw;
  },
  setItem(key, value) {
    directManagedLocalStorageIo.setItem(key, value);
  },
  removeItem(key) {
    directManagedLocalStorageIo.removeItem(key);
  },
  listKeys() {
    return directManagedLocalStorageIo.listKeys();
  },
};

function createCachedManagedLocalStorageIo(): {
  deactivate: () => void;
  flush: () => void;
  invalidateAll: () => void;
  io: ManagedLocalStorageIo;
  reset: () => void;
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
        // runs from idle callbacks / deactivate, so it must not throw; a
        // dropped manifest write self-heals via maintenance sweeps
        try {
          const written = setManagedLocalStorageItemWithQuotaRecovery(
            key,
            value,
            io,
          );
          // a dropped write must not leave a phantom cached value that later
          // reads in the same locked scope would mistake for stored data
          if (!written) cache.delete(key);
        } catch (error) {
          cache.delete(key);
          handleManagedLocalStorageBackgroundError(error);
        }
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

  const io: ManagedLocalStorageIo = {
    invalidate(key) {
      cache.delete(key);
      allKeysLoaded = false;
    },
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

      const raw = sharedDirectManagedLocalStorageIo.getItem(key);
      cache.set(key, raw);
      return raw;
    },
    setItem(key, value) {
      const written = setManagedLocalStorageItemWithQuotaRecovery(
        key,
        value,
        io,
      );
      // only cache values that actually reached localStorage, so a quota
      // failure never leaves a phantom cached value
      if (written && active) {
        cache.set(key, value);
      }
      if (written) invalidateManagedStorageCachesAfterMutation(key, io);
    },
    removeItem(key) {
      if (active) {
        cache.set(key, null);
      }
      localStorage.removeItem(key);
      invalidateManagedStorageCachesAfterMutation(key, io);
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
          setManagedLocalStorageItemWithQuotaRecovery(
            key,
            value,
            directManagedLocalStorageIo,
          );
        }
        return;
      }

      // while quota writes are disabled the deferred flush would drop the
      // write anyway, so don't queue it (or cache a phantom value); removals
      // still go through since they free space instead of consuming quota
      if (value !== null && isLocalStorageQuotaWritesDisabled()) return;

      cache.set(key, value);
      pendingManifestWrites.set(key, value);
      invalidateManagedStorageCachesAfterMutation(key, io);
      schedulePendingManifestFlush();
    },
  };

  return {
    deactivate() {
      flushPendingManifestWrites();
      active = false;
      cache.clear();
    },
    flush: flushPendingManifestWrites,
    invalidateAll() {
      cache.clear();
      allKeysLoaded = false;
    },
    io,
    reset() {
      flushPendingManifestWrites();
      cache.clear();
      allKeysLoaded = false;
    },
  };
}

type CachedManagedLocalStorageIo = ReturnType<
  typeof createCachedManagedLocalStorageIo
>;

const activeMaintenanceCaches = new Set<CachedManagedLocalStorageIo>();
let managedStorageInvalidationListenerReady = false;

function invalidateManagedStorageCachesAfterMutation(
  key: string,
  source: ManagedLocalStorageIo,
): void {
  sharedManifestRawCache.delete(key);
  for (const cache of activeMaintenanceCaches) {
    if (cache.io !== source) cache.io.invalidate?.(key);
  }
}

function ensureManagedStorageInvalidationListener(): void {
  if (managedStorageInvalidationListenerReady) return;

  addManagedLocalStorageMutationListener((key) => {
    invalidateManagedStorageCachesAfterMutation(
      key,
      directManagedLocalStorageIo,
    );
  });

  window.addEventListener('storage', (event) => {
    if (event.storageArea !== null && event.storageArea !== localStorage)
      return;

    if (event.key === null) {
      sharedManifestRawCache.clear();
    } else {
      sharedManifestRawCache.delete(event.key);
    }

    for (const cache of activeMaintenanceCaches) {
      if (event.key === null) {
        cache.invalidateAll();
      } else {
        cache.io.invalidate?.(event.key);
      }
    }
  });
  managedStorageInvalidationListenerReady = true;
}

const maintenanceIoCaches = new WeakMap<
  IdleCleanupContext,
  { cache: CachedManagedLocalStorageIo; continuationCount: number }
>();

async function withExistingManagedLocalStorageIoCache<T>(
  cachedIo: CachedManagedLocalStorageIo,
  callback: () => T | Promise<T>,
): Promise<T> {
  managedLocalStorageIoStack.push(cachedIo.io);

  try {
    return await callback();
  } finally {
    cachedIo.flush();
    managedLocalStorageIoStack.pop();
  }
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
  return getManagedLocalStorageIo() ?? sharedDirectManagedLocalStorageIo;
}

function getManagedLocalStorageIoWithWarning(): ManagedLocalStorageIo {
  warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
  return getActiveManagedLocalStorageIo();
}

async function runWithManagedLocalStorageLock<T>(
  callback: () => T | Promise<T>,
  existingCachedIo?: CachedManagedLocalStorageIo,
): Promise<T> {
  if (getManagedLocalStorageIo() !== undefined) {
    return await callback();
  }

  const lockManager = getNavigatorLockManager();

  if (lockManager === null) {
    warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
    return await trackManagedLocalStorageMutationWrites(() =>
      existingCachedIo === undefined
        ? callback()
        : withExistingManagedLocalStorageIoCache(existingCachedIo, callback),
    );
  }

  return lockManager.request(MANAGED_LOCAL_STORAGE_LOCK_NAME, () =>
    trackManagedLocalStorageMutationWrites(() =>
      existingCachedIo === undefined
        ? withManagedLocalStorageIoCache(callback)
        : withExistingManagedLocalStorageIoCache(existingCachedIo, callback),
    ),
  );
}

export type LocalStorageMetadataOptions =
  | { metadata: 'single' }
  | { metadata: 'namespace'; namespacePrefix: string };

type LocalPersistentStorage = {
  kind: 'local-sync';
  runLocked<T>(callback: () => T | Promise<T>): Promise<T>;
  runMaintenanceLocked<T>(
    context: IdleCleanupContext,
    callback: () => T | Promise<T>,
  ): Promise<T>;
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
  removeNamespaceEntriesIfUnchanged(
    storagePrefix: string,
    candidates: ManagedLocalStorageNamespaceRemovalCandidate[],
    candidateIndex: number,
    shouldYield: () => boolean,
  ): ManagedLocalStorageNamespaceRemovalResult;
  clearManifest(manifestKey: string): void;
  clearSession(sessionKey: string): void;
  registerMaintenanceCallback(
    manifestKey: string,
    callback: (context?: IdleCleanupContext) => Promise<void>,
  ): void;
  unregisterMaintenanceCallback(manifestKey: string): void;
  runMaintenance(
    forceManifestKeys: Iterable<string> | undefined,
    context: IdleCleanupContext,
  ): Promise<void>;
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
  runMaintenanceLocked<T>(
    context: IdleCleanupContext,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const maintenanceIo = maintenanceIoCaches.get(context);
    if (maintenanceIo === undefined) {
      return runWithManagedLocalStorageLock(callback);
    }

    const continuationCount = context.getContinuationCount();
    if (continuationCount !== maintenanceIo.continuationCount) {
      maintenanceIo.cache.reset();
      maintenanceIo.continuationCount = continuationCount;
    }

    return runWithManagedLocalStorageLock(callback, maintenanceIo.cache);
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
  removeNamespaceEntriesIfUnchanged(
    storagePrefix: string,
    candidates: ManagedLocalStorageNamespaceRemovalCandidate[],
    candidateIndex: number,
    shouldYield: () => boolean,
  ): ManagedLocalStorageNamespaceRemovalResult {
    return removeManagedLocalStorageNamespaceEntriesIfUnchanged(
      storagePrefix,
      candidates,
      candidateIndex,
      shouldYield,
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
    callback: (context?: IdleCleanupContext) => Promise<void>,
  ): void {
    warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
    registerManagedLocalStorageMaintenanceCallback(manifestKey, callback);
  },
  unregisterMaintenanceCallback(manifestKey: string): void {
    warnIfNavigatorLockUnavailable(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
    unregisterManagedLocalStorageMaintenanceCallback(manifestKey);
  },
  runMaintenance(
    forceManifestKeys: Iterable<string> | undefined,
    context: IdleCleanupContext,
  ): Promise<void> {
    const cache = createCachedManagedLocalStorageIo();
    ensureManagedStorageInvalidationListener();
    activeMaintenanceCaches.add(cache);
    maintenanceIoCaches.set(context, {
      cache,
      continuationCount: context.getContinuationCount(),
    });

    return runManagedLocalStorageMaintenance({
      context,
      forceManifestKeys,
      runLocked: (callback) =>
        localPersistentStorage.runMaintenanceLocked(context, () =>
          callback(getManagedLocalStorageIoWithWarning()),
        ),
    }).finally(() => {
      maintenanceIoCaches.delete(context);
      activeMaintenanceCaches.delete(cache);
      cache.deactivate();
    });
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
