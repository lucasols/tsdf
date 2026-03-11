import {
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_unknown,
} from 'runcheck';
import {
  clearManagedLocalStorageRoot,
  clearManagedLocalStorageSession,
  getManagedLocalStorageRootKeyForPrefix,
  getManagedLocalStorageRootKeyForSingle,
  listManagedLocalStorageKeysSync,
  readManagedLocalStorageEntryByPayload,
  registerManagedLocalStorageRoot,
  removeManagedLocalStoragePayload,
  resetManagedLocalStorageState,
  runManagedLocalStorageMaintenance,
  touchManagedLocalStoragePayload,
  upsertManagedLocalStorageNamespaceEntry,
  upsertManagedLocalStorageSingleEntry,
} from './localStorageMetadata';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  localPersistentStorage,
  opfsPersistentStorage,
} from './storageAdapter';
import type {
  PersistentStorageBaseConfig,
  PersistentStorageSchema,
  StorageAdapter,
  StorageCacheEntry,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEBOUNCE_MS = 1000;

const LOCAL_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const ASYNC_ADAPTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

function getMaxAgeForAdapter(adapter: StorageAdapter): number {
  return adapter.kind === 'sync'
    ? LOCAL_STORAGE_MAX_AGE_MS
    : ASYNC_ADAPTER_MAX_AGE_MS;
}

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});

const timestampSchema = rc_object({ timestamp: rc_number });

let scannedAdapters = new WeakSet<StorageAdapter>();

