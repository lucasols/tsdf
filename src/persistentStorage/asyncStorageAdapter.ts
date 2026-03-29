import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { sleep } from '@ls-stack/utils/sleep';
import { runWithNavigatorLock } from './navigatorLocks';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getNamespaceId,
  getPayloadRecordKey,
  METADATA_RECORD_PREFIX,
  PAYLOAD_RECORD_PREFIX,
} from './opfsFileNaming';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { createEvictionComparator } from './persistenceUtils';
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
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  AsyncStorageProtectedEntryRef,
  AsyncStorageReadOptions,
} from './types';
import { parseAsyncStorageNamespaceKind } from './types';

export const ASYNC_STORAGE_COMMIT_DEBOUNCE_MS = 40;
export const ASYNC_STORAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const ASYNC_STORAGE_STARTUP_CLEANUP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const ASYNC_STORAGE_RECENCY_BUCKET_MS = 6 * 60 * 60 * 1000;
export const ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY = 'tsdf._am.g';
const ASYNC_STARTUP_CLEANUP_LOCK_NAME = 'tsdf-async-storage-maintenance';
const ASYNC_STARTUP_CLEANUP_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; async OPFS startup cleanup is using unlocked coordination.';

function getBucketId(timestamp: number): string {
  return String(Math.floor(timestamp / ASYNC_STORAGE_RECENCY_BUCKET_MS));
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
}

export function isOfflineProtectedMetadata(
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

function parseProtectedRef(
  value: string,
): AsyncStorageProtectedEntryRef | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed.some((entry) => typeof entry !== 'string')
  ) {
    return null;
  }

  const [sessionKey, storeName, rawKind, key] = __LEGIT_CAST__<
    [string, string, string, string],
    unknown
  >(parsed);
  const kind = parseAsyncStorageNamespaceKind(rawKind);
  if (kind === null) return null;

  return { sessionKey, storeName, kind, key };
}

const ASYNC_METADATA_LAST_ACCESS_AT_KEY = 'a';
const ASYNC_METADATA_VERSION_KEY = 'v';

function getInlineCustomMetadata(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const customMetadataEntries = Object.entries(record).filter(
    ([key]) =>
      key !== ASYNC_METADATA_LAST_ACCESS_AT_KEY &&
      key !== ASYNC_METADATA_VERSION_KEY,
  );
  if (customMetadataEntries.length === 0) return undefined;

  return Object.fromEntries(customMetadataEntries);
}

type InternalManagedMetadataRecord = {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  version: number;
};

function parseInternalManagedMetadataRecord(
  value: unknown,
): InternalManagedMetadataRecord | null {
  const record = getRecord(value);
  if (
    record === null ||
    typeof record.a !== 'number' ||
    ('v' in record && record.v !== undefined && typeof record.v !== 'number')
  ) {
    return null;
  }

  const customMetadata = getInlineCustomMetadata(record);

  return {
    lastAccessAt: record.a,
    version: typeof record.v === 'number' ? record.v : 1,
    ...(customMetadata ? { customMetadata } : {}),
  };
}

function serializeInternalManagedMetadataRecord(
  metadata: InternalManagedMetadataRecord,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    [ASYNC_METADATA_LAST_ACCESS_AT_KEY]: metadata.lastAccessAt,
    ...(metadata.version !== 1
      ? { [ASYNC_METADATA_VERSION_KEY]: metadata.version }
      : {}),
  };

  const customMetadata = metadata.customMetadata;
  if (customMetadata === undefined) return serialized;

  if (
    ASYNC_METADATA_LAST_ACCESS_AT_KEY in customMetadata ||
    ASYNC_METADATA_VERSION_KEY in customMetadata
  ) {
    throw new Error(
      '[TSDF] Async storage custom metadata cannot use reserved keys "a" or "v".',
    );
  }

  return { ...serialized, ...customMetadata };
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

function normalizeStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): AsyncStorageNamespaceStaticPolicy | null {
  if (policy === undefined || policy === null) return null;

  const maxEntries =
    typeof policy.maxEntries === 'number' &&
    Number.isInteger(policy.maxEntries) &&
    policy.maxEntries >= 0
      ? policy.maxEntries
      : undefined;
  const pinnedKeys = Array.isArray(policy.pinnedKeys)
    ? [...new Set(policy.pinnedKeys)].sort((left, right) =>
        left.localeCompare(right),
      )
    : [];

  if (maxEntries === undefined && pinnedKeys.length === 0) {
    return null;
  }

  return {
    ...(maxEntries !== undefined ? { maxEntries } : {}),
    ...(pinnedKeys.length > 0 ? { pinnedKeys } : {}),
  };
}

/**
 * Builds a persisted static policy from config values, omitting fields that
 * match the provided default. Returns null when no overrides are needed.
 */
