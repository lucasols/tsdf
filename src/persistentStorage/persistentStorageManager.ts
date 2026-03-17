import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { rc_number, rc_object, rc_parse_json, rc_unknown } from 'runcheck';
import {
  getManagedLocalStorageRuntimeConfig,
  isManagedLocalStorageEntryOfflineProtected,
  resetManagedLocalStorageState,
  setManagedLocalStorageEntryOfflineProtected,
} from './localStorageMetadata';
import {
  OpfsAsyncStorageAdapter,
  serializeProtectedRef,
} from './opfsAsyncStorageAdapter';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  isAsyncStorageAdapter,
  localPersistentStorage,
  opfsPersistentStorage,
  type LocalStorageMetadataOptions,
} from './storageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceKind,
  AsyncStorageNamespaceScope,
  AsyncStorageProtectedEntryRef,
  PersistentStorageBaseConfig,
  StorageAdapter,
  StorageCacheEntry,
} from './types';

const DEBOUNCE_MS = 1000;
const ASYNC_STORAGE_METADATA_PAGE_LIMIT = 100;
export const SYNC_STORAGE_TOUCH_THROTTLE_MS = 60_000;

const cacheEntrySchema = rc_object({
  data: rc_unknown,
  timestamp: rc_number,
  version: rc_number.optional(),
});

let localStorageExpirationScanScheduled = false;
let scannedAsyncAdapters = new WeakSet<AsyncStorageAdapter>();
let localStorageTouchTimestamps = new Map<string, number>();
let cancelScheduledLocalStorageMaintenance: (() => void) | null = null;
let localStorageGlobalMaintenanceRequested = false;
let scheduledLocalStorageMaintenanceManifestKeys = new Set<string>();

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
    scheduleLocalStorageMaintenance();
    return;
  }

  if (scannedAsyncAdapters.has(adapter)) return;
  scannedAsyncAdapters.add(adapter);
}

function ensureAsyncNamespaceKind(
  entryPrefix: string,
): AsyncStorageNamespaceKind {
  switch (entryPrefix) {
    case 'document':
      return 'document';
    case 'ci':
    case 'collection.item':
      return 'collection.item';
    case 'li':
    case 'listQuery.item':
      return 'listQuery.item';
    case 'lq':
    case 'listQuery.query':
      return 'listQuery.query';
    case 'oq':
    case 'offline.queue':
      return 'offline.queue';
    case 'oc':
    case 'offline.conflict':
      return 'offline.conflict';
    case 'oe':
    case 'offline.entity':
      return 'offline.entity';
    case '__internal.protected':
      return '__internal.protected';
    default:
      throw new Error(
        `[tsdf] Unsupported async namespace kind: ${entryPrefix}`,
      );
  }
}

/**
 * Schedules managed localStorage maintenance during idle time.
 *
 * When multiple callers enqueue maintenance before the idle callback runs,
 * forced manifest keys are coalesced and a global sweep request wins over
 * targeted maintenance because it already covers the full cleanup pass.
 */
