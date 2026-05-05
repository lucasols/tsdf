import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject } from '@ls-stack/utils/typeGuards';
import {
  emitTSDFDebugLog,
  type TSDFDebugLogger,
  type TSDFPersistentStorageDebugOperation,
} from '../debug';
import {
  parsePersistedAsyncNamespaceKind,
  serializeProtectedRef,
} from './asyncStorageShared';
import {
  createCompactLocalStorageEntry,
  parseCompactLocalStorageEntry,
  type CompactLocalStorageEntryValue,
} from './compactLocalStorageEntry';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from './documentEntryKey';
import {
  getManagedLocalStorageRuntimeConfig,
  isManagedLocalStorageEntryOfflineProtected,
  resetManagedLocalStorageState,
  setManagedLocalStorageEntryOfflineProtected,
} from './localStorageMetadata';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import type { OfflineNetworkModeConfig } from './offline/types';
import { clearRegisteredOfflineUploadStorage } from './offlineUploadRegistry';
import { serializeJsonForStorage } from './persistenceUtils';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  localPersistentStorage,
  type LocalStorageMetadataOptions,
} from './storageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceKind,
  AsyncStorageNamespaceStaticPolicy,
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

type PersistentStorageRuntimeConfig = Omit<
  PersistentStorageBaseConfig<never>,
  'schema'
> & { debugLogger?: TSDFDebugLogger; prodLogger?: TSDFDebugLogger };

export type PersistentStorageDebugContext = {
  adapterKind: 'async' | 'local-sync';
  debugLogger?: TSDFDebugLogger;
  entryPrefix?: string;
  key?: string;
  namespaceKind?: AsyncStorageNamespaceKind;
  storeName: string;
};

export function createPersistentStorageDebugContext(
  adapter: StorageAdapter,
  storeName: string,
  debugLogger?: TSDFDebugLogger,
  entryPrefix?: string,
  key?: string,
  namespaceKind?: AsyncStorageNamespaceKind,
): PersistentStorageDebugContext {
  return {
    adapterKind: adapter === 'local-sync' ? 'local-sync' : 'async',
    debugLogger,
    entryPrefix,
    key,
    namespaceKind,
    storeName,
  };
}

function startPersistentStorageDebugTiming(
  context: PersistentStorageDebugContext | undefined,
): number | null {
  void context;
  return null;
}

type PersistentStorageDebugStatus = 'success' | 'miss' | 'skipped' | 'error';

function logPersistentStorageOperation(
  context: PersistentStorageDebugContext | undefined,
  operation: TSDFPersistentStorageDebugOperation,
  status: PersistentStorageDebugStatus,
  startTime: number | null,
  details?: Readonly<Record<string, unknown>>,
  error?: unknown,
): void {
  if (!import.meta.env.DEV) return;
  if (!context?.debugLogger) return;

  const durationMs = startTime === null ? undefined : Date.now() - startTime;

  const logDetails: Record<string, unknown> = {
    adapter: context.adapterKind,
    storeName: context.storeName,
    status,
  };
  if (context.entryPrefix !== undefined) {
    logDetails.entryPrefix = context.entryPrefix;
  }
  if (context.key !== undefined) {
    logDetails.key = context.key;
  }
  if (context.namespaceKind !== undefined) {
    logDetails.namespaceKind = context.namespaceKind;
  }
  if (durationMs !== undefined) {
    logDetails.durationMs = durationMs;
  }
  if (error !== undefined) {
    logDetails.error = error;
  }
  if (details !== undefined) {
    Object.assign(logDetails, details);
  }

  emitTSDFDebugLog(context.debugLogger, {
    area: 'persistent-storage',
    level: status === 'error' ? 'error' : 'log',
    message: `persistent storage ${operation} ${status}`,
    operation,
    details: logDetails,
  });
}

function withPersistentStorageDebugKey(
  context: PersistentStorageDebugContext | undefined,
  key: string,
): PersistentStorageDebugContext | undefined {
  if (!import.meta.env.DEV) return undefined;
  if (context === undefined) return undefined;

  return { ...context, key };
}

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
    `[tsdf] store id "${storeName}" must not contain "." when persistentStorage is enabled.`,
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

  const persistedKind = parsePersistedAsyncNamespaceKind(entryPrefix);
  if (persistedKind !== null) return persistedKind;

  throw new Error(`[tsdf] Unsupported async namespace kind: ${entryPrefix}`);
}

/**
 * Schedules managed localStorage maintenance during idle time.
 *
 * When multiple callers enqueue maintenance before the idle callback runs,
 * forced manifest keys are coalesced and a global sweep request wins over
 * targeted maintenance because it already covers the full cleanup pass.
 */