function getStorageKey(sessionKey: string, storeName: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

export type PersistentStorageHandle<T> = {
  /** Loads persisted data, validating version and schema. Returns null if not found or invalid. */
  load(): Promise<T | null>;
  /** Schedules a debounced save. getData is called at save time to capture latest state. */
  scheduleSave(getData: () => T): void;
  /** Immediately saves data, canceling any pending debounce. */
  saveNow(data: T): Promise<void>;
  /** Removes the persisted entry and cancels any pending debounce. */
  clear(): Promise<void>;
  /** Cancels any pending debounce timer without saving. */
  dispose(): void;
};

/**
 * Creates a handle for reading/writing a single persisted storage entry.
 *
 * @param config - Storage configuration including the injected adapter, schema, and version.
 * @param itemValidator - Optional per-item validator for compound data structures.
 *   Called after the overall cache entry is loaded. Use this to validate individual
 *   items within collections/queries.
 */
export function createPersistentStorageHandle<T>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'>,
  { getManifestMeta }: { getManifestMeta?: (data: T) => unknown } = {},
): PersistentStorageHandle<T> {
  const version = config.version ?? 1;
  const { onPersistentStorageError } = config;
  const adapter = config.adapter;
  const usesManagedLocalStorage = adapter === localPersistentStorage;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function registerManagedRoot(key: string): void {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false || !usesManagedLocalStorage) return;

    registerManagedLocalStorageRoot({
      sessionKey,
      storeName: config.storeName,
      mode: 'single',
      storageKey: key,
      cleanupIntervalMs: config.cleanupIntervalMs,
      maxAgeMs: getMaxAgeForAdapter(adapter),
    });
  }

  if (!usesManagedLocalStorage && !scannedAdapters.has(adapter)) {
    scannedAdapters.add(adapter);
    scheduleIdleCleanup(() => {
      void runExpirationScan(adapter, getMaxAgeForAdapter(adapter));
    });
  }

  function getKey(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;
    const key = getStorageKey(sessionKey, config.storeName);
    registerManagedRoot(key);
    return key;
  }

  if (usesManagedLocalStorage) {
    void getKey();
  }

  function clearTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function load(): Promise<T | null> {
    const key = getKey();
    if (key === false) return null;
    try {
      if (
        usesManagedLocalStorage &&
        readManagedLocalStorageEntryByPayload(key) === null
      ) {
        return null;
      }

      const entry = await adapter.read<StorageCacheEntry<T>>(key);

      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => {
          void adapter.remove(key);
          removeManagedLocalStoragePayload(key);
        });
        return null;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));

      return entry.data;
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function writeEntry(data: T): Promise<void> {
    const key = getKey();
    if (key === false) return;

    const entry: StorageCacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version,
    };

    try {
      await adapter.write(key, entry);
      if (usesManagedLocalStorage) {
        const sessionKey = config.getSessionKey();
        if (sessionKey !== false) {
          upsertManagedLocalStorageSingleEntry({
            sessionKey,
            storeName: config.storeName,
            storageKey: key,
            cleanupIntervalMs: config.cleanupIntervalMs,
            maxAgeMs: getMaxAgeForAdapter(adapter),
            lastAccessAt: entry.timestamp,
            meta: getManifestMeta?.(data),
          });
        }
      }
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  function scheduleSave(getData: () => T): void {
    clearTimer();

    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      try {
        void writeEntry(getData());
      } catch (error) {
        onPersistentStorageError?.(error);
      }
    }, DEBOUNCE_MS);
  }

  async function saveNow(data: T): Promise<void> {
    clearTimer();
    await writeEntry(data);
  }

  async function clear(): Promise<void> {
    clearTimer();
    const key = getKey();
    if (key === false) return;

    try {
      await adapter.remove(key);
      if (usesManagedLocalStorage) {
        clearManagedLocalStorageRoot(
          getManagedLocalStorageRootKeyForSingle(key),
        );
      }
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  function dispose(): void {
    clearTimer();
  }

  return { load, scheduleSave, saveNow, clear, dispose };
}

export type PersistentStorageNamespaceHandle<T> = {
  readEntry(entryKey: string): Promise<StorageCacheEntry<T> | null>;
  load(entryKey: string): Promise<T | null>;
  save(entryKey: string, data: T): Promise<void>;
  remove(entryKey: string): Promise<void>;
  listKeys(): Promise<string[]>;
  clear(): Promise<void>;
  dispose(): void;
};

export function createPersistentStorageNamespaceHandle<T>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'> & {
    entryPrefix: string;
  },
  {
    getManifestMeta,
  }: { getManifestMeta?: (data: T, entryKey: string) => unknown } = {},
): PersistentStorageNamespaceHandle<T> {
  const version = config.version ?? 1;
  const { onPersistentStorageError } = config;
  const adapter = config.adapter;
  const usesManagedLocalStorage = adapter === localPersistentStorage;

  function registerManagedRoot(prefix: string): void {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false || !usesManagedLocalStorage) return;

    registerManagedLocalStorageRoot({
      sessionKey,
      storeName: config.storeName,
      mode: 'namespace',
      storagePrefix: prefix,
      cleanupIntervalMs: config.cleanupIntervalMs,
      maxAgeMs: getMaxAgeForAdapter(adapter),
    });
  }

  if (!usesManagedLocalStorage && !scannedAdapters.has(adapter)) {
    scannedAdapters.add(adapter);
    scheduleIdleCleanup(() => {
      void runExpirationScan(adapter, getMaxAgeForAdapter(adapter));
    });
  }

  function getPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    const prefix = `${getStorageKey(sessionKey, config.storeName)}.${config.entryPrefix}.`;
    registerManagedRoot(prefix);
    return prefix;
  }

  if (usesManagedLocalStorage) {
    void getPrefix();
  }

  function getKey(entryKey: string): string | false {
    const prefix = getPrefix();
    if (prefix === false) return false;
    return `${prefix}${entryKey}`;
  }

  async function readEntry(
    entryKey: string,
  ): Promise<StorageCacheEntry<T> | null> {
    const key = getKey(entryKey);
    if (key === false) return null;
    try {
      if (
        usesManagedLocalStorage &&
        readManagedLocalStorageEntryByPayload(key) === null
      ) {
        return null;
      }

      const entry = await adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => {
          void adapter.remove(key);
          removeManagedLocalStoragePayload(key);
        });
        return null;
      }

      return entry;
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function load(entryKey: string): Promise<T | null> {
    const key = getKey(entryKey);
    const entry = await readEntry(entryKey);
    if (!key || !entry) return null;

    scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));

    return entry.data;
  }

  async function save(entryKey: string, data: T): Promise<void> {
    const key = getKey(entryKey);
    if (key === false) return;

    const entry: StorageCacheEntry<T> = {
      data,
      timestamp: Date.now(),
      version,
    };

    try {
      await adapter.write(key, entry);
      if (usesManagedLocalStorage) {
        const sessionKey = config.getSessionKey();
        const prefix = getPrefix();
        if (sessionKey !== false && prefix !== false) {
          upsertManagedLocalStorageNamespaceEntry({
            sessionKey,
            storeName: config.storeName,
            storagePrefix: prefix,
            entryKey,
            payloadKey: key,
            cleanupIntervalMs: config.cleanupIntervalMs,
            maxAgeMs: getMaxAgeForAdapter(adapter),
            lastAccessAt: entry.timestamp,
            meta: getManifestMeta?.(data, entryKey),
          });
        }
      }
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function remove(entryKey: string): Promise<void> {
    const key = getKey(entryKey);
    if (key === false) return;

    try {
      await adapter.remove(key);
      if (usesManagedLocalStorage) {
        removeManagedLocalStoragePayload(key);
      }
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function listKeys(): Promise<string[]> {
    const prefix = getPrefix();
    if (prefix === false) return [];

    try {
      if (usesManagedLocalStorage) {
        const managedKeys = listManagedLocalStorageKeysSync(prefix);
        return (managedKeys ?? []).map((key) => key.slice(prefix.length));
      }

      const keys = await adapter.listKeys(prefix);
      return keys.map((key) => key.slice(prefix.length));
    } catch (error) {
      onPersistentStorageError?.(error);
      return [];
    }
  }

  async function clear(): Promise<void> {
    const prefix = getPrefix();
    if (prefix === false) return;

    try {
      if (usesManagedLocalStorage) {
        clearManagedLocalStorageRoot(
          getManagedLocalStorageRootKeyForPrefix(prefix),
        );
        return;
      }

      await adapter.removeByPrefix(prefix);
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  function dispose(): void {
    // No-op for namespaced handles: debouncing lives in the store integrations.
  }

  return { readEntry, load, save, remove, listKeys, clear, dispose };
}

/**
 * Synchronously reads from localStorage for initial state hydration.
 * Only works with sync adapters backed by localStorage-compatible storage. Returns null if data is not found,
 * version mismatches, or schema validation fails.
 */
export function readFromLocalStorageSync<T>(
  key: string,
  version: number,
  schema: PersistentStorageSchema<T>,
): T | null {
  if (readManagedLocalStorageEntryByPayload(key) === null) {
    return null;
  }

  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const entryResult = rc_parse_json(raw, cacheEntrySchema);
    if (!entryResult.ok) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }
    const entry = entryResult.value;

    if (entry.version !== version) {
      scheduleIdleCleanup(() => {
        localStorage.removeItem(key);
        removeManagedLocalStoragePayload(key);
      });
      return null;
    }

    // Validate as a single item
    const validated = validateWithSchema(schema, entry.data);

    if (validated !== null) {
      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
    } else {
      scheduleIdleCleanup(() => {
        localStorage.removeItem(key);
        removeManagedLocalStoragePayload(key);
      });
    }

    return validated;
  } catch {
    scheduleIdleCleanup(() => {
      localStorage.removeItem(key);
      removeManagedLocalStoragePayload(key);
    });
    return null;
  }
}

export function readStorageEntryFromLocalStorageSync<T = unknown>(
  key: string,
  version: number,
): StorageCacheEntry<T> | null {
  if (readManagedLocalStorageEntryByPayload(key) === null) {
    return null;
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const result = rc_parse_json(raw, cacheEntrySchema);
    if (!result.ok) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }
    const entry = result.value;
    if (entry.version !== version) {
      scheduleIdleCleanup(() => {
        localStorage.removeItem(key);
        removeManagedLocalStoragePayload(key);
      });
      return null;
    }

    return entry as StorageCacheEntry<T>;
  } catch {
    scheduleIdleCleanup(() => {
      localStorage.removeItem(key);
      removeManagedLocalStoragePayload(key);
    });
    return null;
  }
}

/**
 * Gets the storage key for a given session and store name.
 * Exported for use by store persistence integrations.
 */
export function getStorageKeyForStore(
  sessionKey: string,
  storeName: string,
): string {
  return getStorageKey(sessionKey, storeName);
}

export function getStoragePrefixForStoreNamespace(
  sessionKey: string,
  storeName: string,
  entryPrefix: string,
): string {
  return `${getStorageKey(sessionKey, storeName)}.${entryPrefix}.`;
}

export function createProtectedStorageKey(args: {
  sessionKey: string;
  storeName: string;
  kind: string;
  key: string;
}): string {
  if (args.kind === 'document' && args.key === 'document') {
    return getStorageKeyForStore(args.sessionKey, args.storeName);
  }

  return `${getStoragePrefixForStoreNamespace(
    args.sessionKey,
    args.storeName,
    args.kind,
  )}${args.key}`;
}

export function listLocalStorageKeysSync(prefix: string): string[] {
  const managedKeys = listManagedLocalStorageKeysSync(prefix);
  return managedKeys ?? [];
}

/** Clears all persistent storage entries for a given session key and adapter. */
export async function clearSessionStorage(
  sessionKey: string,
  adapter: StorageAdapter,
): Promise<void> {
  if (adapter === localPersistentStorage) {
    clearManagedLocalStorageSession(sessionKey);
    return;
  }

  await adapter.removeByPrefix(`tsdf.${sessionKey}.`);
}

/** Clears all persistent storage entries for a given session key across built-in adapters. */
export async function clearAllSessionStorage(
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    clearSessionStorage(sessionKey, localPersistentStorage),
    clearSessionStorage(sessionKey, opfsPersistentStorage),
  ]);
}