export function buildPersistedStaticPolicy(
  maxEntries: number | undefined,
  defaultMaxEntries: number,
  pinnedKeys: ReadonlySet<string>,
): AsyncStorageNamespaceStaticPolicy | null {
  return normalizeStaticPolicy({
    ...(maxEntries !== undefined && maxEntries !== defaultMaxEntries
      ? { maxEntries }
      : {}),
    ...(pinnedKeys.size > 0 ? { pinnedKeys: [...pinnedKeys] } : {}),
  });
}

function parseStaticPolicy(
  value: unknown,
): AsyncStorageNamespaceStaticPolicy | null {
  const record = getRecord(value);
  if (record === null) return null;

  if (
    ('m' in record &&
      record.m !== undefined &&
      (typeof record.m !== 'number' ||
        !Number.isInteger(record.m) ||
        record.m < 0)) ||
    ('k' in record &&
      record.k !== undefined &&
      (!Array.isArray(record.k) ||
        record.k.some((entry) => typeof entry !== 'string')))
  ) {
    return null;
  }

  return normalizeStaticPolicy({
    ...(typeof record.m === 'number' ? { maxEntries: record.m } : {}),
    ...(Array.isArray(record.k)
      ? { pinnedKeys: __LEGIT_CAST__<string[], unknown>(record.k) }
      : {}),
  });
}

function serializeStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null,
): Record<string, unknown> | undefined {
  if (policy === null) return undefined;

  return {
    ...(policy.maxEntries !== undefined ? { m: policy.maxEntries } : {}),
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
      return { maxEntries: 50 };
    case 'listQuery.item':
      return { maxEntries: 500 };
    case 'listQuery.query':
      return { maxEntries: 100 };
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
    maxEntries:
      persistedStaticPolicy.maxEntries !== undefined &&
      persistedStaticPolicy.maxEntries !== defaultPolicy?.maxEntries
        ? persistedStaticPolicy.maxEntries
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
    maxEntries:
      normalizedPersistedPolicy?.maxEntries ?? defaultPolicy.maxEntries,
    pinnedKeys: normalizedPersistedPolicy?.pinnedKeys,
  });
}

export async function driverGetManyFrom(
  driver: AsyncStorageDriver,
  scope: AsyncStorageNamespaceScope,
  keys: string[],
): Promise<unknown[]> {
  if (keys.length === 0) return [];
  return driver.getMany(scope, keys);
}

export type AsyncStorageManagedMetadataRecord = InternalManagedMetadataRecord;

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