export function scheduleLocalStorageMaintenance(
  forceManifestKeys?: Iterable<string>,
): void {
  if (forceManifestKeys === undefined) {
    localStorageGlobalMaintenanceRequested = true;
    scheduledLocalStorageMaintenanceManifestKeys.clear();
  } else if (!localStorageGlobalMaintenanceRequested) {
    for (const manifestKey of forceManifestKeys) {
      scheduledLocalStorageMaintenanceManifestKeys.add(manifestKey);
    }
  }

  if (cancelScheduledLocalStorageMaintenance !== null) return;

  cancelScheduledLocalStorageMaintenance = scheduleIdleCleanup(() => {
    cancelScheduledLocalStorageMaintenance = null;

    const runGlobalMaintenance = localStorageGlobalMaintenanceRequested;
    const maintenanceManifestKeys = runGlobalMaintenance
      ? undefined
      : [...scheduledLocalStorageMaintenanceManifestKeys];

    localStorageGlobalMaintenanceRequested = false;
    scheduledLocalStorageMaintenanceManifestKeys.clear();

    void localPersistentStorage.runMaintenance(maintenanceManifestKeys);
  });
}

function preserveOfflineProtectionFlag(
  sessionKey: string,
  storageKey: string,
  nextMeta: unknown,
  currentMeta: unknown,
): unknown {
  const currentMetaProtected =
    isManagedLocalStorageEntryOfflineProtected(currentMeta);
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

export function isOfflineNetworkModeActiveSync(
  networkConfig: OfflineNetworkModeConfig | undefined,
): boolean {
  if (!networkConfig?.enabled) return false;

  try {
    const currentOffline =
      networkConfig.getIsOffline?.() ?? navigator.onLine === false;
    return currentOffline === true;
  } catch {
    return false;
  }
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
    // WORKAROUND: The default local-storage codec is generic over unknown and simply forwards JSON-compatible values, so callers rebind it to their T when no custom codec is supplied.
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

      // WORKAROUND: The object/null/array guard above guarantees the compact local-storage entry shape, but the async codec surface still returns unknown.
      return __LEGIT_CAST__<CompactLocalStorageEntryValue, unknown>(serialized);
    },
    deserialize(data) {
      // WORKAROUND: This adapter bridges async and local codec interfaces, and TypeScript cannot express that the compact stored object is the deserialize input for the provided codec.
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
  config: PersistentStorageRuntimeConfig,
  {
    asyncValueCodec,
    getManifestMeta,
    asyncNamespace,
    valueCodec,
  }: {
    asyncValueCodec?: AsyncStorageValueCodec<T>;
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
  const asyncEntryKey =
    asyncNamespace?.entryKey ?? DOCUMENT_PERSISTED_ENTRY_KEY;
  const debugContext = import.meta.env.DEV
    ? createPersistentStorageDebugContext(
        adapter,
        config.storeName,
        config.debugLogger,
        undefined,
        asyncEntryKey,
        asyncNamespace?.kind ?? 'document',
      )
    : undefined;
  const effectiveAsyncValueCodec = asyncValueCodec ?? valueCodec;
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

    asyncAdapter.debugLogger = config.debugLogger;
    asyncAdapter.prodLogger = config.prodLogger;

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
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'load',
              'skipped',
              startTime,
              { reason: 'inactive-session', touch: options.touch },
            );
          }
          return null;
        }

        const entry = await namespace.get(asyncEntryKey, {
          touch: options.touch ?? 'coarse',
        });
        if (!entry) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'load',
              'miss',
              startTime,
              { reason: 'missing-entry', touch: options.touch },
            );
          }
          return null;
        }

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [asyncEntryKey] });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'load',
              'miss',
              startTime,
              {
                expectedVersion: asyncVersion,
                reason: 'version-mismatch',
                storedVersion: entry.metadata.version,
                touch: options.touch,
              },
            );
          }
          return null;
        }

        const decoded = effectiveAsyncValueCodec
          ? effectiveAsyncValueCodec.deserialize(
              entry.value,
              entry.metadata.customMetadata,
            )
          : // WORKAROUND: Stored values cross the persistence boundary as unknown, and in the no-codec path this API intentionally exposes them as the caller's requested T.
            __LEGIT_CAST__<T, unknown>(entry.value);
        if (decoded === null) {
          await namespace.commit({ removes: [asyncEntryKey] });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'load',
              'miss',
              startTime,
              { reason: 'decode-failed', touch: options.touch },
            );
          }
          return null;
        }

        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'load',
            'success',
            startTime,
            { touch: options.touch },
          );
        }
        return decoded;
      }

      const key = getKey();
      if (key === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'load',
            'skipped',
            startTime,
            { reason: 'inactive-session', touch: options.touch },
          );
        }
        return null;
      }

      const entry = readStorageEntryFromLocalStorageSync<T>(
        key,
        version,
        { metadata: 'single' },
        localCodec,
      );
      if (!entry) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            withPersistentStorageDebugKey(debugContext, key),
            'load',
            'miss',
            startTime,
            { touch: options.touch },
          );
        }
        return null;
      }

      scheduleIdleCleanup(() =>
        refreshLocalStorageTimestamp(key, { metadata: 'single' }),
      );
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          withPersistentStorageDebugKey(debugContext, key),
          'load',
          'success',
          startTime,
          { touch: options.touch },
        );
      }
      return entry.data;
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'load',
          'error',
          startTime,
          { touch: options.touch },
          error,
        );
      }
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function writeEntry(data: T): Promise<void> {
    const key = getKey();
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;

    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'write',
              'skipped',
              startTime,
              { reason: 'inactive-session' },
            );
          }
          return;
        }

        await namespace.commit({
          upserts: [
            {
              key: asyncEntryKey,
              value: effectiveAsyncValueCodec
                ? effectiveAsyncValueCodec.serialize(data)
                : data,
              version: asyncVersion,
              metadata: getManifestMeta?.(data),
            },
          ],
        });
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'write',
            'success',
            startTime,
            { upserts: 1 },
          );
        }
        return;
      }

      if (key === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'write',
            'skipped',
            startTime,
            { reason: 'inactive-session' },
          );
        }
        return;
      }
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            withPersistentStorageDebugKey(debugContext, key),
            'write',
            'skipped',
            startTime,
            { reason: 'inactive-session' },
          );
        }
        return;
      }
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
          clearSizeBytes: true,
          mergeMeta: (currentMeta: unknown) =>
            preserveOfflineProtectionFlag(
              sessionKey,
              key,
              getManifestMeta?.(data),
              currentMeta,
            ),
        });
        recordLocalStorageTouch(key, timestamp);
      });
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          withPersistentStorageDebugKey(debugContext, key),
          'write',
          'success',
          startTime,
          { upserts: 1 },
        );
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          key === false
            ? debugContext
            : withPersistentStorageDebugKey(debugContext, key),
          'write',
          'error',
          startTime,
          undefined,
          error,
        );
      }
      onPersistentStorageError?.(error);
    }
  }

  function scheduleSave(getData: () => T): void {
    clearTimer();
    if (import.meta.env.DEV) {
      logPersistentStorageOperation(
        debugContext,
        'schedule-save',
        'success',
        null,
        { debounceMs: DEBOUNCE_MS },
      );
    }

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
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;

    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'clear',
              'skipped',
              startTime,
              { reason: 'inactive-session' },
            );
          }
          return;
        }
        await namespace.commit({ removes: [asyncEntryKey] });
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'clear',
            'success',
            startTime,
            { removes: 1 },
          );
        }
        return;
      }

      const key = getKey();
      if (key === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'clear',
            'skipped',
            startTime,
            { reason: 'inactive-session' },
          );
        }
        return;
      }

      await runLocalStorageMutation(() => {
        localPersistentStorage.clearManifest(
          localPersistentStorage.getManifestKeyForSingle(key),
        );
      });
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          withPersistentStorageDebugKey(debugContext, key),
          'clear',
          'success',
          startTime,
        );
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'clear',
          'error',
          startTime,
          undefined,
          error,
        );
      }
      onPersistentStorageError?.(error);
    }
  }

  function dispose(): void {
    clearTimer();
  }

  return { load, scheduleSave, saveNow, clear, dispose };
}

