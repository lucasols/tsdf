import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  getPayloadRecordKey,
  joinPath,
  OPFS_ROOT_DIR,
  parseFileNameInfo,
} from '../../src/persistentStorage/opfsFileNaming';
import {
  createIndexedDbPersistentStorageForTests,
  type IndexedDbPersistentStorageOperation,
  type IndexedDbPersistentStorageOptions,
} from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';

const INDEXED_DB_ENTRY_STORE = 'entries';
const INDEXED_DB_NAMESPACE_POLICY_STORE = 'namespacePolicies';
const INDEXED_DB_META_STORE = 'meta';
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

type IndexedDbEntryRecord = {
  a: number;
  d: unknown;
  g?: string;
  k: string;
  m?: Record<string, unknown>;
  n: string;
  o: 0 | 1;
  s: string;
  t: AsyncStorageNamespaceScope['kind'];
  v: number;
};

type IndexedDbNamespacePolicyRecord = {
  n: string;
  p: AsyncStorageNamespaceStaticPolicy | null;
  s: string;
  t: AsyncStorageNamespaceScope['kind'];
};

type StorageSeedOptions = { timestamp?: number; version?: number };

type ListQuerySeedItemOptions = StorageSeedOptions & {
  loadedFields?: string[];
};

type ListQueryItemRef = string | { tableId: string; id: number | string };





type IndexedDbPersistentStorageTestStoreOptions = {
  databaseName?: string;
  initialState?: {
    storeName: string;
    sessionKey: string;
    document?: { data: unknown; timestamp?: number; version?: number };
    collection?: Array<{
      payload: string;
      data: unknown;
      timestamp?: number;
      version?: number;
    }>;
    listQuery?: {
      items?: Array<{
        tableId: string;
        id: number | string;
        data: unknown;
        timestamp?: number;
        version?: number;
      }>;
      queries?: Array<{
        params: unknown;
        items: Array<{ tableId: string; id: number | string }>;
        hasMore?: boolean;
        timestamp?: number;
        version?: number;
      }>;
    };
    rawEntries?: Record<string, unknown>;
  };
  persistentStorageOptions?: IndexedDbPersistentStorageOptions;
};

type IndexedDbPersistentStorageTestStoreScope = {
  document: {
    namespace: AsyncStorageNamespaceScope;
    storageKey: () => string;
    seed: <T>(data: T, options?: StorageSeedOptions) => string;
    setPayload: (value: unknown) => void;
    setMetadata: (value: unknown) => void;
    removePayload: () => void;
    removeMetadata: () => void;
  };
  collection: {
    namespace: AsyncStorageNamespaceScope;
    itemKey: (payload: string) => string;
    itemStorageKey: (payload: string) => string;
    listStoredPayloads: () => string[];
    setStaticPolicy: (policy: Record<string, unknown>) => void;
    seedItem: <T>(
      payload: string,
      data: T,
      options?: StorageSeedOptions,
    ) => string;
  };
  listQuery: {
    itemNamespace: AsyncStorageNamespaceScope;
    queryNamespace: AsyncStorageNamespaceScope;
    itemKey: (tableId: string, id: number | string) => string;
    itemStorageKey: (tableId: string, id: number | string) => string;
    queryKey: (params: unknown) => string;
    queryStorageKey: (params: unknown) => string;
    listStoredItemKeys: () => string[];
    listStoredQueryKeys: () => string[];
    setItemStaticPolicy: (policy: Record<string, unknown>) => void;
    setQueryStaticPolicy: (policy: Record<string, unknown>) => void;
    seedItem: <T>(
      tableId: string,
      id: number | string,
      data: T,
      options?: ListQuerySeedItemOptions,
    ) => { itemKey: string; payload: string; storageKey: string };
    seedQuery: (
      params: unknown,
      items: ListQueryItemRef[],
      options?: StorageSeedOptions & { hasMore?: boolean },
    ) => string;
  };
};

function itemKey(payload: string): string {
  return getCompositeKey(payload);
}

function listQueryItemKey(tableId: string, id: number | string): string {
  return getCompositeKey(`${tableId}||${id}`);
}

function listQueryQueryKey(params: unknown): string {
  return getCompositeKey(params);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
}

function createStorageCacheEntry<T>(
  data: T,
  options: { timestamp?: number; version?: number } = {},
): StorageCacheEntry<T> {
  return {
    data,
    timestamp: options.timestamp ?? Date.now(),
    version: options.version ?? 1,
  };
}

function getLogicalStorageKey(
  scope: AsyncStorageNamespaceScope,
  key: string,
): string {
  switch (scope.kind) {
    case 'document':
      return scope.storeName === '__offline__'
        ? `tsdf.${scope.sessionKey}.__offline__.session`
        : `tsdf.${scope.sessionKey}.${scope.storeName}`;
    case 'collection.item':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.ci.${key}`;
    case 'listQuery.item':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.li.${key}`;
    case 'listQuery.query':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.lq.${key}`;
    case 'offline.queue':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.oq.${key}`;
    case 'offline.conflict':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.oc.${key}`;
    case 'offline.entity':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.oe.${key}`;
    case '__internal.protected':
      return `tsdf.${scope.sessionKey}._o_.p`;
  }
}

type ParsedFlatKey = { key: string; scope: AsyncStorageNamespaceScope };

function parseFlatStorageKey(key: string): ParsedFlatKey | null {
  const prefix = 'tsdf.';
  if (!key.startsWith(prefix)) return null;

  const withoutPrefix = key.slice(prefix.length);

  if (withoutPrefix.endsWith('._o_.p')) {
    return {
      key: 'document',
      scope: {
        kind: 'document',
        sessionKey: withoutPrefix.slice(0, -'._o_.p'.length),
        storeName: '_o_.p',
      },
    };
  }

  if (withoutPrefix.endsWith('.__offline__.session')) {
    return {
      key: 'session',
      scope: {
        kind: 'document',
        sessionKey: withoutPrefix.slice(0, -'.__offline__.session'.length),
        storeName: '__offline__',
      },
    };
  }

  const namespaceMarkers = [
    ['.ci.', 'collection.item'],
    ['.li.', 'listQuery.item'],
    ['.lq.', 'listQuery.query'],
    ['.oq.', 'offline.queue'],
    ['.oc.', 'offline.conflict'],
    ['.oe.', 'offline.entity'],
  ] as const;

  for (const [marker, kind] of namespaceMarkers) {
    const markerIndex = withoutPrefix.indexOf(marker);
    if (markerIndex < 0) continue;

    const beforeMarker = withoutPrefix.slice(0, markerIndex);
    const entryKey = withoutPrefix.slice(markerIndex + marker.length);
    const lastSeparatorIndex = beforeMarker.lastIndexOf('.');
    if (lastSeparatorIndex < 0 || entryKey.length === 0) return null;

    return {
      key: entryKey,
      scope: {
        kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(kind),
        sessionKey: beforeMarker.slice(0, lastSeparatorIndex),
        storeName: beforeMarker.slice(lastSeparatorIndex + 1),
      },
    };
  }

  const lastSeparatorIndex = withoutPrefix.lastIndexOf('.');
  if (lastSeparatorIndex <= 0) return null;

  return {
    key: 'document',
    scope: {
      kind: 'document',
      sessionKey: withoutPrefix.slice(0, lastSeparatorIndex),
      storeName: withoutPrefix.slice(lastSeparatorIndex + 1),
    },
  };
}