export function scheduleLocalStorageMaintenance(
  options: { forceManifestKeys?: Iterable<string> } = {},
): void {
  if (options.forceManifestKeys === undefined) {
    localStorageGlobalMaintenanceRequested = true;
    scheduledLocalStorageMaintenanceManifestKeys.clear();
  } else if (!localStorageGlobalMaintenanceRequested) {
    for (const manifestKey of options.forceManifestKeys) {
      scheduledLocalStorageMaintenanceManifestKeys.add(manifestKey);
    }
  }

  if (cancelScheduledLocalStorageMaintenance !== null) return;

  cancelScheduledLocalStorageMaintenance = scheduleIdleCleanup(() => {
    cancelScheduledLocalStorageMaintenance = null;

    const runGlobalMaintenance = localStorageGlobalMaintenanceRequested;
    const forceManifestKeys = runGlobalMaintenance
      ? undefined
      : [...scheduledLocalStorageMaintenanceManifestKeys];

    localStorageGlobalMaintenanceRequested = false;
    scheduledLocalStorageMaintenanceManifestKeys.clear();

    void localPersistentStorage.runMaintenance(forceManifestKeys);
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

export function recordLocalStorageTouch(key: string, timestamp: number): void {
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

export async function touchLocalStorageKeyWithThrottle(
  key: string,
  touch: () => boolean | Promise<boolean>,
): Promise<void> {
  await localPersistentStorage.runLocked(async () => {
    const now = Date.now();
    if (shouldThrottleLocalStorageTouch(key, now)) return;

    if (await touch()) {
      recordLocalStorageTouch(key, now);
    }
  });
}

export function getLocalStorageMaxAgeMs(): number {
  return getManagedLocalStorageRuntimeConfig().maxAgeMs;
}

export function mergeLocalStorageOfflineProtection(
  sessionKey: string,
  storageKey: string,
  currentOfflineProtected: boolean,
): boolean {
  const protectedKeys = getSessionProtectedKeysSnapshot(sessionKey);
  return protectedKeys?.has(storageKey) === true || currentOfflineProtected;
}

export function scheduleLocalStorageRemoval(
  key: string,
  options: LocalStorageMetadataOptions | undefined,
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
  {
    getManifestMeta,
    asyncNamespace,
  }: {
    getManifestMeta?: (data: T) => Record<string, unknown> | undefined;
    asyncNamespace?: {
      storeName?: string;
      kind?: AsyncStorageNamespaceKind;
      entryKey?: string;
    };
  } = {},
): PersistentStorageHandle<T> {
  const version = config.version;
  const asyncVersion = version ?? 1;
  const { onPersistentStorageError } = config;
  const adapter = config.adapter;
  const asyncEntryKey = asyncNamespace?.entryKey ?? 'document';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  scheduleAdapterExpirationScan(adapter);

  function getKey(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;
    return getStorageKey(sessionKey, config.storeName);
  }

  function getAsyncNamespace() {
    if (!isAsyncStorageAdapter(adapter)) return null;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return adapter.openNamespace<T, Record<string, unknown>>({
      sessionKey,
      storeName: asyncNamespace?.storeName ?? config.storeName,
      kind: asyncNamespace?.kind ?? 'document',
    });
  }

  if (isAsyncStorageAdapter(adapter)) {
    void getAsyncNamespace();
  }

  function clearTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function load(): Promise<T | null> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(asyncEntryKey, { touch: 'coarse' });
        if (!entry) return null;

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [asyncEntryKey] });
          return null;
        }

        return entry.value;
      }

      const key = getKey();
      if (key === false) return null;

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

      return null;
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function writeEntry(data: T): Promise<void> {
    const key = getKey();

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;

        await namespace.commit({
          upserts: [
            {
              key: asyncEntryKey,
              value: data,
              version: asyncVersion,
              metadata: getManifestMeta?.(data),
            },
          ],
        });
        return;
      }

      if (key === false) return;
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;
      const entry = createStorageCacheEntry(data, Date.now(), version);

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

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.commit({ removes: [asyncEntryKey] });
        return;
      }

      const key = getKey();
      if (key === false) return;

      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.clearManifest(
            localPersistentStorage.getManifestKeyForSingle(key),
          );
        });
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

export type PersistentStorageNamespaceMetadata<
  TMetadata extends Record<string, unknown>,
> = TMetadata & {
  key: string;
  lastAccessAt: number;
  writtenAt: number;
  version: number;
};

export type PersistentStorageNamespaceHandle<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
> = {
  readEntry(entryKey: string): Promise<StorageCacheEntry<T> | null>;
  load(entryKey: string): Promise<T | null>;
  loadMany(entryKeys: string[]): Promise<Array<T | null>>;
  save(entryKey: string, data: T): Promise<void>;
  remove(entryKey: string): Promise<void>;
  listKeys(): Promise<string[]>;
  listMetadata(args?: {
    cursor?: string | null;
    limit?: number;
    order?: AsyncStorageMetadataOrder;
  }): Promise<{
    entries: PersistentStorageNamespaceMetadata<TMetadata>[];
    cursor: string | null;
  }>;
  clear(): Promise<void>;
  dispose(): void;
};

