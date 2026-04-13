import { createCache, type Cache } from '@ls-stack/utils/cache';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { sleep } from '@ls-stack/utils/sleep';
import { isObject } from '@ls-stack/utils/typeGuards';
import { klona } from 'klona/json';
import { rc_array, rc_number, rc_object, rc_parse, rc_string } from 'runcheck';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  compareMetadata,
  getNamespaceId,
  getPayloadRecordKey,
  normalizeStaticPolicy,
  parseProtectedRef,
  PAYLOAD_RECORD_PREFIX,
  serializeProtectedRef as serializeProtectedRefInternal,
} from './asyncStorageShared';
import { parseCompactLocalStorageEntry } from './compactLocalStorageEntry';
import { runWithNavigatorLock } from './navigatorLocks';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import { isOfflineModeStatusValue } from './offline/types';
import {
  getSerializedStringSize,
  keepEntriesWithinByteBudget,
  serializeJsonForStorage,
} from './persistenceUtils';
import { getDefaultMaxBytesForScope } from './persistentStorageDefaults';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type {
  AsyncStorageAdapter,
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageEntryMetadata,
  AsyncStorageMaintenanceState,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceCommitArgs,
  AsyncStorageNamespaceCommitUpsert,
  AsyncStorageNamespaceGetResult,
  AsyncStorageNamespaceHandle,
  AsyncStorageProtectedEntryRef,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  AsyncStorageReadOptions,
} from './types';
import { parseAsyncStorageNamespaceKind } from './types';

export const ASYNC_STORAGE_COMMIT_DEBOUNCE_MS: number = 40;
export const ASYNC_STORAGE_MAX_AGE_MS: number = 14 * 24 * 60 * 60 * 1000;
const ASYNC_STORAGE_STARTUP_CLEANUP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const ASYNC_STORAGE_RECENCY_BUCKET_MS = 6 * 60 * 60 * 1000;
export const ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY = 'tsdf._am.g' as const;
const ASYNC_STORAGE_WRITER_LOCK_NAME_PREFIX = 'tsdf-async-write:';
const ASYNC_STORAGE_WRITER_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; async persistentStorage is using unlocked writer coordination.';
const ASYNC_STARTUP_CLEANUP_LOCK_NAME = 'tsdf-async-storage-maintenance';
const ASYNC_STARTUP_CLEANUP_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; async OPFS startup cleanup is using unlocked coordination.';
const ASYNC_STORAGE_CACHE_INVALIDATION_CHANNEL_NAME =
  'tsdf-async-storage-cache-v1';
const ASYNC_STORAGE_NAMESPACE_INDEX_CACHE_MAX_SIZE = 500;
const ASYNC_STORAGE_PAYLOAD_CACHE_MAX_SIZE = 5_000;

function getBucketId(timestamp: number): string {
  return String(Math.floor(timestamp / ASYNC_STORAGE_RECENCY_BUCKET_MS));
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;

  return value;
}

function isOfflineProtectedMetadata(
  customMetadata: Record<string, unknown> | undefined,
): boolean {
  return customMetadata?.o === true;
}

export function getProtectedKeysFromMetadata(
  entries: ReadonlyArray<{
    customMetadata?: Record<string, unknown>;
    key: string;
  }>,
): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (isOfflineProtectedMetadata(entry.customMetadata)) {
      keys.add(entry.key);
    }
  }
  return keys;
}

function isSessionOfflineInLocalStorage(sessionKey: string): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const statusEntry = parseCompactLocalStorageEntry(
      localStorage.getItem(`tsdf.${sessionKey}._o_.s`),
    );
    const rawStatus = statusEntry?.value.d ?? null;
    return isOfflineModeStatusValue(rawStatus);
  } catch {
    return false;
  }
}

function setOfflineProtectionMetadata(
  customMetadata: Record<string, unknown> | undefined,
  offlineProtected: boolean,
): Record<string, unknown> | undefined {
  if (offlineProtected) {
    return { ...(customMetadata ?? {}), o: true };
  }

  const { o: _ignored, ...withoutOfflineMarker } = customMetadata ?? {};
  return Object.keys(withoutOfflineMarker).length > 0
    ? withoutOfflineMarker
    : undefined;
}

export function mergeManagedAsyncStorageCustomMetadata(args: {
  currentCustomMetadata?: Record<string, unknown>;
  key: string;
  nextCustomMetadata?: Record<string, unknown>;
  protectedKeysSnapshotSet?: Set<string> | null;
  scope: AsyncStorageNamespaceScope;
}): Record<string, unknown> | undefined {
  const merged = {
    ...(args.currentCustomMetadata ?? {}),
    ...(args.nextCustomMetadata ?? {}),
  };
  const mergedCustomMetadata =
    Object.keys(merged).length > 0 ? merged : undefined;

  if (args.protectedKeysSnapshotSet !== null) {
    return setOfflineProtectionMetadata(
      mergedCustomMetadata,
      args.protectedKeysSnapshotSet?.has(
        serializeProtectedRef({ ...args.scope, key: args.key }),
      ) === true ||
        isOfflineProtectedMetadata(args.nextCustomMetadata) ||
        isOfflineProtectedMetadata(args.currentCustomMetadata),
    );
  }

  return setOfflineProtectionMetadata(
    mergedCustomMetadata,
    isOfflineProtectedMetadata(args.nextCustomMetadata) ||
      isOfflineProtectedMetadata(args.currentCustomMetadata),
  );
}
const ASYNC_METADATA_LAST_ACCESS_AT_KEY = 'a';
const ASYNC_METADATA_VERSION_KEY = 'v';
const ASYNC_METADATA_SIZE_BYTES_KEY = 'z';
const persistedStaticPolicySchema = rc_object({
  b: rc_number.optionalKey(),
  k: rc_array(rc_string).optionalKey(),
});

function getInlineCustomMetadata(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const customMetadataEntries = Object.entries(record).filter(
    ([key]) =>
      key !== ASYNC_METADATA_LAST_ACCESS_AT_KEY &&
      key !== ASYNC_METADATA_VERSION_KEY &&
      key !== ASYNC_METADATA_SIZE_BYTES_KEY,
  );
  if (customMetadataEntries.length === 0) return undefined;

  return Object.fromEntries(customMetadataEntries);
}

type InternalManagedMetadataRecord = {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
};

function parseInternalManagedMetadataRecord(
  value: unknown,
): InternalManagedMetadataRecord | null {
  const record = getRecord(value);
  if (
    record === null ||
    typeof record.a !== 'number' ||
    ('v' in record && record.v !== undefined && typeof record.v !== 'number') ||
    ('z' in record && record.z !== undefined && typeof record.z !== 'number')
  ) {
    return null;
  }

  const customMetadata = getInlineCustomMetadata(record);

  return {
    lastAccessAt: record.a,
    ...(typeof record.z === 'number' ? { sizeBytes: record.z } : {}),
    version: typeof record.v === 'number' ? record.v : 1,
    ...(customMetadata ? { customMetadata } : {}),
  };
}

function serializeInternalManagedMetadataRecord(
  metadata: InternalManagedMetadataRecord,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    [ASYNC_METADATA_LAST_ACCESS_AT_KEY]: metadata.lastAccessAt,
    ...(metadata.sizeBytes !== undefined
      ? { [ASYNC_METADATA_SIZE_BYTES_KEY]: metadata.sizeBytes }
      : {}),
    ...(metadata.version !== 1
      ? { [ASYNC_METADATA_VERSION_KEY]: metadata.version }
      : {}),
  };

  const customMetadata = metadata.customMetadata;
  if (customMetadata === undefined) return serialized;

  if (
    ASYNC_METADATA_LAST_ACCESS_AT_KEY in customMetadata ||
    ASYNC_METADATA_VERSION_KEY in customMetadata ||
    ASYNC_METADATA_SIZE_BYTES_KEY in customMetadata
  ) {
    throw new Error(
      '[TSDF] Async storage custom metadata cannot use reserved keys "a", "v", or "z".',
    );
  }

  return { ...serialized, ...customMetadata };
}

export function estimateManagedAsyncStorageEntrySizeBytes(args: {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  serializedValue: string;
  version: number;
}): number {
  return (
    getSerializedStringSize(args.serializedValue) +
    getSerializedStringSize(
      JSON.stringify(
        serializeInternalManagedMetadataRecord({
          lastAccessAt: args.lastAccessAt,
          sizeBytes: undefined,
          version: args.version,
          ...(args.customMetadata
            ? { customMetadata: args.customMetadata }
            : {}),
        }),
      ),
    )
  );
}

function parseIndexEntries(
  value: unknown,
): Map<string, InternalManagedMetadataRecord> | null {
  const record = getRecord(value);
  const rawEntries = record?.e;
  if (rawEntries === undefined) {
    return value === null ? new Map() : null;
  }

  const entriesRecord = getRecord(rawEntries);
  if (entriesRecord === null) return null;

  const entries = new Map<string, InternalManagedMetadataRecord>();
  for (const [key, rawEntry] of Object.entries(entriesRecord)) {
    const parsed = parseInternalManagedMetadataRecord(rawEntry);
    if (parsed === null) return null;
    entries.set(key, parsed);
  }

  return entries;
}
/**
 * Builds a persisted static policy from config values, omitting fields that
 * match the provided default. Returns null when no overrides are needed.
 */
export function buildPersistedStaticPolicy(
  maxBytes: number | undefined,
  defaultMaxBytes: number,
  pinnedKeys: ReadonlySet<string>,
): AsyncStorageNamespaceStaticPolicy | null {
  return normalizeStaticPolicy({
    ...(maxBytes !== undefined && maxBytes !== defaultMaxBytes
      ? { maxBytes }
      : {}),
    ...(pinnedKeys.size > 0 ? { pinnedKeys: [...pinnedKeys] } : {}),
  });
}

function parseStaticPolicy(
  value: unknown,
): AsyncStorageNamespaceStaticPolicy | null {
  const parsed = rc_parse(value, persistedStaticPolicySchema).unwrapOrNull();
  if (parsed === null) return null;
  if (parsed.b !== undefined && (!Number.isInteger(parsed.b) || parsed.b < 0)) {
    return null;
  }

  return normalizeStaticPolicy({
    ...(parsed.b !== undefined ? { maxBytes: parsed.b } : {}),
    ...(parsed.k !== undefined ? { pinnedKeys: parsed.k } : {}),
  });
}

function serializeStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null,
): Record<string, unknown> | undefined {
  if (policy === null) return undefined;

  return {
    ...(policy.maxBytes !== undefined ? { b: policy.maxBytes } : {}),
    ...(policy.pinnedKeys !== undefined && policy.pinnedKeys.length > 0
      ? { k: policy.pinnedKeys }
      : {}),
  };
}

type InternalManagedIndexState = {
  entries: Map<string, InternalManagedMetadataRecord>;
  staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
};

function serializeIndexState(
  state: InternalManagedIndexState,
): Record<string, unknown> {
  const serializedStaticPolicy = serializeStaticPolicy(state.staticPolicy);

  return {
    e: Object.fromEntries(
      [...state.entries.entries()].map(([key, metadata]) => [
        key,
        serializeInternalManagedMetadataRecord(metadata),
      ]),
    ),
    ...(serializedStaticPolicy !== undefined
      ? { s: serializedStaticPolicy }
      : {}),
  };
}

function getDefaultStaticPolicyForScope(
  scope: AsyncStorageNamespaceScope,
): AsyncStorageNamespaceStaticPolicy | null {
  switch (scope.kind) {
    case 'collection.item':
      return {
        maxBytes: getDefaultMaxBytesForScope({
          adapter: 'async',
          scopeKind: 'collection.item',
        }),
      };
    case 'listQuery.item':
      return {
        maxBytes: getDefaultMaxBytesForScope({
          adapter: 'async',
          scopeKind: 'listQuery.item',
        }),
      };
    case 'listQuery.query':
      return {
        maxBytes: getDefaultMaxBytesForScope({
          adapter: 'async',
          scopeKind: 'listQuery.query',
        }),
      };
    default:
      return null;
  }
}

/**
 * Strips fields from a persisted static policy that match the scope's defaults,
 * so only non-default overrides are stored.
 * Expects already-normalized input.
 */
function normalizePersistedStaticPolicyForScope(
  scope: AsyncStorageNamespaceScope,
  persistedStaticPolicy: AsyncStorageNamespaceStaticPolicy | null,
): AsyncStorageNamespaceStaticPolicy | null {
  if (persistedStaticPolicy === null) return null;
  const defaultPolicy = getDefaultStaticPolicyForScope(scope);

  return normalizeStaticPolicy({
    maxBytes:
      persistedStaticPolicy.maxBytes !== undefined &&
      persistedStaticPolicy.maxBytes !== defaultPolicy?.maxBytes
        ? persistedStaticPolicy.maxBytes
        : undefined,
    pinnedKeys: persistedStaticPolicy.pinnedKeys,
  });
}

