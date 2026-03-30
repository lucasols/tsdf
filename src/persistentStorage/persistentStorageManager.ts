import {
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_unknown,
} from 'runcheck';

import type {
  PersistentStorageBaseConfig,
  PersistentStorageSchema,
  StorageAdapter,
  StorageBackend,
  StorageCacheEntry,
} from './types';

import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { createStorageAdapter } from './storageAdapter';
import { validateWithSchema } from './validateWithSchema';

const DEBOUNCE_MS = 1000;

const LOCAL_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const OPFS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks

function getMaxAgeForBackend(backend: StorageBackend): number {
  return backend === 'localStorage'
    ? LOCAL_STORAGE_MAX_AGE_MS
    : OPFS_MAX_AGE_MS;
}

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});

const timestampSchema = rc_object({ timestamp: rc_number });

const scannedBackends = new Set<StorageBackend>();

function getStorageKey(sessionKey: string, storeName: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

export type PersistentStorageHandle<T> = {
  /** Loads persisted data, validating the cache entry envelope. Returns raw entry data or null if not found or invalid. */
  load(): Promise<unknown>;
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
 * @param config - Storage configuration including backend, schema, and version.
 * @param itemValidator - Optional per-item validator for compound data structures.
 *   Called after the overall cache entry is loaded. Use this to validate individual
 *   items within collections/queries.
 */
export function createPersistentStorageHandle<T>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'>,
  {
    adapter: adapterOverride,
  }: {
    /** Override the storage adapter (useful for testing). */
    adapter?: StorageAdapter;
  } = {},
): PersistentStorageHandle<T> {
  const version = config.version ?? 1;
  const backendKey: StorageBackend = config.backend ?? 'opfs';
  const { onPersistentStorageError } = config;
  const adapter = adapterOverride ?? createStorageAdapter(backendKey);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Schedule expiration scan once per backend per session
  if (!adapterOverride && !scannedBackends.has(backendKey)) {
    scannedBackends.add(backendKey);
    scheduleIdleCleanup(() => {
      void runExpirationScan(adapter, getMaxAgeForBackend(backendKey));
    });
  }

  function getKey(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;
    return getStorageKey(sessionKey, config.storeName);
  }

  function clearTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function load(): Promise<unknown> {
    const key = getKey();
    if (key === false) return null;

    const rawEntry = await adapter.read(key);
    if (!rawEntry) return null;

    const entryResult = rc_parse(rawEntry, cacheEntrySchema);
    if (!entryResult.ok) {
      scheduleIdleCleanup(() => void adapter.remove(key));
      return null;
    }
    const entry = entryResult.value;

    if (entry.version !== version) {
      scheduleIdleCleanup(() => void adapter.remove(key));
      return null;
    }

    // Refresh timestamp to track last access time for expiration
    scheduleIdleCleanup(() => {
      void adapter.write(key, { ...entry, timestamp: Date.now() });
    });

    return entry.data;
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

    await adapter.remove(key);
  }

  function dispose(): void {
    clearTimer();
  }

  return { load, scheduleSave, saveNow, clear, dispose };
}

export type PersistentStorageNamespaceHandle<T> = {
  readEntry(entryKey: string): Promise<StorageCacheEntry<unknown> | null>;
  load(entryKey: string): Promise<unknown>;
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
  { adapter: adapterOverride }: { adapter?: StorageAdapter } = {},
): PersistentStorageNamespaceHandle<T> {
  const version = config.version ?? 1;
  const backendKey: StorageBackend = config.backend ?? 'opfs';
  const { onPersistentStorageError } = config;
  const adapter = adapterOverride ?? createStorageAdapter(backendKey);

  if (!adapterOverride && !scannedBackends.has(backendKey)) {
    scannedBackends.add(backendKey);
    scheduleIdleCleanup(() => {
      void runExpirationScan(adapter, getMaxAgeForBackend(backendKey));
    });
  }

  function getPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    return `${getStorageKey(sessionKey, config.storeName)}.${config.entryPrefix}.`;
  }

  function getKey(entryKey: string): string | false {
    const prefix = getPrefix();
    if (prefix === false) return false;
    return `${prefix}${entryKey}`;
  }

  async function readEntry(
    entryKey: string,
  ): Promise<StorageCacheEntry<unknown> | null> {
    const key = getKey(entryKey);
    if (key === false) return null;

    const rawEntry = await adapter.read(key);
    if (!rawEntry) return null;

    const entryResult = rc_parse(rawEntry, cacheEntrySchema);
    if (!entryResult.ok) {
      scheduleIdleCleanup(() => void adapter.remove(key));
      return null;
    }
    const entry = entryResult.value;

    if (entry.version !== version) {
      scheduleIdleCleanup(() => void adapter.remove(key));
      return null;
    }

    return entry;
  }

  async function load(entryKey: string): Promise<unknown> {
    const key = getKey(entryKey);
    const entry = await readEntry(entryKey);
    if (!key || !entry) return null;

    scheduleIdleCleanup(() => {
      void adapter.write(key, { ...entry, timestamp: Date.now() });
    });

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
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function remove(entryKey: string): Promise<void> {
    const key = getKey(entryKey);
    if (key === false) return;

    await adapter.remove(key);
  }

  async function listKeys(): Promise<string[]> {
    const prefix = getPrefix();
    if (prefix === false) return [];

    const keys = await adapter.listKeys(prefix);
    return keys.map((key) => key.slice(prefix.length));
  }

  async function clear(): Promise<void> {
    const prefix = getPrefix();
    if (prefix === false) return;

    await adapter.removeByPrefix(prefix);
  }

  function dispose(): void {
    // No-op for namespaced handles: debouncing lives in the store integrations.
  }

  return { readEntry, load, save, remove, listKeys, clear, dispose };
}

/**
 * Synchronously reads from localStorage for initial state hydration.
 * Only works with localStorage backend. Returns null if data is not found,
 * version mismatches, or schema validation fails.
 */
export function readFromLocalStorageSync<T>(
  key: string,
  version: number,
  schema: PersistentStorageSchema<T>,
): T | null {
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
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }

    // Validate as a single item
    const validated = validateWithSchema(schema, entry.data);

    if (validated !== null) {
      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
    } else {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
    }

    return validated;
  } catch {
    scheduleIdleCleanup(() => localStorage.removeItem(key));
    return null;
  }
}

