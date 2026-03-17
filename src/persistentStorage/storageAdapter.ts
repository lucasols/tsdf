import { murmur3 } from '@ls-stack/utils/hash';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_array,
  rc_object,
  rc_parse_json,
  rc_string,
  rc_unknown,
} from 'runcheck';
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
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type { AsyncStorageAdapter } from './types';

const MANAGED_LOCAL_STORAGE_LOCK_NAME = 'tsdf-local-storage-metadata';
const MANAGED_LOCAL_STORAGE_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; localPersistentStorage is using unlocked localStorage coordination.';
let warnedManagedLocalStorageLockUnavailable = false;
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
  warnIfManagedLocalStorageLockUnavailable();
  return getActiveManagedLocalStorageIo();
}

function getManagedLocalStorageLockManager(): LockManager | null {
  const globalNavigator = __LEGIT_CAST__<Navigator | null | undefined, unknown>(
    globalThis.navigator,
  );
  return (
    __LEGIT_CAST__<LockManager | null | undefined, unknown>(
      globalNavigator?.locks,
    ) ?? null
  );
}

function warnIfManagedLocalStorageLockUnavailable(): void {
  if (getManagedLocalStorageLockManager() !== null) return;

  if (!warnedManagedLocalStorageLockUnavailable) {
    warnedManagedLocalStorageLockUnavailable = true;
    console.warn(MANAGED_LOCAL_STORAGE_LOCK_WARNING);
  }
}