export async function listAllPersistentStorageNamespaceMetadata<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  namespace: PersistentStorageNamespaceHandle<T, TMetadata>,
  args: { order?: AsyncStorageMetadataOrder; limit?: number } = {},
): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]> {
  const entries: PersistentStorageNamespaceMetadata<TMetadata>[] = [];
  const limit = Math.max(1, args.limit ?? ASYNC_STORAGE_METADATA_PAGE_LIMIT);
  let cursor: string | null = null;

  do {
    const page = await namespace.listMetadata({
      cursor,
      limit,
      order: args.order,
    });

    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor !== null);

  return entries;
}

export function createPersistentStorageNamespaceHandle<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  config: Omit<PersistentStorageBaseConfig<never>, 'schema'> & {
    entryPrefix: string;
  },
  {
    getManifestMeta,
  }: {
    getManifestMeta?: (data: T, entryKey: string) => TMetadata | undefined;
  } = {},
): PersistentStorageNamespaceHandle<T, TMetadata> {
  const version = config.version;
  const asyncVersion = version ?? 1;
  const { onPersistentStorageError } = config;
  const adapter = config.adapter;
  const asyncNamespaceKind = ensureAsyncNamespaceKind(config.entryPrefix);
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

  function getAsyncNamespace() {
    if (!isAsyncStorageAdapter(adapter)) return null;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return adapter.openNamespace<T, TMetadata>({
      sessionKey,
      storeName: config.storeName,
      kind: asyncNamespaceKind,
    });
  }

  if (isAsyncStorageAdapter(adapter)) {
    void getAsyncNamespace();
  }

  async function readEntry(
    entryKey: string,
  ): Promise<StorageCacheEntry<T> | null> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(entryKey, { touch: 'never' });
        if (!entry) return null;

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        return {
          data: entry.value,
          timestamp: entry.metadata.lastAccessAt,
          version: entry.metadata.version,
        };
      }

      const prefix = getPrefix();
      if (prefix === false) return null;
      const key = `${prefix}${entryKey}`;

      if (adapter === 'local-sync') {
        return readStorageEntryFromLocalStorageSync<T>(key, version, {
          metadata: 'namespace',
          namespacePrefix: prefix,
        });
      }

      return null;
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function load(entryKey: string): Promise<T | null> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(entryKey, { touch: 'coarse' });
        if (!entry) return null;

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        return entry.value;
      }

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
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function loadMany(entryKeys: string[]): Promise<Array<T | null>> {
    if (entryKeys.length === 0) return [];

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return entryKeys.map(() => null);

        const entries = await namespace.getMany(entryKeys, { touch: 'coarse' });
        const staleKeys: string[] = [];

        const values = entries.map((entry, index) => {
          if (!entry) return null;
          if (entry.metadata.version !== asyncVersion) {
            const key = entryKeys[index];
            if (key !== undefined) {
              staleKeys.push(key);
            }
            return null;
          }
          return entry.value;
        });

        if (staleKeys.length > 0) {
          await namespace.commit({ removes: staleKeys });
        }

        return values;
      }

      return Promise.all(entryKeys.map((entryKey) => load(entryKey)));
    } catch (error) {
      onPersistentStorageError?.(error);
      return entryKeys.map(() => null);
    }
  }

  async function save(entryKey: string, data: T): Promise<void> {
    const key = getKey(entryKey);

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;

        await namespace.commit({
          upserts: [
            {
              key: entryKey,
              value: data,
              version: asyncVersion,
              metadata: getManifestMeta?.(data, entryKey),
            },
          ],
        });
        return;
      }

      if (key === false) return;
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;
      const entry = createStorageCacheEntry(data, Date.now(), version);

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
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function remove(entryKey: string): Promise<void> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.commit({ removes: [entryKey] });
        return;
      }

      const prefix = getPrefix();
      if (prefix === false) return;
      const key = `${prefix}${entryKey}`;

      if (adapter === 'local-sync') {
        await runLocalStorageMutation(() => {
          localPersistentStorage.remove(key, {
            metadata: 'namespace',
            namespacePrefix: prefix,
          });
        });
        return;
      }
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function listMetadata(
    args: {
      cursor?: string | null;
      limit?: number;
      order?: AsyncStorageMetadataOrder;
    } = {},
  ): Promise<{
    entries: PersistentStorageNamespaceMetadata<TMetadata>[];
    cursor: string | null;
  }> {
    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          return { entries: [], cursor: null };
        }

        return namespace.listMetadata(args);
      }

      const prefix = getPrefix();
      if (prefix === false) {
        return { entries: [], cursor: null };
      }

      const order = args.order ?? 'key';
      const limit = Math.max(1, args.limit ?? 100);
      const offset =
        args.cursor === null || args.cursor === undefined
          ? 0
          : Number(args.cursor) || 0;

      const sortedEntries = localPersistentStorage
        .listManifestEntries(prefix)
        .filter((entry) => entry.entryKey !== undefined)
        .sort((left, right) => {
          if (order === 'key') {
            return (left.entryKey ?? '').localeCompare(right.entryKey ?? '');
          }

          const direction = order === 'lru-asc' ? 1 : -1;
          if (left.lastAccessAt !== right.lastAccessAt) {
            return direction * (left.lastAccessAt - right.lastAccessAt);
          }

          return (left.entryKey ?? '').localeCompare(right.entryKey ?? '');
        });

      const pageEntries = sortedEntries
        .slice(offset, offset + limit)
        .flatMap((entry) => {
          if (entry.entryKey === undefined) return [];

          return [
            {
              ...(entry.meta
                ? __LEGIT_CAST__<TMetadata, unknown>(entry.meta)
                : __LEGIT_CAST__<TMetadata, Record<string, never>>({})),
              key: entry.entryKey,
              lastAccessAt: entry.lastAccessAt,
              writtenAt: entry.lastAccessAt,
              version: asyncVersion,
            },
          ];
        });

      return {
        entries: pageEntries,
        cursor:
          offset + pageEntries.length >= sortedEntries.length
            ? null
            : String(offset + pageEntries.length),
      };
    } catch (error) {
      onPersistentStorageError?.(error);
      return { entries: [], cursor: null };
    }
  }

  async function listKeys(): Promise<string[]> {
    const entries: PersistentStorageNamespaceMetadata<TMetadata>[] = [];
    let cursor: string | null = null;

    do {
      const page = await listMetadata({
        cursor,
        limit: ASYNC_STORAGE_METADATA_PAGE_LIMIT,
        order: 'key',
      });
      entries.push(...page.entries);
      cursor = page.cursor;
    } while (cursor !== null);

    return entries.map((entry) => entry.key);
  }

  async function clear(): Promise<void> {
    const prefix = getPrefix();

    try {
      if (isAsyncStorageAdapter(adapter)) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.clear();
        return;
      }

      if (prefix === false) return;

      await runLocalStorageMutation(() => {
        localPersistentStorage.clearManifest(
          localPersistentStorage.getManifestKeyForPrefix(prefix),
        );
      });
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  function dispose(): void {
    // No-op for namespaced handles: debouncing lives in the store integrations.
  }

  return {
    readEntry,
    load,
    loadMany,
    save,
    remove,
    listKeys,
    listMetadata,
    clear,
    dispose,
  };
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
  backend?: 'localStorage' | 'opfs';
  sessionKey: string;
  storeName: string;
  kind: string;
  key: string;
}): string {
  if ((args.backend ?? 'localStorage') === 'localStorage') {
    if (args.kind === 'document' && args.key === 'document') {
      return getStorageKeyForStore(args.sessionKey, args.storeName);
    }

    return `${getStoragePrefixForStoreNamespace(
      args.sessionKey,
      args.storeName,
      args.kind,
    )}${args.key}`;
  }

  return serializeProtectedRef({
    sessionKey: args.sessionKey,
    storeName: args.storeName,
    kind: ensureAsyncNamespaceKind(args.kind),
    key: args.key,
  });
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

  if (adapter instanceof OpfsAsyncStorageAdapter) {
    await adapter.clearSession(sessionKey);
  }
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
  _maxAgeMs: number,
): Promise<void> {
  if (adapter === 'local-sync') {
    await localPersistentStorage.runMaintenance();
  }
}