/**
 * Merges a persisted static policy (already normalized for scope) with the
 * scope's defaults to produce the effective policy.
 * Expects already-normalized input.
 */
function getEffectiveStaticPolicyForScope(
  scope: AsyncStorageNamespaceScope,
  normalizedPersistedPolicy: AsyncStorageNamespaceStaticPolicy | null,
): AsyncStorageNamespaceStaticPolicy | null {
  const defaultPolicy = getDefaultStaticPolicyForScope(scope);
  if (defaultPolicy === null) return normalizedPersistedPolicy;

  return normalizeStaticPolicy({
    maxBytes: normalizedPersistedPolicy?.maxBytes ?? defaultPolicy.maxBytes,
    pinnedKeys: normalizedPersistedPolicy?.pinnedKeys,
  });
}

async function driverGetManyFrom(
  driver: AsyncStorageDriver,
  scope: AsyncStorageNamespaceScope,
  keys: string[],
): Promise<unknown[]> {
  if (keys.length === 0) return [];
  return driver.getMany(scope, keys);
}

export type AsyncStorageManagedMetadataRecord = InternalManagedMetadataRecord;

type AsyncStorageManagedMetadataFilter = { equals: unknown; key: string };

type AsyncStorageManagedMetadataListArgs = {
  filter?: AsyncStorageManagedMetadataFilter;
  knownRecordKeys?: string[] | null;
  order?: AsyncStorageMetadataOrder;
};

/** @internal */
export type AsyncStorageManagedDriverCapabilities = {
  applyManagedCommit?: (
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
    helpers: {
      mergeOfflineProtectionMetadata: (
        key: string,
        nextCustomMetadata: Record<string, unknown> | undefined,
        currentCustomMetadata: Record<string, unknown> | undefined,
      ) => Record<string, unknown> | undefined;
    },
  ) => Promise<void>;
  clearManagedNamespace?: (scope: AsyncStorageNamespaceScope) => Promise<void>;
  listManagedKeys?: (scope: AsyncStorageNamespaceScope) => Promise<string[]>;
  listManagedMetadata?: (
    scope: AsyncStorageNamespaceScope,
    args?: AsyncStorageManagedMetadataListArgs,
  ) => Promise<AsyncStorageEntryMetadata<Record<string, unknown>>[]>;
  readProtectedStorageKeys?: (sessionKey: string) => Promise<string[]>;
  readManagedEntries?: <TValue>(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ) => Promise<
    Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null
    >
  >;
  readNamespaceIndexState?: (
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys?: string[] | null,
  ) => Promise<{
    entries: Map<string, AsyncStorageManagedMetadataRecord> | null;
    exists: boolean;
    staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
    valid: boolean;
  }>;
  persistNamespaceIndexState?: (
    scope: AsyncStorageNamespaceScope,
    state: {
      entries: Map<string, AsyncStorageManagedMetadataRecord>;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
    },
  ) => Promise<void>;
  syncSessionProtectedKeys?: (
    sessionKey: string,
    protectedKeys: Iterable<string>,
  ) => Promise<void>;
};

type AsyncStorageManagedDriver = AsyncStorageDriver & {
  __tsdfManagedStorage?: AsyncStorageManagedDriverCapabilities;
};

function getManagedDriverCapabilities(
  driver: AsyncStorageDriver,
): AsyncStorageManagedDriverCapabilities | null {
  // WORKAROUND: Managed-driver capabilities live on an internal optional property
  // so custom raw drivers can keep the minimal public AsyncStorageDriver shape.
  const managedDriver = __LEGIT_CAST__<
    AsyncStorageManagedDriver,
    AsyncStorageDriver
  >(driver);
  return managedDriver.__tsdfManagedStorage ?? null;
}

export async function readAsyncStorageNamespaceIndexStateUsingDriver(
  driver: AsyncStorageDriver,
  scope: AsyncStorageNamespaceScope,
  knownRecordKeys?: string[] | null,
): Promise<{
  entries: Map<string, AsyncStorageManagedMetadataRecord> | null;
  exists: boolean;
  staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
  valid: boolean;
}> {
  const managedCapabilities = getManagedDriverCapabilities(driver);
  if (managedCapabilities?.readNamespaceIndexState !== undefined) {
    return managedCapabilities.readNamespaceIndexState(scope, knownRecordKeys);
  }

  if (
    knownRecordKeys != null &&
    !knownRecordKeys.includes(ASYNC_NAMESPACE_INDEX_RECORD_KEY)
  ) {
    return { entries: null, exists: false, staticPolicy: null, valid: true };
  }
  const indexKnownToExist = knownRecordKeys != null;

  const rawIndex = await driver.get(scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY);
  if (rawIndex === null) {
    return indexKnownToExist
      ? { entries: null, exists: true, staticPolicy: null, valid: false }
      : { entries: null, exists: false, staticPolicy: null, valid: true };
  }

  const record = getRecord(rawIndex);
  const parsed = parseIndexEntries(rawIndex);
  if (parsed === null) {
    return { entries: null, exists: true, staticPolicy: null, valid: false };
  }

  return {
    entries: parsed,
    exists: true,
    staticPolicy: parseStaticPolicy(record?.s),
    valid: true,
  };
}

type AsyncStoragePayloadReadState = { value: unknown };

type AsyncStorageReadCacheGenerationSnapshot = {
  globalGeneration: number;
  namespaceGeneration: number;
  namespaceId: string;
};

function cloneStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null,
): AsyncStorageNamespaceStaticPolicy | null {
  if (policy === null) return null;
  return {
    maxBytes: policy.maxBytes,
    pinnedKeys: policy.pinnedKeys ? [...policy.pinnedKeys] : undefined,
  };
}

function cloneManagedMetadataRecord(
  metadata: AsyncStorageManagedMetadataRecord,
): AsyncStorageManagedMetadataRecord {
  return {
    lastAccessAt: metadata.lastAccessAt,
    sizeBytes: metadata.sizeBytes,
    version: metadata.version,
    customMetadata: metadata.customMetadata
      ? klona(metadata.customMetadata)
      : undefined,
  };
}

type AsyncStorageNamespaceIndexReadState = Awaited<
  ReturnType<typeof readAsyncStorageNamespaceIndexStateUsingDriver>
>;

function cloneNamespaceIndexReadState(
  state: AsyncStorageNamespaceIndexReadState,
): AsyncStorageNamespaceIndexReadState {
  let entries: Map<string, AsyncStorageManagedMetadataRecord> | null = null;
  if (state.entries !== null) {
    entries = new Map();
    for (const [key, metadata] of state.entries) {
      entries.set(key, cloneManagedMetadataRecord(metadata));
    }
  }
  return {
    entries,
    exists: state.exists,
    staticPolicy: cloneStaticPolicy(state.staticPolicy),
    valid: state.valid,
  };
}

type AsyncStorageCacheInvalidationReason =
  | 'clear'
  | 'commit'
  | 'remove'
  | 'startup-cleanup';

function parseCacheInvalidationReason(
  value: unknown,
): AsyncStorageCacheInvalidationReason | null {
  switch (value) {
    case 'clear':
    case 'commit':
    case 'remove':
    case 'startup-cleanup':
      return value;
    default:
      return null;
  }
}

type AsyncStorageCacheInvalidationMessage = {
  kind: 'namespace-invalidated';
  protocolVersion: 1;
  reason: AsyncStorageCacheInvalidationReason;
  scope: AsyncStorageNamespaceScope;
};

function parseAsyncStorageCacheInvalidationMessage(
  value: unknown,
): AsyncStorageCacheInvalidationMessage | null {
  const record = getRecord(value);
  if (
    record === null ||
    record.kind !== 'namespace-invalidated' ||
    record.protocolVersion !== 1
  ) {
    return null;
  }

  const scopeRecord = getRecord(record.scope);
  if (
    scopeRecord === null ||
    typeof scopeRecord.kind !== 'string' ||
    typeof scopeRecord.sessionKey !== 'string' ||
    typeof scopeRecord.storeName !== 'string'
  ) {
    return null;
  }

  const kind = parseAsyncStorageNamespaceKind(scopeRecord.kind);
  if (kind === null) return null;

  const reason = parseCacheInvalidationReason(record.reason);
  if (reason === null) return null;

  return {
    kind: 'namespace-invalidated',
    protocolVersion: 1,
    reason,
    scope: {
      kind,
      sessionKey: scopeRecord.sessionKey,
      storeName: scopeRecord.storeName,
    },
  };
}

type AsyncStorageReadCacheParticipant = {
  clearAllCachedReads: () => void;
  onRemoteCacheInvalidation: (
    message: AsyncStorageCacheInvalidationMessage,
  ) => void;
};

const asyncStorageReadCacheParticipants: Array<
  WeakRef<AsyncStorageReadCacheParticipant>
> = [];
let asyncStorageCacheInvalidationChannel: BroadcastChannel | null | undefined;
let asyncStorageReadCacheLifecycleReady = false;

function getLiveAsyncStorageReadCacheParticipants(): AsyncStorageReadCacheParticipant[] {
  const liveParticipants: AsyncStorageReadCacheParticipant[] = [];
  const retainedRefs: Array<WeakRef<AsyncStorageReadCacheParticipant>> = [];

  for (const ref of asyncStorageReadCacheParticipants) {
    const participant = ref.deref();
    if (participant === undefined) continue;
    liveParticipants.push(participant);
    retainedRefs.push(ref);
  }

  asyncStorageReadCacheParticipants.length = 0;
  asyncStorageReadCacheParticipants.push(...retainedRefs);
  return liveParticipants;
}

function clearAllAsyncStorageReadCaches(): void {
  for (const participant of getLiveAsyncStorageReadCacheParticipants()) {
    participant.clearAllCachedReads();
  }
}

function notifyLocalAsyncStorageReadCacheInvalidation(
  source: AsyncStorageReadCacheParticipant,
  message: AsyncStorageCacheInvalidationMessage,
): void {
  for (const participant of getLiveAsyncStorageReadCacheParticipants()) {
    if (participant === source) continue;
    participant.onRemoteCacheInvalidation(message);
  }
}

function handleAsyncStorageCacheInvalidationEvent(
  event: MessageEvent<unknown>,
) {
  const message = parseAsyncStorageCacheInvalidationMessage(event.data);
  if (message === null) return;

  for (const participant of getLiveAsyncStorageReadCacheParticipants()) {
    participant.onRemoteCacheInvalidation(message);
  }
}

function ensureAsyncStorageReadCacheLifecycle(): void {
  if (!asyncStorageReadCacheLifecycleReady) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        clearAllAsyncStorageReadCaches();
      }
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', () => {
        clearAllAsyncStorageReadCaches();
      });
    }

    asyncStorageReadCacheLifecycleReady = true;
  }

  if (asyncStorageCacheInvalidationChannel !== undefined) return;

  try {
    asyncStorageCacheInvalidationChannel = new BroadcastChannel(
      ASYNC_STORAGE_CACHE_INVALIDATION_CHANNEL_NAME,
    );
    asyncStorageCacheInvalidationChannel.addEventListener(
      'message',
      handleAsyncStorageCacheInvalidationEvent,
    );
  } catch {
    asyncStorageCacheInvalidationChannel = null;
  }
}

function registerAsyncStorageReadCacheParticipant(
  participant: AsyncStorageReadCacheParticipant,
): void {
  ensureAsyncStorageReadCacheLifecycle();
  asyncStorageReadCacheParticipants.push(new WeakRef(participant));
}

function parseMaintenanceState(
  value: unknown,
): AsyncStorageMaintenanceState | null {
  const record = getRecord(value);
  if (record === null) return null;

  const lastSuccessfulCleanupAt = record.lca;
  if (
    lastSuccessfulCleanupAt !== null &&
    typeof lastSuccessfulCleanupAt !== 'number'
  ) {
    return null;
  }

  return { lastSuccessfulCleanupAt };
}

function createDefaultMaintenanceState(): AsyncStorageMaintenanceState {
  return { lastSuccessfulCleanupAt: null };
}

