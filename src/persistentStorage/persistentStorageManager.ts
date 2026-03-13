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
  AsyncStorageAdapter,
  PersistentStorageBaseConfig,
  StorageAdapter,
  StorageCacheEntry,
} from './types';

const DEBOUNCE_MS = 1000;
export const SYNC_STORAGE_TOUCH_THROTTLE_MS = 60_000;

const PERSISTENT_STORAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number,
});

const timestampSchema = rc_object({ timestamp: rc_number });

let localStorageExpirationScanScheduled = false;
let scannedAsyncAdapters = new WeakSet<AsyncStorageAdapter>();
let localStorageTouchTimestamps = new Map<string, number>();

export function getLocalStorageAdapter(
  adapter: StorageAdapter,
): typeof localPersistentStorage | null {
  return adapter === 'local-sync' ? localPersistentStorage : null;
}

function getStorageKey(sessionKey: string, storeName: string): string {
  return `tsdf.${sessionKey}.${storeName}`;
}

function scheduleAdapterExpirationScan(adapter: StorageAdapter): void {
  if (adapter === 'local-sync') {
    if (localStorageExpirationScanScheduled) return;
    localStorageExpirationScanScheduled = true;
  } else {
    if (scannedAsyncAdapters.has(adapter)) return;
    scannedAsyncAdapters.add(adapter);
  }
  scheduleIdleCleanup(() => {
    void runExpirationScan(adapter, PERSISTENT_STORAGE_MAX_AGE_MS);
  });
}

async function runLocalStorageMutation<T>(
  callback: () => T | Promise<T>,
): Promise<T> {
  return localPersistentStorage.runLocked(callback);
}

function recordLocalStorageTouch(key: string, timestamp: number): void {
  localStorageTouchTimestamps.set(key, timestamp);
}

function shouldThrottleLocalStorageTouch(
  key: string,
  timestamp: number,
): boolean {
  const previousTimestamp = localStorageTouchTimestamps.get(key);
  return (
    previousTimestamp !== undefined &&
    timestamp - previousTimestamp < SYNC_STORAGE_TOUCH_THROTTLE_MS
  );
}

export function scheduleLocalStorageRemoval(key: string): void {
  scheduleIdleCleanup(() => {
    void runLocalStorageMutation(() => {
      localPersistentStorage.remove(key);
    });
  });
}

type LocalStorageMetadataLookupMode = 'auto' | 'single' | 'namespace';

type LocalStorageMetadataOptions = {
  metadataMode?: LocalStorageMetadataLookupMode;
  metadataNamespacePrefix?: string;
};