/** Resets expiration scan tracking. Exported for test cleanup. */
export function resetExpirationScanTracking(): void {
  cancelScheduledLocalStorageMaintenance?.();
  cancelScheduledLocalStorageMaintenance = null;
  localStorageGlobalMaintenanceRequested = false;
  scheduledLocalStorageMaintenanceManifestKeys = new Set<string>();
  localStorageExpirationScanScheduled = false;
  scannedAsyncAdapters = new WeakSet<AsyncStorageAdapter>();
  localStorageTouchTimestamps = new Map<string, number>();
  resetManagedLocalStorageState();
  if (opfsPersistentStorage instanceof OpfsAsyncStorageAdapter) {
    opfsPersistentStorage.resetForTests();
  }
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  if (adapter === 'local-sync') {
    return localPersistentStorage.readProtectedStorageKeys(sessionKey);
  }

  if (!isAsyncStorageAdapter(adapter)) {
    return new Set<string>();
  }

  const namespace = adapter.openNamespace<{ keys: string[] }>({
    sessionKey,
    storeName: '_o_.p',
    kind: 'document',
  });
  const entry = await namespace.get('document', { touch: 'never' });
  return new Set(entry?.value.keys ?? []);
}

function parseProtectedAsyncStorageKey(
  protectedStorageKey: string,
): AsyncStorageProtectedEntryRef | null {
  try {
    const parsed = JSON.parse(protectedStorageKey);
    if (!Array.isArray(parsed) || parsed.length !== 4) {
      return null;
    }

    const [sessionKey, storeName, kind, key] = parsed;
    if (
      typeof sessionKey !== 'string' ||
      typeof storeName !== 'string' ||
      typeof kind !== 'string' ||
      typeof key !== 'string'
    ) {
      return null;
    }

    return { sessionKey, storeName, kind: ensureAsyncNamespaceKind(kind), key };
  } catch {
    return null;
  }
}

