import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type {
  AsyncStorageAdapter,
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
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

export const ASYNC_STORAGE_COMMIT_DEBOUNCE_MS = 40;
export const ASYNC_STORAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const ASYNC_STORAGE_STARTUP_CLEANUP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const ASYNC_STORAGE_STARTUP_CLEANUP_LEASE_TTL_MS = 60 * 1000;
export const ASYNC_STORAGE_RECENCY_BUCKET_MS = 6 * 60 * 60 * 1000;
const INTERNAL_PAYLOAD_PREFIX = '__tsdf_payload__:';
const INTERNAL_METADATA_PREFIX = '__tsdf_meta__:';
const INTERNAL_REGISTRY_KEY = 'registry';
const INTERNAL_MAINTENANCE_KEY = 'maintenance';
const INTERNAL_ASYNC_SCOPE: AsyncStorageNamespaceScope = {
  sessionKey: '__tsdf_async__',
  storeName: '__tsdf_async__',
  kind: '__internal.protected',
};

function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

function getBucketId(timestamp: number): string {
  return String(Math.floor(timestamp / ASYNC_STORAGE_RECENCY_BUCKET_MS));
}

function getPayloadRecordKey(key: string): string {
  return `${INTERNAL_PAYLOAD_PREFIX}${key}`;
}

function getMetadataRecordKey(key: string): string {
  return `${INTERNAL_METADATA_PREFIX}${key}`;
}

function getUserKeyFromMetadataRecord(recordKey: string): string | null {
  return recordKey.startsWith(INTERNAL_METADATA_PREFIX)
    ? recordKey.slice(INTERNAL_METADATA_PREFIX.length)
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

type InternalNamespaceRegistry = { namespaces: AsyncStorageNamespaceScope[] };

function parseInternalNamespaceRegistry(
  value: unknown,
): InternalNamespaceRegistry | null {
  const record = getRecord(value);
  if (record === null || !Array.isArray(record.namespaces)) {
    return null;
  }

  const namespaces: AsyncStorageNamespaceScope[] = [];
  for (const entry of record.namespaces) {
    const parsed = getRecord(entry);
    if (
      parsed === null ||
      typeof parsed.sessionKey !== 'string' ||
      typeof parsed.storeName !== 'string' ||
      typeof parsed.kind !== 'string'
    ) {
      return null;
    }

    namespaces.push({
      sessionKey: parsed.sessionKey,
      storeName: parsed.storeName,
      kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(
        parsed.kind,
      ),
    });
  }

  return { namespaces };
}

function parseMaintenanceState(
  value: unknown,
): AsyncStorageMaintenanceState | null {
  const record = getRecord(value);
  if (record === null) return null;

  const lastSuccessfulCleanupAt = record.lastSuccessfulCleanupAt;
  if (
    lastSuccessfulCleanupAt !== null &&
    typeof lastSuccessfulCleanupAt !== 'number'
  ) {
    return null;
  }

  if (record.startupCleanupLease === null) {
    return { lastSuccessfulCleanupAt, startupCleanupLease: null };
  }

  const lease = getRecord(record.startupCleanupLease);
  if (
    lease === null ||
    typeof lease.holderId !== 'string' ||
    typeof lease.expiresAt !== 'number'
  ) {
    return null;
  }

  return {
    lastSuccessfulCleanupAt,
    startupCleanupLease: {
      holderId: lease.holderId,
      expiresAt: lease.expiresAt,
    },
  };
}

function createDefaultMaintenanceState(): AsyncStorageMaintenanceState {
  return { lastSuccessfulCleanupAt: null, startupCleanupLease: null };
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

function nowMinusLatest(
  metadata: AsyncStorageEntryMetadata<Record<string, unknown>>,
  now: number,
): number {
  return now - Math.max(metadata.lastAccessAt, metadata.writtenAt);
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

  private pendingNamespaceCommits = new Map<string, PendingNamespaceCommit>();
  private recentTouchedBuckets = new Map<string, string>();
  private knownRegisteredNamespaces = new Set<string>();
  private startupCleanupScheduled = false;

  constructor(private readonly driver: AsyncStorageDriver) {}

  openNamespace<
    TValue,
    TCustomMetadata extends Record<string, unknown> = Record<string, never>,
  >(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
    this.scheduleStartupCleanupIfNeeded();
    return new ManagedAsyncStorageNamespaceHandle<TValue, TCustomMetadata>(
      this,
      scope,
    );
  }

  async clearSession(sessionKey: string): Promise<void> {
    await this.flushAllPendingNamespaceCommits();
    const registry = await this.readNamespaceRegistry();
    const scopesToClear = registry.namespaces.filter(
      (scope) => scope.sessionKey === sessionKey,
    );

    await Promise.all(
      scopesToClear.map(async (scope) => {
        await this.driver.clear(scope);
        this.pendingNamespaceCommits.delete(getNamespaceId(scope));
        this.knownRegisteredNamespaces.delete(getNamespaceId(scope));
        this.clearRecentTouchedBucketsForNamespace(scope);
      }),
    );

    await this.writeNamespaceRegistry({
      namespaces: registry.namespaces.filter(
        (scope) => scope.sessionKey !== sessionKey,
      ),
    });
  }

  resetForTests(): void {
    for (const pending of this.pendingNamespaceCommits.values()) {
      pending.cancelFlush?.();
    }
    this.pendingNamespaceCommits.clear();
    this.recentTouchedBuckets.clear();
    this.knownRegisteredNamespaces.clear();
    this.startupCleanupScheduled = false;
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
    if (this.recentTouchedBuckets.get(touchGuardKey) === currentBucket) {
      return false;
    }

    const pending = this.pendingNamespaceCommits.get(namespaceKey);
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
    const pending = this.getOrCreatePendingNamespaceCommit(scope);
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

    this.schedulePendingNamespaceFlush(pending);

    return new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  async flushPendingNamespaceCommit(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    const namespaceKey = getNamespaceId(scope);
    const pending = this.pendingNamespaceCommits.get(namespaceKey);
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
      this.pendingNamespaceCommits.delete(namespaceKey);
      for (const waiter of waiters) {
        waiter.resolve();
      }
      return;
    }

    pending.flushPromise = this.applyManagedCommit(scope, {
      upserts,
      removes,
      touches,
    })
      .then(() => {
        const currentBucket = getBucketId(Date.now());
        for (const touch of touches) {
          this.recentTouchedBuckets.set(
            `${namespaceKey}::${touch.key}`,
            getBucketId(touch.lastAccessAt),
          );
        }
        for (const upsert of upserts) {
          this.recentTouchedBuckets.set(
            `${namespaceKey}::${upsert.key}`,
            currentBucket,
          );
        }
        this.pruneRecentTouchedBuckets(currentBucket);
        for (const waiter of waiters) {
          waiter.resolve();
        }
      })
      .catch((error) => {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
        throw error;
      })
      .finally(() => {
        pending.flushPromise = null;
        if (pending.waiters.length === 0) {
          this.pendingNamespaceCommits.delete(namespaceKey);
          return;
        }
        this.schedulePendingNamespaceFlush(pending);
      });

    await pending.flushPromise;
  }

  async flushAllPendingNamespaceCommits(): Promise<void> {
    await Promise.all(
      [...this.pendingNamespaceCommits.values()].map((pending) =>
        this.flushPendingNamespaceCommit(pending.scope),
      ),
    );
  }

  clearRecentTouchedBucketsForNamespace(
    scope: AsyncStorageNamespaceScope,
  ): void {
    const keyPrefix = `${getNamespaceId(scope)}::`;
    for (const key of this.recentTouchedBuckets.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.recentTouchedBuckets.delete(key);
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
    const uniqueKeys = [...new Set(keys)];
    const rawKeys = uniqueKeys.flatMap((key) => [
      getPayloadRecordKey(key),
      getMetadataRecordKey(key),
    ]);
    const rawValues = await this.driverGetMany(scope, rawKeys);
    const valueByRawKey = new Map<string, unknown>();
    for (const [index, rawKey] of rawKeys.entries()) {
      valueByRawKey.set(rawKey, rawValues[index] ?? null);
    }

    const result = new Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null
    >();
    const orphanedKeys: string[] = [];

    for (const key of uniqueKeys) {
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
        >(this.toPublicMetadata(metadata)),
      });
    }

    if (orphanedKeys.length > 0) {
      await this.removeManagedKeys(scope, orphanedKeys);
    }

    return result;
  }

  async listManagedMetadata<TCustomMetadata extends Record<string, unknown>>(
    scope: AsyncStorageNamespaceScope,
    args: { order?: AsyncStorageMetadataOrder },
  ): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]> {
    const order = args.order ?? 'key';
    const keys = await this.driver.listKeys(scope);
    const metadataKeys = keys.filter((key) =>
      key.startsWith(INTERNAL_METADATA_PREFIX),
    );
    const metadataValues = await this.driverGetMany(scope, metadataKeys);
    const validEntries: AsyncStorageEntryMetadata<Record<string, unknown>>[] =
      [];
    const orphanedUserKeys: string[] = [];

    for (const [index, metadataKey] of metadataKeys.entries()) {
      const metadata = parseInternalManagedMetadataRecord(
        metadataValues[index],
      );
      const userKey = getUserKeyFromMetadataRecord(metadataKey);
      if (metadata !== null && userKey !== null) {
        validEntries.push(this.toPublicMetadata(metadata));
      } else if (userKey !== null) {
        orphanedUserKeys.push(userKey);
      }
    }

    if (orphanedUserKeys.length > 0) {
      await this.removeManagedKeys(scope, orphanedUserKeys);
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
    await this.unregisterNamespace(scope);
    this.pendingNamespaceCommits.delete(getNamespaceId(scope));
    this.clearRecentTouchedBucketsForNamespace(scope);
  }

  private toPublicMetadata(
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

  private async applyManagedCommit(
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
    const existingMetadataValues = await this.driverGetMany(
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
      const serializedValue = this.safeSerializeValue(upsert.value);
      const existingMetadata = existingMetadataByKey.get(upsert.key);
      const nextMetadata: InternalManagedMetadataRecord = {
        key: upsert.key,
        writtenAt: now,
        lastAccessAt:
          touchesByKey.get(upsert.key) ?? existingMetadata?.lastAccessAt ?? now,
        version: upsert.version,
        ...(serializedValue !== null
          ? { sizeBytes: serializedValue.length }
          : {}),
        ...(upsert.metadata ? { customMetadata: upsert.metadata } : {}),
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
      await this.driverRemoveMany(scope, removeEntries);
    }
    if (setEntries.length > 0) {
      await this.driverSetMany(scope, setEntries);
    }

    if (upserts.length > 0) {
      await this.registerNamespace(scope);
    } else if (removes.length > 0) {
      if (await this.namespaceHasManagedEntries(scope)) {
        await this.registerNamespace(scope);
      } else {
        await this.unregisterNamespace(scope);
      }
    }
  }

  private safeSerializeValue(value: unknown): string | null {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  private async removeManagedKeys(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 0) return;

    await this.driverRemoveMany(
      scope,
      uniqueKeys.flatMap((key) => [
        getPayloadRecordKey(key),
        getMetadataRecordKey(key),
      ]),
    );

    if (!(await this.namespaceHasManagedEntries(scope))) {
      await this.unregisterNamespace(scope);
    }
  }

  private async namespaceHasManagedEntries(
    scope: AsyncStorageNamespaceScope,
  ): Promise<boolean> {
    return (await this.listManagedKeys(scope)).length > 0;
  }

  private async driverGetMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<unknown[]> {
    if (keys.length === 0) return [];
    if (this.driver.getMany) {
      return this.driver.getMany(scope, keys);
    }

    return Promise.all(keys.map((key) => this.driver.get(scope, key)));
  }

  private async driverSetMany(
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    if (this.driver.setMany) {
      await this.driver.setMany(scope, entries);
      return;
    }

    await Promise.all(
      entries.map((entry) => this.driver.set(scope, entry.key, entry.value)),
    );
  }

  private async driverRemoveMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    if (this.driver.removeMany) {
      await this.driver.removeMany(scope, keys);
      return;
    }

    await Promise.all(keys.map((key) => this.driver.remove(scope, key)));
  }

  private async readNamespaceRegistry(): Promise<InternalNamespaceRegistry> {
    const raw = await this.driver.get(
      INTERNAL_ASYNC_SCOPE,
      INTERNAL_REGISTRY_KEY,
    );
    return parseInternalNamespaceRegistry(raw) ?? { namespaces: [] };
  }

  private async writeNamespaceRegistry(
    registry: InternalNamespaceRegistry,
  ): Promise<void> {
    await this.driver.set(
      INTERNAL_ASYNC_SCOPE,
      INTERNAL_REGISTRY_KEY,
      registry,
    );
  }

  private async registerNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    const scopeId = getNamespaceId(scope);
    if (this.knownRegisteredNamespaces.has(scopeId)) return;

    const registry = await this.readNamespaceRegistry();
    if (
      registry.namespaces.some((entry) => getNamespaceId(entry) === scopeId)
    ) {
      this.knownRegisteredNamespaces.add(scopeId);
      return;
    }

    registry.namespaces.push(scope);
    await this.writeNamespaceRegistry(registry);
    this.knownRegisteredNamespaces.add(scopeId);
  }

  private async unregisterNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    const scopeId = getNamespaceId(scope);
    this.knownRegisteredNamespaces.delete(scopeId);
    const registry = await this.readNamespaceRegistry();
    const namespaces = registry.namespaces.filter(
      (entry) => getNamespaceId(entry) !== scopeId,
    );
    if (namespaces.length === registry.namespaces.length) {
      return;
    }

    await this.writeNamespaceRegistry({ namespaces });
  }

  private async readMaintenanceState(): Promise<AsyncStorageMaintenanceState> {
    const raw = await this.driver.get(
      INTERNAL_ASYNC_SCOPE,
      INTERNAL_MAINTENANCE_KEY,
    );
    return parseMaintenanceState(raw) ?? createDefaultMaintenanceState();
  }

  private async writeMaintenanceState(
    state: AsyncStorageMaintenanceState,
  ): Promise<void> {
    await this.driver.set(
      INTERNAL_ASYNC_SCOPE,
      INTERNAL_MAINTENANCE_KEY,
      state,
    );
  }

  private getOrCreatePendingNamespaceCommit(
    scope: AsyncStorageNamespaceScope,
  ): PendingNamespaceCommit {
    const namespaceKey = getNamespaceId(scope);
    const existing = this.pendingNamespaceCommits.get(namespaceKey);
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
    this.pendingNamespaceCommits.set(namespaceKey, created);
    return created;
  }

  private schedulePendingNamespaceFlush(pending: PendingNamespaceCommit): void {
    if (pending.cancelFlush !== null || pending.flushPromise !== null) return;

    const timeoutId = setTimeout(() => {
      pending.cancelFlush = null;
      void this.flushPendingNamespaceCommit(pending.scope);
    }, ASYNC_STORAGE_COMMIT_DEBOUNCE_MS);

    pending.cancelFlush = () => clearTimeout(timeoutId);
  }

  private pruneRecentTouchedBuckets(currentBucket: string): void {
    for (const [key, bucket] of this.recentTouchedBuckets) {
      if (bucket !== currentBucket) {
        this.recentTouchedBuckets.delete(key);
      }
    }
  }

  private scheduleStartupCleanupIfNeeded(): void {
    if (this.startupCleanupScheduled) return;
    this.startupCleanupScheduled = true;

    scheduleIdleCleanup(() => {
      void this.runStartupCleanupIfDue().catch(() => {
        // Ignore startup cleanup failures; regular reads and writes still work.
      });
    });
  }

  private async runStartupCleanupIfDue(): Promise<void> {
    const maintenance = await this.readMaintenanceState();
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

    const holderId = `startup-cleanup-${Math.random().toString(36).slice(2, 10)}`;
    const acquired = await this.tryAcquireStartupCleanupLease({
      holderId,
      ttlMs: ASYNC_STORAGE_STARTUP_CLEANUP_LEASE_TTL_MS,
    });
    if (!acquired) return;

    try {
      await this.performStartupCleanup();
      await this.finishStartupCleanup({ holderId, finishedAt: Date.now() });
    } catch {
      // Leave the lease to expire naturally if cleanup crashes.
    }
  }

  private async tryAcquireStartupCleanupLease(args: {
    holderId: string;
    ttlMs: number;
  }): Promise<boolean> {
    const state = await this.readMaintenanceState();
    const now = Date.now();
    const currentLease = state.startupCleanupLease;

    if (
      currentLease &&
      currentLease.holderId !== args.holderId &&
      currentLease.expiresAt > now
    ) {
      return false;
    }

    await this.writeMaintenanceState({
      ...state,
      startupCleanupLease: {
        holderId: args.holderId,
        expiresAt: now + args.ttlMs,
      },
    });

    return true;
  }

  private async finishStartupCleanup(args: {
    holderId: string;
    finishedAt: number;
  }): Promise<void> {
    const state = await this.readMaintenanceState();
    const currentLease = state.startupCleanupLease;

    if (currentLease && currentLease.holderId !== args.holderId) {
      return;
    }

    await this.writeMaintenanceState({
      lastSuccessfulCleanupAt: args.finishedAt,
      startupCleanupLease: null,
    });
  }

  private async performStartupCleanup(): Promise<void> {
    await this.flushAllPendingNamespaceCommits();
    const registry = await this.readNamespaceRegistry();
    const protectedRefsBySession = new Map<string, Set<string>>();

    for (const scope of registry.namespaces) {
      const namespace = this.openNamespace<unknown, Record<string, unknown>>(
        scope,
      );
      const cachedProtectedRefs = protectedRefsBySession.get(scope.sessionKey);
      const protectedRefs =
        cachedProtectedRefs ?? (await this.readProtectedRefs(scope.sessionKey));

      if (!cachedProtectedRefs) {
        protectedRefsBySession.set(scope.sessionKey, protectedRefs);
      }

      const keysToRemove: string[] = [];
      for (const entry of await namespace.listMetadata({ order: 'key' })) {
        const isProtected = protectedRefs.has(
          serializeProtectedRef({ ...scope, key: entry.key }),
        );
        if (
          !isProtected &&
          nowMinusLatest(entry, Date.now()) > ASYNC_STORAGE_MAX_AGE_MS
        ) {
          keysToRemove.push(entry.key);
        }
      }

      if (keysToRemove.length > 0) {
        await this.applyManagedCommit(scope, { removes: keysToRemove });
      }
    }
  }

  private async readProtectedRefs(sessionKey: string): Promise<Set<string>> {
    const protectedKeysSnapshot = getSessionProtectedKeysSnapshot(sessionKey);
    if (protectedKeysSnapshot !== null) {
      return new Set(protectedKeysSnapshot);
    }

    const namespace = this.openNamespace<unknown>(
      getProtectedKeysStorageScope(sessionKey),
    );
    const entry = await namespace.get(PROTECTED_KEYS_STORAGE_ENTRY_KEY, {
      touch: 'never',
    });
    return new Set(parseProtectedKeys(entry?.value)?.keys ?? []);
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