async function runWithManagedLocalStorageLock<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  if (getManagedLocalStorageIo() !== undefined) {
    return await callback();
  }

  const lockManager = getManagedLocalStorageLockManager();

  if (lockManager == null) {
    warnIfManagedLocalStorageLockUnavailable();
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
  read<T>(key: string): T | null;
  write<T>(key: string, value: T): void;
  remove(key: string, options?: LocalStorageMetadataOptions): void;
  removeByPrefix(prefix: string): void;
  listKeys(prefix: string): string[];
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
   * Reads a value from `localStorage` for this exact key.
   * Returns `null` when the key does not exist or parsing fails.
   */
  read<T>(key: string): T | null {
    try {
      const raw = localPersistentStorage.readRaw(key);
      if (raw === null) return null;
      return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
    } catch {
      return null;
    }
  },

  /**
   * Stores a value in `localStorage` using `JSON.stringify` for persistence.
   */
  write<T>(key: string, value: T): void {
    getManagedLocalStorageIoWithWarning().setItem(key, JSON.stringify(value));
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
   * Removes all keys beginning with the provided prefix from `localStorage`.
   */
  removeByPrefix(prefix: string): void {
    const io = getManagedLocalStorageIoWithWarning();
    const manifestKey = getManagedLocalStorageManifestKeyForPrefix(prefix);
    if (io.getItem(manifestKey) !== null) {
      clearManagedLocalStorageManifest(manifestKey, io);
      return;
    }

    for (const key of io.listKeys()) {
      if (key.startsWith(prefix)) {
        localPersistentStorage.remove(key);
      }
    }
  },

  /**
   * Returns all keys in `localStorage` that start with the provided prefix.
   */
  listKeys(prefix: string): string[] {
    const io = getManagedLocalStorageIoWithWarning();
    const managedKeys = listManagedLocalStorageKeysSync(prefix, io);
    if (managedKeys !== null) return managedKeys;

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
    warnIfManagedLocalStorageLockUnavailable();
    registerManagedLocalStorageMaintenanceCallback(manifestKey, callback);
  },
  unregisterMaintenanceCallback(manifestKey: string): void {
    warnIfManagedLocalStorageLockUnavailable();
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

const OPFS_CACHE_DIR = 'tsdf-cache';

const opfsBucketEntrySchema = rc_object({ key: rc_string, value: rc_unknown });

const opfsBucketFileSchema = rc_object({
  entries: rc_array(opfsBucketEntrySchema),
});

async function getOpfsCacheDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_CACHE_DIR, { create: true });
}

function getOpfsFileName(key: string): string {
  return `${murmur3(key, 'uint32')}.json`;
}

type OpfsBucketEntry = { key: string; value: unknown };

type OpfsBucketFile = { entries: OpfsBucketEntry[] };

function parseOpfsBucket(raw: string): OpfsBucketFile | null {
  const result = rc_parse_json(raw, opfsBucketFileSchema);
  return result.ok ? result.value : null;
}

async function readOpfsBucket(
  dir: FileSystemDirectoryHandle,
  key: string,
): Promise<OpfsBucketFile | null> {
  try {
    const fileHandle = await dir.getFileHandle(getOpfsFileName(key));
    const file = await fileHandle.getFile();
    return parseOpfsBucket(await file.text());
  } catch {
    return null;
  }
}

async function writeOpfsBucket(
  dir: FileSystemDirectoryHandle,
  key: string,
  bucket: OpfsBucketFile,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(getOpfsFileName(key), {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(bucket));
  await writable.close();
}

export const opfsPersistentStorage: AsyncStorageAdapter = {
  /** Identifier for adapter type and async runtime behavior. */
  kind: 'async',

  /**
   * Reads a typed value from OPFS bucket storage. Returns `null` when missing.
   */
  async read<T>(key: string): Promise<T | null> {
    try {
      const dir = await getOpfsCacheDir();
      const bucket = await readOpfsBucket(dir, key);
      const entry = bucket?.entries.find((item) => item.key === key);

      if (!entry) return null;
      return __LEGIT_CAST__<T, unknown>(entry.value);
    } catch {
      return null;
    }
  },

  /**
   * Writes a typed value into OPFS bucket storage, creating files as needed.
   */
  async write<T>(key: string, value: T): Promise<void> {
    const dir = await getOpfsCacheDir();
    const bucket = (await readOpfsBucket(dir, key)) ?? { entries: [] };
    const nextEntry = { key, value };
    const existingIndex = bucket.entries.findIndex((item) => item.key === key);

    if (existingIndex === -1) {
      bucket.entries.push(nextEntry);
    } else {
      bucket.entries[existingIndex] = nextEntry;
    }

    await writeOpfsBucket(dir, key, bucket);
  },

  /**
   * Removes a cached OPFS bucket entry by exact key.
   */
  async remove(key: string): Promise<void> {
    try {
      const dir = await getOpfsCacheDir();
      const bucket = await readOpfsBucket(dir, key);
      if (!bucket) return;

      const nextEntries = bucket.entries.filter((item) => item.key !== key);
      if (nextEntries.length === bucket.entries.length) return;

      if (nextEntries.length === 0) {
        await dir.removeEntry(getOpfsFileName(key));
        return;
      }

      await writeOpfsBucket(dir, key, { entries: nextEntries });
    } catch {
      // Silently handle not-found errors
    }
  },

  /**
   * Removes all OPFS entries whose keys match the provided prefix.
   */
  async removeByPrefix(prefix: string): Promise<void> {
    try {
      const dir = await getOpfsCacheDir();

      for await (const [name] of dir.entries()) {
        if (!name.endsWith('.json')) continue;

        try {
          const fileHandle = await dir.getFileHandle(name);
          const file = await fileHandle.getFile();
          const bucket = parseOpfsBucket(await file.text());
          if (!bucket) continue;

          const nextEntries = bucket.entries.filter(
            (entry) => !entry.key.startsWith(prefix),
          );

          if (nextEntries.length === bucket.entries.length) continue;

          if (nextEntries.length === 0) {
            await dir.removeEntry(name);
          } else {
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify({ entries: nextEntries }));
            await writable.close();
          }
        } catch {
          // Ignore entries that can't be read or removed
        }
      }
    } catch {
      // Silently handle errors
    }
  },

  /**
   * Returns all keys in OPFS storage matching the provided prefix.
   */
  async listKeys(prefix: string): Promise<string[]> {
    try {
      const dir = await getOpfsCacheDir();
      const keys: string[] = [];

      for await (const [name] of dir.entries()) {
        if (!name.endsWith('.json')) continue;

        try {
          const fileHandle = await dir.getFileHandle(name);
          const file = await fileHandle.getFile();
          const bucket = parseOpfsBucket(await file.text());
          if (!bucket) continue;

          for (const entry of bucket.entries) {
            if (entry.key.startsWith(prefix)) {
              keys.push(entry.key);
            }
          }
        } catch {
          // Ignore entries that can't be decoded
        }
      }

      return keys;
    } catch {
      return [];
    }
  },
};