class ManagedAsyncStorageNamespaceHandle<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, never>,
> implements AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
  constructor(
    private readonly adapter: ManagedAsyncStorageAdapter,
    private readonly scope: AsyncStorageNamespaceScope,
  ) {}

  async get(
    key: string,
    options: AsyncStorageReadOptions = {},
  ): Promise<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null> {
    await this.adapter.flushPendingNamespaceCommit(this.scope, [key]);
    const entries = await this.adapter.readManagedEntries<
      TValue,
      TCustomMetadata
    >(this.scope, [key]);
    const entry = entries.get(key) ?? null;
    if (!entry) return null;

    const now = Date.now();
    const touchMode = options.touch ?? 'coarse';
    if (
      this.adapter.shouldEnqueueTouch(
        this.scope,
        key,
        entry.metadata.lastAccessAt,
        touchMode,
        now,
      )
    ) {
      void this.commit({ touches: [{ key, lastAccessAt: now }] }).catch(
        () => {},
      );
    }

    return entry;
  }

  async getMany(
    keys: string[],
    options: AsyncStorageReadOptions = {},
  ): Promise<
    Array<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
  > {
    if (keys.length === 0) return [];

    const uniqueKeys = [...new Set(keys)];
    await this.adapter.flushPendingNamespaceCommit(this.scope, uniqueKeys);
    const entries = await this.adapter.readManagedEntries<
      TValue,
      TCustomMetadata
    >(this.scope, uniqueKeys);
    const entryByKey = new Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null
    >();
    const touches: string[] = [];
    const now = Date.now();
    const touchMode = options.touch ?? 'coarse';

    for (const key of uniqueKeys) {
      const entry = entries.get(key) ?? null;
      entryByKey.set(key, entry);

      if (
        entry !== null &&
        this.adapter.shouldEnqueueTouch(
          this.scope,
          key,
          entry.metadata.lastAccessAt,
          touchMode,
          now,
        )
      ) {
        touches.push(key);
      }
    }

    if (touches.length > 0) {
      void this.commit({
        touches: touches.map((key) => ({ key, lastAccessAt: now })),
      }).catch(() => {});
    }

    return keys.map((key) => entryByKey.get(key) ?? null);
  }

  commit(
    args: AsyncStorageNamespaceCommitArgs<TValue, TCustomMetadata>,
  ): Promise<void> {
    return this.adapter.queueCommitToNamespace(this.scope, args);
  }

  async listKeys(): Promise<string[]> {
    await this.adapter.flushPendingNamespaceCommit(this.scope);
    return this.adapter.listManagedKeys(this.scope);
  }

  async listMetadata(
    args: { order?: AsyncStorageMetadataOrder } = {},
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    await this.adapter.flushPendingNamespaceCommit(this.scope);
    return this.adapter.listManagedMetadata<TCustomMetadata>(this.scope, args);
  }

  async listMetadataByFilter(args: {
    filter: AsyncStorageManagedMetadataFilter;
    order?: AsyncStorageMetadataOrder;
  }): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    await this.adapter.flushPendingNamespaceCommit(this.scope);
    return this.adapter.listManagedMetadata<TCustomMetadata>(this.scope, args);
  }

  async clear(): Promise<void> {
    await this.adapter.flushPendingNamespaceCommit(this.scope);
    await this.adapter.clearManagedNamespace(this.scope);
  }
}

type AsyncStorageCleanupCapableDriver = AsyncStorageDriver & {
  withIsolatedCleanupDriver?: <T>(
    callback: (driver: AsyncStorageDriver) => Promise<T>,
  ) => Promise<T>;
};

type AsyncStorageStartupCleanupActionCapableDriver =
  AsyncStorageCleanupCapableDriver & {
    cleanupFinalizeRemovedRecords?: (
      scope: AsyncStorageNamespaceScope,
      removedKeys: string[],
    ) => void;
    cleanupFinalizeRemovedSessionDir?: (sessionKey: string) => void;
    cleanupFinalizeRemovedStoreDir?: (
      scope: AsyncStorageNamespaceScope,
      removedKeys: string[],
    ) => void;
    cleanupRemoveKnownRecords?: (
      scope: AsyncStorageNamespaceScope,
      keys: string[],
    ) => Promise<string[]>;
    cleanupRemoveKnownSessionDir?: (sessionKey: string) => Promise<boolean>;
    cleanupRemoveKnownStoreDir?: (
      scope: AsyncStorageNamespaceScope,
      keys: string[],
    ) => Promise<boolean>;
  };

type StartupCleanupDeleteAction =
  | { kind: 'removeRecords'; keys: string[]; scope: AsyncStorageNamespaceScope }
  | { kind: 'removeSessionDir'; sessionKey: string }
  | {
      kind: 'removeStoreDir';
      keys: string[];
      scope: AsyncStorageNamespaceScope;
    };

type StartupCleanupScopePlan = {
  deleteAction: StartupCleanupDeleteAction | null;
  persistEntries: Map<string, InternalManagedMetadataRecord> | null;
  persistStaticPolicy?: AsyncStorageNamespaceStaticPolicy | null;
  scope: AsyncStorageNamespaceScope;
};

export type AsyncStartupCleanupStoreDeletePlan = {
  representativeScope: AsyncStorageNamespaceScope;
  removedKeysByScope: Array<{
    keys: string[];
    scope: AsyncStorageNamespaceScope;
  }>;
};

type StartupCleanupDeleteActionResult =
  | {
      action: Extract<StartupCleanupDeleteAction, { kind: 'removeRecords' }>;
      allSucceeded: boolean;
      kind: 'removeRecords';
      removedKeys: string[];
    }
  | {
      action: Extract<StartupCleanupDeleteAction, { kind: 'removeSessionDir' }>;
      kind: 'removeSessionDir';
      removed: boolean;
    }
  | {
      action: Extract<StartupCleanupDeleteAction, { kind: 'removeStoreDir' }>;
      kind: 'removeStoreDir';
      removed: boolean;
    };

export type AsyncStartupCleanupScopePlan = {
  deleteKeys: string[];
  persistEntries: Map<string, AsyncStorageManagedMetadataRecord> | null;
  persistStaticPolicy?: AsyncStorageNamespaceStaticPolicy | null;
  scope: AsyncStorageNamespaceScope;
};

type AsyncStartupStoreCleanupCallback = (args: {
  discoveredScopes: AsyncStorageDiscoveredScope[];
  driver: AsyncStorageDriver;
  now: number;
}) => Promise<{
  scopePlans: AsyncStartupCleanupScopePlan[];
  storeDeletePlans?: AsyncStartupCleanupStoreDeletePlan[];
}>;

const registeredAsyncStartupStoreCleanupCallbacks = new WeakMap<
  AsyncStorageAdapter,
  Map<string, AsyncStartupStoreCleanupCallback>
>();

function getStoreRegistryKey(sessionKey: string, storeName: string): string {
  return JSON.stringify([sessionKey, storeName]);
}

export function registerAsyncStartupStoreCleanup(
  adapter: AsyncStorageAdapter,
  sessionKey: string,
  storeName: string,
  callback: AsyncStartupStoreCleanupCallback,
): void {
  const registry =
    registeredAsyncStartupStoreCleanupCallbacks.get(adapter) ??
    new Map<string, AsyncStartupStoreCleanupCallback>();
  registry.set(getStoreRegistryKey(sessionKey, storeName), callback);
  registeredAsyncStartupStoreCleanupCallbacks.set(adapter, registry);
}

export function unregisterAsyncStartupStoreCleanup(
  adapter: AsyncStorageAdapter,
  sessionKey: string,
  storeName: string,
): void {
  const registry = registeredAsyncStartupStoreCleanupCallbacks.get(adapter);
  if (registry === undefined) return;

  registry.delete(getStoreRegistryKey(sessionKey, storeName));
  if (registry.size === 0) {
    registeredAsyncStartupStoreCleanupCallbacks.delete(adapter);
  }
}

type PendingNamespaceCommit = {
  cancelFlush: (() => void) | null;
  inFlightBarrierKeys: Set<string> | null;
  flushPromise: Promise<void> | null;
  hasStaticPolicyUpdate: boolean;
  removes: Set<string>;
  scope: AsyncStorageNamespaceScope;
  staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
  touches: Map<string, number>;
  upserts: Map<
    string,
    AsyncStorageNamespaceCommitUpsert<unknown, Record<string, unknown>>
  >;
  waiters: Array<{ reject: (error: unknown) => void; resolve: () => void }>;
};

class ManagedAsyncStorageAdapter implements AsyncStorageAdapter {
  readonly kind = 'async' as const;