function buildCustomMetadata(
  scope: AsyncStorageNamespaceScope,
  data: unknown,
): Record<string, unknown> {
  const record = getRecord(data);
  if (record === null) return {};

  switch (scope.kind) {
    case 'collection.item':
    case 'listQuery.item':
      return typeof record.payload === 'string'
        ? { p: record.payload }
        : typeof record.p === 'string'
          ? { p: record.p }
          : {};
    case 'listQuery.query':
      return {
        ...(typeof record.payload === 'object' ||
        typeof record.payload === 'string'
          ? { p: record.payload }
          : 'p' in record
            ? { p: record.p }
            : {}),
      };
    default:
      return {};
  }
}

function normalizeTestStaticPolicy(
  policy: Record<string, unknown>,
): AsyncStorageNamespaceStaticPolicy {
  return {
    ...(typeof policy.m === 'number' ? { maxEntries: policy.m } : {}),
    ...(Array.isArray(policy.p)
      ? {
          pinnedKeys: policy.p.filter(
            (value): value is string => typeof value === 'string',
          ),
        }
      : {}),
  };
}

function serializeTestStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): Record<string, unknown> | null {
  if (policy === undefined || policy === null) return null;

  return {
    ...(typeof policy.maxEntries === 'number' ? { m: policy.maxEntries } : {}),
    ...(Array.isArray(policy.pinnedKeys) ? { p: policy.pinnedKeys } : {}),
  };
}

type ManagedMetadataRecord = {
  customMetadata: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  version: number;
  writtenAt: number;
};

type ManagedIndexRecord = {
  entries: Map<string, ManagedMetadataRecord>;
  staticPolicy: Record<string, unknown> | null;
};

function serializeManagedMetadataRecord(
  metadata: ManagedMetadataRecord,
): Record<string, unknown> {
  return {
    a: metadata.lastAccessAt,
    ...(metadata.version !== 1 ? { v: metadata.version } : {}),
    ...metadata.customMetadata,
  };
}

function parseManagedMetadataRecord(
  value: unknown,
  key: string,
): ManagedMetadataRecord | null {
  const record = getRecord(value);
  if (
    record === null ||
    typeof record.a !== 'number' ||
    ('v' in record && record.v !== undefined && typeof record.v !== 'number')
  ) {
    return null;
  }

  const customMetadata = Object.fromEntries(
    Object.entries(record).filter(
      ([entryKey]) => entryKey !== 'a' && entryKey !== 'v',
    ),
  );

  return {
    customMetadata,
    key,
    lastAccessAt: record.a,
    version: typeof record.v === 'number' ? record.v : 1,
    writtenAt: record.a,
  };
}

function parseManagedIndexRecord(value: unknown): ManagedIndexRecord | null {
  const record = getRecord(value);
  const rawEntries = getRecord(record?.e);
  if (rawEntries === null) return null;

  const entries = new Map<string, ManagedMetadataRecord>();
  for (const [key, rawEntry] of Object.entries(rawEntries)) {
    const parsed = parseManagedMetadataRecord(rawEntry, key);
    if (parsed === null) return null;
    entries.set(key, parsed);
  }

  return {
    entries,
    staticPolicy: getRecord(record?.s),
  };
}

function normalizeMetadataValue(key: string, value: unknown): unknown {
  const record = getRecord(value);
  if (record === null) return value;

  if (
    typeof record.a === 'number' &&
    (!('v' in record) || record.v === undefined || typeof record.v === 'number')
  ) {
    return value;
  }

  if (
    typeof record.lastAccessAt === 'number' &&
    typeof record.version === 'number'
  ) {
    return serializeManagedMetadataRecord({
      customMetadata: getRecord(record.customMetadata) ?? {},
      key,
      lastAccessAt: record.lastAccessAt,
      version: record.version,
      writtenAt: record.lastAccessAt,
    });
  }

  return value;
}

function normalizeLogicalPayload(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
  metadata?: ManagedMetadataRecord | null,
): unknown {
  const record = getRecord(value);
  if (record === null) return value;

  switch (scope.kind) {
    case 'document':
      return 'd' in record ? { data: record.d } : value;
    case 'collection.item':
      return 'd' in record && 'p' in record
        ? { data: record.d, payload: record.p }
        : value;
    case 'listQuery.item':
      return 'd' in record && 'p' in record
        ? {
            data: record.d,
            payload: record.p,
            ...('lf' in record && Array.isArray(record.lf)
              ? { loadedFields: record.lf }
              : {}),
          }
        : value;
    case 'listQuery.query':
      return Array.isArray(record.i) &&
        metadata?.customMetadata !== undefined &&
        'p' in metadata.customMetadata
        ? {
            hasMore: record.h === true,
            items: record.i,
            payload: metadata.customMetadata.p,
          }
        : value;
    default:
      return value;
  }
}

function storeDirPath(
  scope: Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'>,
): string {
  return joinPath(
    OPFS_ROOT_DIR,
    encodePathSegment(scope.sessionKey),
    encodePathSegment(scope.storeName),
  );
}

function filePathForRecord(
  scope: AsyncStorageNamespaceScope,
  key: string,
): string {
  return joinPath(storeDirPath(scope), buildFileName(scope, key));
}

function openRequestAsPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () =>
      // WORKAROUND: IndexedDB DOM requests expose `result` as `unknown`/`any`,
      // and test helpers choose the expected shape at each callsite.
      resolve(__LEGIT_CAST__<T, unknown>(request.result));
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

async function waitForRealTaskTick(): Promise<void> {
  await new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function iterateCursor<T>(
  request: IDBRequest<IDBCursorWithValue | null>,
  callback: (cursor: IDBCursorWithValue) => Promise<T> | T,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB cursor request failed.'));
    request.onsuccess = async () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }

      try {
        await callback(cursor);
        cursor.continue();
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('IndexedDB cursor callback failed.'),
        );
      }
    };
  });
}

let currentIndexedDbPersistentStorageTestStore:
  | ReturnType<typeof createIndexedDbPersistentStorageTestStore>
  | null = null;