export function readStorageEntryFromLocalStorageSync(
  key: string,
  version: number,
): StorageCacheEntry<unknown> | null {
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
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return null;
    }

    return entry;
  } catch {
    scheduleIdleCleanup(() => localStorage.removeItem(key));
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

export function listLocalStorageKeysSync(prefix: string): string[] {
  const keys: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      keys.push(key);
    }
  }

  return keys;
}

/** Clears all persistent storage entries for a given session key and backend. */
export async function clearSessionStorage(
  sessionKey: string,
  backend: StorageBackend,
): Promise<void> {
  const adapter = createStorageAdapter(backend);
  await adapter.removeByPrefix(`tsdf.${sessionKey}.`);
}

/** Clears all persistent storage entries for a given session key across all backends. */
export async function clearAllSessionStorage(
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    clearSessionStorage(sessionKey, 'localStorage'),
    clearSessionStorage(sessionKey, 'opfs'),
  ]);
}

/**
 * Refreshes the timestamp of a localStorage cache entry to track last access time.
 * Used by store persistence setup functions after successful sync reads.
 */
export function refreshLocalStorageTimestamp(key: string): void {
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
  const prefix = 'tsdf.';
  const keys = await adapter.listKeys(prefix);
  const now = Date.now();

  for (const key of keys) {
    const raw = await adapter.read(key);
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
  scannedBackends.clear();
}