type PersistentStorageNamespaceMetadata<
  TMetadata extends Record<string, unknown>,
> = {
  customMetadata: TMetadata;
  key: string;
  lastAccessAt: number;
  sizeBytes?: number;
  writtenAt: number;
  version: number;
};

type PersistentStorageNamespaceCommitArgs<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
> = {
  removes?: string[];
  staticPolicy?: AsyncStorageNamespaceStaticPolicy | null;
  touches?: Array<{ key: string; lastAccessAt?: number }>;
  upserts?: Array<{ data: T; key: string; metadata?: TMetadata }>;
};

type PersistentStorageNamespaceHandle<
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
  listMetadataByFilter(args: {
    equals: unknown;
    key: string;
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

export async function listPersistentStorageNamespaceMetadataByFilter<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  namespace: PersistentStorageNamespaceHandle<T, TMetadata>,
  args: { equals: unknown; key: string; order?: AsyncStorageMetadataOrder },
): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]> {
  return namespace.listMetadataByFilter(args);
}

export function createPersistentStorageNamespaceHandle<
  T,
  TMetadata extends Record<string, unknown> = Record<string, never>,
>(
  config: PersistentStorageRuntimeConfig & { entryPrefix: string },
  {
    asyncValueCodec,
    getManifestMeta,
    valueCodec,
  }: {
    asyncValueCodec?: AsyncStorageValueCodec<T, unknown, TMetadata>;
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
  const debugContext = import.meta.env.DEV
    ? createPersistentStorageDebugContext(
        adapter,
        config.storeName,
        config.debugLogger,
        config.entryPrefix,
        undefined,
        asyncNamespaceKind,
      )
    : undefined;
  const effectiveAsyncValueCodec = asyncValueCodec ?? valueCodec;
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

    asyncAdapter.debugLogger = config.debugLogger;
    asyncAdapter.prodLogger = config.prodLogger;

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
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;
    const operationDetails = import.meta.env.DEV
      ? {
          removes: args.removes?.length ?? 0,
          touches: args.touches?.length ?? 0,
          upserts: args.upserts?.length ?? 0,
        }
      : undefined;

    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'commit',
              'skipped',
              startTime,
              { ...operationDetails, reason: 'inactive-session' },
            );
          }
          return;
        }

        await namespace.commit({
          removes: args.removes,
          staticPolicy: args.staticPolicy,
          touches: args.touches,
          upserts: args.upserts?.map((upsert) => ({
            key: upsert.key,
            ...(() => {
              const value = effectiveAsyncValueCodec
                ? effectiveAsyncValueCodec.serialize(upsert.data)
                : // WORKAROUND: In the no-codec path, persistence stores opaque caller values as unknown and only erases the generic for transport through the adapter.
                  __LEGIT_CAST__<unknown, T>(upsert.data);
              const serialized = serializeJsonForStorage(value);
              return {
                serializedValue: serialized.rawValue,
                sizeBytes: serialized.sizeBytes,
                value,
              };
            })(),
            version: asyncVersion,
            metadata:
              upsert.metadata ?? getManifestMeta?.(upsert.data, upsert.key),
          })),
        });
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'commit',
            'success',
            startTime,
            operationDetails,
          );
        }
        return;
      }

      const prefix = getPrefix();
      if (prefix === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'commit',
            'skipped',
            startTime,
            { ...operationDetails, reason: 'inactive-session' },
          );
        }
        return;
      }
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'commit',
            'skipped',
            startTime,
            { ...operationDetails, reason: 'inactive-session' },
          );
        }
        return;
      }
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

          const { sizeBytes } = localPersistentStorage.write(key, entry);
          localPersistentStorage.upsertNamespaceEntry({
            storagePrefix: prefix,
            entryKey: upsert.key,
            lastAccessAt: timestamp,
            sizeBytes,
            mergeMeta: (currentMeta: unknown) =>
              preserveOfflineProtectionFlag(
                sessionKey,
                key,
                upsert.metadata ?? getManifestMeta?.(upsert.data, upsert.key),
                currentMeta,
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
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'commit',
          'success',
          startTime,
          operationDetails,
        );
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'commit',
          'error',
          startTime,
          operationDetails,
          error,
        );
      }
      onPersistentStorageError?.(error);
    }
  }

  async function readEntry(
    entryKey: string,
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<StorageCacheEntry<T> | null> {
    const context = import.meta.env.DEV
      ? withPersistentStorageDebugKey(debugContext, entryKey)
      : undefined;
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(context)
      : null;
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              context,
              'read-entry',
              'skipped',
              startTime,
              { reason: 'inactive-session', touch: options.touch },
            );
          }
          return null;
        }

        const entry = await namespace.get(entryKey, {
          touch: options.touch ?? 'never',
        });
        if (!entry) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              context,
              'read-entry',
              'miss',
              startTime,
              { reason: 'missing-entry', touch: options.touch },
            );
          }
          return null;
        }

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [entryKey] });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              context,
              'read-entry',
              'miss',
              startTime,
              {
                expectedVersion: asyncVersion,
                reason: 'version-mismatch',
                storedVersion: entry.metadata.version,
                touch: options.touch,
              },
            );
          }
          return null;
        }

        const decoded = effectiveAsyncValueCodec
          ? effectiveAsyncValueCodec.deserialize(
              entry.value,
              entry.metadata.customMetadata,
            )
          : // WORKAROUND: Stored values cross the persistence boundary as unknown, and in the no-codec path this API intentionally exposes them as the caller's requested T.
            __LEGIT_CAST__<T, unknown>(entry.value);
        if (decoded === null) {
          await namespace.commit({ removes: [entryKey] });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              context,
              'read-entry',
              'miss',
              startTime,
              { reason: 'decode-failed', touch: options.touch },
            );
          }
          return null;
        }

        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            context,
            'read-entry',
            'success',
            startTime,
            { touch: options.touch },
          );
        }
        return {
          data: decoded,
          timestamp: entry.metadata.lastAccessAt,
          version: entry.metadata.version,
        };
      }

      const prefix = getPrefix();
      if (prefix === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            context,
            'read-entry',
            'skipped',
            startTime,
            { reason: 'inactive-session', touch: options.touch },
          );
        }
        return null;
      }
      const key = `${prefix}${entryKey}`;

      const entry = readStorageEntryFromLocalStorageSync<T>(
        key,
        version,
        { metadata: 'namespace', namespacePrefix: prefix },
        localCodec,
      );
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          withPersistentStorageDebugKey(context, key),
          'read-entry',
          entry ? 'success' : 'miss',
          startTime,
          { touch: options.touch },
        );
      }
      return entry;
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          context,
          'read-entry',
          'error',
          startTime,
          { touch: options.touch },
          error,
        );
      }
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function load(
    entryKey: string,
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<T | null> {
    const context = import.meta.env.DEV
      ? withPersistentStorageDebugKey(debugContext, entryKey)
      : undefined;
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(context)
      : null;
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              context,
              'load',
              'skipped',
              startTime,
              { reason: 'inactive-session', touch: options.touch },
            );
          }
          return null;
        }

        const entry = await namespace.get(entryKey, {
          touch: options.touch ?? 'coarse',
        });
        if (!entry) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(context, 'load', 'miss', startTime, {
              reason: 'missing-entry',
              touch: options.touch,
            });
          }
          return null;
        }

        if (entry.metadata.version !== asyncVersion) {
          await namespace.commit({ removes: [entryKey] });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(context, 'load', 'miss', startTime, {
              expectedVersion: asyncVersion,
              reason: 'version-mismatch',
              storedVersion: entry.metadata.version,
              touch: options.touch,
            });
          }
          return null;
        }

        const decoded = effectiveAsyncValueCodec
          ? effectiveAsyncValueCodec.deserialize(
              entry.value,
              entry.metadata.customMetadata,
            )
          : // WORKAROUND: Stored values cross the persistence boundary as unknown, and in the no-codec path this API intentionally exposes them as the caller's requested T.
            __LEGIT_CAST__<T, unknown>(entry.value);
        if (decoded === null) {
          await namespace.commit({ removes: [entryKey] });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(context, 'load', 'miss', startTime, {
              reason: 'decode-failed',
              touch: options.touch,
            });
          }
          return null;
        }

        if (import.meta.env.DEV) {
          logPersistentStorageOperation(context, 'load', 'success', startTime, {
            touch: options.touch,
          });
        }
        return decoded;
      }

      const prefix = getPrefix();
      if (prefix === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(context, 'load', 'skipped', startTime, {
            reason: 'inactive-session',
            touch: options.touch,
          });
        }
        return null;
      }

      const key = `${prefix}${entryKey}`;
      const entry = await readEntry(entryKey);
      if (!entry) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            withPersistentStorageDebugKey(context, key),
            'load',
            'miss',
            startTime,
            { touch: options.touch },
          );
        }
        return null;
      }

      scheduleIdleCleanup(() =>
        refreshLocalStorageTimestamp(key, {
          metadata: 'namespace',
          namespacePrefix: prefix,
        }),
      );

      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          withPersistentStorageDebugKey(context, key),
          'load',
          'success',
          startTime,
          { touch: options.touch },
        );
      }
      return entry.data;
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          context,
          'load',
          'error',
          startTime,
          { touch: options.touch },
          error,
        );
      }
      onPersistentStorageError?.(error);
      return null;
    }
  }

  async function loadMany(
    entryKeys: string[],
    options: { touch?: AsyncStorageTouchMode } = {},
  ): Promise<Array<T | null>> {
    if (entryKeys.length === 0) return [];

    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'load-many',
              'skipped',
              startTime,
              {
                keyCount: entryKeys.length,
                reason: 'inactive-session',
                touch: options.touch,
              },
            );
          }
          return entryKeys.map(() => null);
        }

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
          const decoded = effectiveAsyncValueCodec
            ? effectiveAsyncValueCodec.deserialize(
                entry.value,
                entry.metadata.customMetadata,
              )
            : // WORKAROUND: Stored values cross the persistence boundary as unknown, and in the no-codec path this API intentionally exposes them as the caller's requested T.
              __LEGIT_CAST__<T, unknown>(entry.value);
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

        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'load-many',
            'success',
            startTime,
            {
              hitCount: values.filter((value) => value !== null).length,
              keyCount: entryKeys.length,
              staleCount: staleKeys.length,
              touch: options.touch,
            },
          );
        }
        return values;
      }

      const values = await Promise.all(
        entryKeys.map((entryKey) => load(entryKey)),
      );
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'load-many',
          'success',
          startTime,
          {
            hitCount: values.filter((value) => value !== null).length,
            keyCount: entryKeys.length,
            touch: options.touch,
          },
        );
      }
      return values;
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'load-many',
          'error',
          startTime,
          { keyCount: entryKeys.length, touch: options.touch },
          error,
        );
      }
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
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'list-metadata',
              'skipped',
              startTime,
              { order: args.order, reason: 'inactive-session' },
            );
          }
          return [];
        }

        const entries = await namespace.listMetadata(args);
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-metadata',
            'success',
            startTime,
            { count: entries.length, order: args.order },
          );
        }
        return entries;
      }

      const prefix = getPrefix();
      if (prefix === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-metadata',
            'skipped',
            startTime,
            { order: args.order, reason: 'inactive-session' },
          );
        }
        return [];
      }

      const order = args.order ?? 'key';

      const entries = localPersistentStorage
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
            ? // WORKAROUND: Metadata is only guaranteed to be record-shaped at runtime, and this API rebinds that validated record to the caller's metadata generic.
              __LEGIT_CAST__<TMetadata, unknown>(entry.meta)
            : // WORKAROUND: Missing metadata is represented internally as an empty record, which this API rebinds to the caller's metadata generic.
              __LEGIT_CAST__<TMetadata, Record<string, never>>({}),
          key: entry.entryKey,
          lastAccessAt: entry.lastAccessAt,
          sizeBytes: entry.sizeBytes,
          writtenAt: entry.lastAccessAt,
          version: asyncVersion,
        }));
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'list-metadata',
          'success',
          startTime,
          { count: entries.length, order },
        );
      }
      return entries;
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'list-metadata',
          'error',
          startTime,
          { order: args.order },
          error,
        );
      }
      onPersistentStorageError?.(error);
      return [];
    }
  }

  async function listMetadataByFilter(args: {
    equals: unknown;
    key: string;
    order?: AsyncStorageMetadataOrder;
  }): Promise<PersistentStorageNamespaceMetadata<TMetadata>[]> {
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;
    const operationDetails = import.meta.env.DEV
      ? { filterKey: args.key, order: args.order }
      : undefined;
    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'list-metadata-by-filter',
              'skipped',
              startTime,
              { ...operationDetails, reason: 'inactive-session' },
            );
          }
          return [];
        }

        if (typeof namespace.listMetadataByFilter === 'function') {
          const entries = await namespace.listMetadataByFilter({
            filter: { equals: args.equals, key: args.key },
            order: args.order,
          });
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'list-metadata-by-filter',
              'success',
              startTime,
              { ...operationDetails, count: entries.length },
            );
          }
          return entries;
        }

        const entries = (
          await namespace.listMetadata({ order: args.order })
        ).filter((entry) => {
          // WORKAROUND: Async metadata is normalized to a plain record before
          // reaching this fallback path.
          const metadata = __LEGIT_CAST__<Record<string, unknown>, unknown>(
            entry.customMetadata,
          );
          return metadata[args.key] === args.equals;
        });
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-metadata-by-filter',
            'success',
            startTime,
            { ...operationDetails, count: entries.length },
          );
        }
        return entries;
      }

      const prefix = getPrefix();
      if (prefix === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-metadata-by-filter',
            'skipped',
            startTime,
            { ...operationDetails, reason: 'inactive-session' },
          );
        }
        return [];
      }

      const order = args.order ?? 'key';
      const entries = localPersistentStorage
        .listManifestEntries(prefix)
        .filter((entry) => {
          const metadata = isObject(entry.meta) ? entry.meta : null;
          return metadata?.[args.key] === args.equals;
        })
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
            ? // WORKAROUND: Sync manifest metadata is stored as a plain record,
              // and this cast only rebinds the caller's metadata generic.
              __LEGIT_CAST__<TMetadata, unknown>(entry.meta)
            : (() => {
                // WORKAROUND: Empty metadata is represented as a shared empty
                // record, and this cast only rebinds the caller's metadata generic.
                return __LEGIT_CAST__<TMetadata, Record<string, never>>({});
              })(),
          key: entry.entryKey,
          lastAccessAt: entry.lastAccessAt,
          writtenAt: entry.lastAccessAt,
          version: asyncVersion,
        }));
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'list-metadata-by-filter',
          'success',
          startTime,
          { ...operationDetails, count: entries.length, order },
        );
      }
      return entries;
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'list-metadata-by-filter',
          'error',
          startTime,
          operationDetails,
          error,
        );
      }
      onPersistentStorageError?.(error);
      return [];
    }
  }

  async function listKeys(): Promise<string[]> {
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;
    if (asyncAdapter !== null) {
      const namespace = getAsyncNamespace();
      if (!namespace) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-keys',
            'skipped',
            startTime,
            { reason: 'inactive-session' },
          );
        }
        return [];
      }

      try {
        const keys = await namespace.listKeys();
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-keys',
            'success',
            startTime,
            { count: keys.length },
          );
        }
        return keys;
      } catch (error) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'list-keys',
            'error',
            startTime,
            undefined,
            error,
          );
        }
        onPersistentStorageError?.(error);
        return [];
      }
    }

    const entries = await listMetadata({ order: 'key' });
    const keys = entries.map((entry) => entry.key);
    if (import.meta.env.DEV) {
      logPersistentStorageOperation(
        debugContext,
        'list-keys',
        'success',
        startTime,
        { count: keys.length },
      );
    }
    return keys;
  }

  async function clear(): Promise<void> {
    const prefix = getPrefix();
    const startTime = import.meta.env.DEV
      ? startPersistentStorageDebugTiming(debugContext)
      : null;

    try {
      if (asyncAdapter !== null) {
        const namespace = getAsyncNamespace();
        if (!namespace) {
          if (import.meta.env.DEV) {
            logPersistentStorageOperation(
              debugContext,
              'clear',
              'skipped',
              startTime,
              { reason: 'inactive-session' },
            );
          }
          return;
        }
        await namespace.clear();
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'clear',
            'success',
            startTime,
          );
        }
        return;
      }

      if (prefix === false) {
        if (import.meta.env.DEV) {
          logPersistentStorageOperation(
            debugContext,
            'clear',
            'skipped',
            startTime,
            { reason: 'inactive-session' },
          );
        }
        return;
      }

      await runLocalStorageMutation(() => {
        localPersistentStorage.clearManifest(
          localPersistentStorage.getManifestKeyForPrefix(prefix),
        );
      });
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'clear',
          'success',
          startTime,
        );
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        logPersistentStorageOperation(
          debugContext,
          'clear',
          'error',
          startTime,
          undefined,
          error,
        );
      }
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
    listMetadataByFilter,
    clear,
    dispose,
  };
}