export function getCurrentIndexedDbPersistentStorageTestStore() {
  if (currentIndexedDbPersistentStorageTestStore === null) {
    throw new Error(
      'Expected an active IndexedDB persistent storage test store.',
    );
  }

  return currentIndexedDbPersistentStorageTestStore;
}

export function clearCurrentIndexedDbPersistentStorageTestStore(): void {
  currentIndexedDbPersistentStorageTestStore = null;
}

export async function resetCurrentIndexedDbPersistentStorageTestStore(): Promise<void> {
  const currentStore = currentIndexedDbPersistentStorageTestStore;
  currentIndexedDbPersistentStorageTestStore = null;
  await currentStore?.adapter.resetForTests?.();
}

export function createIndexedDbPersistentStorageTestStore(
  options: IndexedDbPersistentStorageTestStoreOptions = {},
) {
  const instrumentationOperations: IndexedDbPersistentStorageOperation[] = [];
  const databaseName =
    options.databaseName ??
    `tsdf-persistent-storage-test-${Math.random().toString(36).slice(2, 10)}`;
  const { adapter: baseAdapter, driver } = createIndexedDbPersistentStorageForTests(
    {
    ...(options.persistentStorageOptions ?? {}),
    databaseName,
    instrumentation: {
      onApplyManagedCommit(scope, args) {
        applyCachedManagedCommit(scope, args);
      },
      onClearManagedNamespace(scope) {
        clearCachedNamespace(scope);
      },
      onPersistNamespaceIndexState(scope, state) {
        syncCachedIndexState(scope, state);
      },
      onRemoveMany(scope, keys) {
        removeCachedRecords(scope, keys);
      },
      operations: instrumentationOperations,
      record(operation) {
        instrumentationOperations.push(operation);
      },
      reset() {
        instrumentationOperations.length = 0;
      },
    },
    },
  );

  let pendingWrites = Promise.resolve();
  let instrumentationStartIndex = 0;
  let readStartIndex = 0;
  let cachedPseudoFileMap = new Map<string, string>();
  const extraPseudoFiles = new Map<string, string>();
  const removeEntryFailures = new Map<string, number>();

  function enqueueWrite(callback: () => Promise<void>): void {
    pendingWrites = pendingWrites.then(callback);
  }

  function trackWrite(promise: Promise<void>): void {
    pendingWrites = pendingWrites.then(() => promise);
  }

  async function waitForPendingWritesOnly(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentPendingWrites = pendingWrites;
      await Promise.resolve();
      await waitForRealTaskTick();
      await currentPendingWrites;
      if (currentPendingWrites === pendingWrites) break;
    }
  }

  async function settlePendingWrites(): Promise<void> {
    await waitForPendingWritesOnly();
    await refreshCache();
  }

  async function flushWrites(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await waitForRealTaskTick();
      const currentPendingWrites = pendingWrites;
      await currentPendingWrites;
      if (currentPendingWrites === pendingWrites) break;
    }

    await settlePendingWrites();
  }

  async function refreshCache(): Promise<void> {
    cachedPseudoFileMap = await buildPseudoFileMap();
  }

  function removeCachedRecords(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): void {
    for (const key of keys) {
      cachedPseudoFileMap.delete(filePathForRecord(scope, key));
    }
  }

  function syncCachedIndexState(
    scope: AsyncStorageNamespaceScope,
    state: {
      entries: Map<
        string,
        {
          customMetadata?: Record<string, unknown>;
          lastAccessAt: number;
          version: number;
        }
      >;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
    },
  ): void {
    const indexPath = filePathForRecord(scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    if (state.entries.size === 0 && state.staticPolicy === null) {
      cachedPseudoFileMap.delete(indexPath);
      return;
    }

    const serializedEntries = Object.fromEntries(
      [...state.entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, metadata]) => [
          key,
          serializeManagedMetadataRecord({
            customMetadata: metadata.customMetadata ?? {},
            key,
            lastAccessAt: metadata.lastAccessAt,
            version: metadata.version,
            writtenAt: metadata.lastAccessAt,
          }),
        ]),
    );
    cachedPseudoFileMap.set(
      indexPath,
      JSON.stringify({
        e: serializedEntries,
        ...(state.staticPolicy !== null ? { s: state.staticPolicy } : {}),
      }),
    );
  }

  function writeCachedIndexState(
    scope: AsyncStorageNamespaceScope,
    args: {
      entries: Map<string, ManagedMetadataRecord>;
      staticPolicy: Record<string, unknown> | null;
    },
  ): void {
    syncCachedIndexState(scope, {
      entries: new Map(
        [...args.entries.entries()].map(([key, metadata]) => [
          key,
          {
            customMetadata: metadata.customMetadata,
            lastAccessAt: metadata.lastAccessAt,
            version: metadata.version,
          },
        ]),
      ),
      staticPolicy: __LEGIT_CAST__<
        AsyncStorageNamespaceStaticPolicy | null,
        Record<string, unknown> | null
      >(args.staticPolicy),
    });
  }

  function upsertCachedLogicalEntry(args: {
    key: string;
    metadata: ManagedMetadataRecord;
    payload: unknown;
    scope: AsyncStorageNamespaceScope;
  }): void {
    const entries = readNamespaceIndexFromCache(args.scope);
    entries.set(args.key, args.metadata);
    cachedPseudoFileMap.set(
      filePathForRecord(args.scope, getPayloadRecordKey(args.key)),
      JSON.stringify(args.payload),
    );
    writeCachedIndexState(args.scope, {
      entries,
      staticPolicy: readManagedIndexRecordFromCache(args.scope)?.staticPolicy ?? null,
    });
  }

  function removeCachedLogicalEntry(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): void {
    cachedPseudoFileMap.delete(filePathForRecord(scope, getPayloadRecordKey(key)));
    const entries = readNamespaceIndexFromCache(scope);
    entries.delete(key);
    writeCachedIndexState(scope, {
      entries,
      staticPolicy: readManagedIndexRecordFromCache(scope)?.staticPolicy ?? null,
    });
  }

  function clearCachedNamespace(scope: AsyncStorageNamespaceScope): void {
    const storePrefix = `${storeDirPath(scope)}/`;
    for (const path of [...cachedPseudoFileMap.keys()]) {
      if (path.startsWith(storePrefix)) {
        cachedPseudoFileMap.delete(path);
      }
    }
  }

  function applyCachedManagedCommit(
    scope: AsyncStorageNamespaceScope,
    args: {
      removes?: string[];
      staticPolicy?: AsyncStorageNamespaceStaticPolicy | null;
      touches?: Array<{ key: string; lastAccessAt?: number }>;
      upserts?: Array<{
        key: string;
        metadata?: Record<string, unknown>;
        value: unknown;
        version: number;
      }>;
    },
  ): void {
    const indexRecord = readManagedIndexRecordFromCache(scope);
    const entries = indexRecord?.entries ?? new Map<string, ManagedMetadataRecord>();
    let staticPolicy = indexRecord?.staticPolicy ?? null;

    for (const key of args.removes ?? []) {
      cachedPseudoFileMap.delete(filePathForRecord(scope, getPayloadRecordKey(key)));
      entries.delete(key);
    }

    for (const touch of args.touches ?? []) {
      const existing = entries.get(touch.key);
      if (existing === undefined) continue;
      const nextLastAccessAt = touch.lastAccessAt ?? existing.lastAccessAt;
      entries.set(touch.key, {
        ...existing,
        lastAccessAt: nextLastAccessAt,
        writtenAt: nextLastAccessAt,
      });
    }

    for (const upsert of args.upserts ?? []) {
      const existing = entries.get(upsert.key);
      const nextLastAccessAt =
        existing?.lastAccessAt ?? Date.now();
      const metadata: ManagedMetadataRecord = {
        customMetadata: upsert.metadata ?? existing?.customMetadata ?? {},
        key: upsert.key,
        lastAccessAt: nextLastAccessAt,
        version: upsert.version,
        writtenAt: nextLastAccessAt,
      };
      entries.set(upsert.key, metadata);
      cachedPseudoFileMap.set(
        filePathForRecord(scope, getPayloadRecordKey(upsert.key)),
        JSON.stringify(upsert.value),
      );
    }

    if ('staticPolicy' in args) {
      staticPolicy = serializeTestStaticPolicy(args.staticPolicy) ?? null;
    }

    writeCachedIndexState(scope, {
      entries,
      staticPolicy,
    });
  }

  async function openDatabase(): Promise<IDBDatabase> {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INDEXED_DB_ENTRY_STORE)) {
        const store = database.createObjectStore(INDEXED_DB_ENTRY_STORE, {
          keyPath: ['s', 'n', 't', 'k'],
        });
        store.createIndex('bySession', 's', { unique: false });
        store.createIndex(
          'byScopeLastAccessAt',
          ['s', 'n', 't', 'a', 'k'],
          { unique: false },
        );
        store.createIndex(
          'byScopeGroup',
          ['s', 'n', 't', 'g', 'k'],
          { unique: false },
        );
        store.createIndex(
          'bySessionOfflineProtected',
          ['s', 'o', 'n', 't', 'k'],
          { unique: false },
        );
      }

      if (!database.objectStoreNames.contains(INDEXED_DB_NAMESPACE_POLICY_STORE)) {
        const store = database.createObjectStore(
          INDEXED_DB_NAMESPACE_POLICY_STORE,
          { keyPath: ['s', 'n', 't'] },
        );
        store.createIndex('bySession', 's', { unique: false });
      }

      if (!database.objectStoreNames.contains(INDEXED_DB_META_STORE)) {
        database.createObjectStore(INDEXED_DB_META_STORE, { keyPath: 'k' });
      }
    };
    return openRequestAsPromise(request);
  }

  async function withReadonlyStores<T>(
    storeNames: string[],
    callback: (transaction: IDBTransaction) => T | Promise<T>,
  ): Promise<T> {
    const database = await openDatabase();
    const transaction = database.transaction(storeNames, 'readonly');

    try {
      const result = await callback(transaction);
      await transactionDone(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  async function withReadwriteStores<T>(
    storeNames: string[],
    callback: (transaction: IDBTransaction) => T | Promise<T>,
  ): Promise<T> {
    const database = await openDatabase();
    const transaction = database.transaction(storeNames, 'readwrite');

    try {
      const result = await callback(transaction);
      await transactionDone(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  async function getEntryRecord(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): Promise<IndexedDbEntryRecord | null> {
    return withReadonlyStores([INDEXED_DB_ENTRY_STORE], async (transaction) => {
      const result = await openRequestAsPromise<IndexedDbEntryRecord | undefined>(
        transaction
          .objectStore(INDEXED_DB_ENTRY_STORE)
          .get([scope.sessionKey, scope.storeName, scope.kind, key]),
      );
      return result ?? null;
    });
  }

  async function getPolicyRecord_(
    scope: AsyncStorageNamespaceScope,
  ): Promise<IndexedDbNamespacePolicyRecord | null> {
    return withReadonlyStores(
      [INDEXED_DB_NAMESPACE_POLICY_STORE],
      async (transaction) => {
        const result =
          await openRequestAsPromise<IndexedDbNamespacePolicyRecord | undefined>(
            transaction
              .objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE)
              .get([scope.sessionKey, scope.storeName, scope.kind]),
          );
        return result ?? null;
      },
    );
  }

  async function putEntryRecord(
    scope: AsyncStorageNamespaceScope,
    args: {
      customMetadata?: Record<string, unknown>;
      key: string;
      lastAccessAt: number;
      value: unknown;
      version: number;
    },
  ): Promise<void> {
    await withReadwriteStores([INDEXED_DB_ENTRY_STORE], (transaction) => {
      transaction.objectStore(INDEXED_DB_ENTRY_STORE).put({
        a: args.lastAccessAt,
        d: args.value,
        g:
          typeof args.customMetadata?.g === 'string'
            ? args.customMetadata.g
            : undefined,
        k: args.key,
        m: args.customMetadata,
        n: scope.storeName,
        o: args.customMetadata?.o === true ? 1 : 0,
        s: scope.sessionKey,
        t: scope.kind,
        v: args.version,
      } satisfies IndexedDbEntryRecord);
    });
  }

  async function deleteEntryRecord(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): Promise<void> {
    await withReadwriteStores([INDEXED_DB_ENTRY_STORE], (transaction) => {
      transaction
        .objectStore(INDEXED_DB_ENTRY_STORE)
        .delete([scope.sessionKey, scope.storeName, scope.kind, key]);
    });
  }

  async function putPolicyRecord(
    scope: AsyncStorageNamespaceScope,
    staticPolicy: AsyncStorageNamespaceStaticPolicy | null,
  ): Promise<void> {
    await withReadwriteStores(
      [INDEXED_DB_NAMESPACE_POLICY_STORE],
      (transaction) => {
        const store = transaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);
        if (staticPolicy === null) {
          store.delete([scope.sessionKey, scope.storeName, scope.kind]);
        } else {
          store.put({
            n: scope.storeName,
            p: staticPolicy,
            s: scope.sessionKey,
            t: scope.kind,
          } satisfies IndexedDbNamespacePolicyRecord);
        }
      },
    );
  }

  async function listEntryRecords(
    scope: AsyncStorageNamespaceScope,
  ): Promise<IndexedDbEntryRecord[]> {
    return withReadonlyStores([INDEXED_DB_ENTRY_STORE], async (transaction) => {
      const entries: IndexedDbEntryRecord[] = [];
      await iterateCursor(
        transaction.objectStore(INDEXED_DB_ENTRY_STORE).openCursor(
          IDBKeyRange.bound(
            [scope.sessionKey, scope.storeName, scope.kind, ''],
            [scope.sessionKey, scope.storeName, scope.kind, '\uffff'],
          ),
        ),
        (cursor) => {
          entries.push(__LEGIT_CAST__<IndexedDbEntryRecord, unknown>(cursor.value));
        },
      );
      return entries.sort((left, right) => left.key.localeCompare(right.key));
    });
  }

  async function readLogicalStorageEntry<T>(
    flatKey: string,
  ): Promise<StorageCacheEntry<T> | null> {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return null;

    const record = await getEntryRecord(parsed.scope, parsed.key);
    if (record === null) return null;

    const metadata = toManagedMetadata(record);
    return {
      data: __LEGIT_CAST__<T, unknown>(
        normalizeLogicalPayload(parsed.scope, record.d, metadata),
      ),
      timestamp: metadata.lastAccessAt,
      version: metadata.version,
    };
  }

  function writeLogicalStorageEntry(flatKey: string, value: unknown): void {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return;

    const entry = __LEGIT_CAST__<StorageCacheEntry<unknown>, unknown>(value);
    upsertCachedLogicalEntry({
      key: parsed.key,
      metadata: {
        customMetadata: buildCustomMetadata(parsed.scope, entry.data),
        key: parsed.key,
        lastAccessAt: entry.timestamp,
        version: entry.version ?? 1,
        writtenAt: entry.timestamp,
      },
      payload: entry.data,
      scope: parsed.scope,
    });
    trackWrite(
      putEntryRecord(parsed.scope, {
        customMetadata: buildCustomMetadata(parsed.scope, entry.data),
        key: parsed.key,
        lastAccessAt: entry.timestamp,
        value: entry.data,
        version: entry.version ?? 1,
      }),
    );
  }

  function setPayloadValue(key: string, value: unknown): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;

    const currentMetadata = readMetadataFromCache(key);
    const nextTimestamp = currentMetadata?.lastAccessAt ?? Date.now();
    upsertCachedLogicalEntry({
      key: parsed.key,
      metadata: {
        customMetadata:
          currentMetadata?.customMetadata ?? buildCustomMetadata(parsed.scope, value),
        key: parsed.key,
        lastAccessAt: nextTimestamp,
        version: currentMetadata?.version ?? 1,
        writtenAt: nextTimestamp,
      },
      payload: value,
      scope: parsed.scope,
    });

    trackWrite(
      (async () => {
        const existing = await getEntryRecord(parsed.scope, parsed.key);
        await putEntryRecord(parsed.scope, {
          customMetadata:
            existing?.m ?? buildCustomMetadata(parsed.scope, value),
          key: parsed.key,
          lastAccessAt: existing?.a ?? Date.now(),
          value,
          version: existing?.v ?? 1,
        });
      })(),
    );
  }

  function setMetadataValue(key: string, value: unknown): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;

    const currentEntry = readLogicalStorageEntryFromCache<unknown>(key);
    if (currentEntry !== null) {
      const normalized = normalizeMetadataValue(parsed.key, value);
      const metadata = parseManagedMetadataRecord(normalized, parsed.key);
      if (metadata !== null) {
        upsertCachedLogicalEntry({
          key: parsed.key,
          metadata,
          payload: currentEntry.data,
          scope: parsed.scope,
        });
      }
    }

    trackWrite(
      (async () => {
        const existing = await getEntryRecord(parsed.scope, parsed.key);
        if (existing === null) return;

        const normalized = normalizeMetadataValue(parsed.key, value);
        const metadata = parseManagedMetadataRecord(normalized, parsed.key);
        if (metadata === null) return;

        await putEntryRecord(parsed.scope, {
          customMetadata: metadata.customMetadata,
          key: parsed.key,
          lastAccessAt: metadata.lastAccessAt,
          value: existing.d,
          version: metadata.version,
        });
      })(),
    );
  }

  function removePayloadValue(key: string): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;
    removeCachedLogicalEntry(parsed.scope, parsed.key);
    trackWrite(deleteEntryRecord(parsed.scope, parsed.key));
  }

  function removeMetadataValue(key: string): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;
    removeCachedLogicalEntry(parsed.scope, parsed.key);
    trackWrite(deleteEntryRecord(parsed.scope, parsed.key));
  }

  function setNamespaceStaticPolicy(
    scope: AsyncStorageNamespaceScope,
    policy: Record<string, unknown>,
  ): void {
    writeCachedIndexState(scope, {
      entries: readNamespaceIndexFromCache(scope),
      staticPolicy: policy,
    });
    trackWrite(
      putPolicyRecord(scope, normalizeTestStaticPolicy(policy)),
    );
  }

  function toManagedMetadata(record: IndexedDbEntryRecord): ManagedMetadataRecord {
    return {
      customMetadata: record.m ?? {},
      key: record.k,
      lastAccessAt: record.a,
      version: record.v,
      writtenAt: record.a,
    };
  }

  function createScope(
    storeName: string,
    sessionKey: string,
  ): IndexedDbPersistentStorageTestStoreScope {
    const documentNamespace = {
      kind: 'document',
      sessionKey,
      storeName,
    } satisfies AsyncStorageNamespaceScope;
    const collectionNamespace = {
      kind: 'collection.item',
      sessionKey,
      storeName,
    } satisfies AsyncStorageNamespaceScope;
    const listQueryItemNamespace = {
      kind: 'listQuery.item',
      sessionKey,
      storeName,
    } satisfies AsyncStorageNamespaceScope;
    const listQueryQueryNamespace = {
      kind: 'listQuery.query',
      sessionKey,
      storeName,
    } satisfies AsyncStorageNamespaceScope;
    const documentStorageKey = getLogicalStorageKey(
      documentNamespace,
      'document',
    );

    function collectionItemStorageKey(payload: string): string {
      return getLogicalStorageKey(collectionNamespace, itemKey(payload));
    }

    function rawListQueryItemPayload(
      tableId: string,
      id: number | string,
    ): string {
      return `${tableId}||${id}`;
    }

    function listQueryItemStorageKey(
      tableId: string,
      id: number | string,
    ): string {
      return getLogicalStorageKey(
        listQueryItemNamespace,
        listQueryItemKey(tableId, id),
      );
    }

    function listQueryStorageKey(params: unknown): string {
      return getLogicalStorageKey(
        listQueryQueryNamespace,
        listQueryQueryKey(params),
      );
    }

    function normalizeQueryItemRef(item: ListQueryItemRef): string {
      if (typeof item === 'string') return item;
      return listQueryItemKey(item.tableId, item.id);
    }

    return {
      document: {
        namespace: documentNamespace,
        storageKey: () => documentStorageKey,
        seed<T>(data: T, seedOptions?: StorageSeedOptions) {
          writeLogicalStorageEntry(
            documentStorageKey,
            createStorageCacheEntry(
              { d: data },
              {
                timestamp: seedOptions?.timestamp,
                version: seedOptions?.version,
              },
            ),
          );
          return documentStorageKey;
        },
        setMetadata: (value) => setMetadataValue(documentStorageKey, value),
        setPayload: (value) => setPayloadValue(documentStorageKey, value),
        removeMetadata: () => removeMetadataValue(documentStorageKey),
        removePayload: () => removePayloadValue(documentStorageKey),
      },
      collection: {
        itemKey,
        itemStorageKey: collectionItemStorageKey,
        listStoredPayloads: () =>
          listStoredKeysForNamespaceFromCache(collectionNamespace).flatMap(
            (key) => {
              const metadata = readMetadataFromCache(
                getLogicalStorageKey(collectionNamespace, key),
              );
              return typeof metadata?.customMetadata.p === 'string'
                ? [metadata.customMetadata.p]
                : [];
            },
          ),
        namespace: collectionNamespace,
        seedItem<T>(payload: string, data: T, seedOptions?: StorageSeedOptions) {
          const storageKey = collectionItemStorageKey(payload);
          writeLogicalStorageEntry(
            storageKey,
            createStorageCacheEntry(
              { d: data, p: payload },
              {
                timestamp: seedOptions?.timestamp,
                version: seedOptions?.version,
              },
            ),
          );
          return storageKey;
        },
        setStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(collectionNamespace, policy),
      },
      listQuery: {
        itemKey: listQueryItemKey,
        itemNamespace: listQueryItemNamespace,
        itemStorageKey: listQueryItemStorageKey,
        listStoredItemKeys: () =>
          listStoredKeysForNamespaceFromCache(listQueryItemNamespace),
        listStoredQueryKeys: () =>
          listStoredKeysForNamespaceFromCache(listQueryQueryNamespace),
        queryKey: listQueryQueryKey,
        queryNamespace: listQueryQueryNamespace,
        queryStorageKey: listQueryStorageKey,
        seedItem<T>(
          tableId: string,
          id: number | string,
          data: T,
          seedOptions?: ListQuerySeedItemOptions,
        ) {
          const payload = rawListQueryItemPayload(tableId, id);
          const storageKey = listQueryItemStorageKey(tableId, id);
          const entryKey = listQueryItemKey(tableId, id);
          writeLogicalStorageEntry(
            storageKey,
            createStorageCacheEntry(
              {
                ...(seedOptions?.loadedFields !== undefined
                  ? { lf: seedOptions.loadedFields }
                  : {}),
                d: data,
                p: payload,
              },
              {
                timestamp: seedOptions?.timestamp,
                version: seedOptions?.version,
              },
            ),
          );
          return { itemKey: entryKey, payload, storageKey };
        },
        seedQuery(
          params: unknown,
          items: ListQueryItemRef[],
          queryOptions: StorageSeedOptions & { hasMore?: boolean } = {},
        ) {
          const storageKey = listQueryStorageKey(params);
          writeLogicalStorageEntry(
            storageKey,
            createStorageCacheEntry(
              {
                ...(queryOptions.hasMore === true ? { h: true } : {}),
                i: items.map(normalizeQueryItemRef),
              },
              {
                timestamp: queryOptions.timestamp,
                version: queryOptions.version,
              },
            ),
          );
          setMetadataValue(storageKey, {
            customMetadata: { p: params },
            lastAccessAt: queryOptions.timestamp ?? Date.now(),
            version: queryOptions.version ?? 1,
          });
          return storageKey;
        },
        setItemStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(listQueryItemNamespace, policy),
        setQueryStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(listQueryQueryNamespace, policy),
      },
    };
  }

  async function buildPseudoFileMap(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const discoveredScopes = await driver.listScopesWithKnownRecordKeys();

    for (const { knownRecordKeys, scope } of discoveredScopes.sort((left, right) =>
      JSON.stringify(left.scope).localeCompare(JSON.stringify(right.scope)),
    )) {
      const recordKeys =
        knownRecordKeys.length > 0
          ? knownRecordKeys
          : await driver.listKeys(scope);

      for (const recordKey of recordKeys) {
        const rawValue = await driver.get(scope, recordKey);
        if (rawValue === null) continue;

        files.set(filePathForRecord(scope, recordKey), JSON.stringify(rawValue));
      }
    }

    for (const [path, raw] of extraPseudoFiles) {
      files.set(path, raw);
    }

    return files;
  }

  function getPseudoFileEntries(path: string): string[] {
    const normalizedPath = path.replace(/^\/+|\/+$/g, '');
    const prefix = normalizedPath.length === 0 ? '' : `${normalizedPath}/`;
    const childEntries = new Set<string>();

    for (const filePath of cachedPseudoFileMap.keys()) {
      if (normalizedPath.length > 0 && filePath === normalizedPath) {
        continue;
      }

      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      if (remainder.length === 0) continue;

      const nextSeparatorIndex = remainder.indexOf('/');
      if (nextSeparatorIndex < 0) {
        childEntries.add(`file:${remainder}`);
        continue;
      }

      childEntries.add(`dir:${remainder.slice(0, nextSeparatorIndex)}`);
    }

    return [...childEntries].sort((left, right) => left.localeCompare(right));
  }

  function parsePseudoScopePath(
    path: string,
  ): { fileName: string; scope: AsyncStorageNamespaceScope } | null {
    const normalizedPath = path.replace(/^\/+|\/+$/g, '');
    const pathSegments = normalizedPath.split('/');
    if (pathSegments.length !== 4 || pathSegments[0] !== OPFS_ROOT_DIR) {
      return null;
    }

    const [, sessionKeySegment, storeNameSegment, fileName] = pathSegments;
    if (
      sessionKeySegment === undefined ||
      storeNameSegment === undefined ||
      fileName === undefined
    ) {
      return null;
    }

    const parsedFileName = parseFileNameInfo(fileName);
    if (parsedFileName === null) return null;

    return {
      fileName,
      scope: {
        kind: parsedFileName.kind,
        sessionKey: decodePathSegment(sessionKeySegment),
        storeName: decodePathSegment(storeNameSegment),
      },
    };
  }

  async function resolveRawRecordPath(
    path: string,
  ): Promise<
    | {
        recordKey: string;
        scope: AsyncStorageNamespaceScope;
      }
    | null
  > {
    const parsedPath = parsePseudoScopePath(path);
    if (parsedPath === null) return null;

    const parsedFileName = parseFileNameInfo(parsedPath.fileName);
    if (parsedFileName === null) return null;

    if (parsedFileName.key !== null) {
      return { recordKey: parsedFileName.key, scope: parsedPath.scope };
    }

    const scopeEntries = await listEntryRecords(parsedPath.scope);
    for (const entry of scopeEntries) {
      const recordKey = getPayloadRecordKey(entry.k);
      if (filePathForRecord(parsedPath.scope, recordKey) === path) {
        return { recordKey, scope: parsedPath.scope };
      }
    }

    return null;
  }

  async function writePseudoFile(path: string, raw: string): Promise<void> {
    const parsedPath = await resolveRawRecordPath(path);
    if (parsedPath === null) {
      extraPseudoFiles.set(path, raw);
      await refreshCache();
      return;
    }

    const parsedValue = safeJsonParse(raw);
    if (parsedValue === null) {
      extraPseudoFiles.set(path, raw);
      await refreshCache();
      return;
    }

    extraPseudoFiles.delete(path);
    await driver.set(parsedPath.scope, parsedPath.recordKey, parsedValue);
    await refreshCache();
  }

  async function removePseudoEntry(path: string): Promise<void> {
    const remainingFailures = removeEntryFailures.get(path) ?? 0;
    if (remainingFailures > 0) {
      if (remainingFailures === 1) {
        removeEntryFailures.delete(path);
      } else {
        removeEntryFailures.set(path, remainingFailures - 1);
      }

      throw new DOMException(
        'A requested file or directory could not be found at the time an operation was processed.',
        'NotFoundError',
      );
    }

    const parsedPath = await resolveRawRecordPath(path);
    if (parsedPath === null) {
      extraPseudoFiles.delete(path);
      await refreshCache();
      return;
    }

    extraPseudoFiles.delete(path);
    await driver.remove(parsedPath.scope, parsedPath.recordKey);
    await refreshCache();
  }

  async function readMetadata(
    key: string,
  ): Promise<ManagedMetadataRecord | null> {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return null;
    const record = await getEntryRecord(parsed.scope, parsed.key);
    return record === null ? null : toManagedMetadata(record);
  }

  async function listRawNamespaceKeys(
    scope: AsyncStorageNamespaceScope,
  ): Promise<string[]> {
    return driver.listKeys(scope);
  }

  function readNamespaceIndexFromCache(
    scope: AsyncStorageNamespaceScope,
  ): Map<string, ManagedMetadataRecord> {
    return readManagedIndexRecordFromCache(scope)?.entries ?? new Map<string, ManagedMetadataRecord>();
  }

  function readManagedIndexRecordFromCache(
    scope: AsyncStorageNamespaceScope,
  ): ManagedIndexRecord | null {
    const raw = cachedPseudoFileMap.get(
      filePathForRecord(scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY),
    );
    if (raw === undefined) return null;

    return parseManagedIndexRecord(safeJsonParse(raw));
  }

  function readMetadataFromCache(key: string): ManagedMetadataRecord | null {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return null;

    return readNamespaceIndexFromCache(parsed.scope).get(parsed.key) ?? null;
  }

  function readLogicalStorageEntryFromCache<T>(
    flatKey: string,
  ): StorageCacheEntry<T> | null {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return null;

    const payloadRaw = cachedPseudoFileMap.get(
      filePathForRecord(parsed.scope, getPayloadRecordKey(parsed.key)),
    );
    const metadata = readNamespaceIndexFromCache(parsed.scope).get(parsed.key);
    if (payloadRaw === undefined || metadata === undefined) return null;

    const payload = safeJsonParse(payloadRaw);
    if (payload === null) return null;

    return {
      data: __LEGIT_CAST__<T, unknown>(
        normalizeLogicalPayload(parsed.scope, payload, metadata),
      ),
      timestamp: metadata.lastAccessAt,
      version: metadata.version,
    };
  }

  function listStoredKeysForNamespaceFromCache(
    scope: AsyncStorageNamespaceScope,
  ): string[] {
    return [...readNamespaceIndexFromCache(scope).keys()].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  const adapter: AsyncStorageAdapter = {
    kind: 'async',
    openNamespace(scope) {
      const namespace = baseAdapter.openNamespace(scope);
      return {
        async get(key, options) {
          await flushWrites();
          const result = await namespace.get(key, options);
          cachedPseudoFileMap = await buildPseudoFileMap();
          return result;
        },
        async getMany(keys, options) {
          await flushWrites();
          const result = await namespace.getMany(keys, options);
          cachedPseudoFileMap = await buildPseudoFileMap();
          return result;
        },
        async listKeys() {
          await flushWrites();
          const result = await namespace.listKeys();
          cachedPseudoFileMap = await buildPseudoFileMap();
          return result;
        },
        async commit(args) {
          await flushWrites();
          const result = await namespace.commit(args);
          cachedPseudoFileMap = await buildPseudoFileMap();
          return result;
        },
        async listMetadata(args) {
          await flushWrites();
          const result = await namespace.listMetadata(args);
          cachedPseudoFileMap = await buildPseudoFileMap();
          return result;
        },
        ...(namespace.listMetadataByFilter === undefined
          ? {}
          : {
              async listMetadataByFilter(args) {
                await flushWrites();
                const result = (await namespace.listMetadataByFilter?.(args)) ?? [];
                cachedPseudoFileMap = await buildPseudoFileMap();
                return result;
              },
            }),
        async clear() {
          await flushWrites();
          const result = await namespace.clear();
          cachedPseudoFileMap = await buildPseudoFileMap();
          return result;
        },
      };
    },
    async readProtectedStorageKeys(sessionKey) {
      await flushWrites();
      const result = await baseAdapter.readProtectedStorageKeys(sessionKey);
      cachedPseudoFileMap = await buildPseudoFileMap();
      return result;
    },
    async syncSessionProtectedKeys(
      sessionKey,
      protectedKeys,
      previousProtectedKeys,
    ) {
      await flushWrites();
      const result = await baseAdapter.syncSessionProtectedKeys(
        sessionKey,
        protectedKeys,
        previousProtectedKeys,
      );
      cachedPseudoFileMap = await buildPseudoFileMap();
      return result;
    },
    async clearSession(sessionKey) {
      await flushWrites();
      const result = await baseAdapter.clearSession(sessionKey);
      cachedPseudoFileMap = await buildPseudoFileMap();
      return result;
    },
    resetForTests() {
      baseAdapter.resetForTests?.();
    },
  };

  function seedInitialState(): void {
    const initialState = options.initialState;
    if (initialState !== undefined) {
      const scope = createScope(initialState.storeName, initialState.sessionKey);
      const documentState = initialState.document;
      if (documentState !== undefined) {
        scope.document.seed(documentState.data, {
          timestamp: documentState.timestamp,
          version: documentState.version,
        });
      }

      for (const item of initialState.collection ?? []) {
        scope.collection.seedItem(item.payload, item.data, {
          timestamp: item.timestamp,
          version: item.version,
        });
      }

      for (const item of initialState.listQuery?.items ?? []) {
        scope.listQuery.seedItem(item.tableId, item.id, item.data, {
          timestamp: item.timestamp,
          version: item.version,
        });
      }

      for (const query of initialState.listQuery?.queries ?? []) {
        scope.listQuery.seedQuery(query.params, query.items, {
          hasMore: query.hasMore,
          timestamp: query.timestamp,
          version: query.version,
        });
      }
    }

    for (const [key, value] of Object.entries(
      options.initialState?.rawEntries ?? {},
    )) {
      if (typeof value === 'string') {
        const parsed = safeJsonParse(value);
        if (parsed !== null) {
          writeLogicalStorageEntry(key, parsed);
        }
        continue;
      }

      writeLogicalStorageEntry(key, value);
    }
  }

  seedInitialState();

  const store = {
    adapter,
    buildPseudoFileMap,
    async refreshCache() {
      await refreshCache();
    },
    getCachedPseudoFileMap() {
      return new Map(cachedPseudoFileMap);
    },
    clearReadRequests() {
      readStartIndex = instrumentationOperations.length;
    },
    clearInstrumentation() {
      instrumentationStartIndex = instrumentationOperations.length;
      readStartIndex = instrumentationOperations.length;
    },
    databaseName,
    driver,
    flushIndexedDbCommits: waitForPendingWritesOnly,
    flushPendingWrites: settlePendingWrites,
    flushWrites,
    mockIndexedDbFileView: {
      failRemoveEntry(path: string, times = 1) {
        if (times <= 0) {
          removeEntryFailures.delete(path);
          return;
        }

        removeEntryFailures.set(path, times);
      },
      fileExists(path: string) {
        return cachedPseudoFileMap.has(path);
      },
      listEntries(path: string) {
        return getPseudoFileEntries(path);
      },
      removeFile(path: string) {
        enqueueWrite(() => removePseudoEntry(path));
      },
      removeEntry(path: string) {
        return removePseudoEntry(path);
      },
      writeFile(path: string, raw: string) {
        enqueueWrite(() => writePseudoFile(path, raw));
      },
    },
    scopeReadRequests(args?: { storeName: string; sessionKey: string }) {
      const payloadGetRequests = store.payloadGetRequests;
      if (args === undefined) return payloadGetRequests;

      const scopePrefix = `tsdf.${args.sessionKey}.${args.storeName}.`;
      return payloadGetRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    getRaw(key: string) {
      const entry = readLogicalStorageEntryFromCache(key);
      return entry === null ? null : JSON.stringify(entry);
    },
    has(key: string) {
      return readLogicalStorageEntryFromCache(key) !== null;
    },
    get listKeysRequests() {
      return instrumentationOperations
        .slice(instrumentationStartIndex)
        .filter(
          (
            operation,
          ): operation is Extract<
            IndexedDbPersistentStorageOperation,
            { type: 'listManagedMetadata' }
          > => operation.type === 'listManagedMetadata',
        )
        .filter((operation) => operation.usedIndex === 'key')
        .map((operation) => operation.scope);
    },
    get operations() {
      return instrumentationOperations.slice(instrumentationStartIndex);
    },
    get payloadGetManyRequests() {
      return instrumentationOperations
        .slice(readStartIndex)
        .filter(
          (
            operation,
          ): operation is Extract<
            IndexedDbPersistentStorageOperation,
            { type: 'readManagedEntries' }
          > => operation.type === 'readManagedEntries',
        )
        .filter((operation) => operation.keys.length > 1)
        .map((operation) =>
          operation.keys.map((key) => getLogicalStorageKey(operation.scope, key)),
        );
    },
    get payloadGetRequests() {
      return instrumentationOperations
        .slice(readStartIndex)
        .filter(
          (
            operation,
          ): operation is Extract<
            IndexedDbPersistentStorageOperation,
            { type: 'readManagedEntries' }
          > => operation.type === 'readManagedEntries',
        )
        .filter((operation) => operation.keys.length === 1)
        .flatMap((operation) =>
          operation.keys.map((key) => getLogicalStorageKey(operation.scope, key)),
        );
    },
    storage: {
      getRaw(key: string) {
        return store.getRaw(key);
      },
      has(key: string) {
        return store.has(key);
      },
      writeRaw(key: string, raw: string) {
        store.setRaw(key, raw);
      },
      writeValue<T>(key: string, value: T) {
        store.setValue(key, value);
      },
      writePayload(key: string, value: unknown) {
        store.setPayload(key, value);
      },
      writeMetadata(key: string, value: unknown) {
        store.setMetadata(key, value);
      },
      removePayload(key: string) {
        store.removePayload(key);
      },
      removeMetadata(key: string) {
        store.removeMetadata(key);
      },
    },
    rawNamespace: {
      async get(scope: AsyncStorageNamespaceScope, key: string) {
        await flushWrites();
        return driver.get(scope, key);
      },
      async listKeys(scope: AsyncStorageNamespaceScope) {
        await flushWrites();
        return listRawNamespaceKeys(scope);
      },
      remove(scope: AsyncStorageNamespaceScope, key: string) {
        enqueueWrite(() => driver.remove(scope, key));
      },
      set(scope: AsyncStorageNamespaceScope, key: string, value: unknown) {
        enqueueWrite(() => driver.set(scope, key, value));
      },
    },
    async readMetadata(key: string) {
      return readMetadata(key);
    },
    removeMetadata(key: string) {
      removeMetadataValue(key);
    },
    removePayload(key: string) {
      removePayloadValue(key);
    },
    scope: createScope,
    setMetadata(key: string, value: unknown) {
      setMetadataValue(key, value);
    },
    setPayload(key: string, value: unknown) {
      setPayloadValue(key, value);
    },
    setRaw(key: string, raw: string) {
      const parsed = safeJsonParse(raw);
      if (parsed === null) return;
      writeLogicalStorageEntry(key, parsed);
    },
    setValue<T>(key: string, value: T) {
      writeLogicalStorageEntry(key, value);
    },
  };

  currentIndexedDbPersistentStorageTestStore = store;
  return store;
}

export type IndexedDbPersistentStorageTestStore = ReturnType<
  typeof createIndexedDbPersistentStorageTestStore
>;
