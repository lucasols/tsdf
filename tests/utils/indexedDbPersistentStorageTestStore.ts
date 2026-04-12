import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getPayloadRecordKey,
} from '../../src/persistentStorage/asyncStorageShared';
import {
  createIndexedDbPersistentStorageForTests,
  type IndexedDbPersistentStorageOperation,
  type IndexedDbPersistentStorageOptions,
} from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import type {
  AsyncStorageAdapter,
  AsyncStorageDriver,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';

const INDEXED_DB_ENTRY_STORE = 'entries';
const INDEXED_DB_NAMESPACE_POLICY_STORE = 'namespacePolicies';
const INDEXED_DB_META_STORE = 'meta';
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

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

type IndexedDbStructureInspection = {
  stores: Array<{
    autoIncrement: boolean;
    indexes: Array<{
      keyPath: string | string[] | null;
      multiEntry: boolean;
      name: string;
      unique: boolean;
    }>;
    keyPath: string | string[] | null;
    name: string;
    rows: Array<{ key: unknown; value: unknown }>;
  }>;
  version: number;
};

type FakeIndexedDbRawRecord = { key: unknown; value: unknown };

type FakeIndexedDbRawIndex = {
  keyPath: string | string[] | null;
  multiEntry: boolean;
  name: string;
  unique: boolean;
};

type IndexedDbStoreKey = IDBKeyRange | IDBValidKey;

type FakeIndexedDbRawObjectStore = {
  autoIncrement: boolean;
  keyPath: string | string[] | null;
  rawIndexes: Map<string, FakeIndexedDbRawIndex>;
  deleteRecord: (key: unknown, rollbackLog?: Array<() => void>) => void;
  records: {
    get: (key: unknown) => FakeIndexedDbRawRecord | undefined;
    values: (
      range?: unknown,
      direction?: 'next' | 'nextunique' | 'prev' | 'prevunique',
    ) => Iterable<FakeIndexedDbRawRecord>;
  };
  storeRecord: (
    newRecord: { key: unknown; value: unknown },
    noOverwrite?: boolean,
    rollbackLog?: Array<() => void>,
  ) => unknown;
};

type FakeIndexedDbRawDatabase = {
  rawObjectStores: Map<string, FakeIndexedDbRawObjectStore>;
  version: number;
};

type FakeIndexedDbFactory = IDBFactory & {
  _databases?: Map<string, FakeIndexedDbRawDatabase>;
};

export type IndexedDbPersistentStorageTestStoreScope = {
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
    listStoredPayloads: () => Promise<string[]>;
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
    listStoredItemKeys: () => Promise<string[]>;
    listStoredQueryKeys: () => Promise<string[]>;
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

function isValidEntryRecord(value: unknown): value is IndexedDbEntryRecord {
  const record = getRecord(value);
  if (record === null) return false;

  return (
    typeof record.s === 'string' &&
    typeof record.n === 'string' &&
    typeof record.t === 'string' &&
    typeof record.k === 'string' &&
    typeof record.a === 'number' &&
    typeof record.v === 'number' &&
    (record.m === undefined || getRecord(record.m) !== null) &&
    (record.g === undefined || typeof record.g === 'string') &&
    (record.o === 0 || record.o === 1)
  );
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

export function serializeTestStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): Record<string, unknown> | null {
  if (policy === undefined || policy === null) return null;

  return {
    ...(typeof policy.maxEntries === 'number' ? { m: policy.maxEntries } : {}),
    ...(Array.isArray(policy.pinnedKeys) ? { p: policy.pinnedKeys } : {}),
  };
}

export type ManagedMetadataRecord = {
  customMetadata: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  version: number;
  writtenAt: number;
};

export function serializeManagedMetadataRecord(
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

function openRequestAsPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () =>
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

let currentIndexedDbPersistentStorageTestStore: ReturnType<
  typeof createIndexedDbPersistentStorageTestStore
> | null = null;

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

export function resetCurrentIndexedDbPersistentStorageTestStore(): Promise<void> {
  const currentStore = currentIndexedDbPersistentStorageTestStore;
  currentIndexedDbPersistentStorageTestStore = null;
  currentStore?.adapter.resetForTests?.();
  return Promise.resolve();
}

export function createIndexedDbPersistentStorageTestStore(
  options: IndexedDbPersistentStorageTestStoreOptions = {},
) {
  const instrumentationOperations: IndexedDbPersistentStorageOperation[] = [];
  const databaseName =
    options.databaseName ??
    `tsdf-persistent-storage-test-${Math.random().toString(36).slice(2, 10)}`;
  const { adapter: baseAdapter, driver } =
    createIndexedDbPersistentStorageForTests({
      ...(options.persistentStorageOptions ?? {}),
      databaseName,
      instrumentation: {
        operations: instrumentationOperations,
        record(operation) {
          instrumentationOperations.push(operation);
        },
        reset() {
          instrumentationOperations.length = 0;
        },
      },
    });

  let pendingWrites = Promise.resolve();
  let instrumentationStartIndex = 0;
  let readStartIndex = 0;
  const cleanupRemoveKnownRecordsFailures = new Map<string, number>();

  type CleanupCapableDriver = AsyncStorageDriver & {
    cleanupRemoveKnownRecords?: (
      scope: AsyncStorageNamespaceScope,
      keys: string[],
    ) => Promise<string[]>;
    withIsolatedCleanupDriver?: <T>(
      callback: (driver: AsyncStorageDriver) => Promise<T>,
    ) => Promise<T>;
  };

  const cleanupCapableDriver = __LEGIT_CAST__<
    CleanupCapableDriver,
    AsyncStorageDriver
  >(driver);

  cleanupCapableDriver.withIsolatedCleanupDriver = async (callback) =>
    callback(driver);
  cleanupCapableDriver.cleanupRemoveKnownRecords = async (scope, keys) => {
    const scopeId = JSON.stringify([
      scope.sessionKey,
      scope.storeName,
      scope.kind,
    ]);
    const pendingFailures = cleanupRemoveKnownRecordsFailures.get(scopeId) ?? 0;

    if (pendingFailures > 0) {
      if (pendingFailures === 1) {
        cleanupRemoveKnownRecordsFailures.delete(scopeId);
      } else {
        cleanupRemoveKnownRecordsFailures.set(scopeId, pendingFailures - 1);
      }

      return [];
    }

    await driver.removeMany(scope, keys);
    return [...keys];
  };

  function enqueueWrite(callback: () => Promise<void>): void {
    pendingWrites = pendingWrites.then(callback);
  }

  async function waitForPendingWritesOnly(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentPendingWrites = pendingWrites;
      await currentPendingWrites;
      await Promise.resolve();
      if (currentPendingWrites === pendingWrites) return;
      await waitForRealTaskTick();
    }
  }

  async function settlePendingWrites(): Promise<void> {
    await waitForPendingWritesOnly();
  }

  async function flushWrites(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(0);
      const currentPendingWrites = pendingWrites;
      await currentPendingWrites;
      await Promise.resolve();

      if (currentPendingWrites === pendingWrites && vi.getTimerCount() === 0) {
        break;
      }

      if (currentPendingWrites !== pendingWrites) continue;

      await waitForRealTaskTick();
    }

    await settlePendingWrites();
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
        store.createIndex('byScopeLastAccessAt', ['s', 'n', 't', 'a', 'k'], {
          unique: false,
        });
        store.createIndex('byScopeGroup', ['s', 'n', 't', 'g', 'k'], {
          unique: false,
        });
        store.createIndex(
          'bySessionOfflineProtected',
          ['s', 'o', 'n', 't', 'k'],
          { unique: false },
        );
      }

      if (
        !database.objectStoreNames.contains(INDEXED_DB_NAMESPACE_POLICY_STORE)
      ) {
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

  function getRawFakeIndexedDbDatabase(): FakeIndexedDbRawDatabase | null {
    return (
      __LEGIT_CAST__<FakeIndexedDbFactory, IDBFactory>(
        indexedDB,
      )._databases?.get(databaseName) ?? null
    );
  }

  function getRawFakeIndexedDbStore(
    storeName: string,
  ): FakeIndexedDbRawObjectStore | null {
    return (
      getRawFakeIndexedDbDatabase()?.rawObjectStores.get(storeName) ?? null
    );
  }

  function listRawFakeIndexedDbStoreRows(
    storeName: string,
  ): Array<{ key: unknown; value: unknown }> {
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore === null) return [];

    return [...rawStore.records.values()]
      .map((record) => ({
        key: structuredClone(record.key),
        value: structuredClone(record.value),
      }))
      .sort((left, right) =>
        JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)),
      );
  }

  function mutateRawFakeIndexedDbStoreRow(
    storeName: string,
    key: unknown,
    update: (current: unknown) => unknown,
  ): void {
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore === null) {
      throw new Error(`Expected raw IndexedDB store "${storeName}" to exist.`);
    }

    const record = rawStore.records.get(key);
    if (record === undefined) {
      throw new Error(
        `Expected raw IndexedDB row ${JSON.stringify(key)} in "${storeName}".`,
      );
    }

    record.value = structuredClone(update(structuredClone(record.value)));
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

  function getEntryRecord(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): IndexedDbEntryRecord | null {
    const row = listRawFakeIndexedDbStoreRows(INDEXED_DB_ENTRY_STORE).find(
      (entry) =>
        JSON.stringify(entry.key) ===
          JSON.stringify([
            scope.sessionKey,
            scope.storeName,
            scope.kind,
            key,
          ]) && isValidEntryRecord(entry.value),
    );

    return row === undefined
      ? null
      : __LEGIT_CAST__<IndexedDbEntryRecord, unknown>(row.value);
  }

  async function getPolicyRecord_(
    scope: AsyncStorageNamespaceScope,
  ): Promise<IndexedDbNamespacePolicyRecord | null> {
    return withReadonlyStores(
      [INDEXED_DB_NAMESPACE_POLICY_STORE],
      async (transaction) => {
        const result = await openRequestAsPromise<
          IndexedDbNamespacePolicyRecord | undefined
        >(
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
      transaction
        .objectStore(INDEXED_DB_ENTRY_STORE)
        .put({
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
        const store = transaction.objectStore(
          INDEXED_DB_NAMESPACE_POLICY_STORE,
        );
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

  function listEntryRecords(
    scope: AsyncStorageNamespaceScope,
  ): IndexedDbEntryRecord[] {
    return listRawFakeIndexedDbStoreRows(INDEXED_DB_ENTRY_STORE)
      .filter(
        (entry) =>
          Array.isArray(entry.key) &&
          entry.key[0] === scope.sessionKey &&
          entry.key[1] === scope.storeName &&
          entry.key[2] === scope.kind &&
          isValidEntryRecord(entry.value),
      )
      .map((entry) =>
        __LEGIT_CAST__<IndexedDbEntryRecord, unknown>(entry.value),
      )
      .sort((left, right) => left.k.localeCompare(right.k));
  }

  function getStoreRow(storeName: string, key: unknown): unknown {
    return (
      listRawFakeIndexedDbStoreRows(storeName).find(
        (row) => JSON.stringify(row.key) === JSON.stringify(key),
      )?.value ?? null
    );
  }

  function listStoreRows(
    storeName: string,
  ): Array<{ key: unknown; value: unknown }> {
    return listRawFakeIndexedDbStoreRows(storeName);
  }

  function inspectIndexedDbStructure(): IndexedDbStructureInspection {
    const rawDatabase = getRawFakeIndexedDbDatabase();
    if (rawDatabase === null) {
      return { stores: [], version: 0 };
    }

    const stores = [...rawDatabase.rawObjectStores.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([storeName, rawStore]) => ({
        autoIncrement: rawStore.autoIncrement,
        indexes: [...rawStore.rawIndexes.values()]
          .map((index) => ({
            keyPath: structuredClone(index.keyPath),
            multiEntry: index.multiEntry,
            name: index.name,
            unique: index.unique,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        keyPath: structuredClone(rawStore.keyPath),
        name: storeName,
        rows: listRawFakeIndexedDbStoreRows(storeName),
      }));

    return { stores, version: rawDatabase.version };
  }

  async function putStoreRow(storeName: string, value: unknown): Promise<void> {
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore !== null) {
      rawStore.storeRecord({ key: undefined, value: structuredClone(value) });
      return;
    }

    await withReadwriteStores([storeName], (transaction) => {
      transaction.objectStore(storeName).put(value);
    });
  }

  async function deleteStoreRow(
    storeName: string,
    key: unknown,
  ): Promise<void> {
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore !== null) {
      rawStore.deleteRecord(structuredClone(key));
      return;
    }

    await withReadwriteStores([storeName], (transaction) => {
      transaction
        .objectStore(storeName)
        .delete(__LEGIT_CAST__<IndexedDbStoreKey, unknown>(key));
    });
  }

  async function updateStoreRow(
    storeName: string,
    key: unknown,
    update: (current: unknown) => unknown,
  ): Promise<void> {
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore !== null) {
      const existingRecord = rawStore.records.get(key);
      rawStore.deleteRecord(structuredClone(key));
      rawStore.storeRecord({
        key: structuredClone(key),
        value: structuredClone(
          update(
            existingRecord === undefined ? undefined : existingRecord.value,
          ),
        ),
      });
      return;
    }

    await withReadwriteStores([storeName], async (transaction) => {
      const store = transaction.objectStore(storeName);
      const currentValue = await openRequestAsPromise(
        store.get(__LEGIT_CAST__<IndexedDbStoreKey, unknown>(key)),
      );
      store.put(update(currentValue));
    });
  }

  function toManagedMetadata(
    record: IndexedDbEntryRecord,
  ): ManagedMetadataRecord {
    return {
      customMetadata: record.m ?? {},
      key: record.k,
      lastAccessAt: record.a,
      version: record.v,
      writtenAt: record.a,
    };
  }

  function readLogicalStorageEntry<T>(
    flatKey: string,
  ): Promise<StorageCacheEntry<T> | null> {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return Promise.resolve(null);

    const record = getEntryRecord(parsed.scope, parsed.key);
    if (record === null) return Promise.resolve(null);

    const metadata = toManagedMetadata(record);
    return Promise.resolve({
      data: __LEGIT_CAST__<T, unknown>(
        normalizeLogicalPayload(parsed.scope, record.d, metadata),
      ),
      timestamp: metadata.lastAccessAt,
      version: metadata.version,
    });
  }

  function writeLogicalStorageEntry(flatKey: string, value: unknown): void {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return;

    const entry = __LEGIT_CAST__<StorageCacheEntry<unknown>, unknown>(value);
    const customMetadata = buildCustomMetadata(parsed.scope, entry.data);
    enqueueWrite(async () => {
      await putEntryRecord(parsed.scope, {
        customMetadata,
        key: parsed.key,
        lastAccessAt: entry.timestamp,
        value: entry.data,
        version: entry.version ?? 1,
      });
    });
  }

  function setPayloadValue(key: string, value: unknown): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;

    enqueueWrite(async () => {
      const existing = getEntryRecord(parsed.scope, parsed.key);
      await putEntryRecord(parsed.scope, {
        customMetadata: existing?.m ?? buildCustomMetadata(parsed.scope, value),
        key: parsed.key,
        lastAccessAt: existing?.a ?? Date.now(),
        value,
        version: existing?.v ?? 1,
      });
    });
  }

  function setMetadataValue(key: string, value: unknown): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;

    enqueueWrite(async () => {
      const existing = getEntryRecord(parsed.scope, parsed.key);
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
    });
  }

  function removePayloadValue(key: string): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;
    enqueueWrite(() => deleteEntryRecord(parsed.scope, parsed.key));
  }

  function removeMetadataValue(key: string): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;
    enqueueWrite(() => deleteEntryRecord(parsed.scope, parsed.key));
  }

  function setNamespaceStaticPolicy(
    scope: AsyncStorageNamespaceScope,
    policy: Record<string, unknown>,
  ): void {
    enqueueWrite(() =>
      putPolicyRecord(scope, normalizeTestStaticPolicy(policy)),
    );
  }

  function readMetadata(key: string): Promise<ManagedMetadataRecord | null> {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return Promise.resolve(null);
    const record = getEntryRecord(parsed.scope, parsed.key);
    return Promise.resolve(record === null ? null : toManagedMetadata(record));
  }

  async function listRawNamespaceKeys(
    scope: AsyncStorageNamespaceScope,
  ): Promise<string[]> {
    return driver.listKeys(scope);
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
        listStoredPayloads() {
          const entries = listEntryRecords(collectionNamespace);
          return Promise.resolve(
            entries
              .flatMap((entry) =>
                typeof entry.m?.p === 'string' ? [entry.m.p] : [],
              )
              .sort((left, right) => left.localeCompare(right)),
          );
        },
        namespace: collectionNamespace,
        seedItem<T>(
          payload: string,
          data: T,
          seedOptions?: StorageSeedOptions,
        ) {
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
        listStoredItemKeys() {
          const entries = listEntryRecords(listQueryItemNamespace);
          return Promise.resolve(
            entries
              .map((entry) => entry.k)
              .sort((left, right) => left.localeCompare(right)),
          );
        },
        listStoredQueryKeys() {
          const entries = listEntryRecords(listQueryQueryNamespace);
          return Promise.resolve(
            entries
              .map((entry) => entry.k)
              .sort((left, right) => left.localeCompare(right)),
          );
        },
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

  const adapter: AsyncStorageAdapter = {
    kind: 'async',
    openNamespace<
      TValue,
      TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
    >(
      scope: AsyncStorageNamespaceScope,
    ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
      const namespace = baseAdapter.openNamespace<TValue, TCustomMetadata>(
        scope,
      );
      return {
        async get(key, options) {
          await flushWrites();
          return namespace.get(key, options);
        },
        async getMany(keys, options) {
          await flushWrites();
          return namespace.getMany(keys, options);
        },
        async listKeys() {
          await flushWrites();
          return namespace.listKeys();
        },
        async commit(args) {
          await flushWrites();
          return namespace.commit(args);
        },
        async listMetadata(args) {
          await flushWrites();
          return namespace.listMetadata(args);
        },
        ...(namespace.listMetadataByFilter === undefined
          ? {}
          : {
              async listMetadataByFilter(args) {
                await flushWrites();
                return (await namespace.listMetadataByFilter?.(args)) ?? [];
              },
            }),
        async clear() {
          await flushWrites();
          return namespace.clear();
        },
      } satisfies AsyncStorageNamespaceHandle<TValue, TCustomMetadata>;
    },
    async readProtectedStorageKeys(sessionKey) {
      await flushWrites();
      return baseAdapter.readProtectedStorageKeys(sessionKey);
    },
    async syncSessionProtectedKeys(
      sessionKey,
      protectedKeys,
      previousProtectedKeys,
    ) {
      await flushWrites();
      return baseAdapter.syncSessionProtectedKeys(
        sessionKey,
        protectedKeys,
        previousProtectedKeys,
      );
    },
    async clearSession(sessionKey) {
      await flushWrites();
      return baseAdapter.clearSession(sessionKey);
    },
    resetForTests() {
      cleanupRemoveKnownRecordsFailures.clear();
      baseAdapter.resetForTests?.();
    },
  };

  function seedInitialState(): void {
    const initialState = options.initialState;
    if (initialState !== undefined) {
      const scope = createScope(
        initialState.storeName,
        initialState.sessionKey,
      );
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
    scopeReadRequests(args?: { storeName: string; sessionKey: string }) {
      const payloadGetRequests = store.payloadGetRequests;
      if (args === undefined) return payloadGetRequests;

      const scopePrefix = `tsdf.${args.sessionKey}.${args.storeName}.`;
      return payloadGetRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    async getRaw(key: string) {
      const entry = await readLogicalStorageEntry(key);
      return entry === null ? null : JSON.stringify(entry);
    },
    async has(key: string) {
      return (await readLogicalStorageEntry(key)) !== null;
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
          operation.keys.map((key) =>
            getLogicalStorageKey(operation.scope, key),
          ),
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
          operation.keys.map((key) =>
            getLogicalStorageKey(operation.scope, key),
          ),
        );
    },
    storage: {
      async getRaw(key: string) {
        return store.getRaw(key);
      },
      async has(key: string) {
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
    indexedDb: {
      getRow(storeName: string, key: unknown) {
        return Promise.resolve(getStoreRow(storeName, key));
      },
      listRows(storeName: string) {
        return Promise.resolve(listStoreRows(storeName));
      },
      async putRow(storeName: string, value: unknown) {
        await settlePendingWrites();
        return putStoreRow(storeName, value);
      },
      async updateRow(
        storeName: string,
        key: unknown,
        update: (current: unknown) => unknown,
      ) {
        await settlePendingWrites();
        return updateStoreRow(storeName, key, update);
      },
      async deleteRow(storeName: string, key: unknown) {
        await settlePendingWrites();
        return deleteStoreRow(storeName, key);
      },
      async inspectStructure() {
        await settlePendingWrites();
        return inspectIndexedDbStructure();
      },
      async mutateRawRow(
        storeName: string,
        key: unknown,
        update: (current: unknown) => unknown,
      ) {
        await flushWrites();
        mutateRawFakeIndexedDbStoreRow(storeName, key, update);
      },
      queueMutateRawRow(
        storeName: string,
        key: unknown,
        update: (current: unknown) => unknown,
      ) {
        enqueueWrite(() => {
          mutateRawFakeIndexedDbStoreRow(storeName, key, update);
          return Promise.resolve();
        });
      },
      failCleanupRemoveKnownRecords(
        scope: AsyncStorageNamespaceScope,
        times = 1,
      ) {
        const scopeId = JSON.stringify([
          scope.sessionKey,
          scope.storeName,
          scope.kind,
        ]);
        if (times <= 0) {
          cleanupRemoveKnownRecordsFailures.delete(scopeId);
          return;
        }

        cleanupRemoveKnownRecordsFailures.set(scopeId, times);
      },
    },
    rawNamespace: {
      async get(scope: AsyncStorageNamespaceScope, key: string) {
        return driver.get(scope, key);
      },
      async listKeys(scope: AsyncStorageNamespaceScope) {
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
