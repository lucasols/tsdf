import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  getMetadataRecordKey,
  getPayloadRecordKey,
  METADATA_RECORD_PREFIX,
} from './opfsFileNaming';
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
  AsyncStorageProtectedEntryRef,
  AsyncStorageReadOptions,
} from './types';
import {
  getProtectedKeysStorageScope,
  parseProtectedKeys,
  PROTECTED_KEYS_STORAGE_ENTRY_KEY,
} from './offline/protectedKeysPersistence';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import { runWithNavigatorLock } from './navigatorLocks';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

export const ASYNC_STORAGE_COMMIT_DEBOUNCE_MS = 40;
export const ASYNC_STORAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const ASYNC_STORAGE_STARTUP_CLEANUP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const ASYNC_STORAGE_RECENCY_BUCKET_MS = 6 * 60 * 60 * 1000;
export const ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY = 'tsdf._am.g';
const ASYNC_STARTUP_CLEANUP_LOCK_NAME = 'tsdf-async-storage-maintenance';
const ASYNC_STARTUP_CLEANUP_LOCK_WARNING =
  '[TSDF] navigator.locks is unavailable; async OPFS startup cleanup is using unlocked coordination.';
function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

function getBucketId(timestamp: number): string {
  return String(Math.floor(timestamp / ASYNC_STORAGE_RECENCY_BUCKET_MS));
}

function getUserKeyFromMetadataRecord(recordKey: string): string | null {
  return recordKey.startsWith(METADATA_RECORD_PREFIX)
    ? recordKey.slice(METADATA_RECORD_PREFIX.length)
    : null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
}

type InternalManagedMetadataRecord = {
  customMetadata?: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
  writtenAt: number;
};