function refreshLocalStorageTimestampUnlocked(
  key: string,
  {
    metadataMode = 'auto',
    metadataNamespacePrefix,
  }: LocalStorageMetadataOptions = {},
): void {
  const now = Date.now();
  if (shouldThrottleLocalStorageTouch(key, now)) return;

  if (
    localPersistentStorage.touchEntry(key, {
      mode: metadataMode,
      namespacePrefix: metadataNamespacePrefix,
    })
  ) {
    recordLocalStorageTouch(key, now);
    return;
  }

  const raw = localPersistentStorage.readRaw(key);
  if (raw === null) return;

  const result = rc_parse_json(raw, cacheEntrySchema);
  if (!result.ok) return;

  localPersistentStorage.write(key, { ...result.value, timestamp: now });
  recordLocalStorageTouch(key, now);
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
      if (adapter === 'local-sync') {
        const entry = readStorageEntryFromLocalStorageSync<T>(key, version);
        if (!entry) return null;

        scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
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
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.write(key, entry);
          const sessionKey = config.getSessionKey();
          if (sessionKey === false) return;

          localPersistentStorage.upsertSingleEntry({
            sessionKey,
            storeName: config.storeName,
            storageKey: key,
            cleanupIntervalMs: config.cleanupIntervalMs,
            maxAgeMs: PERSISTENT_STORAGE_MAX_AGE_MS,
            lastAccessAt: entry.timestamp,
            meta: getManifestMeta?.(data),
          });
          recordLocalStorageTouch(key, entry.timestamp);
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
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.clearRoot(
            localPersistentStorage.getRootKeyForSingle(key),
          );
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
    const prefix = getPrefix();
    if (prefix === false) return null;

    const key = `${prefix}${entryKey}`;
    try {
      if (adapter === 'local-sync') {
        return readStorageEntryFromLocalStorageSync<T>(key, version, {
          metadataMode: 'namespace',
          metadataNamespacePrefix: prefix,
        });
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
    const prefix = getPrefix();
    if (prefix === false) return null;

    const key = `${prefix}${entryKey}`;
    const entry = await readEntry(entryKey);
    if (!entry) return null;

    if (adapter === 'local-sync') {
      scheduleIdleCleanup(() =>
        refreshLocalStorageTimestamp(key, {
          metadataMode: 'namespace',
          metadataNamespacePrefix: prefix,
        }),
      );
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
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.write(key, entry);
          const sessionKey = config.getSessionKey();
          const prefix = getPrefix();
          if (sessionKey === false || prefix === false) return;

          localPersistentStorage.upsertNamespaceEntry({
            sessionKey,
            storeName: config.storeName,
            storagePrefix: prefix,
            entryKey,
            payloadKey: key,
            cleanupIntervalMs: config.cleanupIntervalMs,
            maxAgeMs: PERSISTENT_STORAGE_MAX_AGE_MS,
            lastAccessAt: entry.timestamp,
            meta: getManifestMeta?.(data, entryKey),
          });
          recordLocalStorageTouch(key, entry.timestamp);
        });
        return;
      }

      await adapter.write(key, entry);
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function remove(entryKey: string): Promise<void> {
    const prefix = getPrefix();
    if (prefix === false) return;

    const key = `${prefix}${entryKey}`;

    try {
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.remove(key, {
            mode: 'namespace',
            namespacePrefix: prefix,
          });
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
      if (adapter === 'local-sync') {
        return localPersistentStorage
          .listKeys(prefix)
          .map((key) => key.slice(prefix.length));
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
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.clearRoot(
            localPersistentStorage.getRootKeyForPrefix(prefix),
          );
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

export function readStorageEntryFromLocalStorageSync<T = unknown>(
  key: string,
  version: number,
  {
    metadataMode = 'auto',
    metadataNamespacePrefix,
  }: LocalStorageMetadataOptions = {},
): StorageCacheEntry<T> | null {
  const metadata = localPersistentStorage.readEntryMetadataByPayload(key, {
    mode: metadataMode,
    namespacePrefix: metadataNamespacePrefix,
  });
  const raw = localPersistentStorage.readRaw(key);

  if (metadata === null) {
    if (raw !== null) {
      scheduleLocalStorageRemoval(key);
    }
    return null;
  }

  if (raw === null) {
    scheduleLocalStorageRemoval(key);
    return null;
  }

  try {
    const result = rc_parse_json(raw, cacheEntrySchema);
    if (!result.ok) {
      scheduleLocalStorageRemoval(key);
      return null;
    }
    const entry = result.value;
    if (entry.version !== version) {
      scheduleLocalStorageRemoval(key);
      return null;
    }

    return __LEGIT_CAST__<StorageCacheEntry<T>, StorageCacheEntry<unknown>>(
      entry,
    );
  } catch {
    scheduleLocalStorageRemoval(key);
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
  if (adapter === 'local-sync') {
    localPersistentStorage.clearSession(sessionKey);
    return;
  }

  await adapter.removeByPrefix(`tsdf.${sessionKey}.`);
}

/** Clears all persistent storage entries for a given session key across built-in adapters. */
export async function clearAllSessionStorage(
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    clearSessionStorage(sessionKey, 'local-sync'),
    clearSessionStorage(sessionKey, opfsPersistentStorage),
  ]);
}

/**
 * Refreshes the timestamp of a localStorage cache entry to track last access time.
 * Used by store persistence setup functions after successful sync reads.
 */
export function refreshLocalStorageTimestamp(
  key: string,
  options?: LocalStorageMetadataOptions,
): void {
  void localPersistentStorage.runLocked(() => {
    refreshLocalStorageTimestampUnlocked(key, options);
  });
}

async function runExpirationScan(
  adapter: StorageAdapter,
  maxAgeMs: number,
): Promise<void> {
  if (adapter === 'local-sync') {
    await localPersistentStorage.runMaintenance();
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
  localStorageExpirationScanScheduled = false;
  scannedAsyncAdapters = new WeakSet<AsyncStorageAdapter>();
  localStorageTouchTimestamps = new Map<string, number>();
  resetManagedLocalStorageState();
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  if (adapter === 'local-sync') {
    return localPersistentStorage.readProtectedStorageKeys(sessionKey);
  }

  const entry = await adapter.read<StorageCacheEntry<{ keys: string[] }>>(
    `tsdf.${sessionKey}.__offline__.protected`,
  );

  return new Set(entry?.data.keys ?? []);
}
