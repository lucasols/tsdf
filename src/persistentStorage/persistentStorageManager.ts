import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_number,
  rc_object,
  rc_parse,
  rc_parse_json,
  rc_unknown,
} from 'runcheck';
import { resetManagedLocalStorageState } from './localStorageMetadata';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  localPersistentStorage,
  opfsPersistentStorage,
} from './storageAdapter';
import type {
  PersistentStorageBaseConfig,
  PersistentStorageSchema,
  SyncStorageAdapter,
  StorageAdapter,
  StorageCacheEntry,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEBOUNCE_MS = 1000;
export const SYNC_STORAGE_TOUCH_THROTTLE_MS = 60_000;

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
let syncStorageTouchTimestamps = new WeakMap<
  SyncStorageAdapter,
  Map<string, number>
>();

function getStorageKey(sessionKey: string, storeName: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

function scheduleAdapterExpirationScan(adapter: StorageAdapter): void {
  if (scannedAdapters.has(adapter)) return;

  scannedAdapters.add(adapter);
  scheduleIdleCleanup(() => {
    void runExpirationScan(adapter, getMaxAgeForAdapter(adapter));
  });
}

async function runSyncStorageMutation<T>(
  adapter: SyncStorageAdapter,
  callback: () => T | Promise<T>,
): Promise<T> {
  if (adapter.runLocked) {
    return adapter.runLocked(callback);
  }

  return await callback();
}

function getSyncStorageTouchTimestampMap(
  adapter: SyncStorageAdapter,
): Map<string, number> {
  let timestamps = syncStorageTouchTimestamps.get(adapter);
  if (!timestamps) {
    timestamps = new Map<string, number>();
    syncStorageTouchTimestamps.set(adapter, timestamps);
  }

  return timestamps;
}

function recordSyncStorageTouch(
  adapter: SyncStorageAdapter,
  key: string,
  timestamp: number,
): void {
  getSyncStorageTouchTimestampMap(adapter).set(key, timestamp);
}

function shouldThrottleSyncStorageTouch(
  adapter: SyncStorageAdapter,
  key: string,
  timestamp: number,
): boolean {
  const previousTimestamp = getSyncStorageTouchTimestampMap(adapter).get(key);
  return (
    previousTimestamp !== undefined &&
    timestamp - previousTimestamp < SYNC_STORAGE_TOUCH_THROTTLE_MS
  );
}

export function scheduleSyncStorageRemoval(
  adapter: SyncStorageAdapter,
  key: string,
): void {
  scheduleIdleCleanup(() => {
    void runSyncStorageMutation(adapter, () => {
      adapter.remove(key);
    });
  });
}

function refreshSyncStorageTimestampUnlocked(
  adapter: SyncStorageAdapter,
  key: string,
): void {
  const now = Date.now();
  if (shouldThrottleSyncStorageTouch(adapter, key, now)) return;

  if (adapter.touchEntry(key)) {
    recordSyncStorageTouch(adapter, key, now);
    return;
  }

  const raw = adapter.readRaw(key);
  if (raw === null) return;

  const result = rc_parse_json(raw, cacheEntrySchema);
  if (!result.ok) return;

  adapter.write(key, { ...result.value, timestamp: now });
  recordSyncStorageTouch(adapter, key, now);
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
  const syncAdapter = adapter.kind === 'sync' ? adapter : null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  scheduleAdapterExpirationScan(adapter);

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
    try {
      if (syncAdapter !== null) {
        const entry = readStorageEntryFromSyncStorageSync<T>(
          syncAdapter,
          key,
          version,
        );
        if (!entry) return null;

        scheduleIdleCleanup(() =>
          refreshSyncStorageTimestamp(syncAdapter, key),
        );
        return entry.data;
      }

      const entry = await adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => {
          void adapter.remove(key);
        });
        return null;
      }

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
      if (syncAdapter !== null) {
        await runSyncStorageMutation(syncAdapter, () => {
          syncAdapter.write(key, entry);
          const sessionKey = config.getSessionKey();
          if (sessionKey === false) return;

          syncAdapter.upsertSingleEntry({
            sessionKey,
            storeName: config.storeName,
            storageKey: key,
            cleanupIntervalMs: config.cleanupIntervalMs,
            maxAgeMs: getMaxAgeForAdapter(syncAdapter),
            lastAccessAt: entry.timestamp,
            meta: getManifestMeta?.(data),
          });
          recordSyncStorageTouch(syncAdapter, key, entry.timestamp);
        });
        return;
      }

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

    try {
      if (syncAdapter !== null) {
        await runSyncStorageMutation(syncAdapter, () => {
          syncAdapter.clearRoot(syncAdapter.getRootKeyForSingle(key));
        });
      } else {
        await adapter.remove(key);
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
  const syncAdapter = adapter.kind === 'sync' ? adapter : null;
  scheduleAdapterExpirationScan(adapter);

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
  ): Promise<StorageCacheEntry<T> | null> {
    const key = getKey(entryKey);
    if (key === false) return null;
    try {
      if (syncAdapter !== null) {
        return readStorageEntryFromSyncStorageSync<T>(
          syncAdapter,
          key,
          version,
        );
      }

      const entry = await adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (entry.version !== version) {
        scheduleIdleCleanup(() => {
          void adapter.remove(key);
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

    if (syncAdapter !== null) {
      scheduleIdleCleanup(() => refreshSyncStorageTimestamp(syncAdapter, key));
    }

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
      if (syncAdapter !== null) {
        await runSyncStorageMutation(syncAdapter, () => {
          syncAdapter.write(key, entry);
          const sessionKey = config.getSessionKey();
          const prefix = getPrefix();
          if (sessionKey === false || prefix === false) return;

          syncAdapter.upsertNamespaceEntry({
            sessionKey,
            storeName: config.storeName,
            storagePrefix: prefix,
            entryKey,
            payloadKey: key,
            cleanupIntervalMs: config.cleanupIntervalMs,
            maxAgeMs: getMaxAgeForAdapter(syncAdapter),
            lastAccessAt: entry.timestamp,
            meta: getManifestMeta?.(data, entryKey),
          });
          recordSyncStorageTouch(syncAdapter, key, entry.timestamp);
        });
        return;
      }

      await adapter.write(key, entry);
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function remove(entryKey: string): Promise<void> {
    const key = getKey(entryKey);
    if (key === false) return;

    try {
      if (syncAdapter !== null) {
        await runSyncStorageMutation(syncAdapter, () => {
          syncAdapter.remove(key);
        });
        return;
      }

      await adapter.remove(key);
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function listKeys(): Promise<string[]> {
    const prefix = getPrefix();
    if (prefix === false) return [];

    try {
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
      if (syncAdapter !== null) {
        await runSyncStorageMutation(syncAdapter, () => {
          syncAdapter.clearRoot(syncAdapter.getRootKeyForPrefix(prefix));
        });
      } else {
        await adapter.removeByPrefix(prefix);
      }
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
 * Synchronously reads from a sync storage adapter for initial state hydration.
 * Returns null if data is not found,
 * version mismatches, or schema validation fails.
 */
export function readFromSyncStorageSync<T>(
  adapter: SyncStorageAdapter,
  key: string,
  version: number,
  schema: PersistentStorageSchema<T>,
): T | null {
  const entry = readStorageEntryFromSyncStorageSync<T>(adapter, key, version);
  if (!entry) return null;

  const validated = validateWithSchema(schema, entry.data);

  if (validated !== null) {
    scheduleIdleCleanup(() => refreshSyncStorageTimestamp(adapter, key));
  } else {
    scheduleSyncStorageRemoval(adapter, key);
  }

  return validated;
}

export function readStorageEntryFromSyncStorageSync<T = unknown>(
  adapter: SyncStorageAdapter,
  key: string,
  version: number,
): StorageCacheEntry<T> | null {
  const metadata = adapter.readEntryMetadataByPayload(key);
  const raw = adapter.readRaw(key);

  if (metadata === null) {
    if (raw !== null) {
      scheduleSyncStorageRemoval(adapter, key);
    }
    return null;
  }

  if (raw === null) {
    scheduleSyncStorageRemoval(adapter, key);
    return null;
  }

  try {
    const result = rc_parse_json(raw, cacheEntrySchema);
    if (!result.ok) {
      scheduleSyncStorageRemoval(adapter, key);
      return null;
    }
    const entry = result.value;
    if (entry.version !== version) {
      scheduleSyncStorageRemoval(adapter, key);
      return null;
    }

    return __LEGIT_CAST__<StorageCacheEntry<T>, StorageCacheEntry<unknown>>(
      entry,
    );
  } catch {
    scheduleSyncStorageRemoval(adapter, key);
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

export function readManifestPayloadMeta(meta: unknown): unknown {
  if (typeof meta !== 'object' || meta === null || !('payload' in meta)) {
    return undefined;
  }

  return meta.payload;
}

/** Clears all persistent storage entries for a given session key and adapter. */
export async function clearSessionStorage(
  sessionKey: string,
  adapter: StorageAdapter,
): Promise<void> {
  if (adapter.kind === 'sync') {
    adapter.clearSession(sessionKey);
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
 * Refreshes the timestamp of a sync cache entry to track last access time.
 * Used by store persistence setup functions after successful sync reads.
 */
export function refreshSyncStorageTimestamp(
  adapter: SyncStorageAdapter,
  key: string,
): void {
  if (adapter.runLocked) {
    void adapter.runLocked(() => {
      refreshSyncStorageTimestampUnlocked(adapter, key);
    });
    return;
  }

  refreshSyncStorageTimestampUnlocked(adapter, key);
}

async function runExpirationScan(
  adapter: StorageAdapter,
  maxAgeMs: number,
): Promise<void> {
  if (adapter.kind === 'sync') {
    await adapter.runMaintenance();
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
  syncStorageTouchTimestamps = new WeakMap<
    SyncStorageAdapter,
    Map<string, number>
  >();
  resetManagedLocalStorageState();
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  if (adapter.kind === 'sync') {
    return adapter.readProtectedStorageKeys(sessionKey);
  }

  const entry = await adapter.read<StorageCacheEntry<{ keys: string[] }>>(
    `tsdf.${sessionKey}.__offline__.protected`,
  );

  return new Set(entry?.data.keys ?? []);
}