function parseInternalManagedMetadataRecord(
  value: unknown,
): InternalManagedMetadataRecord | null {
  const record = getRecord(value);
  if (
    record === null ||
    typeof record.key !== 'string' ||
    typeof record.writtenAt !== 'number' ||
    typeof record.lastAccessAt !== 'number' ||
    typeof record.version !== 'number' ||
    (record.sizeBytes !== undefined && typeof record.sizeBytes !== 'number')
  ) {
    return null;
  }

  return {
    key: record.key,
    writtenAt: record.writtenAt,
    lastAccessAt: record.lastAccessAt,
    version: record.version,
    ...(record.sizeBytes !== undefined ? { sizeBytes: record.sizeBytes } : {}),
    ...(getRecord(record.customMetadata)
      ? { customMetadata: getRecord(record.customMetadata) ?? undefined }
      : {}),
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

type PendingNamespaceCommit = {
  cancelFlush: (() => void) | null;
  flushPromise: Promise<void> | null;
  removes: Set<string>;
  scope: AsyncStorageNamespaceScope;
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

  resetForTests(): void {
    for (const pending of this.#pendingNamespaceCommits.values()) {
      pending.cancelFlush?.();
    }
    this.#observedScopes.clear();
    this.#pendingNamespaceCommits.clear();
    this.#recentTouchedBuckets.clear();
    this.#startupCleanupScheduled = false;
    this.driver.resetForTests?.();
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
    const touches = [...pending.touches.entries()].map(
      ([key, lastAccessAt]) => ({ key, lastAccessAt }),
    );
    const waiters = [...pending.waiters];
    pending.upserts = new Map();
    pending.removes = new Set();
    pending.touches = new Map();
    pending.waiters = [];

    if (upserts.length === 0 && removes.length === 0 && touches.length === 0) {
      this.#pendingNamespaceCommits.delete(namespaceKey);
      for (const waiter of waiters) {
        waiter.resolve();
      }
      return;
    }

    pending.flushPromise = this.#applyManagedCommit(scope, {
      upserts,
      removes,
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

  async readManagedEntries<
    TValue,
    TCustomMetadata extends Record<string, unknown>,
  >(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<
    Map<string, AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
  > {
    return this.#readManagedEntriesUsingDriver(this.driver, scope, keys);
  }

  async #readManagedEntriesUsingDriver<
    TValue,
    TCustomMetadata extends Record<string, unknown>,
  >(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<
    Map<string, AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
  > {
    const rawKeys = keys.flatMap((key) => [
      getPayloadRecordKey(key),
      getMetadataRecordKey(key),
    ]);
    const rawValues = await this.#driverGetManyFrom(driver, scope, rawKeys);
    const valueByRawKey = new Map<string, unknown>();
    for (const [index, rawKey] of rawKeys.entries()) {
      valueByRawKey.set(rawKey, rawValues[index] ?? null);
    }

    const result = new Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null
    >();
    const orphanedKeys: string[] = [];

    for (const key of keys) {
      const rawPayload = valueByRawKey.get(getPayloadRecordKey(key)) ?? null;
      const rawMetadata = valueByRawKey.get(getMetadataRecordKey(key)) ?? null;
      const metadata = parseInternalManagedMetadataRecord(rawMetadata);

      if (rawPayload === null && metadata === null) {
        result.set(key, null);
        continue;
      }

      if (rawPayload === null || metadata === null) {
        orphanedKeys.push(key);
        result.set(key, null);
        continue;
      }

      result.set(key, {
        value: __LEGIT_CAST__<TValue, unknown>(rawPayload),
        metadata: __LEGIT_CAST__<
          AsyncStorageEntryMetadata<TCustomMetadata>,
          AsyncStorageEntryMetadata<Record<string, unknown>>
        >(this.#toPublicMetadata(metadata)),
      });
    }

    if (orphanedKeys.length > 0) {
      await this.#removeManagedKeysUsingDriver(driver, scope, orphanedKeys);
    }

    return result;
  }

  async listManagedMetadata<TCustomMetadata extends Record<string, unknown>>(
    scope: AsyncStorageNamespaceScope,
    args: { order?: AsyncStorageMetadataOrder },
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    return this.#listManagedMetadataUsingDriver(this.driver, scope, args);
  }

  async #listManagedMetadataUsingDriver<
    TCustomMetadata extends Record<string, unknown>,
  >(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    args: { order?: AsyncStorageMetadataOrder } = {},
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    const metadataKeys = (await driver.listKeys(scope)).filter((key) =>
      key.startsWith(METADATA_RECORD_PREFIX),
    );
    return this.#listManagedMetadataByMetadataKeysUsingDriver(
      driver,
      scope,
      metadataKeys,
      args.order ?? 'key',
    );
  }

  async #listManagedMetadataByMetadataKeysUsingDriver<
    TCustomMetadata extends Record<string, unknown>,
  >(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    metadataKeys: string[],
    order: AsyncStorageMetadataOrder = 'key',
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    const metadataValues = await this.#driverGetManyFrom(
      driver,
      scope,
      metadataKeys,
    );
    const validEntries: AsyncStorageEntryMetadata<Record<string, unknown>>[] =
      [];
    const orphanedUserKeys: string[] = [];

    for (const [index, metadataKey] of metadataKeys.entries()) {
      const metadata = parseInternalManagedMetadataRecord(
        metadataValues[index],
      );
      const userKey = getUserKeyFromMetadataRecord(metadataKey);
      if (metadata !== null && userKey !== null) {
        validEntries.push(this.#toPublicMetadata(metadata));
      } else if (userKey !== null) {
        orphanedUserKeys.push(userKey);
      }
    }

    if (orphanedUserKeys.length > 0) {
      await this.#removeManagedKeysUsingDriver(driver, scope, orphanedUserKeys);
    }

    validEntries.sort((left, right) => compareMetadata(left, right, order));

    return __LEGIT_CAST__<
      AsyncStorageEntryMetadata<TCustomMetadata>[],
      AsyncStorageEntryMetadata<Record<string, unknown>>[]
    >(validEntries);
  }

  async listManagedKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    return (await this.driver.listKeys(scope)).flatMap((key) => {
      const userKey = getUserKeyFromMetadataRecord(key);
      return userKey === null ? [] : [userKey];
    });
  }

  async clearManagedNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    await this.driver.clear(scope);
    this.#observedScopes.delete(getNamespaceId(scope));
    this.#pendingNamespaceCommits.delete(getNamespaceId(scope));
    this.clearRecentTouchedBucketsForNamespace(scope);
  }

  #toPublicMetadata(
    metadata: InternalManagedMetadataRecord,
  ): AsyncStorageEntryMetadata<Record<string, unknown>> {
    return {
      key: metadata.key,
      payloadRef: getPayloadRecordKey(metadata.key),
      writtenAt: metadata.writtenAt,
      lastAccessAt: metadata.lastAccessAt,
      version: metadata.version,
      ...(metadata.sizeBytes !== undefined
        ? { sizeBytes: metadata.sizeBytes }
        : {}),
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
    const keysNeedingMetadata = [
      ...new Set([...upserts.map((upsert) => upsert.key), ...touchedKeys]),
    ];
    const existingMetadataValues = await this.#driverGetManyFrom(
      this.driver,
      scope,
      keysNeedingMetadata.map((key) => getMetadataRecordKey(key)),
    );
    const existingMetadataByKey = new Map<
      string,
      InternalManagedMetadataRecord
    >();
    for (const [index, key] of keysNeedingMetadata.entries()) {
      const metadata = parseInternalManagedMetadataRecord(
        existingMetadataValues[index] ?? null,
      );
      if (metadata !== null) {
        existingMetadataByKey.set(key, metadata);
      }
    }

    const now = Date.now();
    const touchesByKey = new Map(
      touches.map((touch) => [touch.key, touch.lastAccessAt ?? now]),
    );
    const setEntries: AsyncStorageDriverSetEntry[] = [];
    const removeEntries: string[] = [];

    for (const key of removes) {
      removeEntries.push(getPayloadRecordKey(key), getMetadataRecordKey(key));
    }

    for (const upsert of upserts) {
      const serializedValue = this.#safeSerializeValue(upsert.value);
      const existingMetadata = existingMetadataByKey.get(upsert.key);
      const customMetadata =
        upsert.metadata ?? existingMetadata?.customMetadata;
      const nextMetadata: InternalManagedMetadataRecord = {
        key: upsert.key,
        writtenAt: now,
        lastAccessAt:
          touchesByKey.get(upsert.key) ?? existingMetadata?.lastAccessAt ?? now,
        version: upsert.version,
        ...(serializedValue !== null
          ? { sizeBytes: serializedValue.length }
          : {}),
        ...(customMetadata ? { customMetadata } : {}),
      };

      setEntries.push({
        key: getPayloadRecordKey(upsert.key),
        value: upsert.value,
      });
      setEntries.push({
        key: getMetadataRecordKey(upsert.key),
        value: nextMetadata,
      });
    }

    const upsertKeySet = new Set(upserts.map((upsert) => upsert.key));
    for (const key of touchedKeys) {
      if (upsertKeySet.has(key)) continue;
      const metadata = existingMetadataByKey.get(key);
      if (!metadata) continue;
      setEntries.push({
        key: getMetadataRecordKey(key),
        value: { ...metadata, lastAccessAt: touchesByKey.get(key) ?? now },
      });
    }

    if (removeEntries.length > 0) {
      await this.#driverRemoveManyFrom(this.driver, scope, removeEntries);
    }
    if (setEntries.length > 0) {
      await this.#driverSetManyFrom(this.driver, scope, setEntries);
    }
  }

  #safeSerializeValue(value: unknown): string | null {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
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
      uniqueKeys.flatMap((key) => [
        getPayloadRecordKey(key),
        getMetadataRecordKey(key),
      ]),
    );
  }

  async #driverGetManyFrom(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<unknown[]> {
    if (keys.length === 0) return [];
    if (driver.getMany) {
      return driver.getMany(scope, keys);
    }

    return Promise.all(keys.map((key) => driver.get(scope, key)));
  }

  async #driverSetManyFrom(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    if (driver.setMany) {
      await driver.setMany(scope, entries);
      return;
    }

    await Promise.all(
      entries.map((entry) => driver.set(scope, entry.key, entry.value)),
    );
  }

  async #driverRemoveManyFrom(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    if (driver.removeMany) {
      await driver.removeMany(scope, keys);
      return;
    }

    await Promise.all(keys.map((key) => driver.remove(scope, key)));
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
    const discoveredScopes = await driver.listScopes?.(sessionKey);
    const scopes =
      discoveredScopes ??
      [...this.#observedScopes.values()].filter(
        (scope) => sessionKey === undefined || scope.sessionKey === sessionKey,
      );

    return scopes.filter((scope) => scope.kind !== '__internal.protected');
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
      removes: new Set(),
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
    const maintenance = this.#readMaintenanceState();
    const now = Date.now();
    if (
      maintenance.lastSuccessfulCleanupAt !== null &&
      now - maintenance.lastSuccessfulCleanupAt <
        ASYNC_STORAGE_STARTUP_CLEANUP_COOLDOWN_MS
    ) {
      return;
    }

    if (document.hidden) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 150);
      });
    }
    await runWithNavigatorLock(
      ASYNC_STARTUP_CLEANUP_LOCK_NAME,
      ASYNC_STARTUP_CLEANUP_LOCK_WARNING,
      async () => {
        const lockedMaintenance = this.#readMaintenanceState();
        const lockedNow = Date.now();
        if (
          lockedMaintenance.lastSuccessfulCleanupAt !== null &&
          lockedNow - lockedMaintenance.lastSuccessfulCleanupAt <
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
    const discoveredScopes = await this.#listDiscoveredCleanupScopes(driver);
    const now = Date.now();

    const sessionKeys = [
      ...new Set(discoveredScopes.map(({ scope }) => scope.sessionKey)),
    ];
    const protectedRefsBySession = new Map(
      await Promise.all(
        sessionKeys.map(
          async (sessionKey) =>
            [
              sessionKey,
              await this.#readProtectedRefs(sessionKey, driver),
            ] as const,
        ),
      ),
    );

    await Promise.all(
      discoveredScopes.map(async ({ scope, metadataRecordKeys }) => {
        const protectedRefs = protectedRefsBySession.get(scope.sessionKey);
        if (protectedRefs === undefined) return;

        const metadataEntries =
          metadataRecordKeys === null
            ? await this.#listManagedMetadataUsingDriver(driver, scope, {
                order: 'key',
              })
            : await this.#listManagedMetadataByMetadataKeysUsingDriver(
                driver,
                scope,
                metadataRecordKeys,
                'key',
              );
        const keysToRemove: string[] = [];
        for (const entry of metadataEntries) {
          const isProtected = protectedRefs.has(
            serializeProtectedRef({ ...scope, key: entry.key }),
          );
          if (
            !isProtected &&
            now - Math.max(entry.lastAccessAt, entry.writtenAt) >
              ASYNC_STORAGE_MAX_AGE_MS
          ) {
            keysToRemove.push(entry.key);
          }
        }

        if (keysToRemove.length > 0) {
          await this.#removeManagedKeysUsingDriver(driver, scope, keysToRemove);
        }
      }),
    );
  }

  async #listDiscoveredCleanupScopes(
    driver: AsyncStorageDriver,
  ): Promise<AsyncStorageDiscoveredScope[]> {
    const discoveredScopes = await driver.listScopesWithMetadataKeys?.();
    if (discoveredScopes !== undefined) {
      return discoveredScopes.filter(
        ({ scope }) => scope.kind !== '__internal.protected',
      );
    }

    return (await this.#listDiscoveredScopes(undefined, driver)).map(
      (scope) => ({ metadataRecordKeys: null, scope }),
    );
  }

  async #readProtectedRefs(
    sessionKey: string,
    driver: AsyncStorageDriver = this.driver,
  ): Promise<Set<string>> {
    const protectedKeysSnapshot = getSessionProtectedKeysSnapshot(sessionKey);
    if (protectedKeysSnapshot !== null) {
      return new Set(protectedKeysSnapshot);
    }

    const protectedScope = getProtectedKeysStorageScope(sessionKey);
    const entry = (
      await this.#readManagedEntriesUsingDriver<
        unknown,
        Record<string, unknown>
      >(driver, protectedScope, [PROTECTED_KEYS_STORAGE_ENTRY_KEY])
    ).get(PROTECTED_KEYS_STORAGE_ENTRY_KEY);
    return new Set(parseProtectedKeys(entry?.value)?.keys ?? []);
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