function compareMetadata(
  left: AsyncStorageEntryMetadata<Record<string, unknown>>,
  right: AsyncStorageEntryMetadata<Record<string, unknown>>,
  order: AsyncStorageMetadataOrder,
): number {
  if (order === 'key') {
    return left.key.localeCompare(right.key);
  }

  if (left.lastAccessAt !== right.lastAccessAt) {
    return order === 'lru-asc'
      ? left.lastAccessAt - right.lastAccessAt
      : right.lastAccessAt - left.lastAccessAt;
  }

  return left.key.localeCompare(right.key);
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
    await this.adapter.flushPendingNamespaceCommit(this.scope);
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

    await this.adapter.flushPendingNamespaceCommit(this.scope);
    const uniqueKeys = [...new Set(keys)];
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

export type AsyncStartupStoreCleanupCallback = (args: {
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

  #observedScopes = new Map<string, AsyncStorageNamespaceScope>();
  #pendingNamespaceCommits = new Map<string, PendingNamespaceCommit>();
  #recentTouchedBuckets = new Map<string, string>();
  #startupCleanupScheduled = false;

  constructor(private readonly driver: AsyncStorageDriver) {}

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
    await this.flushAllPendingNamespaceCommits();
    const scopesToClear = await this.#listDiscoveredScopes(sessionKey);

    await Promise.all(
      scopesToClear.map((scope) => this.clearManagedNamespace(scope)),
    );
  }

  async readProtectedStorageKeys(
    sessionKey: string,
    driver: AsyncStorageDriver = this.driver,
  ): Promise<Set<string>> {
    const protectedKeysSnapshot = getSessionProtectedKeysSnapshot(sessionKey);
    if (protectedKeysSnapshot !== null && protectedKeysSnapshot.size > 0) {
      return new Set(protectedKeysSnapshot);
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
    await this.flushAllPendingNamespaceCommits();

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

    await Promise.all(
      [...updatesByScope.values()].map(async ({ scope, protectionByKey }) => {
        const indexEntries = await this.#readNamespaceIndexEntriesUsingDriver(
          this.driver,
          scope,
        );
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
            staticPolicy: await this.#readNamespaceIndexStaticPolicyUsingDriver(
              this.driver,
              scope,
            ),
          });
        }
      }),
    );
  }

  resetForTests(): void {
    for (const pending of this.#pendingNamespaceCommits.values()) {
      pending.cancelFlush?.();
    }
    this.#observedScopes.clear();
    this.#pendingNamespaceCommits.clear();
    this.#recentTouchedBuckets.clear();
    this.#startupCleanupScheduled = false;
    this.driver.__resetForTests?.();
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
  ): Promise<void> {
    const namespaceKey = getNamespaceId(scope);
    const pending = this.#pendingNamespaceCommits.get(namespaceKey);
    if (!pending) return;
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
    const waiters = [...pending.waiters];
    pending.hasStaticPolicyUpdate = false;
    pending.upserts = new Map();
    pending.removes = new Set();
    pending.staticPolicy = null;
    pending.touches = new Map();
    pending.waiters = [];

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
    const state = await readAsyncStorageNamespaceIndexStateUsingDriver(
      driver,
      scope,
      knownRecordKeys,
    );
    return state.valid && state.entries !== null ? state.entries : new Map();
  }

  async #readNamespaceIndexStaticPolicyUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys?: string[] | null,
  ): Promise<AsyncStorageNamespaceStaticPolicy | null> {
    const state = await readAsyncStorageNamespaceIndexStateUsingDriver(
      driver,
      scope,
      knownRecordKeys,
    );
    return state.valid ? normalizeStaticPolicy(state.staticPolicy) : null;
  }

  async #persistNamespaceIndexUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    state: InternalManagedIndexState,
  ): Promise<void> {
    if (state.entries.size === 0) {
      await this.#driverRemoveManyFrom(driver, scope, [
        ASYNC_NAMESPACE_INDEX_RECORD_KEY,
      ]);
      return;
    }

    await this.#driverSetManyFrom(driver, scope, [
      {
        key: ASYNC_NAMESPACE_INDEX_RECORD_KEY,
        value: serializeIndexState(state),
      },
    ]);
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
    const metadataByKey = await this.#readNamespaceIndexEntriesUsingDriver(
      this.driver,
      scope,
    );
    const payloadKeys = keys.filter((key) => metadataByKey.has(key));
    const payloadValues = await driverGetManyFrom(
      this.driver,
      scope,
      payloadKeys.map((key) => getPayloadRecordKey(key)),
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
        value: __LEGIT_CAST__<TValue, unknown>(rawPayload),
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
    args: { order?: AsyncStorageMetadataOrder } = {},
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    return this.#listManagedMetadataUsingDriver(this.driver, scope, args);
  }

  async #listManagedMetadataUsingDriver<
    TCustomMetadata extends Record<string, unknown>,
  >(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    args: {
      knownRecordKeys?: string[] | null;
      order?: AsyncStorageMetadataOrder;
    } = {},
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
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

    validEntries.sort((left, right) =>
      compareMetadata(left, right, args.order ?? 'key'),
    );

    return __LEGIT_CAST__<
      AsyncStorageEntryMetadata<TCustomMetadata>[],
      AsyncStorageEntryMetadata<Record<string, unknown>>[]
    >(validEntries);
  }

  async listManagedKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
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
    await this.driver.clear(scope);
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
      version: metadata.version,
      customMetadata: metadata.customMetadata ?? {},
    };
  }

  async #applyManagedCommit(
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
  ): Promise<void> {
    const currentIndexState =
      await readAsyncStorageNamespaceIndexStateUsingDriver(this.driver, scope);
    const indexEntries =
      currentIndexState.valid && currentIndexState.entries !== null
        ? currentIndexState.entries
        : new Map<string, InternalManagedMetadataRecord>();
    const upserts = args.upserts ?? [];
    const removes = [...new Set(args.removes ?? [])];
    const touches = args.touches ?? [];
    const touchedKeys = [...new Set(touches.map((touch) => touch.key))];

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
      const customMetadata = this.#mergeOfflineProtectionMetadata(
        scope,
        upsert.key,
        upsert.metadata,
        existingMetadata?.customMetadata,
        protectedKeysSnapshotSet,
      );
      const nextLastAccessAt =
        touchesByKey.get(upsert.key) ?? existingMetadata?.lastAccessAt ?? now;
      const nextMetadata: InternalManagedMetadataRecord = {
        lastAccessAt: nextLastAccessAt,
        version: upsert.version,
        ...(customMetadata ? { customMetadata } : {}),
      };

      setEntries.push({
        key: getPayloadRecordKey(upsert.key),
        value: upsert.value,
      });

      if (
        existingMetadata !== undefined &&
        existingMetadata.lastAccessAt === nextMetadata.lastAccessAt &&
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
    if (indexChanged) {
      await this.#persistNamespaceIndexUsingDriver(this.driver, scope, {
        entries: indexEntries,
        staticPolicy: nextStaticPolicy,
      });
    }
  }

  #mergeOfflineProtectionMetadata(
    scope: AsyncStorageNamespaceScope,
    key: string,
    nextCustomMetadata: Record<string, unknown> | undefined,
    currentCustomMetadata: Record<string, unknown> | undefined,
    protectedKeysSnapshotSet: Set<string> | null,
  ): Record<string, unknown> | undefined {
    const merged = {
      ...(currentCustomMetadata ?? {}),
      ...(nextCustomMetadata ?? {}),
    };
    const mergedCustomMetadata =
      Object.keys(merged).length > 0 ? merged : undefined;

    if (protectedKeysSnapshotSet !== null) {
      return setOfflineProtectionMetadata(
        mergedCustomMetadata,
        protectedKeysSnapshotSet.has(
          serializeProtectedRef({ ...scope, key }),
        ) ||
          isOfflineProtectedMetadata(nextCustomMetadata) ||
          isOfflineProtectedMetadata(currentCustomMetadata),
      );
    }

    return setOfflineProtectionMetadata(
      mergedCustomMetadata,
      isOfflineProtectedMetadata(nextCustomMetadata) ||
        isOfflineProtectedMetadata(currentCustomMetadata),
    );
  }

  async #removeManagedKeysUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return;

    await this.#driverRemoveManyFrom(
      driver,
      scope,
      uniqueKeys.map((key) => getPayloadRecordKey(key)),
    );

    const indexState = await readAsyncStorageNamespaceIndexStateUsingDriver(
      driver,
      scope,
    );
    if (!indexState.valid || indexState.entries === null) return;

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
    await this.#withCleanupDriver((driver) =>
      this.#performStartupCleanupWithDriver(driver),
    );
  }

  async #performStartupCleanupWithDriver(
    driver: AsyncStorageDriver,
  ): Promise<void> {
    const cleanupActionDriver = __LEGIT_CAST__<
      AsyncStorageStartupCleanupActionCapableDriver,
      AsyncStorageDriver
    >(driver);
    const discoveredScopes = await this.#listDiscoveredCleanupScopes(driver);
    const now = Date.now();
    const protectedRefsBySession = new Map(
      [...new Set(discoveredScopes.map(({ scope }) => scope.sessionKey))].map(
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

    for (const settledResult of sessionDeleteResults) {
      if (settledResult.status !== 'fulfilled') continue;
      const result = settledResult.value;
      if (result.kind !== 'removeSessionDir' || !result.removed) continue;
      cleanupActionDriver.cleanupFinalizeRemovedSessionDir?.(
        result.action.sessionKey,
      );
    }
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
    const legacyMetadataRecordKeys: string[] = [];
    const rawKeysToRemove: string[] = [];

    for (const key of rawKeys) {
      if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
        payloadKeys.add(key.slice(PAYLOAD_RECORD_PREFIX.length));
      } else if (key.startsWith(METADATA_RECORD_PREFIX)) {
        legacyMetadataRecordKeys.push(key);
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
    const payloadRecordKeysToRemove = new Set<string>([
      ...legacyMetadataRecordKeys,
      ...rawKeysToRemove,
    ]);
    const candidateEntries: Array<{
      itemKey: string;
      lastAccessAt: number;
      protected: boolean;
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
      });
    }

    for (const payloadKey of payloadKeys) {
      if (!indexState.entries.has(payloadKey)) {
        payloadRecordKeysToRemove.add(getPayloadRecordKey(payloadKey));
      }
    }

    if (
      effectiveStaticPolicy?.maxEntries !== undefined &&
      candidateEntries.length > effectiveStaticPolicy.maxEntries
    ) {
      const unprotectedCount = candidateEntries.filter(
        ({ protected: isProtected }) => !isProtected,
      ).length;

      if (unprotectedCount > effectiveStaticPolicy.maxEntries) {
        const pinnedKeys = new Set(effectiveStaticPolicy.pinnedKeys ?? []);
        candidateEntries.sort(
          createEvictionComparator(
            [
              (entry) => entry.protected,
              (entry) => pinnedKeys.has(entry.itemKey),
            ],
            (entry) => entry.lastAccessAt,
          ),
        );

        const keptKeys = new Set(
          candidateEntries
            .slice(0, effectiveStaticPolicy.maxEntries)
            .map(({ itemKey }) => itemKey),
        );

        for (const { itemKey } of candidateEntries) {
          if (keptKeys.has(itemKey)) continue;
          payloadRecordKeysToRemove.add(getPayloadRecordKey(itemKey));
          nextEntries.delete(itemKey);
        }
      }
    }

    const indexChanged =
      nextEntries.size !== indexState.entries.size ||
      rawKeysToRemove.length > 0 ||
      legacyMetadataRecordKeys.length > 0 ||
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
  return JSON.stringify([ref.sessionKey, ref.storeName, ref.kind, ref.key]);
}
