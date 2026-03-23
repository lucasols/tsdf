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

function serializeIndexEntries(
  entries: Map<string, InternalManagedMetadataRecord>,
): Record<string, unknown> {
  return {
    e: Object.fromEntries(
      [...entries.entries()].map(([key, metadata]) => [
        key,
        serializeInternalManagedMetadataRecord(metadata),
      ]),
    ),
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

type NamespaceIndexCache = {
  cancelFlush: (() => void) | null;
  dirty: boolean;
  entries: Map<string, InternalManagedMetadataRecord>;
  flushPromise: Promise<void> | null;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  scope: AsyncStorageNamespaceScope;
};

class ManagedAsyncStorageAdapter implements AsyncStorageAdapter {
  readonly kind = 'async' as const;

  #namespaceIndexes = new Map<string, NamespaceIndexCache>();
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
    if (protectedKeysSnapshot !== null) {
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
        const indexCache = await this.#refreshNamespaceIndexCache(scope);
        let changed = false;

        for (const [key, shouldProtect] of protectionByKey.entries()) {
          const existingMetadata = indexCache.entries.get(key);
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

          indexCache.entries.set(key, nextMetadata);
          changed = true;
        }

        if (changed) {
          indexCache.dirty = true;
          await this.#flushNamespaceIndex(scope);
        }
      }),
    );
  }

  resetForTests(): void {
    for (const pending of this.#pendingNamespaceCommits.values()) {
      pending.cancelFlush?.();
    }
    for (const index of this.#namespaceIndexes.values()) {
      index.cancelFlush?.();
    }
    this.#namespaceIndexes.clear();
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

  async #ensureNamespaceIndexLoaded(
    scope: AsyncStorageNamespaceScope,
  ): Promise<NamespaceIndexCache> {
    const namespaceKey = getNamespaceId(scope);
    let cache = this.#namespaceIndexes.get(namespaceKey);
    if (cache === undefined) {
      cache = {
        cancelFlush: null,
        dirty: false,
        entries: new Map(),
        flushPromise: null,
        loaded: false,
        loadPromise: null,
        scope,
      };
      this.#namespaceIndexes.set(namespaceKey, cache);
    }

    if (cache.loaded) return cache;
    if (cache.loadPromise !== null) {
      await cache.loadPromise;
      return cache;
    }

    cache.loadPromise = this.#readNamespaceIndexStateUsingDriver(
      this.driver,
      scope,
    )
      .then(({ entries, valid }) => {
        cache.loaded = true;
        cache.entries = valid && entries !== null ? entries : new Map();
      })
      .finally(() => {
        cache.loadPromise = null;
      });

    await cache.loadPromise;
    return cache;
  }

  async #refreshNamespaceIndexCache(
    scope: AsyncStorageNamespaceScope,
  ): Promise<NamespaceIndexCache> {
    const namespaceKey = getNamespaceId(scope);
    let cache = this.#namespaceIndexes.get(namespaceKey);
    if (cache === undefined) {
      cache = {
        cancelFlush: null,
        dirty: false,
        entries: new Map(),
        flushPromise: null,
        loaded: false,
        loadPromise: null,
        scope,
      };
      this.#namespaceIndexes.set(namespaceKey, cache);
    } else if (cache.loadPromise !== null) {
      await cache.loadPromise;
    }

    const state = await this.#readNamespaceIndexStateUsingDriver(
      this.driver,
      scope,
    );
    cache.entries =
      state.valid && state.entries !== null ? state.entries : new Map();
    cache.loaded = true;
    return cache;
  }

  #scheduleNamespaceIndexFlush(indexCache: NamespaceIndexCache): void {
    if (indexCache.cancelFlush !== null || indexCache.flushPromise !== null) {
      return;
    }

    indexCache.cancelFlush = scheduleIdleCleanup(() => {
      indexCache.cancelFlush = null;
      void this.#flushNamespaceIndex(indexCache.scope).catch(() => {});
    });
  }

  async #flushNamespaceIndex(scope: AsyncStorageNamespaceScope): Promise<void> {
    const indexCache = await this.#ensureNamespaceIndexLoaded(scope);
    if (indexCache.flushPromise !== null) {
      await indexCache.flushPromise;
      return;
    }

    indexCache.cancelFlush?.();
    indexCache.cancelFlush = null;

    if (!indexCache.dirty) return;

    const snapshot = new Map(indexCache.entries);
    indexCache.dirty = false;
    indexCache.flushPromise = this.#persistNamespaceIndexUsingDriver(
      this.driver,
      scope,
      snapshot,
    )
      .catch((error: unknown) => {
        indexCache.dirty = true;
        throw error;
      })
      .finally(() => {
        indexCache.flushPromise = null;
        if (indexCache.dirty) {
          this.#scheduleNamespaceIndexFlush(indexCache);
        }
      });

    await indexCache.flushPromise;
  }

  async #flushAllPendingNamespaceIndexes(): Promise<void> {
    await Promise.all(
      [...this.#namespaceIndexes.values()].map((indexCache) =>
        this.#flushNamespaceIndex(indexCache.scope),
      ),
    );
  }

  async #readNamespaceIndexStateUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys?: string[] | null,
  ): Promise<{
    entries: Map<string, InternalManagedMetadataRecord> | null;
    exists: boolean;
    valid: boolean;
  }> {
    if (
      knownRecordKeys !== undefined &&
      knownRecordKeys !== null &&
      !knownRecordKeys.includes(ASYNC_NAMESPACE_INDEX_RECORD_KEY)
    ) {
      return { entries: null, exists: false, valid: true };
    }
    const indexKnownToExist =
      knownRecordKeys !== undefined &&
      knownRecordKeys !== null &&
      knownRecordKeys.includes(ASYNC_NAMESPACE_INDEX_RECORD_KEY);

    const rawIndex = await driver.get(scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    if (rawIndex === null) {
      return indexKnownToExist
        ? { entries: null, exists: true, valid: false }
        : { entries: null, exists: false, valid: true };
    }

    const parsed = parseIndexEntries(rawIndex);
    if (parsed === null) {
      return { entries: null, exists: true, valid: false };
    }

    return { entries: parsed, exists: true, valid: true };
  }

  async #getNamespaceIndexEntriesUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys?: string[] | null,
  ): Promise<Map<string, InternalManagedMetadataRecord>> {
    if (driver === this.driver) {
      return (await this.#ensureNamespaceIndexLoaded(scope)).entries;
    }

    const state = await this.#readNamespaceIndexStateUsingDriver(
      driver,
      scope,
      knownRecordKeys,
    );
    return state.valid && state.entries !== null ? state.entries : new Map();
  }

  async #persistNamespaceIndexUsingDriver(
    driver: AsyncStorageDriver,
    scope: AsyncStorageNamespaceScope,
    entries: Map<string, InternalManagedMetadataRecord>,
  ): Promise<void> {
    if (entries.size === 0) {
      await this.#driverRemoveManyFrom(driver, scope, [
        ASYNC_NAMESPACE_INDEX_RECORD_KEY,
      ]);
      return;
    }

    await this.#driverSetManyFrom(driver, scope, [
      {
        key: ASYNC_NAMESPACE_INDEX_RECORD_KEY,
        value: serializeIndexEntries(entries),
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
    const metadataByKey = await this.#getNamespaceIndexEntriesUsingDriver(
      this.driver,
      scope,
    );
    const payloadKeys = keys.filter((key) => metadataByKey.has(key));
    const payloadValues = await this.#driverGetManyFrom(
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
    const metadataEntries = await this.#getNamespaceIndexEntriesUsingDriver(
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
    return [
      ...(await this.#ensureNamespaceIndexLoaded(scope)).entries.keys(),
    ].sort((left, right) => left.localeCompare(right));
  }

  async clearManagedNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    await this.driver.clear(scope);
    const namespaceKey = getNamespaceId(scope);
    const indexCache = this.#namespaceIndexes.get(namespaceKey);
    indexCache?.cancelFlush?.();
    this.#namespaceIndexes.delete(namespaceKey);
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
    const indexCache = await this.#refreshNamespaceIndexCache(scope);
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

    for (const key of removes) {
      indexCache.entries.delete(key);
    }

    const protectedKeysSnapshotSet = getSessionProtectedKeysSnapshot(
      scope.sessionKey,
    );

    for (const upsert of upserts) {
      const existingMetadata = indexCache.entries.get(upsert.key);
      const customMetadata = this.#mergeOfflineProtectionMetadata(
        scope,
        upsert.key,
        upsert.metadata,
        existingMetadata?.customMetadata,
        protectedKeysSnapshotSet,
      );
      const nextMetadata: InternalManagedMetadataRecord = {
        lastAccessAt: touchesByKey.get(upsert.key) ?? now,
        version: upsert.version,
        ...(customMetadata ? { customMetadata } : {}),
      };

      setEntries.push({
        key: getPayloadRecordKey(upsert.key),
        value: upsert.value,
      });
      indexCache.entries.set(upsert.key, nextMetadata);
    }

    let touchesApplied = false;
    const upsertKeySet = new Set(upserts.map((upsert) => upsert.key));
    for (const key of touchedKeys) {
      if (upsertKeySet.has(key)) continue;
      const metadata = indexCache.entries.get(key);
      if (!metadata) continue;
      indexCache.entries.set(key, {
        ...metadata,
        lastAccessAt: touchesByKey.get(key) ?? now,
      });
      touchesApplied = true;
    }

    if (removeEntries.length > 0) {
      await this.#driverRemoveManyFrom(this.driver, scope, removeEntries);
    }
    if (setEntries.length > 0) {
      await this.#driverSetManyFrom(this.driver, scope, setEntries);
    }

    const indexChanged =
      removes.length > 0 || upserts.length > 0 || touchesApplied;
    if (indexChanged) {
      indexCache.dirty = true;
      await this.#flushNamespaceIndex(scope);
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
        protectedKeysSnapshotSet.has(serializeProtectedRef({ ...scope, key })),
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

    if (driver === this.driver) {
      const indexCache = await this.#refreshNamespaceIndexCache(scope);
      let changed = false;
      for (const key of uniqueKeys) {
        changed = indexCache.entries.delete(key) || changed;
      }
      if (changed) {
        indexCache.dirty = true;
        await this.#flushNamespaceIndex(scope);
      }
      return;
    }

    const indexState = await this.#readNamespaceIndexStateUsingDriver(
      driver,
      scope,
    );
    if (!indexState.valid || indexState.entries === null) return;

    let changed = false;
    for (const key of uniqueKeys) {
      changed = indexState.entries.delete(key) || changed;
    }
    if (changed) {
      await this.#persistNamespaceIndexUsingDriver(
        driver,
        scope,
        indexState.entries,
      );
    }
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
    await this.#flushAllPendingNamespaceIndexes();
    await this.#withCleanupDriver((driver) =>
      this.#performStartupCleanupWithDriver(driver),
    );
  }

  async #performStartupCleanupWithDriver(
    driver: AsyncStorageDriver,
  ): Promise<void> {
    const discoveredScopes = await this.#listDiscoveredCleanupScopes(driver);
    const now = Date.now();
    const protectedRefsBySession = new Map(
      [...new Set(discoveredScopes.map(({ scope }) => scope.sessionKey))].map(
        (sessionKey) =>
          [sessionKey, getSessionProtectedKeysSnapshot(sessionKey)] as const,
      ),
    );

    await Promise.all(
      discoveredScopes.map(async ({ knownRecordKeys, scope }) => {
        const protectedRefs = protectedRefsBySession.get(scope.sessionKey);
        const rawKeys = knownRecordKeys ?? (await driver.listKeys(scope));
        const indexState = await this.#readNamespaceIndexStateUsingDriver(
          driver,
          scope,
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
            (key) =>
              key !== ASYNC_NAMESPACE_INDEX_RECORD_KEY || indexState.exists,
          );
          if (keysToRemove.length > 0) {
            await this.#driverRemoveManyFrom(driver, scope, keysToRemove);
          }
          return;
        }

        const nextEntries = new Map<string, InternalManagedMetadataRecord>();
        const payloadRecordKeysToRemove = new Set<string>([
          ...legacyMetadataRecordKeys,
          ...rawKeysToRemove,
        ]);

        for (const [key, metadata] of indexState.entries.entries()) {
          const isProtected =
            isOfflineProtectedMetadata(metadata.customMetadata) ||
            protectedRefs?.has(serializeProtectedRef({ ...scope, key })) ===
              true;
          if (!payloadKeys.has(key)) continue;
          if (
            !isProtected &&
            now - metadata.lastAccessAt > ASYNC_STORAGE_MAX_AGE_MS
          ) {
            payloadRecordKeysToRemove.add(getPayloadRecordKey(key));
            continue;
          }

          nextEntries.set(key, metadata);
        }

        for (const payloadKey of payloadKeys) {
          if (!indexState.entries.has(payloadKey)) {
            payloadRecordKeysToRemove.add(getPayloadRecordKey(payloadKey));
          }
        }

        const indexChanged =
          nextEntries.size !== indexState.entries.size ||
          rawKeysToRemove.length > 0 ||
          legacyMetadataRecordKeys.length > 0;

        const shouldDeleteEmptyIndex = indexChanged && nextEntries.size === 0;
        if (shouldDeleteEmptyIndex) {
          payloadRecordKeysToRemove.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
        }

        if (payloadRecordKeysToRemove.size > 0) {
          await this.#driverRemoveManyFrom(driver, scope, [
            ...payloadRecordKeysToRemove,
          ]);
        }

        if (indexChanged && !shouldDeleteEmptyIndex) {
          await this.#persistNamespaceIndexUsingDriver(
            driver,
            scope,
            nextEntries,
          );
        }
      }),
    );
  }

  async #listDiscoveredCleanupScopes(
    driver: AsyncStorageDriver,
    sessionKey?: string,
  ): Promise<AsyncStorageDiscoveredScope[]> {
    const discoveredScopes =
      await driver.listScopesWithKnownRecordKeys?.(sessionKey);
    if (discoveredScopes !== undefined) {
      return discoveredScopes.filter(
        ({ scope }) => scope.kind !== '__internal.protected',
      );
    }

    return (await this.#listDiscoveredScopes(sessionKey, driver)).map(
      (scope) => ({ knownRecordKeys: null, scope }),
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
