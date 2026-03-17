import { murmur3 } from '@ls-stack/utils/hash';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type {
  AsyncStorageAdapter,
  AsyncStorageEntryMetadata,
  AsyncStorageEntryMetadataBase,
  AsyncStorageMaintenanceState,
  AsyncStorageMetadataOrder,
  AsyncStorageMetadataPage,
  AsyncStorageNamespaceCommitArgs,
  AsyncStorageNamespaceGetResult,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceScope,
  AsyncStorageProtectedEntryRef,
  AsyncStorageReadOptions,
} from './types';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

const OPFS_CACHE_DIR = 'tsdf-cache-v2';
const ROOT_DIR = 'root';
const NAMESPACES_DIR = 'namespaces';
const REGISTRY_FILE = 'index.json';
const MAINTENANCE_FILE = 'maintenance.json';
const MANIFEST_FILE = 'manifest.json';
const LOOKUP_DIR = 'lookup';
const RECENCY_DIR = 'recency';
const ACCESS_BUCKETS_DIR = 'access';
const WRITE_BUCKETS_DIR = 'write';
const PAYLOADS_DIR = 'payloads';
const LOOKUP_SHARD_COUNT = 32;
const DEFAULT_METADATA_PAGE_LIMIT = 100;

export const OPFS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const OPFS_STARTUP_CLEANUP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
export const OPFS_STARTUP_CLEANUP_LEASE_TTL_MS = 60 * 1000;
export const OPFS_RECENCY_BUCKET_MS = 6 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

function toNamespaceDirName(scope: AsyncStorageNamespaceScope): string {
  return `ns-${murmur3(getNamespaceId(scope), 'uint32').toString(16)}`;
}

type NamespaceManifest = {
  sequence: number;
  lookup: Record<string, string>;
  accessBuckets: Record<string, string>;
  writeBuckets: Record<string, string>;
};

function createDefaultManifest(): NamespaceManifest {
  return { sequence: 0, lookup: {}, accessBuckets: {}, writeBuckets: {} };
}

function createDefaultMaintenanceState(): AsyncStorageMaintenanceState {
  return { lastSuccessfulCleanupAt: null, startupCleanupLease: null };
}

function isMaintenanceState(
  value: unknown,
): value is AsyncStorageMaintenanceState {
  return (
    isRecord(value) &&
    (value.lastSuccessfulCleanupAt === null ||
      typeof value.lastSuccessfulCleanupAt === 'number') &&
    (value.startupCleanupLease === null ||
      (isRecord(value.startupCleanupLease) &&
        typeof value.startupCleanupLease.holderId === 'string' &&
        typeof value.startupCleanupLease.expiresAt === 'number'))
  );
}

function isNamespaceManifest(value: unknown): value is NamespaceManifest {
  return (
    isRecord(value) &&
    typeof value.sequence === 'number' &&
    isRecord(value.lookup) &&
    isRecord(value.accessBuckets) &&
    isRecord(value.writeBuckets)
  );
}

type NamespaceRegistryEntry = AsyncStorageNamespaceScope & {
  id: string;
  dirName: string;
  updatedAt: number;
};

function isNamespaceRegistryEntry(
  value: unknown,
): value is NamespaceRegistryEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.dirName === 'string' &&
    typeof value.sessionKey === 'string' &&
    typeof value.storeName === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.updatedAt === 'number'
  );
}

type NamespaceRegistryFile = { entries: NamespaceRegistryEntry[] };

function isNamespaceRegistryFile(
  value: unknown,
): value is NamespaceRegistryFile {
  return (
    isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(isNamespaceRegistryEntry)
  );
}

type LookupShardFile = {
  entries: Record<string, AsyncStorageEntryMetadata<Record<string, unknown>>>;
};

function isLookupShardFile(value: unknown): value is LookupShardFile {
  return isRecord(value) && isRecord(value.entries);
}

type BucketFile = { keys: string[] };

function isBucketFile(value: unknown): value is BucketFile {
  return (
    isRecord(value) &&
    Array.isArray(value.keys) &&
    value.keys.every((key) => typeof key === 'string')
  );
}

