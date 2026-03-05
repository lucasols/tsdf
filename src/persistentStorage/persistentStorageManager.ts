import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createStorageAdapter } from './storageAdapter';
import type {
  PersistentStorageBaseConfig,
  PersistentStorageSchema,
  StorageAdapter,
  StorageBackend,
  StorageCacheEntry,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEBOUNCE_MS = 1000;

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
  const { onPersistentStorageError } = config;
  const adapter =
    adapterOverride ?? createStorageAdapter(config.backend ?? 'opfs');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  async function load(): Promise<T | null> {
    const key = getKey();
    if (key === false) return null;

    const entry = await adapter.read<StorageCacheEntry<T>>(key);

    if (!entry) return null;
    if (entry.version !== version) return null;

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
      void writeEntry(getData());
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

    const entry = __LEGIT_CAST__<StorageCacheEntry<unknown>, unknown>(
      JSON.parse(raw),
    );

    if (entry.version !== version) return null;

    // Validate as a single item
    const validated = validateWithSchema(schema, entry.data);
    return validated;
  } catch {
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
