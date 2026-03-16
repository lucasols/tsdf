import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_parse,
  rc_number,
  rc_object,
  rc_parse_json,
  rc_unknown,
} from 'runcheck';
import {
  getManagedLocalStorageRuntimeConfig,
  isManagedLocalStorageEntryOfflineProtected,
  resetManagedLocalStorageState,
  setManagedLocalStorageEntryOfflineProtected,
} from './localStorageMetadata';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  localPersistentStorage,
  opfsPersistentStorage,
  type LocalStorageMetadataOptions,
} from './storageAdapter';
import type {
  AsyncStorageAdapter,
  PersistentStorageBaseConfig,
  StorageAdapter,
  StorageCacheEntry,
} from './types';

const DEBOUNCE_MS = 1000;
export const SYNC_STORAGE_TOUCH_THROTTLE_MS = 60_000;

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number.optional(),
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

export function assertValidPersistentStoreName(storeName: string): void {
  if (import.meta.env.PROD) return;
  if (!storeName.includes('.')) return;

  throw new Error(
    `[tsdf] persistentStorage.storeName "${storeName}" must not contain ".".`,
  );
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
    void runExpirationScan(
      adapter,
      getManagedLocalStorageRuntimeConfig().maxAgeMs,
    );
  });
}

function preserveOfflineProtectionFlag(
  sessionKey: string,
  storageKey: string,
  nextMeta: unknown,
  getCurrentMeta: () => unknown,
): unknown {
  const currentMetaProtected =
    isManagedLocalStorageEntryOfflineProtected(getCurrentMeta());
  const protectedKeys = getSessionProtectedKeysSnapshot(sessionKey);
  if (protectedKeys !== null) {
    return setManagedLocalStorageEntryOfflineProtected(
      nextMeta,
      protectedKeys.has(storageKey) || currentMetaProtected,
    );
  }

  return currentMetaProtected
    ? setManagedLocalStorageEntryOfflineProtected(nextMeta, true)
    : nextMeta;
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

export function scheduleLocalStorageRemoval(
  key: string,
  options: LocalStorageMetadataOptions,
): void {
  scheduleIdleCleanup(() => {
    void runLocalStorageMutation(() => {
      localPersistentStorage.remove(key, options);
    });
  });
}

function refreshLocalStorageTimestampUnlocked(
  key: string,
  options: LocalStorageMetadataOptions,
): void {
  const now = Date.now();
  if (shouldThrottleLocalStorageTouch(key, now)) return;

  const touched =
    options.metadata === 'single'
      ? localPersistentStorage.touchSingleEntry(key)
      : localPersistentStorage.touchNamespaceEntry(
          key,
          options.namespacePrefix,
        );

  if (touched) {
    recordLocalStorageTouch(key, now);
  }
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
  const version = config.version;
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
        const entry = readStorageEntryFromLocalStorageSync<T>(key, version, {
          metadata: 'single',
        });
        if (!entry) return null;

        scheduleIdleCleanup(() =>
          refreshLocalStorageTimestamp(key, { metadata: 'single' }),
        );
        return entry.data;
      }

      const entry = await adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (!doesStorageEntryVersionMatch(entry.version, version)) {
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
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const entry = createStorageCacheEntry(data, Date.now(), version);

    try {
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.write(key, entry);
          localPersistentStorage.upsertSingleEntry({
            storageKey: key,
            lastAccessAt: entry.timestamp,
            meta: preserveOfflineProtectionFlag(
              sessionKey,
              key,
              getManifestMeta?.(data),
              () =>
                localPersistentStorage.readSingleEntryMetadataByPayload(key)
                  ?.meta,
            ),
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
          localPersistentStorage.clearManifest(
            localPersistentStorage.getManifestKeyForSingle(key),
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
  const version = config.version;
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
          metadata: 'namespace',
          namespacePrefix: prefix,
        });
      }

      const entry = await adapter.read<StorageCacheEntry<T>>(key);
      if (!entry) return null;

      if (!doesStorageEntryVersionMatch(entry.version, version)) {
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
          metadata: 'namespace',
          namespacePrefix: prefix,
        }),
      );
    }

    return entry.data;
  }

  async function save(entryKey: string, data: T): Promise<void> {
    const key = getKey(entryKey);
    if (key === false) return;
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const entry = createStorageCacheEntry(data, Date.now(), version);

    try {
      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.write(key, entry);
          const prefix = getPrefix();
          if (prefix === false) return;

          localPersistentStorage.upsertNamespaceEntry({
            storagePrefix: prefix,
            entryKey,
            lastAccessAt: entry.timestamp,
            meta: preserveOfflineProtectionFlag(
              sessionKey,
              key,
              getManifestMeta?.(data, entryKey),
              () =>
                localPersistentStorage.readNamespaceEntryMetadataByPayload(
                  key,
                  prefix,
                )?.meta,
            ),
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
            metadata: 'namespace',
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
          localPersistentStorage.clearManifest(
            localPersistentStorage.getManifestKeyForPrefix(prefix),
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
  version: number | undefined,
  options: LocalStorageMetadataOptions,
): StorageCacheEntry<T> | null {
  const metadata =
    options.metadata === 'single'
      ? localPersistentStorage.readSingleEntryMetadataByPayload(key)
      : localPersistentStorage.readNamespaceEntryMetadataByPayload(
          key,
          options.namespacePrefix,
        );
  const raw = localPersistentStorage.readRaw(key);

  function removeAndReturnNull(): null {
    scheduleLocalStorageRemoval(key, options);
    return null;
  }

  if (metadata === null) {
    if (raw !== null) return removeAndReturnNull();
    return null;
  }

  if (
    Date.now() - metadata.lastAccessAt >
    getManagedLocalStorageRuntimeConfig().maxAgeMs
  ) {
    return removeAndReturnNull();
  }

  if (raw === null) return removeAndReturnNull();

  try {
    const result = rc_parse_json(raw, cacheEntrySchema);
    if (!result.ok) return removeAndReturnNull();
    const entry = result.value;
    if (!doesStorageEntryVersionMatch(entry.version, version)) {
      return removeAndReturnNull();
    }

    return __LEGIT_CAST__<StorageCacheEntry<T>, StorageCacheEntry<unknown>>(
      entry,
    );
  } catch {
    return removeAndReturnNull();
  }
}

function doesStorageEntryVersionMatch(
  entryVersion: number | undefined,
  expectedVersion: number | undefined,
): boolean {
  if (expectedVersion === undefined) {
    return entryVersion === undefined;
  }

  return entryVersion === expectedVersion;
}

function createStorageCacheEntry<T>(
  data: T,
  timestamp: number,
  version: number | undefined,
): StorageCacheEntry<T> {
  if (version === undefined) {
    return { data, timestamp };
  }

  return { data, timestamp, version };
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
  if (typeof meta !== 'object' || meta === null || !('p' in meta)) {
    return undefined;
  }

  return meta.p;
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
  options: LocalStorageMetadataOptions,
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
    if (!key.endsWith('._o_.p')) continue;

    const entry =
      await adapter.read<StorageCacheEntry<{ keys: string[] }>>(key);
    for (const protectedKey of entry?.data.keys ?? []) {
      protectedKeys.add(protectedKey);
    }
  }

  for (const key of keys) {
    if (key.includes('._o_.')) continue;
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
    `tsdf.${sessionKey}._o_.p`,
  );

  return new Set(entry?.data.keys ?? []);
}