  #cachedNamespaceIndexReads: Cache<AsyncStorageNamespaceIndexReadState> =
    createCache({ maxCacheSize: ASYNC_STORAGE_NAMESPACE_INDEX_CACHE_MAX_SIZE });
  #cachedPayloadReads: Cache<AsyncStoragePayloadReadState | null> = createCache(
    { maxCacheSize: ASYNC_STORAGE_PAYLOAD_CACHE_MAX_SIZE },
  );
  #namespaceReadCacheGenerations = new Map<string, number>();
  #observedScopes = new Map<string, AsyncStorageNamespaceScope>();
  #pendingNamespaceCommits = new Map<string, PendingNamespaceCommit>();
  #readCacheGeneration = 0;
  #recentTouchedBuckets = new Map<string, string>();
  #startupCleanupScheduled = false;

  constructor(private readonly driver: AsyncStorageDriver) {
    registerAsyncStorageReadCacheParticipant(this);
  }

  async #runWithSessionWriterLock<T>(
    sessionKey: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return runWithNavigatorLock(
      `${ASYNC_STORAGE_WRITER_LOCK_NAME_PREFIX}${sessionKey}`,
      ASYNC_STORAGE_WRITER_LOCK_WARNING,
      callback,
    );
  }

  openNamespace<
    TValue,
    TCustomMetadata extends Record<string, unknown> = Record<string, never>,
  >(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
    this.#observedScopes.set(getNamespaceId(scope), scope);
    this.#scheduleStartupCleanupIfNeeded();
    return new ManagedAsyncStorageNamespaceHandle<TValue, TCustomMetadata>(
      this,
      scope,
    );
  }

  async clearSession(sessionKey: string): Promise<void> {
    await this.#runWithSessionWriterLock(sessionKey, async () => {
      await this.#flushPendingNamespaceCommitsForSessionUnlocked(sessionKey);
      const scopesToClear = await this.#listDiscoveredScopes(sessionKey);

      await Promise.all(
        scopesToClear.map((scope) =>
          this.#clearManagedNamespaceUnlocked(scope),
        ),
      );
    });
  }

  async readProtectedStorageKeys(
    sessionKey: string,
    driver: AsyncStorageDriver = this.driver,
  ): Promise<Set<string>> {
    const protectedKeysSnapshot = getSessionProtectedKeysSnapshot(sessionKey);
    if (protectedKeysSnapshot !== null && protectedKeysSnapshot.size > 0) {
      return new Set(protectedKeysSnapshot);
    }

    const managedCapabilities = getManagedDriverCapabilities(driver);
    if (managedCapabilities?.readProtectedStorageKeys !== undefined) {
      return new Set(
        await managedCapabilities.readProtectedStorageKeys(sessionKey),
      );
    }

    const discovered = await this.#listDiscoveredCleanupScopes(
      driver,
      sessionKey,
    );
    const protectedRefSets = await Promise.all(
      discovered.map(async ({ knownRecordKeys, scope }) => {
        const metadataEntries = await this.#listManagedMetadataUsingDriver(
          driver,
          scope,
          { knownRecordKeys, order: 'key' },
        );

        const refs: string[] = [];
        for (const entry of metadataEntries) {
          if (isOfflineProtectedMetadata(entry.customMetadata)) {
            refs.push(serializeProtectedRef({ ...scope, key: entry.key }));
          }
        }
        return refs;
      }),
    );

    return new Set(protectedRefSets.flat());
  }

  async syncSessionProtectedKeys(
    sessionKey: string,
    protectedKeys: Iterable<string>,
    previousProtectedKeys: Iterable<string> = [],
  ): Promise<void> {
    const nextProtectedRefSet = new Set(protectedKeys);
    const previousProtectedRefSet = new Set(previousProtectedKeys);
    const changedProtectedRefs = [
      ...[...nextProtectedRefSet].filter(
        (entryRef) => !previousProtectedRefSet.has(entryRef),
      ),
      ...[...previousProtectedRefSet].filter(
        (entryRef) => !nextProtectedRefSet.has(entryRef),
      ),
    ];

    if (changedProtectedRefs.length === 0) return;

    const updatesByScope = new Map<
      string,
      {
        protectionByKey: Map<string, boolean>;
        scope: AsyncStorageNamespaceScope;
      }
    >();

    for (const entryRef of changedProtectedRefs) {
      const parsedRef = parseProtectedRef(entryRef);
      if (parsedRef === null || parsedRef.sessionKey !== sessionKey) continue;

      const scope = {
        sessionKey: parsedRef.sessionKey,
        storeName: parsedRef.storeName,
        kind: parsedRef.kind,
      } satisfies AsyncStorageNamespaceScope;
      const namespaceId = getNamespaceId(scope);
      const existingScopeUpdate = updatesByScope.get(namespaceId);

      if (existingScopeUpdate !== undefined) {
        existingScopeUpdate.protectionByKey.set(
          parsedRef.key,
          nextProtectedRefSet.has(entryRef),
        );
        continue;
      }

      updatesByScope.set(namespaceId, {
        scope,
        protectionByKey: new Map([
          [parsedRef.key, nextProtectedRefSet.has(entryRef)],
        ]),
      });
    }

    await this.#runWithSessionWriterLock(sessionKey, async () => {
      await this.#flushPendingNamespaceCommitsForSessionUnlocked(sessionKey);

      const managedCapabilities = getManagedDriverCapabilities(this.driver);
      if (managedCapabilities?.syncSessionProtectedKeys !== undefined) {
        await managedCapabilities.syncSessionProtectedKeys(
          sessionKey,
          nextProtectedRefSet,
        );
        for (const { scope } of updatesByScope.values()) {
          this.#invalidateCachedNamespace(scope);
          this.#broadcastNamespaceInvalidation(scope, 'commit');
        }
        return;
      }

      await Promise.all(
        [...updatesByScope.values()].map(async ({ scope, protectionByKey }) => {
          const indexState = await this.#readNamespaceIndexStateUsingDriver(
            this.driver,
            scope,
          );
          const indexEntries =
            indexState.valid && indexState.entries !== null
              ? indexState.entries
              : new Map<string, InternalManagedMetadataRecord>();
          let changed = false;

          for (const [key, shouldProtect] of protectionByKey.entries()) {
            const existingMetadata = indexEntries.get(key);
            if (existingMetadata === undefined) continue;
            if (
              isOfflineProtectedMetadata(existingMetadata.customMetadata) ===
              shouldProtect
            ) {
              continue;
            }

            const nextCustomMetadata = setOfflineProtectionMetadata(
              existingMetadata.customMetadata,
              shouldProtect,
            );
            const nextMetadata: InternalManagedMetadataRecord = {
              ...existingMetadata,
            };
            if (nextCustomMetadata !== undefined) {
              nextMetadata.customMetadata = nextCustomMetadata;
            } else {
              delete nextMetadata.customMetadata;
            }

            indexEntries.set(key, nextMetadata);
            changed = true;
          }

          if (changed) {
            await this.#persistNamespaceIndexUsingDriver(this.driver, scope, {
              entries: indexEntries,
              staticPolicy: normalizeStaticPolicy(indexState.staticPolicy),
            });
            this.#invalidateCachedNamespace(scope);
            this.#broadcastNamespaceInvalidation(scope, 'commit');
          }
        }),
      );
    });
  }

  resetForTests(): void {
    for (const pending of this.#pendingNamespaceCommits.values()) {
      pending.cancelFlush?.();
    }
    this.clearAllCachedReads();
    this.#namespaceReadCacheGenerations.clear();
    this.#observedScopes.clear();
    this.#pendingNamespaceCommits.clear();
    this.#recentTouchedBuckets.clear();
    this.#startupCleanupScheduled = false;
    void this.driver.__resetForTests?.();
  }

  shouldEnqueueTouch(
    scope: AsyncStorageNamespaceScope,
    key: string,
    lastAccessAt: number,
    touchMode: AsyncStorageReadOptions['touch'],
    now: number,
  ): boolean {
    if (touchMode === 'never') return false;

    const currentBucket = getBucketId(now);
    if (touchMode !== 'force' && getBucketId(lastAccessAt) === currentBucket) {
      return false;
    }

    const namespaceKey = getNamespaceId(scope);
    const touchGuardKey = `${namespaceKey}::${key}`;
    if (this.#recentTouchedBuckets.get(touchGuardKey) === currentBucket) {
      return false;
    }

    const pending = this.#pendingNamespaceCommits.get(namespaceKey);
    const pendingTouch = pending?.touches.get(key);
    return (
      pendingTouch === undefined || getBucketId(pendingTouch) !== currentBucket
    );
  }

  #hasPendingBarrierForKeys(
    pending: PendingNamespaceCommit,
    keys: readonly string[],
  ): boolean {
    return keys.some((key) => {
      return (
        pending.upserts.has(key) ||
        pending.removes.has(key) ||
        pending.inFlightBarrierKeys?.has(key) === true
      );
    });
  }

  async queueCommitToNamespace<
    TValue,
    TCustomMetadata extends Record<string, unknown>,
  >(
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<TValue, TCustomMetadata>,
  ): Promise<void> {
    const pending = this.#getOrCreatePendingNamespaceCommit(scope);
    const now = Date.now();

    for (const touch of args.touches ?? []) {
      pending.touches.set(touch.key, touch.lastAccessAt ?? now);
    }

    for (const remove of args.removes ?? []) {
      pending.upserts.delete(remove);
      pending.touches.delete(remove);
      pending.removes.add(remove);
    }

    if ('staticPolicy' in args) {
      pending.hasStaticPolicyUpdate = true;
      pending.staticPolicy = args.staticPolicy ?? null;
    }

    for (const upsert of args.upserts ?? []) {
      pending.removes.delete(upsert.key);
      pending.upserts.set(
        upsert.key,
        // WORKAROUND: Pending namespace commits erase value generics internally so one queue can hold mixed namespaces, and this cast restores the normalized internal upsert shape.
        __LEGIT_CAST__<
          AsyncStorageNamespaceCommitUpsert<unknown, Record<string, unknown>>,
          unknown
        >(upsert),
      );
    }

    this.#schedulePendingNamespaceFlush(pending);

    return new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  async flushPendingNamespaceCommit(
    scope: AsyncStorageNamespaceScope,
    keys?: readonly string[],
  ): Promise<void> {
    const namespaceKey = getNamespaceId(scope);
    const pending = this.#pendingNamespaceCommits.get(namespaceKey);
    if (!pending) return;
    if (
      keys !== undefined &&
      keys.length > 0 &&
      !this.#hasPendingBarrierForKeys(pending, keys)
    ) {
      return;
    }

    await this.#runWithSessionWriterLock(scope.sessionKey, async () => {
      await this.#flushPendingNamespaceCommitUnlocked(scope, keys);
    });
  }

  async #flushPendingNamespaceCommitUnlocked(
    scope: AsyncStorageNamespaceScope,
    keys?: readonly string[],
  ): Promise<void> {
    const namespaceKey = getNamespaceId(scope);
    const pending = this.#pendingNamespaceCommits.get(namespaceKey);
    if (!pending) return;
    if (
      keys !== undefined &&
      keys.length > 0 &&
      !this.#hasPendingBarrierForKeys(pending, keys)
    ) {
      return;
    }
    if (pending.flushPromise) {
      await pending.flushPromise;
      return;
    }

    pending.cancelFlush?.();
    pending.cancelFlush = null;

    const upserts = [...pending.upserts.values()];
    const removes = [...pending.removes];
    const hasStaticPolicyUpdate = pending.hasStaticPolicyUpdate;
    const staticPolicy = pending.staticPolicy;
    const touches = [...pending.touches.entries()].map(
      ([key, lastAccessAt]) => ({ key, lastAccessAt }),
    );
    const inFlightBarrierKeys = new Set([
      ...pending.upserts.keys(),
      ...pending.removes,
    ]);
    const waiters = [...pending.waiters];
    pending.hasStaticPolicyUpdate = false;
    pending.upserts = new Map();
    pending.removes = new Set();
    pending.staticPolicy = null;
    pending.touches = new Map();
    pending.waiters = [];
    pending.inFlightBarrierKeys =
      inFlightBarrierKeys.size > 0 ? inFlightBarrierKeys : null;

    if (
      upserts.length === 0 &&
      removes.length === 0 &&
      touches.length === 0 &&
      !hasStaticPolicyUpdate
    ) {
      this.#pendingNamespaceCommits.delete(namespaceKey);
      for (const waiter of waiters) {
        waiter.resolve();
      }
      return;
    }

    pending.flushPromise = this.#applyManagedCommit(scope, {
      upserts,
      removes,
      ...(hasStaticPolicyUpdate ? { staticPolicy } : {}),
      touches,
    })
      .then(() => {
        const currentBucket = getBucketId(Date.now());
        for (const touch of touches) {
          this.#recentTouchedBuckets.set(
            `${namespaceKey}::${touch.key}`,
            getBucketId(touch.lastAccessAt),
          );
        }
        for (const upsert of upserts) {
          this.#recentTouchedBuckets.set(
            `${namespaceKey}::${upsert.key}`,
            currentBucket,
          );
        }
        this.#pruneRecentTouchedBuckets(currentBucket);
        for (const waiter of waiters) {
          waiter.resolve();
        }
      })
      .catch((error: unknown) => {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
        throw error;
      })
      .finally(() => {
        pending.inFlightBarrierKeys = null;
        pending.flushPromise = null;
        if (pending.waiters.length === 0) {
          this.#pendingNamespaceCommits.delete(namespaceKey);
          return;
        }
        this.#schedulePendingNamespaceFlush(pending);
      });

    await pending.flushPromise;
  }

  async flushAllPendingNamespaceCommits(): Promise<void> {
    await Promise.all(
      [...this.#pendingNamespaceCommits.values()].map((pending) =>
        this.flushPendingNamespaceCommit(pending.scope),
      ),
    );
  }

  async #flushPendingNamespaceCommitsForSessionUnlocked(
    sessionKey: string,
  ): Promise<void> {
    await Promise.all(
      [...this.#pendingNamespaceCommits.values()]
        .filter((pending) => pending.scope.sessionKey === sessionKey)
        .map((pending) =>
          this.#flushPendingNamespaceCommitUnlocked(pending.scope),
        ),
    );
  }

  clearRecentTouchedBucketsForNamespace(
    scope: AsyncStorageNamespaceScope,
  ): void {
    const keyPrefix = `${getNamespaceId(scope)}::`;
    for (const key of this.#recentTouchedBuckets.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.#recentTouchedBuckets.delete(key);
      }
    }
  }

  async #readNamespaceIndexEntriesUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys?: string[] | null,
  ): Promise<Map<string, InternalManagedMetadataRecord>> {
    const state = await this.#readNamespaceIndexStateUsingDriver(
      driver,
      scope,
      { knownRecordKeys },
    );
    return state.valid && state.entries !== null ? state.entries : new Map();
  }

  async #readNamespaceIndexStaticPolicyUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys?: string[] | null,
  ): Promise<AsyncStorageNamespaceStaticPolicy | null> {
    const state = await this.#readNamespaceIndexStateUsingDriver(
      driver,
      scope,
      { knownRecordKeys },
    );
    return state.valid ? normalizeStaticPolicy(state.staticPolicy) : null;
  }

  async #readNamespaceIndexStateUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    args: { knownRecordKeys?: string[] | null } = {},
  ): Promise<AsyncStorageNamespaceIndexReadState> {
    const knownRecordKeys = args.knownRecordKeys;
    const namespaceKey = getNamespaceId(scope);
    const shouldUseCache = driver === this.driver;

    if (knownRecordKeys != null) {
      if (!knownRecordKeys.includes(ASYNC_NAMESPACE_INDEX_RECORD_KEY)) {
        this.#invalidateCachedNamespace(scope);
        return {
          entries: null,
          exists: false,
          staticPolicy: null,
          valid: true,
        };
      }

      if (shouldUseCache) {
        const existing =
          await this.#cachedNamespaceIndexReads.getAsync(namespaceKey);
        if (existing !== undefined) {
          return cloneNamespaceIndexReadState(existing);
        }
      }
    }

    if (!shouldUseCache) {
      return readAsyncStorageNamespaceIndexStateUsingDriver(
        driver,
        scope,
        knownRecordKeys,
      );
    }

    const cacheGeneration = this.#getReadCacheGenerationSnapshot(scope);
    const state = await this.#cachedNamespaceIndexReads.getOrInsertAsync(
      namespaceKey,
      async ({ skipCaching }) => {
        const nextState = await readAsyncStorageNamespaceIndexStateUsingDriver(
          driver,
          scope,
          knownRecordKeys,
        );
        if (!this.#isReadCacheGenerationSnapshotCurrent(cacheGeneration)) {
          return skipCaching(nextState);
        }

        return this.#shouldCacheNamespaceIndexState(nextState)
          ? cloneNamespaceIndexReadState(nextState)
          : skipCaching(nextState);
      },
    );
    return cloneNamespaceIndexReadState(state);
  }

  async #persistNamespaceIndexUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    state: InternalManagedIndexState,
    advanceGeneration = true,
  ): Promise<void> {
    if (advanceGeneration) {
      this.#advanceNamespaceReadCacheGeneration(scope);
    }

    const managedCapabilities = getManagedDriverCapabilities(driver);
    if (managedCapabilities?.persistNamespaceIndexState !== undefined) {
      await managedCapabilities.persistNamespaceIndexState(scope, state);
      if (state.entries.size === 0) {
        this.#invalidateCachedNamespaceIndexState(scope);
      } else {
        this.#setCachedNamespaceIndexState(scope, {
          entries: state.entries,
          exists: true,
          staticPolicy: state.staticPolicy,
          valid: true,
        });
      }
      return;
    }

    if (state.entries.size === 0) {
      await this.#driverRemoveManyFrom(driver, scope, [
        ASYNC_NAMESPACE_INDEX_RECORD_KEY,
      ]);
      this.#invalidateCachedNamespaceIndexState(scope);
      return;
    }

    await this.#driverSetManyFrom(driver, scope, [
      {
        key: ASYNC_NAMESPACE_INDEX_RECORD_KEY,
        value: serializeIndexState(state),
      },
    ]);
    this.#setCachedNamespaceIndexState(scope, {
      entries: state.entries,
      exists: true,
      staticPolicy: state.staticPolicy,
      valid: true,
    });
  }

  async readManagedEntries<
    TValue,
    TCustomMetadata extends Record<string, unknown>,
  >(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<
    Map<string, AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
  > {
    const managedCapabilities = getManagedDriverCapabilities(this.driver);
    if (managedCapabilities?.readManagedEntries !== undefined) {
      // WORKAROUND: Fast-path drivers already normalize metadata to the shared
      // record-based shape; this cast only rebinds the caller's metadata generic.
      return __LEGIT_CAST__<
        Map<
          string,
          AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null
        >,
        Map<
          string,
          AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null
        >
      >(await managedCapabilities.readManagedEntries<TValue>(scope, keys));
    }

    const metadataByKey = await this.#readNamespaceIndexEntriesUsingDriver(
      this.driver,
      scope,
    );
    const payloadKeys = keys.filter((key) => metadataByKey.has(key));
    const payloadValues = await this.#readPayloadValuesUsingDriver(
      this.driver,
      scope,
      payloadKeys,
    );
    const payloadByKey = new Map<string, unknown>();
    for (const [index, key] of payloadKeys.entries()) {
      payloadByKey.set(key, payloadValues[index] ?? null);
    }

    const result = new Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null
    >();
    const orphanedKeys: string[] = [];

    for (const key of keys) {
      const metadata = metadataByKey.get(key);
      if (metadata === undefined) {
        result.set(key, null);
        continue;
      }

      const rawPayload = payloadByKey.get(key) ?? null;
      if (rawPayload === null) {
        orphanedKeys.push(key);
        result.set(key, null);
        continue;
      }

      result.set(key, {
        // WORKAROUND: Managed storage payloads cross the storage boundary as unknown, and version plus metadata validation above determine when they are safe to expose as TValue.
        value: __LEGIT_CAST__<TValue, unknown>(rawPayload),
        // WORKAROUND: Internal metadata is always normalized to record-shaped custom metadata, and this public API only rebinds that validated record to the caller's generic.
        metadata: __LEGIT_CAST__<
          AsyncStorageEntryMetadata<TCustomMetadata>,
          AsyncStorageEntryMetadata<Record<string, unknown>>
        >(this.#toPublicMetadata(key, metadata)),
      });
    }

    if (orphanedKeys.length > 0) {
      await this.#removeManagedKeysUsingDriver(
        this.driver,
        scope,
        orphanedKeys,
      );
    }

    return result;
  }

  async listManagedMetadata<TCustomMetadata extends Record<string, unknown>>(
    scope: AsyncStorageNamespaceScope,
    args: {
      filter?: AsyncStorageManagedMetadataFilter;
      order?: AsyncStorageMetadataOrder;
    } = {},
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    return this.#listManagedMetadataUsingDriver(this.driver, scope, args);
  }

  async #listManagedMetadataUsingDriver<
    TCustomMetadata extends Record<string, unknown>,
  >(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageManagedMetadataListArgs = {},
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    const managedCapabilities = getManagedDriverCapabilities(driver);
    if (managedCapabilities?.listManagedMetadata !== undefined) {
      // WORKAROUND: Fast-path drivers already return the shared public metadata
      // shape, and this cast only rebinds the caller's metadata generic.
      return __LEGIT_CAST__<
        AsyncStorageEntryMetadata<TCustomMetadata>[],
        AsyncStorageEntryMetadata<Record<string, unknown>>[]
      >(await managedCapabilities.listManagedMetadata(scope, args));
    }

    const metadataEntries = await this.#readNamespaceIndexEntriesUsingDriver(
      driver,
      scope,
      args.knownRecordKeys,
    );
    const validEntries: AsyncStorageEntryMetadata<Record<string, unknown>>[] =
      [];
    for (const [key, metadata] of metadataEntries.entries()) {
      validEntries.push(this.#toPublicMetadata(key, metadata));
    }

    if (args.filter !== undefined) {
      const { filter } = args;
      // WORKAROUND: Entries in this fallback path are already normalized to the
      // public metadata shape, and this cast only narrows the public generic.
      return __LEGIT_CAST__<
        AsyncStorageEntryMetadata<TCustomMetadata>[],
        AsyncStorageEntryMetadata<Record<string, unknown>>[]
      >(
        validEntries
          .filter((entry) => entry.customMetadata[filter.key] === filter.equals)
          .sort((left, right) =>
            compareMetadata(left, right, args.order ?? 'key'),
          ),
      );
    }

    validEntries.sort((left, right) =>
      compareMetadata(left, right, args.order ?? 'key'),
    );

    // WORKAROUND: Internal metadata is always normalized to record-shaped custom metadata, and this public API only rebinds that validated array to the caller's generic.
    return __LEGIT_CAST__<
      AsyncStorageEntryMetadata<TCustomMetadata>[],
      AsyncStorageEntryMetadata<Record<string, unknown>>[]
    >(validEntries);
  }

  async listManagedKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    const managedCapabilities = getManagedDriverCapabilities(this.driver);
    if (managedCapabilities?.listManagedKeys !== undefined) {
      return managedCapabilities.listManagedKeys(scope);
    }

    const indexEntries = await this.#readNamespaceIndexEntriesUsingDriver(
      this.driver,
      scope,
    );

    return [...indexEntries.keys()].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  async clearManagedNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    await this.#runWithSessionWriterLock(scope.sessionKey, async () => {
      await this.#clearManagedNamespaceUnlocked(scope);
    });
  }

  async #clearManagedNamespaceUnlocked(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    const managedCapabilities = getManagedDriverCapabilities(this.driver);
    if (managedCapabilities?.clearManagedNamespace !== undefined) {
      await managedCapabilities.clearManagedNamespace(scope);
    } else {
      await this.driver.clear(scope);
    }
    this.#invalidateCachedNamespace(scope);
    this.#broadcastNamespaceInvalidation(scope, 'clear');
    const namespaceKey = getNamespaceId(scope);
    this.#observedScopes.delete(namespaceKey);
    this.#pendingNamespaceCommits.delete(namespaceKey);
    this.clearRecentTouchedBucketsForNamespace(scope);
  }

  #toPublicMetadata(
    key: string,
    metadata: InternalManagedMetadataRecord,
  ): AsyncStorageEntryMetadata<Record<string, unknown>> {
    return {
      key,
      payloadRef: getPayloadRecordKey(key),
      writtenAt: metadata.lastAccessAt,
      lastAccessAt: metadata.lastAccessAt,
      sizeBytes: metadata.sizeBytes,
      version: metadata.version,
      customMetadata: metadata.customMetadata ?? {},
    };
  }

  async #applyManagedCommit(
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
  ): Promise<void> {
    const upserts = args.upserts ?? [];
    const removes = [...new Set(args.removes ?? [])];
    const touches = args.touches ?? [];
    const touchedKeys = [...new Set(touches.map((touch) => touch.key))];

    const managedCapabilities = getManagedDriverCapabilities(this.driver);
    if (managedCapabilities?.applyManagedCommit !== undefined) {
      await managedCapabilities.applyManagedCommit(scope, args, {
        mergeOfflineProtectionMetadata: (
          key,
          nextCustomMetadata,
          currentCustomMetadata,
        ) =>
          mergeManagedAsyncStorageCustomMetadata({
            currentCustomMetadata,
            key,
            nextCustomMetadata,
            protectedKeysSnapshotSet: getSessionProtectedKeysSnapshot(
              scope.sessionKey,
            ),
            scope,
          }),
      });
      this.#advanceNamespaceReadCacheGeneration(scope);
      this.#invalidateCachedNamespaceIndexState(scope);

      for (const key of removes) {
        this.#invalidateCachedPayloadValue(scope, key);
      }

      for (const upsert of upserts) {
        this.#setCachedPayloadValue(scope, upsert.key, { value: upsert.value });
      }

      this.#broadcastNamespaceInvalidation(scope, 'commit');
      return;
    }

    const currentIndexState = await this.#readNamespaceIndexStateUsingDriver(
      this.driver,
      scope,
    );
    const indexEntries =
      currentIndexState.valid && currentIndexState.entries !== null
        ? currentIndexState.entries
        : new Map<string, InternalManagedMetadataRecord>();

    const now = Date.now();
    const touchesByKey = new Map(
      touches.map((touch) => [touch.key, touch.lastAccessAt ?? now]),
    );
    const setEntries: AsyncStorageDriverSetEntry[] = [];
    const removeEntries = removes.map((key) => getPayloadRecordKey(key));
    let indexChanged = false;
    let nextStaticPolicy = normalizeStaticPolicy(
      currentIndexState.staticPolicy,
    );

    for (const key of removes) {
      indexChanged = indexEntries.delete(key) || indexChanged;
    }

    if ('staticPolicy' in args) {
      const normalizedNextStaticPolicy = normalizeStaticPolicy(
        args.staticPolicy ?? null,
      );
      if (!deepEqual(nextStaticPolicy, normalizedNextStaticPolicy)) {
        nextStaticPolicy = normalizedNextStaticPolicy;
        indexChanged = true;
      }
    }

    const protectedKeysSnapshotSet = getSessionProtectedKeysSnapshot(
      scope.sessionKey,
    );

    for (const upsert of upserts) {
      const existingMetadata = indexEntries.get(upsert.key);
      const customMetadata = mergeManagedAsyncStorageCustomMetadata({
        currentCustomMetadata: existingMetadata?.customMetadata,
        key: upsert.key,
        nextCustomMetadata: upsert.metadata,
        protectedKeysSnapshotSet,
        scope,
      });
      const nextLastAccessAt =
        touchesByKey.get(upsert.key) ?? existingMetadata?.lastAccessAt ?? now;
      const serializedValue =
        upsert.serializedValue !== undefined
          ? { rawValue: upsert.serializedValue }
          : serializeJsonForStorage(upsert.value);
      const nextSizeBytes =
        scope.kind !== 'document'
          ? estimateManagedAsyncStorageEntrySizeBytes({
              customMetadata,
              lastAccessAt: nextLastAccessAt,
              serializedValue: serializedValue.rawValue,
              version: upsert.version,
            })
          : undefined;
      const nextMetadata: InternalManagedMetadataRecord = {
        lastAccessAt: nextLastAccessAt,
        version: upsert.version,
        ...(nextSizeBytes !== undefined ? { sizeBytes: nextSizeBytes } : {}),
        ...(customMetadata ? { customMetadata } : {}),
      };

      setEntries.push({
        key: getPayloadRecordKey(upsert.key),
        serializedValue: serializedValue.rawValue,
        ...(nextSizeBytes !== undefined ? { sizeBytes: nextSizeBytes } : {}),
        value: upsert.value,
      });

      if (
        existingMetadata !== undefined &&
        existingMetadata.lastAccessAt === nextMetadata.lastAccessAt &&
        existingMetadata.sizeBytes === nextMetadata.sizeBytes &&
        existingMetadata.version === nextMetadata.version &&
        deepEqual(existingMetadata.customMetadata, nextMetadata.customMetadata)
      ) {
        continue;
      }

      indexEntries.set(upsert.key, nextMetadata);
      indexChanged = true;
    }

    if (touchedKeys.length > 0) {
      const upsertKeySet = new Set(upserts.map((upsert) => upsert.key));
      for (const key of touchedKeys) {
        if (upsertKeySet.has(key)) continue;
        const metadata = indexEntries.get(key);
        if (!metadata) continue;

        const nextLastAccessAt = touchesByKey.get(key) ?? now;
        if (metadata.lastAccessAt === nextLastAccessAt) continue;

        indexEntries.set(key, { ...metadata, lastAccessAt: nextLastAccessAt });
        indexChanged = true;
      }
    }

    await Promise.all([
      removeEntries.length > 0
        ? this.#driverRemoveManyFrom(this.driver, scope, removeEntries)
        : Promise.resolve(),
      setEntries.length > 0
        ? this.#driverSetManyFrom(this.driver, scope, setEntries)
        : Promise.resolve(),
    ]);

    this.#advanceNamespaceReadCacheGeneration(scope);

    for (const key of removes) {
      this.#invalidateCachedPayloadValue(scope, key);
    }

    for (const upsert of upserts) {
      this.#setCachedPayloadValue(scope, upsert.key, { value: upsert.value });
    }

    if (indexChanged) {
      await this.#persistNamespaceIndexUsingDriver(
        this.driver,
        scope,
        { entries: indexEntries, staticPolicy: nextStaticPolicy },
        false,
      );
    } else {
      this.#setCachedNamespaceIndexState(scope, {
        entries: currentIndexState.valid ? indexEntries : null,
        exists: currentIndexState.exists,
        staticPolicy: currentIndexState.staticPolicy,
        valid: currentIndexState.valid,
      });
    }

    this.#broadcastNamespaceInvalidation(scope, 'commit');
  }

  async #removeManagedKeysUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return;

    await this.#runWithSessionWriterLock(scope.sessionKey, async () => {
      const indexState = await this.#readNamespaceIndexStateUsingDriver(
        driver,
        scope,
      );

      await this.#driverRemoveManyFrom(
        driver,
        scope,
        uniqueKeys.map((key) => getPayloadRecordKey(key)),
      );

      for (const key of uniqueKeys) {
        this.#invalidateCachedPayloadValue(scope, key);
      }

      if (indexState.valid && indexState.entries !== null) {
        let changed = false;
        for (const key of uniqueKeys) {
          changed = indexState.entries.delete(key) || changed;
        }
        if (changed) {
          await this.#persistNamespaceIndexUsingDriver(driver, scope, {
            entries: indexState.entries,
            staticPolicy: normalizeStaticPolicy(indexState.staticPolicy),
          });
        }
      }

      this.#broadcastNamespaceInvalidation(scope, 'remove');
    });
  }

  async #driverSetManyFrom(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await driver.setMany(scope, entries);
  }

  async #driverRemoveManyFrom(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    await driver.removeMany(scope, keys);
  }

  #readMaintenanceState(): AsyncStorageMaintenanceState {
    const raw = localStorage.getItem(ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY);
    if (raw === null) return createDefaultMaintenanceState();

    try {
      return (
        parseMaintenanceState(JSON.parse(raw)) ??
        createDefaultMaintenanceState()
      );
    } catch {
      return createDefaultMaintenanceState();
    }
  }

  #writeMaintenanceState(state: AsyncStorageMaintenanceState): void {
    localStorage.setItem(
      ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
      JSON.stringify({ lca: state.lastSuccessfulCleanupAt }),
    );
  }

  clearAllCachedReads(): void {
    this.#readCacheGeneration += 1;
    this.#cachedNamespaceIndexReads.clear();
    this.#cachedPayloadReads.clear();
  }

  onRemoteCacheInvalidation(
    message: AsyncStorageCacheInvalidationMessage,
  ): void {
    this.#invalidateCachedNamespace(message.scope);
  }

  async #readPayloadValuesUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<unknown[]> {
    if (keys.length === 0) return [];

    const shouldUseCache = driver === this.driver;
    if (!shouldUseCache) {
      return driverGetManyFrom(
        driver,
        scope,
        keys.map((key) => getPayloadRecordKey(key)),
      );
    }

    const cacheGeneration = this.#getReadCacheGenerationSnapshot(scope);
    const promisesByKey = new Map<
      string,
      Promise<AsyncStoragePayloadReadState | null>
    >();
    const uncachedKeys: string[] = [];

    for (const key of keys) {
      const payloadCacheKey = this.#getPayloadCacheKey(scope, key);
      if (this.#cachedPayloadReads.has(payloadCacheKey)) {
        promisesByKey.set(
          key,
          this.#cachedPayloadReads
            .getAsync(payloadCacheKey)
            .then((state) => state ?? null),
        );
        continue;
      }
      uncachedKeys.push(key);
    }

    if (uncachedKeys.length > 0) {
      const readPromise = driverGetManyFrom(
        driver,
        scope,
        uncachedKeys.map((key) => getPayloadRecordKey(key)),
      );

      for (const [index, key] of uncachedKeys.entries()) {
        const payloadCacheKey = this.#getPayloadCacheKey(scope, key);
        const keyPromise = this.#cachedPayloadReads.setAsync(
          payloadCacheKey,
          async ({ skipCaching }) => {
            const value = (await readPromise)[index] ?? null;
            const nextState = value === null ? null : { value: klona(value) };
            if (!this.#isReadCacheGenerationSnapshotCurrent(cacheGeneration)) {
              return skipCaching(nextState);
            }

            return nextState === null ? skipCaching(null) : nextState;
          },
        );
        promisesByKey.set(key, keyPromise);
      }
    }

    return Promise.all(
      keys.map(async (key) => {
        const state = await promisesByKey.get(key);
        return state === null || state === undefined
          ? null
          : klona(state.value);
      }),
    );
  }

  #setCachedNamespaceIndexState(
    scope: AsyncStorageNamespaceScope,
    state: AsyncStorageNamespaceIndexReadState,
  ): void {
    if (!this.#shouldCacheNamespaceIndexState(state)) {
      this.#cachedNamespaceIndexReads.delete(getNamespaceId(scope));
      return;
    }

    this.#cachedNamespaceIndexReads.set(
      getNamespaceId(scope),
      cloneNamespaceIndexReadState(state),
    );
  }

  #setCachedPayloadValue(
    scope: AsyncStorageNamespaceScope,
    key: string,
    state: AsyncStoragePayloadReadState,
  ): void {
    this.#cachedPayloadReads.set(this.#getPayloadCacheKey(scope, key), {
      value: klona(state.value),
    });
  }

  #invalidateCachedNamespaceIndexState(
    scope: AsyncStorageNamespaceScope,
  ): void {
    this.#cachedNamespaceIndexReads.delete(getNamespaceId(scope));
  }

  #invalidateCachedPayloadValue(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): void {
    this.#cachedPayloadReads.delete(this.#getPayloadCacheKey(scope, key));
  }

  #invalidateCachedNamespace(scope: AsyncStorageNamespaceScope): void {
    const namespaceKey = `${getNamespaceId(scope)}::`;
    this.#advanceNamespaceReadCacheGeneration(scope);
    this.#invalidateCachedNamespaceIndexState(scope);

    for (const key of this.#cachedPayloadReads[' cache'].map.keys()) {
      if (key.startsWith(namespaceKey)) {
        this.#cachedPayloadReads.delete(key);
      }
    }
  }

  #getPayloadCacheKey(scope: AsyncStorageNamespaceScope, key: string): string {
    return `${getNamespaceId(scope)}::${key}`;
  }

  #getNamespaceReadCacheGeneration(namespaceId: string): number {
    return this.#namespaceReadCacheGenerations.get(namespaceId) ?? 0;
  }

  #advanceNamespaceReadCacheGeneration(
    scope: AsyncStorageNamespaceScope,
  ): void {
    const namespaceId = getNamespaceId(scope);
    this.#namespaceReadCacheGenerations.set(
      namespaceId,
      this.#getNamespaceReadCacheGeneration(namespaceId) + 1,
    );
  }

  #getReadCacheGenerationSnapshot(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageReadCacheGenerationSnapshot {
    const namespaceId = getNamespaceId(scope);
    return {
      globalGeneration: this.#readCacheGeneration,
      namespaceGeneration: this.#getNamespaceReadCacheGeneration(namespaceId),
      namespaceId,
    };
  }

  #isReadCacheGenerationSnapshotCurrent(
    snapshot: AsyncStorageReadCacheGenerationSnapshot,
  ): boolean {
    return (
      snapshot.globalGeneration === this.#readCacheGeneration &&
      snapshot.namespaceGeneration ===
        this.#getNamespaceReadCacheGeneration(snapshot.namespaceId)
    );
  }

  #shouldCacheNamespaceIndexState(
    state: AsyncStorageNamespaceIndexReadState,
  ): boolean {
    return state.valid && state.exists && state.entries !== null;
  }

  #broadcastNamespaceInvalidation(
    scope: AsyncStorageNamespaceScope,
    reason: AsyncStorageCacheInvalidationReason,
  ): void {
    const message = {
      kind: 'namespace-invalidated',
      protocolVersion: 1,
      reason,
      scope,
    } satisfies AsyncStorageCacheInvalidationMessage;

    notifyLocalAsyncStorageReadCacheInvalidation(this, message);
    asyncStorageCacheInvalidationChannel?.postMessage(message);
  }

  async #listDiscoveredScopes(
    sessionKey?: string,
    driver: AsyncStorageDriver = this.driver,
  ): Promise<AsyncStorageNamespaceScope[]> {
    return (await driver.listScopes(sessionKey)).filter(
      (scope) => scope.kind !== '__internal.protected',
    );
  }

  #getOrCreatePendingNamespaceCommit(
    scope: AsyncStorageNamespaceScope,
  ): PendingNamespaceCommit {
    const namespaceKey = getNamespaceId(scope);
    const existing = this.#pendingNamespaceCommits.get(namespaceKey);
    if (existing) return existing;

    const created: PendingNamespaceCommit = {
      scope,
      cancelFlush: null,
      inFlightBarrierKeys: null,
      flushPromise: null,
      hasStaticPolicyUpdate: false,
      removes: new Set(),
      staticPolicy: null,
      touches: new Map(),
      upserts: new Map(),
      waiters: [],
    };
    this.#pendingNamespaceCommits.set(namespaceKey, created);
    return created;
  }

  #schedulePendingNamespaceFlush(pending: PendingNamespaceCommit): void {
    if (pending.cancelFlush !== null || pending.flushPromise !== null) return;

    const timeoutId = setTimeout(() => {
      pending.cancelFlush = null;
      void this.flushPendingNamespaceCommit(pending.scope);
    }, ASYNC_STORAGE_COMMIT_DEBOUNCE_MS);

    pending.cancelFlush = () => clearTimeout(timeoutId);
  }

  #pruneRecentTouchedBuckets(currentBucket: string): void {
    for (const [key, bucket] of this.#recentTouchedBuckets) {
      if (bucket !== currentBucket) {
        this.#recentTouchedBuckets.delete(key);
      }
    }
  }

  #scheduleStartupCleanupIfNeeded(): void {
    if (this.#startupCleanupScheduled) return;
    this.#startupCleanupScheduled = true;

    scheduleIdleCleanup(() => {
      void this.#runStartupCleanupIfDue().catch(() => {
        // Ignore startup cleanup failures; regular reads and writes still work.
      });
    });
  }

  async #runStartupCleanupIfDue(): Promise<void> {
    if (document.hidden) {
      await sleep(2_000);
    }
    await runWithNavigatorLock(
      ASYNC_STARTUP_CLEANUP_LOCK_NAME,
      ASYNC_STARTUP_CLEANUP_LOCK_WARNING,
      async () => {
        const maintenance = this.#readMaintenanceState();
        const now = Date.now();
        if (
          maintenance.lastSuccessfulCleanupAt !== null &&
          now - maintenance.lastSuccessfulCleanupAt <
            ASYNC_STORAGE_STARTUP_CLEANUP_COOLDOWN_MS
        ) {
          return;
        }

        await this.#performStartupCleanup();
        this.#writeMaintenanceState({ lastSuccessfulCleanupAt: Date.now() });
      },
    );
  }

  async #performStartupCleanup(): Promise<void> {
    await this.flushAllPendingNamespaceCommits();
    const scopesToInvalidate = await this.#withCleanupDriver(async (driver) => {
      const discoveredScopes = await this.#listDiscoveredCleanupScopes(driver);
      const discoveredScopesBySession = new Map<
        string,
        AsyncStorageDiscoveredScope[]
      >();

      for (const discoveredScope of discoveredScopes) {
        const existing = discoveredScopesBySession.get(
          discoveredScope.scope.sessionKey,
        );
        if (existing !== undefined) {
          existing.push(discoveredScope);
        } else {
          discoveredScopesBySession.set(discoveredScope.scope.sessionKey, [
            discoveredScope,
          ]);
        }
      }

      const invalidatedScopesBySession = await Promise.all(
        [...discoveredScopesBySession.entries()].map(
          async ([sessionKey, sessionDiscoveredScopes]) =>
            this.#runWithSessionWriterLock(sessionKey, async () => {
              await this.#flushPendingNamespaceCommitsForSessionUnlocked(
                sessionKey,
              );
              return this.#performStartupCleanupWithDriver(driver, {
                discoveredScopes: sessionDiscoveredScopes,
                sessionKey,
              });
            }),
        ),
      );

      return invalidatedScopesBySession.flat();
    });
    for (const scope of scopesToInvalidate) {
      this.#invalidateCachedNamespace(scope);
      this.#broadcastNamespaceInvalidation(scope, 'startup-cleanup');
    }
  }

  async #performStartupCleanupWithDriver(
    driver: AsyncStorageDriver,
    args: {
      discoveredScopes?: AsyncStorageDiscoveredScope[];
      sessionKey?: string;
    } = {},
  ): Promise<AsyncStorageNamespaceScope[]> {
    // WORKAROUND: Startup cleanup only runs through the cleanup-capable driver path, but this shared helper keeps the broader AsyncStorageDriver parameter.
    const cleanupActionDriver = __LEGIT_CAST__<
      AsyncStorageStartupCleanupActionCapableDriver,
      AsyncStorageDriver
    >(driver);
    const discoveredScopes =
      args.discoveredScopes ??
      (await this.#listDiscoveredCleanupScopes(driver, args.sessionKey));
    const now = Date.now();
    const uniqueSessionKeys = [
      ...new Set(discoveredScopes.map(({ scope }) => scope.sessionKey)),
    ];
    const offlineSessions = new Set(
      uniqueSessionKeys.filter((sessionKey) =>
        isSessionOfflineInLocalStorage(sessionKey),
      ),
    );
    const protectedRefsBySession = new Map(
      uniqueSessionKeys.map(
        (sessionKey) =>
          [sessionKey, getSessionProtectedKeysSnapshot(sessionKey)] as const,
      ),
    );
    const customStartupCallbacks: Map<
      string,
      AsyncStartupStoreCleanupCallback
    > =
      registeredAsyncStartupStoreCleanupCallbacks.get(this) ??
      new Map<string, AsyncStartupStoreCleanupCallback>();
    const discoveredScopesByStore = new Map<
      string,
      AsyncStorageDiscoveredScope[]
    >();
    for (const discoveredScope of discoveredScopes) {
      const storeKey = getStoreRegistryKey(
        discoveredScope.scope.sessionKey,
        discoveredScope.scope.storeName,
      );
      const existing = discoveredScopesByStore.get(storeKey);
      if (existing !== undefined) {
        existing.push(discoveredScope);
      } else {
        discoveredScopesByStore.set(storeKey, [discoveredScope]);
      }
    }

    const callbackEntries: Array<{
      callback: AsyncStartupStoreCleanupCallback;
      scopes: AsyncStorageDiscoveredScope[];
      storeKey: string;
    }> = [];
    for (const [storeKey, storeDiscoveredScopes] of discoveredScopesByStore) {
      const callback = customStartupCallbacks.get(storeKey);
      if (callback === undefined) continue;
      callbackEntries.push({
        callback,
        scopes: storeDiscoveredScopes,
        storeKey,
      });
    }
    const [callbackResults, genericScopePlans] = await Promise.all([
      Promise.all(
        callbackEntries.map(({ callback, scopes }) =>
          callback({ discoveredScopes: scopes, driver, now }),
        ),
      ),
      Promise.all(
        discoveredScopes.map(async ({ knownRecordKeys, scope }) =>
          this.#planStartupCleanupForScope({
            driver,
            knownRecordKeys,
            now,
            protectedRefs:
              protectedRefsBySession.get(scope.sessionKey) ?? undefined,
            skipExpiration: offlineSessions.has(scope.sessionKey),
            scope,
          }),
        ),
      ),
    ]);

    const scopePlansByNamespaceId = new Map(
      genericScopePlans.map((plan) => [getNamespaceId(plan.scope), plan]),
    );
    const customStoreDeletePlans: AsyncStartupCleanupStoreDeletePlan[] = [];

    for (const result of callbackResults) {
      for (const scopePlan of result.scopePlans) {
        const namespaceId = getNamespaceId(scopePlan.scope);
        const existing = scopePlansByNamespaceId.get(namespaceId);
        scopePlansByNamespaceId.set(
          namespaceId,
          this.#mergeStartupCleanupScopePlan(
            existing ?? {
              deleteAction: null,
              persistEntries: null,
              scope: scopePlan.scope,
            },
            {
              deleteAction:
                scopePlan.deleteKeys.length === 0
                  ? null
                  : this.#createStartupCleanupDeleteAction({
                      keys: scopePlan.deleteKeys,
                      scope: scopePlan.scope,
                    }),
              persistEntries: scopePlan.persistEntries ?? null,
              persistStaticPolicy: scopePlan.persistStaticPolicy,
              scope: scopePlan.scope,
            },
          ),
        );
      }

      for (const storeDeletePlan of result.storeDeletePlans ?? []) {
        customStoreDeletePlans.push(storeDeletePlan);
      }
    }

    const scopePlans = [...scopePlansByNamespaceId.values()];
    const genericStoreDeletePlans =
      cleanupActionDriver.cleanupRemoveKnownStoreDir === undefined
        ? []
        : this.#planStartupCleanupStoreDeletes({
            customStoreDeletePlanStoreKeys: new Set(
              customStoreDeletePlans.map((storeDeletePlan) =>
                getStoreRegistryKey(
                  storeDeletePlan.representativeScope.sessionKey,
                  storeDeletePlan.representativeScope.storeName,
                ),
              ),
            ),
            discoveredScopesByStore,
            scopePlansByNamespaceId,
          });
    const storeDeletePlans = [
      ...customStoreDeletePlans,
      ...genericStoreDeletePlans,
    ];
    const persistPlans: Array<{
      entries: Map<string, InternalManagedMetadataRecord> | null;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null | undefined;
      scope: AsyncStorageNamespaceScope;
    }> = [];
    const invalidatedScopesByNamespaceId = new Map<
      string,
      AsyncStorageNamespaceScope
    >();
    const successfulStoreDeleteSessions = new Set<string>();
    const successfulStoreDeleteScopes = new Set<string>();
    const skippedScopeIds = new Set(
      genericStoreDeletePlans.flatMap((storeDeletePlan) =>
        storeDeletePlan.removedKeysByScope.map(({ scope }) =>
          getNamespaceId(scope),
        ),
      ),
    );

    if (cleanupActionDriver.cleanupRemoveKnownStoreDir !== undefined) {
      const removeStoreDir = cleanupActionDriver.cleanupRemoveKnownStoreDir;
      const storeDeleteResults = await Promise.all(
        storeDeletePlans.map(async (storeDeletePlan) => {
          const deleteKeys = [
            ...new Set(
              storeDeletePlan.removedKeysByScope.flatMap(({ keys }) => keys),
            ),
          ];
          const removed = await removeStoreDir(
            storeDeletePlan.representativeScope,
            deleteKeys,
          );
          return { removed, storeDeletePlan };
        }),
      );

      for (const { removed, storeDeletePlan } of storeDeleteResults) {
        if (!removed) continue;

        for (const { keys, scope } of storeDeletePlan.removedKeysByScope) {
          cleanupActionDriver.cleanupFinalizeRemovedRecords?.(scope, keys);
        }
        cleanupActionDriver.cleanupFinalizeRemovedStoreDir?.(
          storeDeletePlan.representativeScope,
          [],
        );

        successfulStoreDeleteSessions.add(
          storeDeletePlan.representativeScope.sessionKey,
        );
        for (const { scope } of storeDeletePlan.removedKeysByScope) {
          const namespaceId = getNamespaceId(scope);
          invalidatedScopesByNamespaceId.set(namespaceId, scope);
          successfulStoreDeleteScopes.add(namespaceId);
          skippedScopeIds.add(namespaceId);
        }
      }
    }

    const deleteResults = await Promise.allSettled(
      scopePlans.flatMap((plan) => {
        if (skippedScopeIds.has(getNamespaceId(plan.scope))) {
          return [];
        }

        return plan.deleteAction === null
          ? []
          : [
              this.#runStartupCleanupDeleteAction(
                cleanupActionDriver,
                plan.deleteAction,
              ),
            ];
      }),
    );

    for (const settledResult of deleteResults) {
      if (settledResult.status !== 'fulfilled') continue;

      const result = settledResult.value;
      switch (result.kind) {
        case 'removeRecords': {
          if (result.removedKeys.length > 0) {
            cleanupActionDriver.cleanupFinalizeRemovedRecords?.(
              result.action.scope,
              result.removedKeys,
            );
            invalidatedScopesByNamespaceId.set(
              getNamespaceId(result.action.scope),
              result.action.scope,
            );
          }
          if (!result.allSucceeded) continue;

          const scopePlan = scopePlansByNamespaceId.get(
            getNamespaceId(result.action.scope),
          );
          if (scopePlan !== undefined && scopePlan.persistEntries !== null) {
            persistPlans.push({
              entries: scopePlan.persistEntries,
              staticPolicy: scopePlan.persistStaticPolicy,
              scope: scopePlan.scope,
            });
          }
          continue;
        }
        case 'removeStoreDir': {
          if (!result.removed) continue;
          cleanupActionDriver.cleanupFinalizeRemovedStoreDir?.(
            result.action.scope,
            result.action.keys,
          );
          successfulStoreDeleteSessions.add(result.action.scope.sessionKey);
          successfulStoreDeleteScopes.add(getNamespaceId(result.action.scope));
          continue;
        }
      }
    }

    for (const scopePlan of scopePlans) {
      if (
        skippedScopeIds.has(getNamespaceId(scopePlan.scope)) ||
        scopePlan.deleteAction !== null ||
        scopePlan.persistEntries === null
      ) {
        continue;
      }

      persistPlans.push({
        entries: scopePlan.persistEntries,
        staticPolicy: scopePlan.persistStaticPolicy,
        scope: scopePlan.scope,
      });
    }

    const sessionDeletePlans = [...successfulStoreDeleteSessions].flatMap(
      (sessionKey) =>
        this.#shouldPlanStartupCleanupSessionDelete(
          cleanupActionDriver,
          scopePlans,
          successfulStoreDeleteScopes,
          sessionKey,
        )
          ? [
              { kind: 'removeSessionDir', sessionKey } satisfies Extract<
                StartupCleanupDeleteAction,
                { kind: 'removeSessionDir' }
              >,
            ]
          : [],
    );

    const sessionDeletePromise = Promise.allSettled(
      sessionDeletePlans.map((action) =>
        this.#runStartupCleanupDeleteAction(cleanupActionDriver, action),
      ),
    );

    const persistPromise = Promise.all(
      persistPlans.map(async ({ entries, scope, staticPolicy }) => {
        if (entries !== null) {
          await this.#persistNamespaceIndexUsingDriver(driver, scope, {
            entries,
            staticPolicy:
              staticPolicy !== undefined
                ? staticPolicy
                : await this.#readNamespaceIndexStaticPolicyUsingDriver(
                    driver,
                    scope,
                  ),
          });
        }
      }),
    );

    const [sessionDeleteResults] = await Promise.all([
      sessionDeletePromise,
      persistPromise,
    ]);

    for (const { scope } of persistPlans) {
      invalidatedScopesByNamespaceId.set(getNamespaceId(scope), scope);
    }

    for (const settledResult of sessionDeleteResults) {
      if (settledResult.status !== 'fulfilled') continue;
      const result = settledResult.value;
      if (result.kind !== 'removeSessionDir' || !result.removed) continue;
      cleanupActionDriver.cleanupFinalizeRemovedSessionDir?.(
        result.action.sessionKey,
      );
    }

    return [...invalidatedScopesByNamespaceId.values()];
  }

  #intersectPersistEntries(
    left: Map<string, InternalManagedMetadataRecord> | null,
    right: Map<string, InternalManagedMetadataRecord> | null,
  ): Map<string, InternalManagedMetadataRecord> | null {
    if (left === null) return right;
    if (right === null) return left;

    const merged = new Map<string, InternalManagedMetadataRecord>();
    for (const [key, metadata] of left.entries()) {
      if (right.has(key)) {
        merged.set(key, metadata);
      }
    }

    return merged.size > 0 ? merged : null;
  }

  #mergeStartupCleanupScopePlan(
    left: StartupCleanupScopePlan,
    right: StartupCleanupScopePlan,
  ): StartupCleanupScopePlan {
    const mergedPersistEntries = this.#intersectPersistEntries(
      left.persistEntries,
      right.persistEntries,
    );
    const getDeleteKeys = (action: StartupCleanupDeleteAction | null) =>
      action !== null && action.kind !== 'removeSessionDir' ? action.keys : [];
    const mergedDeleteKeys = [
      ...new Set([
        ...getDeleteKeys(left.deleteAction),
        ...getDeleteKeys(right.deleteAction),
      ]),
    ].filter(
      (key) =>
        mergedPersistEntries === null ||
        key !== ASYNC_NAMESPACE_INDEX_RECORD_KEY,
    );

    return {
      deleteAction:
        mergedDeleteKeys.length === 0
          ? null
          : this.#createStartupCleanupDeleteAction({
              keys: mergedDeleteKeys,
              scope: left.scope,
            }),
      persistEntries: mergedPersistEntries,
      persistStaticPolicy:
        right.persistStaticPolicy !== undefined
          ? right.persistStaticPolicy
          : left.persistStaticPolicy,
      scope: left.scope,
    };
  }

  #planStartupCleanupStoreDeletes(args: {
    customStoreDeletePlanStoreKeys: Set<string>;
    discoveredScopesByStore: Map<string, AsyncStorageDiscoveredScope[]>;
    scopePlansByNamespaceId: Map<string, StartupCleanupScopePlan>;
  }): AsyncStartupCleanupStoreDeletePlan[] {
    const storeDeletePlans: AsyncStartupCleanupStoreDeletePlan[] = [];

    for (const [storeKey, discoveredScopes] of args.discoveredScopesByStore) {
      if (args.customStoreDeletePlanStoreKeys.has(storeKey)) continue;

      const removedKeysByScope: Array<{
        keys: string[];
        scope: AsyncStorageNamespaceScope;
      }> = [];
      const discoveredKnownKeys = new Set<string>();
      let shouldDeleteWholeStore = discoveredScopes.length > 0;

      for (const discoveredScope of discoveredScopes) {
        const knownRecordKeys = discoveredScope.knownRecordKeys;
        const scopePlan = args.scopePlansByNamespaceId.get(
          getNamespaceId(discoveredScope.scope),
        );
        if (
          knownRecordKeys === null ||
          scopePlan === undefined ||
          scopePlan.persistEntries !== null ||
          scopePlan.deleteAction === null
        ) {
          shouldDeleteWholeStore = false;
          break;
        }

        const plannedDeleteKeys = new Set(
          scopePlan.deleteAction.kind !== 'removeSessionDir'
            ? scopePlan.deleteAction.keys
            : [],
        );
        if (
          !knownRecordKeys.every((knownKey) => plannedDeleteKeys.has(knownKey))
        ) {
          shouldDeleteWholeStore = false;
          break;
        }

        for (const knownKey of knownRecordKeys) {
          discoveredKnownKeys.add(knownKey);
        }
        removedKeysByScope.push({
          keys: [...plannedDeleteKeys],
          scope: discoveredScope.scope,
        });
      }

      if (!shouldDeleteWholeStore) continue;

      const plannedDeleteKeys = new Set(
        removedKeysByScope.flatMap(({ keys }) => keys),
      );
      if (
        plannedDeleteKeys.size !== discoveredKnownKeys.size ||
        [...discoveredKnownKeys].some(
          (knownKey) => !plannedDeleteKeys.has(knownKey),
        )
      ) {
        continue;
      }
      const representativeScope = discoveredScopes[0]?.scope;
      if (representativeScope === undefined) continue;

      storeDeletePlans.push({ removedKeysByScope, representativeScope });
    }

    return storeDeletePlans;
  }

  async #planStartupCleanupForScope(args: {
    driver: AsyncStorageDriver;
    knownRecordKeys: string[] | null;
    now: number;
    protectedRefs: Set<string> | undefined;
    skipExpiration: boolean;
    scope: AsyncStorageNamespaceScope;
  }): Promise<StartupCleanupScopePlan> {
    const rawKeys =
      args.knownRecordKeys ?? (await args.driver.listKeys(args.scope));
    const indexState = await readAsyncStorageNamespaceIndexStateUsingDriver(
      args.driver,
      args.scope,
      rawKeys,
    );
    const payloadKeys = new Set<string>();
    const rawKeysToRemove: string[] = [];

    for (const key of rawKeys) {
      if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
        payloadKeys.add(key.slice(PAYLOAD_RECORD_PREFIX.length));
      } else if (key !== ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
        rawKeysToRemove.push(key);
      }
    }

    if (!indexState.valid || indexState.entries === null) {
      const keysToRemove = rawKeys.filter(
        (key) => key !== ASYNC_NAMESPACE_INDEX_RECORD_KEY || indexState.exists,
      );
      return {
        deleteAction:
          keysToRemove.length === 0
            ? null
            : this.#createStartupCleanupDeleteAction({
                keys: keysToRemove,
                scope: args.scope,
              }),
        persistEntries: null,
        persistStaticPolicy: null,
        scope: args.scope,
      };
    }

    const nextEntries = new Map<string, InternalManagedMetadataRecord>();
    const currentPersistedStaticPolicy = normalizeStaticPolicy(
      indexState.staticPolicy,
    );
    const nextPersistedStaticPolicy = normalizePersistedStaticPolicyForScope(
      args.scope,
      currentPersistedStaticPolicy,
    );
    const effectiveStaticPolicy = getEffectiveStaticPolicyForScope(
      args.scope,
      nextPersistedStaticPolicy,
    );
    const payloadRecordKeysToRemove = new Set<string>(rawKeysToRemove);
    const candidateEntries: Array<{
      itemKey: string;
      lastAccessAt: number;
      protected: boolean;
      sizeBytes: number;
    }> = [];

    for (const [key, metadata] of indexState.entries.entries()) {
      const isProtected =
        isOfflineProtectedMetadata(metadata.customMetadata) ||
        args.protectedRefs?.has(
          serializeProtectedRef({ ...args.scope, key }),
        ) === true;
      if (!payloadKeys.has(key)) continue;
      if (
        !isProtected &&
        !args.skipExpiration &&
        args.now - metadata.lastAccessAt > ASYNC_STORAGE_MAX_AGE_MS
      ) {
        payloadRecordKeysToRemove.add(getPayloadRecordKey(key));
        continue;
      }

      nextEntries.set(key, metadata);
      candidateEntries.push({
        itemKey: key,
        lastAccessAt: metadata.lastAccessAt,
        protected: isProtected,
        sizeBytes: metadata.sizeBytes ?? 0,
      });
    }

    for (const payloadKey of payloadKeys) {
      if (!indexState.entries.has(payloadKey)) {
        payloadRecordKeysToRemove.add(getPayloadRecordKey(payloadKey));
      }
    }

    if (effectiveStaticPolicy?.maxBytes !== undefined) {
      const pinnedKeys = new Set(effectiveStaticPolicy.pinnedKeys ?? []);
      const keptKeys = keepEntriesWithinByteBudget({
        entries: candidateEntries,
        getKey: (entry) => entry.itemKey,
        getLastAccessAt: (entry) => entry.lastAccessAt,
        getSizeBytes: (entry) => entry.sizeBytes,
        isPinned: (entry) => pinnedKeys.has(entry.itemKey),
        isProtected: (entry) => entry.protected,
        maxBytes: effectiveStaticPolicy.maxBytes,
      });

      for (const { itemKey } of candidateEntries) {
        if (keptKeys.has(itemKey)) continue;
        payloadRecordKeysToRemove.add(getPayloadRecordKey(itemKey));
        nextEntries.delete(itemKey);
      }
    }

    const indexChanged =
      nextEntries.size !== indexState.entries.size ||
      rawKeysToRemove.length > 0 ||
      !deepEqual(currentPersistedStaticPolicy, nextPersistedStaticPolicy);

    const deleteKeys = [...payloadRecordKeysToRemove];
    if (indexChanged && nextEntries.size === 0) {
      deleteKeys.push(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    }

    return {
      deleteAction:
        deleteKeys.length === 0
          ? null
          : this.#createStartupCleanupDeleteAction({
              keys: deleteKeys,
              scope: args.scope,
            }),
      persistEntries: indexChanged && nextEntries.size > 0 ? nextEntries : null,
      persistStaticPolicy:
        indexChanged && nextEntries.size > 0
          ? nextPersistedStaticPolicy
          : undefined,
      scope: args.scope,
    };
  }

  #createStartupCleanupDeleteAction(args: {
    keys: string[];
    scope: AsyncStorageNamespaceScope;
  }): StartupCleanupDeleteAction {
    const uniqueKeys = [...new Set(args.keys)];
    return { kind: 'removeRecords', keys: uniqueKeys, scope: args.scope };
  }

  async #runStartupCleanupDeleteAction(
    cleanupActionDriver: AsyncStorageStartupCleanupActionCapableDriver,
    action: StartupCleanupDeleteAction,
  ): Promise<StartupCleanupDeleteActionResult> {
    switch (action.kind) {
      case 'removeRecords': {
        const removedKeys =
          cleanupActionDriver.cleanupRemoveKnownRecords !== undefined
            ? await cleanupActionDriver.cleanupRemoveKnownRecords(
                action.scope,
                action.keys,
              )
            : await this.#driverRemoveManyFrom(
                cleanupActionDriver,
                action.scope,
                action.keys,
              ).then(() => action.keys);

        return {
          action,
          allSucceeded: removedKeys.length === action.keys.length,
          kind: 'removeRecords',
          removedKeys,
        };
      }
      case 'removeStoreDir': {
        return {
          action,
          kind: 'removeStoreDir',
          removed:
            cleanupActionDriver.cleanupRemoveKnownStoreDir === undefined
              ? false
              : await cleanupActionDriver.cleanupRemoveKnownStoreDir(
                  action.scope,
                  action.keys,
                ),
        };
      }
      case 'removeSessionDir': {
        return {
          action,
          kind: 'removeSessionDir',
          removed:
            cleanupActionDriver.cleanupRemoveKnownSessionDir === undefined
              ? false
              : await cleanupActionDriver.cleanupRemoveKnownSessionDir(
                  action.sessionKey,
                ),
        };
      }
    }
  }

  #shouldPlanStartupCleanupSessionDelete(
    cleanupActionDriver: AsyncStorageStartupCleanupActionCapableDriver,
    scopePlans: StartupCleanupScopePlan[],
    successfulStoreDeleteScopes: Set<string>,
    sessionKey: string,
  ): boolean {
    if (cleanupActionDriver.cleanupRemoveKnownSessionDir === undefined) {
      return false;
    }

    const sessionScopePlans = scopePlans.filter(
      (plan) => plan.scope.sessionKey === sessionKey,
    );
    return (
      sessionScopePlans.length > 0 &&
      sessionScopePlans.every((plan) =>
        successfulStoreDeleteScopes.has(getNamespaceId(plan.scope)),
      )
    );
  }

  async #listDiscoveredCleanupScopes(
    driver: AsyncStorageDriver,
    sessionKey?: string,
  ): Promise<AsyncStorageDiscoveredScope[]> {
    const discoveredScopes =
      await driver.listScopesWithKnownRecordKeys(sessionKey);
    return discoveredScopes.filter(
      ({ scope }) => scope.kind !== '__internal.protected',
    );
  }

  async #withCleanupDriver<T>(
    callback: (driver: AsyncStorageDriver) => Promise<T>,
  ): Promise<T> {
    // WORKAROUND: Capability probing happens on the optional cleanup method below, but TypeScript cannot access that method through the base driver interface.
    const maybeCleanupCapableDriver = __LEGIT_CAST__<
      AsyncStorageCleanupCapableDriver,
      AsyncStorageDriver
    >(this.driver);
    if (
      typeof maybeCleanupCapableDriver.withIsolatedCleanupDriver === 'function'
    ) {
      return maybeCleanupCapableDriver.withIsolatedCleanupDriver(callback);
    }

    return callback(this.driver);
  }
}

export function createAsyncStorageAdapter(
  driver: AsyncStorageDriver,
): AsyncStorageAdapter {
  return new ManagedAsyncStorageAdapter(driver);
}
export function serializeProtectedRef(
  ref: AsyncStorageProtectedEntryRef,
): string {
  return serializeProtectedRefInternal(ref);
}