export function readStorageEntryFromLocalStorageSync<T = unknown>(
  key: string,
  version: number | undefined,
  options: LocalStorageMetadataOptions & {
    allowExpiredRead?: boolean;
    debug?: {
      context: PersistentStorageDebugContext;
      details?: Readonly<Record<string, unknown>>;
      operation: TSDFPersistentStorageDebugOperation;
    };
  },
  // WORKAROUND: The default local-storage codec is generic over unknown and simply forwards JSON-compatible values, so callers rebind it to their T when no custom codec is supplied.
  valueCodec: LocalStorageValueCodec<T> = __LEGIT_CAST__<
    LocalStorageValueCodec<T>,
    LocalStorageValueCodec<unknown>
  >(defaultLocalStorageValueCodec),
): StorageCacheEntry<T> | null {
  function logRead(
    status: PersistentStorageDebugStatus,
    reason?: string,
  ): void {
    if (!import.meta.env.DEV) return;
    if (!options.debug) return;

    const details: Record<string, unknown> = {};
    if (reason !== undefined) {
      details.reason = reason;
    }
    if (options.debug.details !== undefined) {
      Object.assign(details, options.debug.details);
    }

    logPersistentStorageOperation(
      withPersistentStorageDebugKey(options.debug.context, key),
      options.debug.operation,
      status,
      null,
      details,
    );
  }

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

  if (metadata === null) {
    if (import.meta.env.DEV) {
      logRead('miss', 'missing-metadata');
    }
    return null;
  }

  if (
    Date.now() - metadata.lastAccessAt >
      getManagedLocalStorageRuntimeConfig().maxAgeMs &&
    !options.allowExpiredRead
  ) {
    if (import.meta.env.DEV) {
      logRead('miss', 'expired-entry');
    }
    return removeAndReturnNull();
  }

  const raw = localPersistentStorage.readRaw(key);
  if (raw === null) {
    if (import.meta.env.DEV) {
      logRead('miss', 'missing-entry');
    }
    return removeAndReturnNull();
  }

  const entry = parseCompactLocalStorageEntry(raw);
  if (entry === null) {
    if (import.meta.env.DEV) {
      logRead('miss', 'invalid-entry');
    }
    return removeAndReturnNull();
  }

  if (!doesStorageEntryVersionMatch(entry.version, version)) {
    if (import.meta.env.DEV) {
      logRead('miss', 'version-mismatch');
    }
    return removeAndReturnNull();
  }

  const decoded = valueCodec.deserialize(entry.value);
  if (decoded === null) {
    if (import.meta.env.DEV) {
      logRead('miss', 'decode-failed');
    }
    return removeAndReturnNull();
  }

  if (import.meta.env.DEV) {
    logRead('success');
  }
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

export function createProtectedStorageKey(
  sessionKey: string,
  storeName: string,
  kind: string,
  key: string,
  backend: 'async' | 'localStorage' = 'localStorage',
): string {
  if (backend === 'localStorage') {
    if (kind === 'document' && key === DOCUMENT_PERSISTED_ENTRY_KEY) {
      return getStorageKeyForStore(sessionKey, storeName);
    }

    return `${getStoragePrefixForStoreNamespace(
      sessionKey,
      storeName,
      kind,
    )}${key}`;
  }

  return serializeProtectedRef({
    sessionKey,
    storeName,
    kind: ensureAsyncNamespaceKind(kind),
    key,
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
  } else {
    await adapter.clearSession(sessionKey);
    await runLocalStorageMutation(() => {
      const sessionOfflineStatusKey = getStorageKey(sessionKey, '_o_.s');
      localPersistentStorage.clearManifest(
        localPersistentStorage.getManifestKeyForSingle(sessionOfflineStatusKey),
      );
    });
  }

  await clearRegisteredOfflineUploadStorage(sessionKey);
}

/** Clears all persistent storage entries for a given session key across built-in adapters. */
export async function clearAllSessionStorage(
  sessionKey: string,
): Promise<void> {
  const { indexedDbPersistentStorage, opfsPersistentStorage } =
    await import('./asyncStorageAdapters');

  await Promise.all([
    clearSessionStorage(sessionKey, 'local-sync'),
    clearSessionStorage(sessionKey, opfsPersistentStorage),
    clearSessionStorage(sessionKey, indexedDbPersistentStorage),
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

/**
 * Resets persistent-storage maintenance and expiration-tracking state.
 *
 * Exported for test cleanup, but restart-style tests should prefer
 * `resetSessionForTests()` from `tests/utils/resetSessionForTests.ts` so this
 * low-level reset stays coordinated with the other session/runtime resets.
 */
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
}

export async function readProtectedStorageKeys(
  adapter: StorageAdapter,
  sessionKey: string,
  debugLogger?: TSDFDebugLogger,
): Promise<Set<string>> {
  const debugContext = import.meta.env.DEV
    ? createPersistentStorageDebugContext(
        adapter,
        '_offline_',
        debugLogger,
        undefined,
        undefined,
        '__internal.protected',
      )
    : undefined;
  const startTime = import.meta.env.DEV
    ? startPersistentStorageDebugTiming(debugContext)
    : null;

  if (adapter === 'local-sync') {
    const keys = localPersistentStorage.readProtectedStorageKeys(sessionKey);
    if (import.meta.env.DEV) {
      logPersistentStorageOperation(
        debugContext,
        'read-protected-keys',
        'success',
        startTime,
        { count: keys.size, sessionKey },
      );
    }
    return keys;
  }

  try {
    const keys = await adapter.readProtectedStorageKeys(sessionKey);
    if (import.meta.env.DEV) {
      logPersistentStorageOperation(
        debugContext,
        'read-protected-keys',
        'success',
        startTime,
        { count: keys.size, sessionKey },
      );
    }
    return keys;
  } catch (error) {
    if (import.meta.env.DEV) {
      logPersistentStorageOperation(
        debugContext,
        'read-protected-keys',
        'error',
        startTime,
        { sessionKey },
        error,
      );
    }
    throw error;
  }
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