/**
 * Refreshes the timestamp of a localStorage cache entry to track last access time.
 * Used by store persistence setup functions after successful sync reads.
 */
export function refreshLocalStorageTimestamp(key: string): void {
  if (touchManagedLocalStoragePayload(key)) return;

  const raw = localStorage.getItem(key);
  if (raw === null) return;

  const result = rc_parse_json(raw, cacheEntrySchema);
  if (!result.ok) return;

  localStorage.setItem(
    key,
    JSON.stringify({ ...result.value, timestamp: Date.now() }),
  );
}

async function runExpirationScan(
  adapter: StorageAdapter,
  maxAgeMs: number,
): Promise<void> {
  if (adapter === localPersistentStorage) {
    await runManagedLocalStorageMaintenance();
    return;
  }

  const prefix = 'tsdf.';
  const keys = await adapter.listKeys(prefix);
  const now = Date.now();
  const protectedKeys = new Set<string>();

  for (const key of keys) {
    if (!key.endsWith('.__offline__.protected')) continue;

    const entry = await adapter.read<StorageCacheEntry<{ keys: string[] }>>(
      key,
    );
    for (const protectedKey of entry?.data.keys ?? []) {
      protectedKeys.add(protectedKey);
    }
  }

  for (const key of keys) {
    if (key.includes('.__offline__.')) continue;
    if (protectedKeys.has(key)) continue;

    const raw = await adapter.read<unknown>(key);
    if (!raw) {
      await adapter.remove(key);
      continue;
    }

    const result = rc_parse(raw, timestampSchema);
    if (!result.ok || now - result.value.timestamp > maxAgeMs) {
      await adapter.remove(key);
    }
  }
}

/** Resets expiration scan tracking. Exported for test cleanup. */
export function resetExpirationScanTracking(): void {
  scannedAdapters = new WeakSet<StorageAdapter>();
  resetManagedLocalStorageState();
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  const entry = await adapter.read<StorageCacheEntry<{ keys: string[] }>>(
    `tsdf.${sessionKey}.__offline__.protected`,
  );

  return new Set(entry?.data.keys ?? []);
}
