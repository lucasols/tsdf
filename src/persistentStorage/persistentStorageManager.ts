import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  getManagedLocalStorageRuntimeConfig,
  isManagedLocalStorageEntryOfflineProtected,
  resetManagedLocalStorageState,
  setManagedLocalStorageEntryOfflineProtected,
} from './localStorageMetadata';
import { serializeProtectedRef } from './asyncStorageAdapter';
import {
  createCompactLocalStorageEntry,
  type CompactLocalStorageEntryValue,
  parseCompactLocalStorageEntry,
} from './compactLocalStorageEntry';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  localPersistentStorage,
  opfsPersistentStorage,
  type LocalStorageMetadataOptions,
} from './storageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceKind,
  AsyncStorageTouchMode,
  PersistentStorageBaseConfig,
  StorageAdapter,
  StorageCacheEntry,
} from './types';
import { parseAsyncStorageNamespaceKind } from './types';

const DEBOUNCE_MS = 1000;
export const SYNC_STORAGE_TOUCH_THROTTLE_MS = 60_000;

let localStorageExpirationScanScheduled = false;
let scannedAsyncAdapters = new WeakSet<AsyncStorageAdapter>();
let localStorageTouchTimestamps = new Map<string, number>();
let cancelScheduledLocalStorageMaintenance: (() => void) | null = null;
let localStorageGlobalMaintenanceRequested = false;
let scheduledLocalStorageMaintenanceManifestKeys = new Set<string>();
const scheduledAsyncMaintenance = new Map<
  string,
  {
    cancel: (() => void) | null;
    callback: () => Promise<void>;
    running: boolean;
    rerunRequested: boolean;
  }
>();

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
  const directKind = parseAsyncStorageNamespaceKind(entryPrefix);
  if (directKind !== null) return directKind;

  switch (entryPrefix) {
    case 'ci':
      return 'collection.item';
    case 'li':
      return 'listQuery.item';
    case 'lq':
      return 'listQuery.query';
    case 'oq':
      return 'offline.queue';
    case 'oc':
      return 'offline.conflict';
    case 'oe':
      return 'offline.entity';
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

type LocalStorageValueCodec<T> = {
  serialize(data: T): CompactLocalStorageEntryValue;
  deserialize(data: CompactLocalStorageEntryValue): T | null;
};

const defaultLocalStorageValueCodec: LocalStorageValueCodec<unknown> = {
  serialize: (data) => ({ d: data }),
  deserialize: (data) => ('d' in data ? data.d : null),
};

type AsyncStorageValueCodec<
  T,
  TSerialized = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  serialize(data: T): TSerialized;
  deserialize(data: TSerialized, metadata?: TMetadata): T | null;
};

function toLocalStorageValueCodec<T>(
  valueCodec: AsyncStorageValueCodec<T> | undefined,
): LocalStorageValueCodec<T> {
  if (valueCodec === undefined) {
    return __LEGIT_CAST__<
      LocalStorageValueCodec<T>,
      LocalStorageValueCodec<unknown>
    >(defaultLocalStorageValueCodec);
  }

  return {
    serialize(data) {
      const serialized = valueCodec.serialize(data);
      if (
        typeof serialized !== 'object' ||
        serialized === null ||
        Array.isArray(serialized)
      ) {
        throw new Error(
          '[TSDF] local-sync persistence codecs must serialize to an object.',
        );
      }

      return __LEGIT_CAST__<CompactLocalStorageEntryValue, unknown>(serialized);
    },
    deserialize(data) {
      return valueCodec.deserialize(__LEGIT_CAST__<never, unknown>(data));
    },
  };
}