export async function readProtectedStorageNamespaceKeys(
  adapter: StorageAdapter,
  sessionKey: string | false,
  args: {
    localStoragePrefix?: string | false | null;
    asyncScope?: AsyncStorageNamespaceScope | null;
  },
): Promise<Set<string>> {
  if (sessionKey === false) {
    return new Set<string>();
  }

  const protectedStorageKeys = await readProtectedStorageKeys(
    adapter,
    sessionKey,
  );

  if (isAsyncStorageAdapter(adapter)) {
    const scope = args.asyncScope;
    if (!scope) return new Set<string>();

    const namespaceKeys = new Set<string>();

    for (const protectedStorageKey of protectedStorageKeys) {
      const ref = parseProtectedAsyncStorageKey(protectedStorageKey);
      if (
        ref?.sessionKey === scope.sessionKey &&
        ref.storeName === scope.storeName &&
        ref.kind === scope.kind
      ) {
        namespaceKeys.add(ref.key);
      }
    }

    return namespaceKeys;
  }

  if (typeof args.localStoragePrefix !== 'string') {
    return new Set<string>();
  }

  const localStoragePrefix = args.localStoragePrefix;

  return new Set(
    [...protectedStorageKeys]
      .filter((key) => key.startsWith(localStoragePrefix))
      .map((key) => key.slice(localStoragePrefix.length)),
  );
}