function isMetadataBase(
  value: unknown,
): value is AsyncStorageEntryMetadataBase {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.payloadRef === 'string' &&
    typeof value.writtenAt === 'number' &&
    typeof value.lastAccessAt === 'number' &&
    typeof value.version === 'number' &&
    (value.sizeBytes === undefined || typeof value.sizeBytes === 'number')
  );
}

function getLookupShardId(key: string): string {
  return String(murmur3(key, 'uint32') % LOOKUP_SHARD_COUNT);
}

function getBucketId(timestamp: number): string {
  return String(Math.floor(timestamp / OPFS_RECENCY_BUCKET_MS));
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

function encodeCursor(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function decodeCursor(
  cursor: string | null | undefined,
): Record<string, unknown> | null {
  if (!cursor) return null;

  try {
    const parsed: unknown = JSON.parse(cursor);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compareMetadataByOrder(
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

async function iterateDirEntries(
  dir: FileSystemDirectoryHandle,
): Promise<string[]> {
  const names: string[] = [];

  for await (const [name] of dir.entries()) {
    names.push(name);
  }

  return names;
}

class OpfsNamespaceHandle<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, never>,
> implements AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
  constructor(
    private readonly adapter: OpfsAsyncStorageAdapter,
    private readonly scope: AsyncStorageNamespaceScope,
  ) {}

  async get(
    key: string,
    options: AsyncStorageReadOptions = {},
  ): Promise<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null> {
    const results = await this.getMany([key], options);
    return results[0] ?? null;
  }

  async getMany(
    keys: string[],
    options: AsyncStorageReadOptions = {},
  ): Promise<
    Array<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
  > {
    if (keys.length === 0) return [];

    try {
      const context = await this.adapter.loadNamespaceContext(this.scope);
      const removals: string[] = [];
      const touches: string[] = [];
      const now = Date.now();
      const uniqueKeys = uniq(keys);
      const metadataByKey = await this.adapter.readMetadataByKeys(
        context,
        uniqueKeys,
      );
      const resultsByKey = new Map<
        string,
        AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null
      >();

      for (const key of uniqueKeys) {
        const metadata = metadataByKey.get(key);
        if (!metadata) {
          resultsByKey.set(key, null);
          continue;
        }

        const payload = await this.adapter.readPayload<TValue>(
          context,
          metadata.payloadRef,
        );

        if (payload === null) {
          removals.push(key);
          resultsByKey.set(key, null);
          continue;
        }

        const touchMode = options.touch ?? 'coarse';
        const shouldTouch =
          touchMode === 'force' ||
          (touchMode === 'coarse' &&
            getBucketId(metadata.lastAccessAt) !== getBucketId(now));

        if (shouldTouch) {
          touches.push(key);
        }

        resultsByKey.set(key, {
          value: payload,
          metadata: __LEGIT_CAST__<
            AsyncStorageEntryMetadata<TCustomMetadata>,
            AsyncStorageEntryMetadata<Record<string, unknown>>
          >({ ...metadata, ...(shouldTouch ? { lastAccessAt: now } : {}) }),
        });
      }

      if (removals.length > 0 || touches.length > 0) {
        await this.commit({
          removes: removals,
          touches: touches.map((key) => ({ key, lastAccessAt: now })),
        });
      }

      return keys.map((key) => resultsByKey.get(key) ?? null);
    } catch {
      return keys.map(() => null);
    }
  }

  commit(
    args: AsyncStorageNamespaceCommitArgs<TValue, TCustomMetadata>,
  ): Promise<void> {
    return this.adapter.commitToNamespace(this.scope, args).catch(() => {});
  }

  async listMetadata(
    args: {
      cursor?: string | null;
      limit?: number;
      order?: AsyncStorageMetadataOrder;
    } = {},
  ): Promise<AsyncStorageMetadataPage<TCustomMetadata>> {
    try {
      const context = await this.adapter.loadNamespaceContext(this.scope);
      const order = args.order ?? 'key';
      const limit = Math.max(1, args.limit ?? DEFAULT_METADATA_PAGE_LIMIT);
      const cursorData = decodeCursor(args.cursor);
      const offset =
        cursorData && typeof cursorData.offset === 'number'
          ? cursorData.offset
          : 0;
      const cursorOrder =
        cursorData && typeof cursorData.order === 'string'
          ? cursorData.order
          : order;

      const allMetadata = await this.adapter.listAllMetadata(context);
      const sorted = allMetadata.sort((left, right) =>
        compareMetadataByOrder(left, right, order),
      );

      const nextEntries = sorted.slice(offset, offset + limit);
      const nextCursor =
        offset + nextEntries.length >= sorted.length
          ? null
          : encodeCursor({ offset: offset + nextEntries.length, order });

      return {
        entries: __LEGIT_CAST__<
          AsyncStorageEntryMetadata<TCustomMetadata>[],
          AsyncStorageEntryMetadata<Record<string, unknown>>[]
        >(nextEntries),
        cursor:
          cursorOrder === order
            ? nextCursor
            : encodeCursor({ offset: 0, order }),
      };
    } catch {
      return { entries: [], cursor: null };
    }
  }

  clear(): Promise<void> {
    return this.adapter.clearNamespace(this.scope).catch(() => {});
  }
}

type CachedNamespace = {
  entry: NamespaceRegistryEntry;
  dir: Promise<FileSystemDirectoryHandle>;
};

export class OpfsAsyncStorageAdapter implements AsyncStorageAdapter {
  readonly kind = 'async' as const;

  private rootDirPromise: Promise<FileSystemDirectoryHandle> | null = null;
  private registryPromise: Promise<NamespaceRegistryFile> | null = null;
  private namespaceCache = new Map<string, CachedNamespace>();
  private startupCleanupScheduled = false;

  openNamespace<
    TValue,
    TCustomMetadata extends Record<string, unknown> = Record<string, never>,
  >(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
    this.scheduleStartupCleanupIfNeeded();
    return new OpfsNamespaceHandle<TValue, TCustomMetadata>(this, scope);
  }

  async readMaintenanceState(): Promise<AsyncStorageMaintenanceState> {
    const root = await this.getRootDir();
    const maintenance = await this.readJsonFile<AsyncStorageMaintenanceState>(
      root,
      MAINTENANCE_FILE,
    );
    return isMaintenanceState(maintenance)
      ? maintenance
      : createDefaultMaintenanceState();
  }

  async tryAcquireStartupCleanupLease(args: {
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

  async finishStartupCleanup(args: {
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

  async clearSession(sessionKey: string): Promise<void> {
    const registry = await this.readRegistry();
    const remaining: NamespaceRegistryEntry[] = [];

    for (const entry of registry.entries) {
      if (entry.sessionKey !== sessionKey) {
        remaining.push(entry);
        continue;
      }

      const namespacesDir = await this.getNamespacesDir();
      try {
        await namespacesDir.removeEntry(entry.dirName, { recursive: true });
      } catch {
        // Ignore missing directories.
      }
      this.namespaceCache.delete(entry.id);
    }

    await this.writeRegistry({ entries: remaining });
  }

  resetForTests(): void {
    this.rootDirPromise = null;
    this.registryPromise = null;
    this.namespaceCache.clear();
    this.startupCleanupScheduled = false;
  }

  async loadNamespaceContext(
    scope: AsyncStorageNamespaceScope,
  ): Promise<{
    entry: NamespaceRegistryEntry;
    dir: FileSystemDirectoryHandle;
    manifest: NamespaceManifest;
  }> {
    const entry = await this.ensureNamespaceEntry(scope);
    const dir = await this.getNamespaceDir(entry);
    const manifest = await this.readManifest(dir);
    return { entry, dir, manifest };
  }

  async listAllMetadata(
    context: Awaited<
      ReturnType<OpfsAsyncStorageAdapter['loadNamespaceContext']>
    >,
  ): Promise<AsyncStorageEntryMetadata<Record<string, unknown>>[]> {
    const shardFiles = Object.values(context.manifest.lookup);
    const lookupDir = await context.dir.getDirectoryHandle(LOOKUP_DIR, {
      create: true,
    });
    const entries: AsyncStorageEntryMetadata<Record<string, unknown>>[] = [];

    for (const fileName of shardFiles) {
      const shard = await this.readJsonFile<LookupShardFile>(
        lookupDir,
        fileName,
      );
      if (!isLookupShardFile(shard)) continue;

      for (const entry of Object.values(shard.entries)) {
        if (isMetadataBase(entry)) {
          entries.push(entry);
        }
      }
    }

    return entries;
  }

  async readMetadataByKeys(
    context: Awaited<
      ReturnType<OpfsAsyncStorageAdapter['loadNamespaceContext']>
    >,
    keys: string[],
  ): Promise<Map<string, AsyncStorageEntryMetadata<Record<string, unknown>>>> {
    const lookupDir = await context.dir.getDirectoryHandle(LOOKUP_DIR, {
      create: true,
    });
    const shardIds = uniq(keys.map((key) => getLookupShardId(key)));
    const shardEntries = new Map<
      string,
      Record<string, AsyncStorageEntryMetadata<Record<string, unknown>>>
    >();

    for (const shardId of shardIds) {
      const fileName = context.manifest.lookup[shardId];
      if (!fileName) continue;

      const shard = await this.readJsonFile<LookupShardFile>(
        lookupDir,
        fileName,
      );
      if (!isLookupShardFile(shard)) continue;

      const validEntries = Object.fromEntries(
        Object.entries(shard.entries).filter((entry) =>
          isMetadataBase(entry[1]),
        ),
      );
      shardEntries.set(shardId, validEntries);
    }

    const result = new Map<
      string,
      AsyncStorageEntryMetadata<Record<string, unknown>>
    >();

    for (const key of keys) {
      const shardEntriesForKey = shardEntries.get(getLookupShardId(key));
      const metadata = shardEntriesForKey?.[key];
      if (metadata) {
        result.set(key, metadata);
      }
    }

    return result;
  }

  async readPayload<TValue>(
    context: Awaited<
      ReturnType<OpfsAsyncStorageAdapter['loadNamespaceContext']>
    >,
    payloadRef: string,
  ): Promise<TValue | null> {
    const payloadsDir = await context.dir.getDirectoryHandle(PAYLOADS_DIR, {
      create: true,
    });
    return this.readJsonFile<TValue>(payloadsDir, `${payloadRef}.json`);
  }

  async commitToNamespace<
    TValue,
    TCustomMetadata extends Record<string, unknown>,
  >(
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<TValue, TCustomMetadata>,
  ): Promise<void> {
    const upserts = args.upserts ?? [];
    const removes = uniq(args.removes ?? []);
    const touchesByKey = new Map(
      (args.touches ?? []).map((touch) => [touch.key, touch.lastAccessAt]),
    );
    const keys = uniq([
      ...upserts.map((upsert) => upsert.key),
      ...removes,
      ...touchesByKey.keys(),
    ]);
    if (keys.length === 0) return;

    const context = await this.loadNamespaceContext(scope);
    const now = Date.now();
    const lookupDir = await context.dir.getDirectoryHandle(LOOKUP_DIR, {
      create: true,
    });
    const payloadsDir = await context.dir.getDirectoryHandle(PAYLOADS_DIR, {
      create: true,
    });
    const [accessBucketsDir, writeBucketsDir] = await Promise.all([
      this.getBucketDir(context.dir, ACCESS_BUCKETS_DIR),
      this.getBucketDir(context.dir, WRITE_BUCKETS_DIR),
    ]);
    const existingMetadata = await this.readMetadataByKeys(context, keys);
    const changedShardIds = new Set(keys.map((key) => getLookupShardId(key)));
    const shardEntries = new Map<
      string,
      Record<string, AsyncStorageEntryMetadata<Record<string, unknown>>>
    >();
    const bucketUpdates = {
      access: new Map<string, Set<string>>(),
      write: new Map<string, Set<string>>(),
    };
    const currentManifest: NamespaceManifest = {
      sequence: context.manifest.sequence,
      lookup: { ...context.manifest.lookup },
      accessBuckets: { ...context.manifest.accessBuckets },
      writeBuckets: { ...context.manifest.writeBuckets },
    };

    for (const shardId of changedShardIds) {
      const fileName = currentManifest.lookup[shardId];
      if (!fileName) {
        shardEntries.set(shardId, {});
        continue;
      }

      const shard = await this.readJsonFile<LookupShardFile>(
        lookupDir,
        fileName,
      );
      if (!isLookupShardFile(shard)) {
        shardEntries.set(shardId, {});
        continue;
      }

      shardEntries.set(
        shardId,
        Object.fromEntries(
          Object.entries(shard.entries).filter((entry) =>
            isMetadataBase(entry[1]),
          ),
        ),
      );
    }

    const touchedBucketIds = new Set<string>();

    const loadBucketSet = async (
      dir: FileSystemDirectoryHandle,
      fileName: string | undefined,
      cache: Map<string, Set<string>>,
      bucketId: string,
      fallback = new Set<string>(),
    ): Promise<Set<string>> => {
      if (cache.has(bucketId)) {
        return cache.get(bucketId) ?? fallback;
      }

      if (!fileName) {
        cache.set(bucketId, new Set(fallback));
        return cache.get(bucketId) ?? fallback;
      }

      const bucket = await this.readJsonFile<BucketFile>(dir, fileName);
      const set = new Set(isBucketFile(bucket) ? bucket.keys : []);
      cache.set(bucketId, set);
      return set;
    };

    for (const key of keys) {
      const existing = existingMetadata.get(key);
      if (existing) {
        const accessBucketId = getBucketId(existing.lastAccessAt);
        const writeBucketId = getBucketId(existing.writtenAt);
        touchedBucketIds.add(accessBucketId);
        touchedBucketIds.add(writeBucketId);
        const accessBucketSet = await loadBucketSet(
          accessBucketsDir,
          currentManifest.accessBuckets[accessBucketId],
          bucketUpdates.access,
          accessBucketId,
        );
        const writeBucketSet = await loadBucketSet(
          writeBucketsDir,
          currentManifest.writeBuckets[writeBucketId],
          bucketUpdates.write,
          writeBucketId,
        );
        accessBucketSet.delete(key);
        writeBucketSet.delete(key);
      }
    }

    for (const removedKey of removes) {
      const shardId = getLookupShardId(removedKey);
      const entries = shardEntries.get(shardId);
      if (entries) {
        delete entries[removedKey];
      }
    }

    for (const [key, lastAccessAt] of touchesByKey) {
      const metadata = existingMetadata.get(key);
      if (!metadata || removes.includes(key)) continue;

      const nextLastAccessAt = lastAccessAt ?? now;
      const nextMetadata = { ...metadata, lastAccessAt: nextLastAccessAt };
      const shardId = getLookupShardId(key);
      const entries = shardEntries.get(shardId);
      if (entries) {
        entries[key] = nextMetadata;
      }

      const accessBucketId = getBucketId(nextLastAccessAt);
      touchedBucketIds.add(accessBucketId);
      const accessBucketSet = await loadBucketSet(
        accessBucketsDir,
        currentManifest.accessBuckets[accessBucketId],
        bucketUpdates.access,
        accessBucketId,
      );
      accessBucketSet.add(key);
    }

    for (const upsert of upserts) {
      const payloadRef = `payload-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      const payloadRaw = JSON.stringify(upsert.value);
      await this.writeTextFile(payloadsDir, `${payloadRef}.json`, payloadRaw);

      const existing = existingMetadata.get(upsert.key);
      if (existing && existing.payloadRef !== payloadRef) {
        try {
          await payloadsDir.removeEntry(`${existing.payloadRef}.json`);
        } catch {
          // Ignore missing payloads.
        }
      }

      const metadata: AsyncStorageEntryMetadata<Record<string, unknown>> = {
        key: upsert.key,
        payloadRef,
        writtenAt: now,
        lastAccessAt:
          touchesByKey.get(upsert.key) ?? existing?.lastAccessAt ?? now,
        sizeBytes: payloadRaw.length,
        version: upsert.version,
        ...(upsert.metadata ?? {}),
      };

      const shardId = getLookupShardId(upsert.key);
      const entries = shardEntries.get(shardId);
      if (entries) {
        entries[upsert.key] = metadata;
      } else {
        shardEntries.set(shardId, { [upsert.key]: metadata });
      }

      const accessBucketId = getBucketId(metadata.lastAccessAt);
      const writeBucketId = getBucketId(metadata.writtenAt);
      touchedBucketIds.add(accessBucketId);
      touchedBucketIds.add(writeBucketId);

      const accessBucketSet = await loadBucketSet(
        accessBucketsDir,
        currentManifest.accessBuckets[accessBucketId],
        bucketUpdates.access,
        accessBucketId,
      );
      const writeBucketSet = await loadBucketSet(
        writeBucketsDir,
        currentManifest.writeBuckets[writeBucketId],
        bucketUpdates.write,
        writeBucketId,
      );
      accessBucketSet.add(upsert.key);
      writeBucketSet.add(upsert.key);
    }

    currentManifest.sequence += 1;

    for (const [shardId, entries] of shardEntries) {
      if (Object.keys(entries).length === 0) {
        delete currentManifest.lookup[shardId];
        continue;
      }

      const fileName = `lookup-${shardId}-${currentManifest.sequence}.json`;
      await this.writeJsonFile(lookupDir, fileName, { entries });
      currentManifest.lookup[shardId] = fileName;
    }

    for (const bucketId of touchedBucketIds) {
      const accessSet = bucketUpdates.access.get(bucketId);
      if (accessSet) {
        if (accessSet.size === 0) {
          delete currentManifest.accessBuckets[bucketId];
        } else {
          const fileName = `access-${bucketId}-${currentManifest.sequence}.json`;
          await this.writeJsonFile(accessBucketsDir, fileName, {
            keys: [...accessSet].sort(),
          });
          currentManifest.accessBuckets[bucketId] = fileName;
        }
      }

      const writeSet = bucketUpdates.write.get(bucketId);
      if (writeSet) {
        if (writeSet.size === 0) {
          delete currentManifest.writeBuckets[bucketId];
        } else {
          const fileName = `write-${bucketId}-${currentManifest.sequence}.json`;
          await this.writeJsonFile(writeBucketsDir, fileName, {
            keys: [...writeSet].sort(),
          });
          currentManifest.writeBuckets[bucketId] = fileName;
        }
      }
    }

    await this.writeManifest(context.dir, currentManifest);
    await this.touchNamespaceEntry(context.entry);
  }

  async clearNamespace(scope: AsyncStorageNamespaceScope): Promise<void> {
    const entry = await this.findNamespaceEntry(scope);
    if (!entry) return;

    const namespacesDir = await this.getNamespacesDir();
    try {
      await namespacesDir.removeEntry(entry.dirName, { recursive: true });
    } catch {
      // Ignore missing directories.
    }

    const registry = await this.readRegistry();
    await this.writeRegistry({
      entries: registry.entries.filter((item) => item.id !== entry.id),
    });
    this.namespaceCache.delete(entry.id);
  }

  private scheduleStartupCleanupIfNeeded(): void {
    if (this.startupCleanupScheduled) return;
    this.startupCleanupScheduled = true;

    scheduleIdleCleanup(() => {
      void this.runStartupCleanupIfDue().catch(() => {
        // Ignore startup cleanup failures; regular reads/writes still self-heal.
      });
    });
  }

  private async runStartupCleanupIfDue(): Promise<void> {
    const maintenance = await this.readMaintenanceState();
    const now = Date.now();
    if (
      maintenance.lastSuccessfulCleanupAt !== null &&
      now - maintenance.lastSuccessfulCleanupAt <
        OPFS_STARTUP_CLEANUP_COOLDOWN_MS
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
      ttlMs: OPFS_STARTUP_CLEANUP_LEASE_TTL_MS,
    });
    if (!acquired) return;

    try {
      await this.performStartupCleanup();
      await this.finishStartupCleanup({ holderId, finishedAt: Date.now() });
    } catch {
      // Leave the lease to expire naturally if cleanup crashes.
    }
  }

  private async performStartupCleanup(): Promise<void> {
    const registry = await this.readRegistry();
    const protectedRefsBySession = new Map<string, Set<string>>();

    for (const entry of registry.entries) {
      const context = await this.loadNamespaceContext(entry);
      const cached = protectedRefsBySession.get(entry.sessionKey);
      const protectedRefs =
        cached ?? (await this.readProtectedRefs(entry.sessionKey));
      if (!cached) protectedRefsBySession.set(entry.sessionKey, protectedRefs);
      const metadataEntries = await this.listAllMetadata(context);
      const referencedPayloads = new Set<string>();
      const [lookupDir, accessDir, writeDir, payloadsDir] = await Promise.all([
        context.dir.getDirectoryHandle(LOOKUP_DIR, { create: true }),
        this.getBucketDir(context.dir, ACCESS_BUCKETS_DIR),
        this.getBucketDir(context.dir, WRITE_BUCKETS_DIR),
        context.dir.getDirectoryHandle(PAYLOADS_DIR, { create: true }),
      ]);
      const nextRemoves: string[] = [];

      for (const metadata of metadataEntries) {
        const protectedKey = serializeProtectedRef({
          ...entry,
          key: metadata.key,
        });
        const isProtected = protectedRefs.has(protectedKey);
        const isExpired =
          nowMinusLatest(metadata, Date.now()) > OPFS_MAX_AGE_MS;
        if (isExpired && !isProtected) {
          nextRemoves.push(metadata.key);
          continue;
        }

        referencedPayloads.add(metadata.payloadRef);
      }

      if (nextRemoves.length > 0) {
        await this.commitToNamespace(entry, { removes: nextRemoves });
      }

      const manifest = await this.readManifest(context.dir);
      const lookupCurrent = new Set(Object.values(manifest.lookup));
      const accessCurrent = new Set(Object.values(manifest.accessBuckets));
      const writeCurrent = new Set(Object.values(manifest.writeBuckets));

      for (const fileName of await iterateDirEntries(lookupDir)) {
        if (!lookupCurrent.has(fileName)) {
          try {
            await lookupDir.removeEntry(fileName);
          } catch {
            // Ignore.
          }
        }
      }

      for (const fileName of await iterateDirEntries(accessDir)) {
        if (!accessCurrent.has(fileName)) {
          try {
            await accessDir.removeEntry(fileName);
          } catch {
            // Ignore.
          }
        }
      }

      for (const fileName of await iterateDirEntries(writeDir)) {
        if (!writeCurrent.has(fileName)) {
          try {
            await writeDir.removeEntry(fileName);
          } catch {
            // Ignore.
          }
        }
      }

      for (const fileName of await iterateDirEntries(payloadsDir)) {
        if (!fileName.endsWith('.json')) continue;
        const payloadRef = fileName.slice(0, -'.json'.length);
        if (referencedPayloads.has(payloadRef)) continue;
        try {
          await payloadsDir.removeEntry(fileName);
        } catch {
          // Ignore.
        }
      }
    }
  }

  private async readProtectedRefs(sessionKey: string): Promise<Set<string>> {
    const scope: AsyncStorageNamespaceScope = {
      sessionKey,
      storeName: '__offline__',
      kind: '__internal.protected',
    };
    const namespace = this.openNamespace<{ keys: string[] }>(scope);
    const entry = await namespace.get('registry', { touch: 'never' });
    return new Set(entry?.value.keys ?? []);
  }

  private async getRootDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootDirPromise) {
      this.rootDirPromise = (async () => {
        const root = await navigator.storage.getDirectory();
        const cacheDir = await root.getDirectoryHandle(OPFS_CACHE_DIR, {
          create: true,
        });
        return cacheDir.getDirectoryHandle(ROOT_DIR, { create: true });
      })();
    }

    return this.rootDirPromise;
  }

  private async getNamespacesDir(): Promise<FileSystemDirectoryHandle> {
    const root = await this.getRootDir();
    return root.getDirectoryHandle(NAMESPACES_DIR, { create: true });
  }

  private async getNamespaceDir(
    entry: NamespaceRegistryEntry,
  ): Promise<FileSystemDirectoryHandle> {
    const cached = this.namespaceCache.get(entry.id);
    if (cached) {
      return cached.dir;
    }

    const namespacesDir = await this.getNamespacesDir();
    const dir = namespacesDir.getDirectoryHandle(entry.dirName, {
      create: true,
    });
    this.namespaceCache.set(entry.id, { entry, dir });
    return dir;
  }

  private async getBucketDir(
    namespaceDir: FileSystemDirectoryHandle,
    bucketKind: typeof ACCESS_BUCKETS_DIR | typeof WRITE_BUCKETS_DIR,
  ): Promise<FileSystemDirectoryHandle> {
    const recencyDir = await namespaceDir.getDirectoryHandle(RECENCY_DIR, {
      create: true,
    });
    return recencyDir.getDirectoryHandle(bucketKind, { create: true });
  }

  private async readRegistry(): Promise<NamespaceRegistryFile> {
    if (!this.registryPromise) {
      this.registryPromise = (async () => {
        const namespacesDir = await this.getNamespacesDir();
        const registry = await this.readJsonFile<NamespaceRegistryFile>(
          namespacesDir,
          REGISTRY_FILE,
        );
        return isNamespaceRegistryFile(registry) ? registry : { entries: [] };
      })();
    }

    return this.registryPromise;
  }

  private async writeRegistry(registry: NamespaceRegistryFile): Promise<void> {
    const namespacesDir = await this.getNamespacesDir();
    await this.writeJsonFile(namespacesDir, REGISTRY_FILE, registry);
    this.registryPromise = Promise.resolve(registry);
  }

  private async ensureNamespaceEntry(
    scope: AsyncStorageNamespaceScope,
  ): Promise<NamespaceRegistryEntry> {
    const existing = await this.findNamespaceEntry(scope);
    if (existing) return existing;

    const registry = await this.readRegistry();
    const nextEntry: NamespaceRegistryEntry = {
      ...scope,
      id: getNamespaceId(scope),
      dirName: toNamespaceDirName(scope),
      updatedAt: Date.now(),
    };

    await this.writeRegistry({ entries: [...registry.entries, nextEntry] });

    const dir = await this.getNamespaceDir(nextEntry);
    await dir.getDirectoryHandle(LOOKUP_DIR, { create: true });
    await dir.getDirectoryHandle(PAYLOADS_DIR, { create: true });
    await this.getBucketDir(dir, ACCESS_BUCKETS_DIR);
    await this.getBucketDir(dir, WRITE_BUCKETS_DIR);
    await this.writeManifest(dir, createDefaultManifest());

    return nextEntry;
  }

  private async findNamespaceEntry(
    scope: AsyncStorageNamespaceScope,
  ): Promise<NamespaceRegistryEntry | null> {
    const registry = await this.readRegistry();
    const id = getNamespaceId(scope);
    return registry.entries.find((entry) => entry.id === id) ?? null;
  }

  private async touchNamespaceEntry(
    entry: NamespaceRegistryEntry,
  ): Promise<void> {
    const registry = await this.readRegistry();
    const nextEntries = registry.entries.map((current) =>
      current.id === entry.id ? { ...current, updatedAt: Date.now() } : current,
    );
    await this.writeRegistry({ entries: nextEntries });
  }

  private async readManifest(
    namespaceDir: FileSystemDirectoryHandle,
  ): Promise<NamespaceManifest> {
    const manifest = await this.readJsonFile<NamespaceManifest>(
      namespaceDir,
      MANIFEST_FILE,
    );
    return isNamespaceManifest(manifest) ? manifest : createDefaultManifest();
  }

  private writeManifest(
    namespaceDir: FileSystemDirectoryHandle,
    manifest: NamespaceManifest,
  ): Promise<void> {
    return this.writeJsonFile(namespaceDir, MANIFEST_FILE, manifest);
  }

  private async writeMaintenanceState(
    state: AsyncStorageMaintenanceState,
  ): Promise<void> {
    const root = await this.getRootDir();
    await this.writeJsonFile(root, MAINTENANCE_FILE, state);
  }

  private async readJsonFile<T>(
    dir: FileSystemDirectoryHandle,
    fileName: string,
  ): Promise<T | null> {
    try {
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return __LEGIT_CAST__<T, unknown>(JSON.parse(await file.text()));
    } catch {
      return null;
    }
  }

  private async writeJsonFile(
    dir: FileSystemDirectoryHandle,
    fileName: string,
    value: unknown,
  ): Promise<void> {
    await this.writeTextFile(dir, fileName, JSON.stringify(value));
  }

  private async writeTextFile(
    dir: FileSystemDirectoryHandle,
    fileName: string,
    raw: string,
  ): Promise<void> {
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(raw);
    await writable.close();
  }
}

function nowMinusLatest(
  metadata: AsyncStorageEntryMetadata<Record<string, unknown>>,
  now: number,
): number {
  return now - Math.max(metadata.lastAccessAt, metadata.writtenAt);
}

export function serializeProtectedRef(
  ref: AsyncStorageProtectedEntryRef,
): string {
  return JSON.stringify([ref.sessionKey, ref.storeName, ref.kind, ref.key]);
}