export type PersistentStorageHandle<T> = {
  /** Loads persisted data, validating version and schema. Returns null if not found or invalid. */
  load(options?: { touch?: AsyncStorageTouchMode }): Promise<T | null>;
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
    valueCodec,
  }: {
    getManifestMeta?: (data: T) => Record<string, unknown> | undefined;
    asyncNamespace?: {
      storeName?: string;
      kind?: AsyncStorageNamespaceKind;
      entryKey?: string;
    };
    valueCodec?: AsyncStorageValueCodec<T>;
  } = {},
): PersistentStorageHandle<T> {
  const version = config.version;
  const asyncVersion = version ?? 1;
  const { onPersistentStorageError } = config;
  const adapter = config.adapter;
  const asyncAdapter = adapter === 'local-sync' ? null : adapter;
  const asyncEntryKey = asyncNamespace?.entryKey ?? 'document';
  const localCodec = toLocalStorageValueCodec(valueCodec);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  scheduleAdapterExpirationScan(adapter);

  function getKey(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;
    return getStorageKey(sessionKey, config.storeName);
  }

  function getAsyncNamespace() {
    if (asyncAdapter === null) return null;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return asyncAdapter.openNamespace<unknown, Record<string, unknown>>({
      sessionKey,
      storeName: asyncNamespace?.storeName ?? config.storeName,
      kind: asyncNamespace?.kind ?? 'document',
    });
  }

  if (asyncAdapter !== null) {
    void getAsyncNamespace();
  }

  function clearTimer() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function load(
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<T | null> {
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(asyncEntryKey, {
          touch: options.touch ?? 'coarse',
        });
        if (!entry) return null;

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [asyncEntryKey] });
          return null;
        }

        const decoded = valueCodec
          ? valueCodec.deserialize(entry.value, entry.metadata.customMetadata)
          : __LEGIT_CAST__<T, unknown>(entry.value);
        if (decoded === null) {
          await namespace.commit({ removes: [asyncEntryKey] });
          return null;
        }

        return decoded;
      }

      const key = getKey();
      if (key === false) return null;

      const entry = readStorageEntryFromLocalStorageSync<T>(
        key,
        version,
        { metadata: 'single' },
        localCodec,
      );
      if (!entry) return null;

      scheduleIdleCleanup(() =>
        refreshLocalStorageTimestamp(key, { metadata: 'single' }),
      );
      return entry.data;
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function writeEntry(data: T): Promise<void> {
    const key = getKey();

    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;

        await namespace.commit({
          upserts: [
            {
              key: asyncEntryKey,
              value: valueCodec ? valueCodec.serialize(data) : data,
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
      const timestamp = Date.now();
      const entry = createCompactLocalStorageEntry(
        localCodec.serialize(data),
        version,
      );

      await runLocalStorageMutation(() => {
        localPersistentStorage.write(key, entry);
        localPersistentStorage.upsertSingleEntry({
          storageKey: key,
          lastAccessAt: timestamp,
          meta: preserveOfflineProtectionFlag(
            sessionKey,
            key,
            getManifestMeta?.(data),
            () =>
              localPersistentStorage.readSingleEntryMetadataByPayload(key)
                ?.meta,
          ),
        });
        recordLocalStorageTouch(key, timestamp);
      });
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
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;
        await namespace.commit({ removes: [asyncEntryKey] });
        return;
      }

      const key = getKey();
      if (key === false) return;

      await runLocalStorageMutation(() => {
        localPersistentStorage.clearManifest(
          localPersistentStorage.getManifestKeyForSingle(key),
        );
      });
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
> = {
  customMetadata: TMetadata;
  key: string;
  lastAccessAt: number;
  writtenAt: number;
  version: number;
};

export type PersistentStorageNamespaceCommitArgs<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
> = {
  removes?: string[];
  touches?: Array<{ key: string; lastAccessAt?: number }>;
  upserts?: Array<{ data: T; key: string; metadata?: TMetadata }>;
};

export type PersistentStorageNamespaceHandle<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
> = {
  commit(
    args: PersistentStorageNamespaceCommitArgs<T, TMetadata>,
  ): Promise<void>;
  readEntry(
    entryKey: string,
    options?: { touch?: AsyncStorageTouchMode },
  ): Promise<StorageCacheEntry<T> | null>;
  load(
    entryKey: string,
    options?: { touch?: AsyncStorageTouchMode },
  ): Promise<T | null>;
  loadMany(
    entryKeys: string[],
    options?: { touch?: AsyncStorageTouchMode },
  ): Promise<Array<T | null>>;
  save(entryKey: string, data: T): Promise<void>;
  remove(entryKey: string): Promise<void>;
  listKeys(): Promise<string[]>;
  listMetadata(args?: {
    order?: AsyncStorageMetadataOrder;
  }): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]>;
  clear(): Promise<void>;
  dispose(): void;
};

export async function listAllPersistentStorageNamespaceMetadata<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  namespace: PersistentStorageNamespaceHandle<T, TMetadata>,
  args: { order?: AsyncStorageMetadataOrder } = {},
): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]> {
  return namespace.listMetadata(args);
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
    valueCodec,
  }: {
    getManifestMeta?: (data: T, entryKey: string) => TMetadata | undefined;
    valueCodec?: AsyncStorageValueCodec<T, unknown, TMetadata>;
  } = {},
): PersistentStorageNamespaceHandle<T, TMetadata> {
  const version = config.version;
  const asyncVersion = version ?? 1;
  const { onPersistentStorageError } = config;
  const adapter = config.adapter;
  const asyncAdapter = adapter === 'local-sync' ? null : adapter;
  const asyncNamespaceKind = ensureAsyncNamespaceKind(config.entryPrefix);
  const localCodec = toLocalStorageValueCodec(valueCodec);
  scheduleAdapterExpirationScan(adapter);

  function getPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    return `${getStorageKey(sessionKey, config.storeName)}.${config.entryPrefix}.`;
  }

  function getAsyncNamespace() {
    if (asyncAdapter === null) return null;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return asyncAdapter.openNamespace<unknown, TMetadata>({
      sessionKey,
      storeName: config.storeName,
      kind: asyncNamespaceKind,
    });
  }

  if (asyncAdapter !== null) {
    void getAsyncNamespace();
  }

  async function commit(
    args: PersistentStorageNamespaceCommitArgs<T, TMetadata>,
  ): Promise<void> {
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return;

        await namespace.commit({
          removes: args.removes,
          touches: args.touches,
          upserts: args.upserts?.map((upsert) => ({
            key: upsert.key,
            value: valueCodec
              ? valueCodec.serialize(upsert.data)
              : __LEGIT_CAST__<unknown, T>(upsert.data),
            version: asyncVersion,
            metadata:
              upsert.metadata ?? getManifestMeta?.(upsert.data, upsert.key),
          })),
        });
        return;
      }

      const prefix = getPrefix();
      if (prefix === false) return;
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;
      const now = Date.now();
      const touchTimestamps = new Map(
        (args.touches ?? []).map((touch) => [touch.key, touch.lastAccessAt]),
      );

      await runLocalStorageMutation(() => {
        for (const entryKey of args.removes ?? []) {
          localPersistentStorage.remove(`${prefix}${entryKey}`, {
            metadata: 'namespace',
            namespacePrefix: prefix,
          });
        }

        for (const upsert of args.upserts ?? []) {
          const key = `${prefix}${upsert.key}`;
          const timestamp = touchTimestamps.get(upsert.key) ?? now;
          const entry = createCompactLocalStorageEntry(
            localCodec.serialize(upsert.data),
            version,
          );

          localPersistentStorage.write(key, entry);
          localPersistentStorage.upsertNamespaceEntry({
            storagePrefix: prefix,
            entryKey: upsert.key,
            lastAccessAt: timestamp,
            meta: preserveOfflineProtectionFlag(
              sessionKey,
              key,
              upsert.metadata ?? getManifestMeta?.(upsert.data, upsert.key),
              () =>
                localPersistentStorage.readNamespaceEntryMetadataByPayload(
                  key,
                  prefix,
                )?.meta,
            ),
          });
          recordLocalStorageTouch(key, timestamp);
        }

        for (const touch of args.touches ?? []) {
          if ((args.upserts ?? []).some((upsert) => upsert.key === touch.key)) {
            continue;
          }

          const key = `${prefix}${touch.key}`;
          if (!localPersistentStorage.touchNamespaceEntry(key, prefix)) {
            continue;
          }

          recordLocalStorageTouch(key, touch.lastAccessAt ?? now);
        }
      });
    } catch (error) {
      onPersistentStorageError?.(error);
    }
  }

  async function readEntry(
    entryKey: string,
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<StorageCacheEntry<T> | null> {
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(entryKey, {
          touch: options.touch ?? 'never',
        });
        if (!entry) return null;

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        const decoded = valueCodec
          ? valueCodec.deserialize(entry.value, entry.metadata.customMetadata)
          : __LEGIT_CAST__<T, unknown>(entry.value);
        if (decoded === null) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        return {
          data: decoded,
          timestamp: entry.metadata.lastAccessAt,
          version: entry.metadata.version,
        };
      }

      const prefix = getPrefix();
      if (prefix === false) return null;
      const key = `${prefix}${entryKey}`;

      return readStorageEntryFromLocalStorageSync<T>(
        key,
        version,
        { metadata: 'namespace', namespacePrefix: prefix },
        localCodec,
      );
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function load(
    entryKey: string,
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<T | null> {
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return null;

        const entry = await namespace.get(entryKey, {
          touch: options.touch ?? 'coarse',
        });
        if (!entry) return null;

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        const decoded = valueCodec
          ? valueCodec.deserialize(entry.value, entry.metadata.customMetadata)
          : __LEGIT_CAST__<T, unknown>(entry.value);
        if (decoded === null) {
          await namespace.commit({ removes: [entryKey] });
          return null;
        }

        return decoded;
      }

      const prefix = getPrefix();
      if (prefix === false) return null;

      const key = `${prefix}${entryKey}`;
      const entry = await readEntry(entryKey);
      if (!entry) return null;

      scheduleIdleCleanup(() =>
        refreshLocalStorageTimestamp(key, {
          metadata: 'namespace',
          namespacePrefix: prefix,
        }),
      );

      return entry.data;
    } catch (error) {
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function loadMany(
    entryKeys: string[],
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<Array<T | null>> {
    if (entryKeys.length === 0) return [];

    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return entryKeys.map(() => null);

        const entries = await namespace.getMany(entryKeys, {
          touch: options.touch ?? 'coarse',
        });
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
          const decoded = valueCodec
            ? valueCodec.deserialize(entry.value, entry.metadata.customMetadata)
            : __LEGIT_CAST__<T, unknown>(entry.value);
          if (decoded === null) {
            const key = entryKeys[index];
            if (key !== undefined) {
              staleKeys.push(key);
            }
            return null;
          }

          return decoded;
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
    await commit({ upserts: [{ data, key: entryKey }] });
  }

  async function remove(entryKey: string): Promise<void> {
    await commit({ removes: [entryKey] });
  }

  async function listMetadata(
    args: { order?: AsyncStorageMetadataOrder } = {},
  ): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]> {
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) return [];

        return namespace.listMetadata(args);
      }

      const prefix = getPrefix();
      if (prefix === false) return [];

      const order = args.order ?? 'key';

      return localPersistentStorage
        .listManifestEntries(prefix)
        .sort((left, right) => {
          if (order === 'key') {
            return left.entryKey.localeCompare(right.entryKey);
          }

          const direction = order === 'lru-asc' ? 1 : -1;
          if (left.lastAccessAt !== right.lastAccessAt) {
            return direction * (left.lastAccessAt - right.lastAccessAt);
          }

          return left.entryKey.localeCompare(right.entryKey);
        })
        .map((entry) => ({
          customMetadata: entry.meta
            ? __LEGIT_CAST__<TMetadata, unknown>(entry.meta)
            : __LEGIT_CAST__<TMetadata, Record<string, never>>({}),
          key: entry.entryKey,
          lastAccessAt: entry.lastAccessAt,
          writtenAt: entry.lastAccessAt,
          version: asyncVersion,
        }));
    } catch (error) {
      onPersistentStorageError?.(error);
      return [];
    }
  }

  async function listKeys(): Promise<string[]> {
    if (asyncAdapter !== null) {
      const namespace = getAsyncNamespace();
      if (!namespace) return [];

      return namespace.listKeys();
    }

    const entries = await listMetadata({ order: 'key' });
    return entries.map((entry) => entry.key);
  }

  async function clear(): Promise<void> {
    const prefix = getPrefix();

    try {
      if (asyncAdapter !== null) {
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
    commit,
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
  valueCodec: LocalStorageValueCodec<T> = __LEGIT_CAST__<
    LocalStorageValueCodec<T>,
    LocalStorageValueCodec<unknown>
  >(defaultLocalStorageValueCodec),
): StorageCacheEntry<T> | null {
  const metadata =
    options.metadata === 'single'
      ? localPersistentStorage.readSingleEntryMetadataByPayload(key)
      : localPersistentStorage.readNamespaceEntryMetadataByPayload(
          key,
          options.namespacePrefix,
        );

  function removeAndReturnNull(): null {
    scheduleLocalStorageRemoval(key, options);
    return null;
  }

  if (metadata === null) return null;

  if (
    Date.now() - metadata.lastAccessAt >
    getManagedLocalStorageRuntimeConfig().maxAgeMs
  ) {
    return removeAndReturnNull();
  }

  const raw = localPersistentStorage.readRaw(key);
  if (raw === null) return removeAndReturnNull();

  const entry = parseCompactLocalStorageEntry(raw);
  if (entry === null) return removeAndReturnNull();

  if (!doesStorageEntryVersionMatch(entry.version, version)) {
    return removeAndReturnNull();
  }

  const decoded = valueCodec.deserialize(entry.value);
  if (decoded === null) return removeAndReturnNull();

  return {
    data: decoded,
    timestamp: metadata.lastAccessAt,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
  };
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

  await adapter.clearSession(sessionKey);
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

/** Resets expiration scan tracking. Exported for test cleanup. */
export function resetExpirationScanTracking(): void {
  cancelScheduledLocalStorageMaintenance?.();
  cancelScheduledLocalStorageMaintenance = null;
  for (const entry of scheduledAsyncMaintenance.values()) {
    entry.cancel?.();
  }
  scheduledAsyncMaintenance.clear();
  localStorageGlobalMaintenanceRequested = false;
  scheduledLocalStorageMaintenanceManifestKeys = new Set<string>();
  localStorageExpirationScanScheduled = false;
  scannedAsyncAdapters = new WeakSet<AsyncStorageAdapter>();
  localStorageTouchTimestamps = new Map<string, number>();
  resetManagedLocalStorageState();
  opfsPersistentStorage.resetForTests?.();
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
): Promise<Set<string>> {
  if (adapter === 'local-sync') {
    return localPersistentStorage.readProtectedStorageKeys(sessionKey);
  }

  return adapter.readProtectedStorageKeys(sessionKey);
}

export function scheduleAsyncStorageMaintenance(
  maintenanceKey: string,
  callback: () => Promise<void>,
): void {
  const existing = scheduledAsyncMaintenance.get(maintenanceKey);
  if (existing) {
    existing.callback = callback;
    if (existing.running) {
      existing.rerunRequested = true;
      return;
    }
    if (existing.cancel !== null) return;
  }

  const entry = existing ?? {
    cancel: null,
    callback,
    running: false,
    rerunRequested: false,
  };
  entry.callback = callback;
  scheduledAsyncMaintenance.set(maintenanceKey, entry);

  entry.cancel = scheduleIdleCleanup(() => {
    entry.cancel = null;
    entry.running = true;

    void entry.callback().finally(() => {
      entry.running = false;
      if (entry.rerunRequested) {
        entry.rerunRequested = false;
        scheduleAsyncStorageMaintenance(maintenanceKey, entry.callback);
        return;
      }

      scheduledAsyncMaintenance.delete(maintenanceKey);
    });
  });
}
