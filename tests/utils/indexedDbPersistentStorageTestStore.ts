import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';
import { estimateManagedAsyncStorageEntrySizeBytes } from '../../src/persistentStorage/asyncStorageAdapter';
import {
  encodePersistedAsyncNamespaceKind,
  getPersistedNamespaceId,
} from '../../src/persistentStorage/asyncStorageShared';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../src/persistentStorage/documentEntryKey';
import {
  createIndexedDbPersistentStorageForTests,
  type IndexedDbPersistentStorageOperation,
  type IndexedDbPersistentStorageOptions,
} from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import { serializeJsonForStorage } from '../../src/persistentStorage/persistenceUtils';
import type {
  AsyncStorageDriver,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { parseAsyncStorageNamespaceKind } from '../../src/persistentStorage/types';

const INDEXED_DB_ENTRY_STORE = 'entries';
const INDEXED_DB_NAMESPACE_POLICY_STORE = 'namespacePolicies';
const INDEXED_DB_META_STORE = 'meta';
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

type IndexedDbPersistedStaticPolicy = { b?: number; k?: string[] };

type IndexedDbNamespacePolicyRecord = {
  p: IndexedDbPersistedStaticPolicy | null;
  s: string;
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

function isValidEntryRecord(value: unknown): boolean {
  const record = getRecord(value);
  if (record === null) return false;

  const allowedKeys = new Set([
    'a',
    'd',
    'f',
    'g',
    'h',
    'i',
    'm',
    'o',
    'p',
    'v',
    'z',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return false;
  }

  const loadedFields = record.f;
  return (
    typeof record.i === 'string' &&
    typeof record.a === 'number' &&
    'd' in record &&
    (record.v === undefined || typeof record.v === 'number') &&
    (record.z === undefined || typeof record.z === 'number') &&
    (record.m === undefined || getRecord(record.m) !== null) &&
    (record.g === undefined || typeof record.g === 'string') &&
    (record.o === undefined || record.o === 1) &&
    (loadedFields === undefined ||
      (loadedFields instanceof Array &&
        loadedFields.every((entry) => typeof entry === 'string'))) &&
    (record.h === undefined || record.h === 1)
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
      key: DOCUMENT_PERSISTED_ENTRY_KEY,
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
    key: DOCUMENT_PERSISTED_ENTRY_KEY,
    scope: {
      kind: 'document',
      sessionKey: withoutPrefix.slice(0, lastSeparatorIndex),
      storeName: withoutPrefix.slice(lastSeparatorIndex + 1),
    },
  };
}

function createScopeId(scope: AsyncStorageNamespaceScope): string {
  return getPersistedNamespaceId(scope);
}

function createScopePrimaryKey(
  scope: AsyncStorageNamespaceScope,
): [string, string, string] {
  return [
    scope.sessionKey,
    scope.storeName,
    encodePersistedAsyncNamespaceKind(scope.kind),
  ];
}

function getEntryPrimaryKey(
  scope: AsyncStorageNamespaceScope,
  key: string,
): [string, string] {
  return [createScopeId(scope), key];
}

function getEntryKeyFromPrimaryKey(key: unknown): string | null {
  return Array.isArray(key) && typeof key[1] === 'string' ? key[1] : null;
}

function splitCustomMetadata(
  customMetadata: Record<string, unknown> | undefined,
): {
  extraMetadata?: Record<string, unknown>;
  group?: string;
  offlineProtected?: true;
  payload?: unknown;
} {
  if (customMetadata === undefined) return {};

  const { g, o, p, ...rest } = customMetadata;
  return {
    ...(typeof g === 'string' ? { group: g } : {}),
    ...(o === true ? { offlineProtected: true as const } : {}),
    ...('p' in customMetadata ? { payload: p } : {}),
    ...(Object.keys(rest).length > 0 ? { extraMetadata: rest } : {}),
  };
}

function mergeCustomMetadata(fields: {
  extraMetadata?: Record<string, unknown>;
  group?: string;
  offlineProtected?: true;
  payload?: unknown;
}): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {
    ...(fields.extraMetadata ?? {}),
    ...(fields.group !== undefined ? { g: fields.group } : {}),
    ...(fields.offlineProtected === true ? { o: true } : {}),
    ...(fields.payload !== undefined ? { p: fields.payload } : {}),
  };

  return Object.keys(result).length > 0 ? result : undefined;
}

type IndexedDbEntryRecord = {
  a: number;
  d: unknown;
  f?: string[];
  g?: string;
  h?: 1;
  i: string;
  m?: Record<string, unknown>;
  o?: 1;
  p?: unknown;
  v?: number;
  z?: number;
};

function compactEntryValue(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
): Pick<IndexedDbEntryRecord, 'd' | 'f' | 'h'> {
  const record = getRecord(value);

  switch (scope.kind) {
    case 'document':
    case 'collection.item':
    case 'listQuery.item':
      return { d: record !== null && 'd' in record ? record.d : value };
    case 'listQuery.query':
      return {
        d: record !== null && Array.isArray(record.i) ? record.i : value,
      };
    default:
      return { d: value };
  }
}

function expandEntryValue(
  scope: AsyncStorageNamespaceScope,
  record: IndexedDbEntryRecord,
): unknown {
  void scope;
  return record.d;
}

function buildCustomMetadata(
  scope: AsyncStorageNamespaceScope,
  data: unknown,
): Record<string, unknown> {
  const record = getRecord(data);
  if (record === null) return {};

  switch (scope.kind) {
    case 'collection.item':
      return typeof record.payload === 'string'
        ? { p: record.payload }
        : typeof record.p === 'string'
          ? { p: record.p }
          : {};
    case 'listQuery.item':
      return {
        ...(typeof record.payload === 'string'
          ? { p: record.payload }
          : typeof record.p === 'string'
            ? { p: record.p }
            : {}),
        ...(Array.isArray(record.loadedFields)
          ? { f: record.loadedFields }
          : Array.isArray(record.lf)
            ? { f: record.lf }
            : {}),
      };
    case 'listQuery.query':
      return {
        ...(typeof record.payload === 'object' ||
        typeof record.payload === 'string'
          ? { p: record.payload }
          : 'p' in record
            ? { p: record.p }
            : {}),
        ...(record.hasMore === true || record.h === true ? { h: true } : {}),
      };
    default:
      return {};
  }
}

function normalizeTestStaticPolicy(
  policy: Record<string, unknown>,
): AsyncStorageNamespaceStaticPolicy {
  return {
    ...(typeof policy.b === 'number'
      ? { maxBytes: policy.b }
      : typeof policy.maxBytes === 'number'
        ? { maxBytes: policy.maxBytes }
        : typeof policy.m === 'number'
          ? { maxBytes: policy.m }
          : typeof policy.maxEntries === 'number'
            ? { maxBytes: policy.maxEntries }
            : {}),
    ...(Array.isArray(policy.k)
      ? {
          pinnedKeys: policy.k.flatMap((value) =>
            typeof value === 'string' ? [value] : [],
          ),
        }
      : Array.isArray(policy.p)
        ? {
            pinnedKeys: policy.p.flatMap((value) =>
              typeof value === 'string' ? [value] : [],
            ),
          }
        : Array.isArray(policy.pinnedKeys)
          ? {
              pinnedKeys: policy.pinnedKeys.flatMap((value) =>
                typeof value === 'string' ? [value] : [],
              ),
            }
          : {}),
  };
}

export function serializeTestStaticPolicy(
  policy:
    | AsyncStorageNamespaceStaticPolicy
    | Record<string, unknown>
    | null
    | undefined,
): Record<string, unknown> | null {
  if (policy === undefined || policy === null) return null;

  const record = __LEGIT_CAST__<Record<string, unknown>, unknown>(policy);

  return {
    ...(typeof record.b === 'number'
      ? { b: record.b }
      : typeof record.maxBytes === 'number'
        ? { b: record.maxBytes }
        : typeof record.m === 'number'
          ? { b: record.m }
          : typeof record.maxEntries === 'number'
            ? { b: record.maxEntries }
            : {}),
    ...(Array.isArray(record.k)
      ? {
          k: record.k.flatMap((value) =>
            typeof value === 'string' ? [value] : [],
          ),
        }
      : Array.isArray(record.p)
        ? {
            k: record.p.flatMap((value) =>
              typeof value === 'string' ? [value] : [],
            ),
          }
        : Array.isArray(record.pinnedKeys)
          ? {
              k: record.pinnedKeys.flatMap((value) =>
                typeof value === 'string' ? [value] : [],
              ),
            }
          : {}),
  };
}

export type ManagedMetadataRecord = {
  customMetadata: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
  writtenAt: number;
};

export function serializeManagedMetadataRecord(
  metadata: ManagedMetadataRecord,
): Record<string, unknown> {
  if (
    'a' in metadata.customMetadata ||
    'v' in metadata.customMetadata ||
    'z' in metadata.customMetadata
  ) {
    throw new Error(
      '[TSDF] Async storage custom metadata cannot use reserved keys "a", "v", or "z".',
    );
  }

  return {
    a: metadata.lastAccessAt,
    ...(metadata.sizeBytes !== undefined ? { z: metadata.sizeBytes } : {}),
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
    ('v' in record && record.v !== undefined && typeof record.v !== 'number') ||
    ('z' in record && record.z !== undefined && typeof record.z !== 'number')
  ) {
    return null;
  }

  const customMetadata = Object.fromEntries(
    Object.entries(record).filter(
      ([entryKey]) => entryKey !== 'a' && entryKey !== 'v' && entryKey !== 'z',
    ),
  );

  return {
    customMetadata,
    key,
    lastAccessAt: record.a,
    ...(typeof record.z === 'number' ? { sizeBytes: record.z } : {}),
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
      ...(typeof record.sizeBytes === 'number'
        ? { sizeBytes: record.sizeBytes }
        : {}),
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

  switch (scope.kind) {
    case 'document':
      return { data: record !== null && 'd' in record ? record.d : value };
    case 'collection.item':
      return metadata?.customMetadata !== undefined &&
        'p' in metadata.customMetadata
        ? {
            data: record !== null && 'd' in record ? record.d : value,
            payload: metadata.customMetadata.p,
          }
        : value;
    case 'listQuery.item':
      if (
        metadata?.customMetadata === undefined ||
        !('p' in metadata.customMetadata)
      ) {
        return value;
      }

      return {
        data: record !== null && 'd' in record ? record.d : value,
        payload: metadata.customMetadata.p,
        ...(Array.isArray(metadata.customMetadata.f)
          ? { loadedFields: metadata.customMetadata.f }
          : record !== null && 'lf' in record && Array.isArray(record.lf)
            ? { loadedFields: record.lf }
            : {}),
      };
    case 'listQuery.query':
      return metadata?.customMetadata !== undefined &&
        'p' in metadata.customMetadata &&
        (Array.isArray(value) || (record !== null && Array.isArray(record.i)))
        ? {
            hasMore:
              metadata.customMetadata.h === true ||
              (record !== null && record.h === true),
            items: Array.isArray(value) ? value : record?.i,
            payload: metadata.customMetadata.p,
          }
        : value;
    default:
      return value;
  }
}

function estimateEntrySizeBytes(args: {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  scope: AsyncStorageNamespaceScope;
  value: unknown;
  version: number;
}): number {
  const compactValue = compactEntryValue(args.scope, args.value);

  return estimateManagedAsyncStorageEntrySizeBytes({
    customMetadata: args.customMetadata,
    lastAccessAt: args.lastAccessAt,
    serializedValue: serializeJsonForStorage(compactValue.d).rawValue,
    version: args.version,
  });
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

export type IndexedDbPersistentStorageTestStore = {
  adapter: ReturnType<
    typeof createIndexedDbPersistentStorageForTests
  >['adapter'];
  clearReadRequests: () => void;
  clearInstrumentation: () => void;
  databaseName: string;
  flushIndexedDbCommits: () => Promise<void>;
  flushPendingWrites: () => Promise<void>;
  flushWrites: () => Promise<void>;
  scopeReadRequests: (args?: {
    storeName: string;
    sessionKey: string;
  }) => string[];
  getRaw: (key: string) => Promise<string | null>;
  has: (key: string) => Promise<boolean>;
  listKeysRequests: AsyncStorageNamespaceScope[];
  operations: IndexedDbPersistentStorageOperation[];
  payloadGetManyRequests: string[][];
  payloadGetRequests: string[];
  storage: {
    getRaw: (key: string) => Promise<string | null>;
    has: (key: string) => Promise<boolean>;
    writeRaw: (key: string, raw: string) => void;
    writeValue: <T>(key: string, value: T) => void;
    writePayload: (key: string, value: unknown) => void;
    writeMetadata: (key: string, value: unknown) => void;
    removePayload: (key: string) => void;
    removeMetadata: (key: string) => void;
  };
  indexedDb: {
    getRow: (storeName: string, key: unknown) => Promise<unknown>;
    listRows: (
      storeName: string,
    ) => Promise<Array<{ key: unknown; value: unknown }>>;
    putRow: (storeName: string, value: unknown) => Promise<unknown>;
    updateRow: (
      storeName: string,
      key: unknown,
      update: (current: unknown) => unknown,
    ) => Promise<unknown>;
    deleteRow: (storeName: string, key: unknown) => Promise<unknown>;
    inspectStructure: () => Promise<IndexedDbStructureInspection>;
    mutateRawRow: (
      storeName: string,
      key: unknown,
      update: (current: unknown) => unknown,
    ) => Promise<void>;
    queueMutateRawRow: (
      storeName: string,
      key: unknown,
      update: (current: unknown) => unknown,
    ) => void;
    failCleanupRemoveKnownRecords: (
      scope: AsyncStorageNamespaceScope,
      times?: number,
    ) => void;
  };
  rawNamespace: {
    get: (scope: AsyncStorageNamespaceScope, key: string) => Promise<unknown>;
    listKeys: (scope: AsyncStorageNamespaceScope) => Promise<string[]>;
    remove: (scope: AsyncStorageNamespaceScope, key: string) => void;
    set: (
      scope: AsyncStorageNamespaceScope,
      key: string,
      value: unknown,
    ) => void;
  };
  readMetadata: (key: string) => Promise<ManagedMetadataRecord | null>;
  removeMetadata: (key: string) => void;
  removePayload: (key: string) => void;
  scope: (
    storeName: string,
    sessionKey: string,
  ) => IndexedDbPersistentStorageTestStoreScope;
  setMetadata: (key: string, value: unknown) => void;
  setPayload: (key: string, value: unknown) => void;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
};

let currentIndexedDbPersistentStorageTestStore: IndexedDbPersistentStorageTestStore | null =
  null;

export function getCurrentIndexedDbPersistentStorageTestStore(): IndexedDbPersistentStorageTestStore {
  if (currentIndexedDbPersistentStorageTestStore === null) {
    throw new Error(
      'Expected an active IndexedDB persistent storage test store.',
    );
  }

  return currentIndexedDbPersistentStorageTestStore;
}

export function resetCurrentIndexedDbPersistentStorageTestStore(): Promise<void> {
  const currentStore = currentIndexedDbPersistentStorageTestStore;
  currentIndexedDbPersistentStorageTestStore = null;
  currentStore?.adapter.resetForTests?.();
  return Promise.resolve();
}

function createIndexedDbPersistentStorageTestStoreInternal(
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
      if (database.objectStoreNames.contains(INDEXED_DB_ENTRY_STORE)) {
        database.deleteObjectStore(INDEXED_DB_ENTRY_STORE);
      }
      if (
        database.objectStoreNames.contains(INDEXED_DB_NAMESPACE_POLICY_STORE)
      ) {
        database.deleteObjectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);
      }

      const entryStore = database.createObjectStore(INDEXED_DB_ENTRY_STORE);
      entryStore.createIndex('byScopeLastAccessAt', ['i', 'a'], {
        unique: false,
      });
      entryStore.createIndex('byScopeGroup', ['i', 'g'], { unique: false });
      entryStore.createIndex('byScopeOfflineProtected', ['i', 'o'], {
        unique: false,
      });

      const scopeStore = database.createObjectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      scopeStore.createIndex('bySession', 's', { unique: false });

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

  function normalizeIndexedDbStoreKey(
    storeName: string,
    key: unknown,
  ): unknown {
    const semanticKind =
      Array.isArray(key) && typeof key[2] === 'string'
        ? parseAsyncStorageNamespaceKind(key[2])
        : null;

    if (
      storeName === INDEXED_DB_ENTRY_STORE &&
      Array.isArray(key) &&
      key.length === 4 &&
      typeof key[0] === 'string' &&
      typeof key[1] === 'string' &&
      semanticKind !== null &&
      typeof key[3] === 'string'
    ) {
      return [
        getPersistedNamespaceId({
          kind: semanticKind,
          sessionKey: key[0],
          storeName: key[1],
        }),
        key[3],
      ];
    }

    if (
      storeName === INDEXED_DB_NAMESPACE_POLICY_STORE &&
      Array.isArray(key) &&
      key.length === 3 &&
      typeof key[0] === 'string' &&
      typeof key[1] === 'string' &&
      semanticKind !== null
    ) {
      return [key[0], key[1], encodePersistedAsyncNamespaceKind(semanticKind)];
    }

    return key;
  }

  function mutateRawFakeIndexedDbStoreRow(
    storeName: string,
    key: unknown,
    update: (current: unknown) => unknown,
  ): void {
    const normalizedKey = normalizeIndexedDbStoreKey(storeName, key);
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore === null) {
      throw new Error(`Expected raw IndexedDB store "${storeName}" to exist.`);
    }

    const record = rawStore.records.get(normalizedKey);
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
          JSON.stringify(getEntryPrimaryKey(scope, key)) &&
        isValidEntryRecord(entry.value),
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
      sizeBytes?: number;
      value: unknown;
      version: number;
    },
  ): Promise<void> {
    await withReadwriteStores(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      async (transaction) => {
        const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
        const scopeStore = transaction.objectStore(
          INDEXED_DB_NAMESPACE_POLICY_STORE,
        );
        const existingScopeRecord = await openRequestAsPromise<
          IndexedDbNamespacePolicyRecord | undefined
        >(scopeStore.get(createScopePrimaryKey(scope)));
        const { extraMetadata, group, offlineProtected, payload } =
          splitCustomMetadata(args.customMetadata);
        const compactValue = compactEntryValue(scope, args.value);
        const sizeBytes =
          scope.kind === 'document'
            ? undefined
            : (args.sizeBytes ??
              estimateEntrySizeBytes({
                customMetadata: args.customMetadata,
                lastAccessAt: args.lastAccessAt,
                scope,
                value: args.value,
                version: args.version,
              }));

        entryStore.put(
          {
            a: args.lastAccessAt,
            ...compactValue,
            ...(group !== undefined ? { g: group } : {}),
            i: createScopeId(scope),
            ...(extraMetadata !== undefined ? { m: extraMetadata } : {}),
            ...(offlineProtected === true ? { o: 1 as const } : {}),
            ...(payload !== undefined ? { p: payload } : {}),
            ...(args.version !== 1 ? { v: args.version } : {}),
            ...(sizeBytes !== undefined ? { z: sizeBytes } : {}),
          } satisfies IndexedDbEntryRecord,
          getEntryPrimaryKey(scope, args.key),
        );
        scopeStore.put(
          {
            p: existingScopeRecord?.p ?? null,
            s: scope.sessionKey,
          } satisfies IndexedDbNamespacePolicyRecord,
          createScopePrimaryKey(scope),
        );
      },
    );
  }

  function getCustomMetadataFromEntryRecord(
    record: IndexedDbEntryRecord,
  ): Record<string, unknown> {
    return (
      mergeCustomMetadata({
        extraMetadata: record.m,
        group: record.g,
        offlineProtected: record.o === 1 ? true : undefined,
        payload: record.p,
      }) ?? {}
    );
  }

  function getManagedMetadataFromEntryRecord(
    key: string,
    record: IndexedDbEntryRecord,
  ): ManagedMetadataRecord {
    return {
      customMetadata: getCustomMetadataFromEntryRecord(record),
      key,
      lastAccessAt: record.a,
      ...(typeof record.z === 'number' ? { sizeBytes: record.z } : {}),
      version: record.v ?? 1,
      writtenAt: record.a,
    };
  }

  async function putPolicyRecord(
    scope: AsyncStorageNamespaceScope,
    staticPolicy: AsyncStorageNamespaceStaticPolicy | null,
  ): Promise<void> {
    await withReadwriteStores(
      [INDEXED_DB_NAMESPACE_POLICY_STORE],
      (transaction) => {
        transaction
          .objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE)
          .put(
            {
              p: serializeTestStaticPolicy(staticPolicy),
              s: scope.sessionKey,
            } satisfies IndexedDbNamespacePolicyRecord,
            createScopePrimaryKey(scope),
          );
      },
    );
  }

  async function deleteEntryRecord(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): Promise<void> {
    await withReadwriteStores([INDEXED_DB_ENTRY_STORE], (transaction) => {
      transaction
        .objectStore(INDEXED_DB_ENTRY_STORE)
        .delete(getEntryPrimaryKey(scope, key));
    });
  }

  function listEntryRecords(
    scope: AsyncStorageNamespaceScope,
  ): IndexedDbEntryRecord[] {
    return listRawFakeIndexedDbStoreRows(INDEXED_DB_ENTRY_STORE)
      .filter(
        (entry) =>
          Array.isArray(entry.key) &&
          entry.key[0] === createScopeId(scope) &&
          isValidEntryRecord(entry.value),
      )
      .map((entry) =>
        __LEGIT_CAST__<IndexedDbEntryRecord, unknown>(entry.value),
      )
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  }

  function listEntryKeys(scope: AsyncStorageNamespaceScope): string[] {
    return listRawFakeIndexedDbStoreRows(INDEXED_DB_ENTRY_STORE)
      .filter(
        (entry) =>
          Array.isArray(entry.key) && entry.key[0] === createScopeId(scope),
      )
      .flatMap((entry) => {
        const entryKey = getEntryKeyFromPrimaryKey(entry.key);
        return entryKey === null ? [] : [entryKey];
      })
      .sort((left, right) => left.localeCompare(right));
  }

  function getStoreRow(storeName: string, key: unknown): unknown {
    const normalizedKey = normalizeIndexedDbStoreKey(storeName, key);
    return (
      listRawFakeIndexedDbStoreRows(storeName).find(
        (row) => JSON.stringify(row.key) === JSON.stringify(normalizedKey),
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
    const normalizedKey = normalizeIndexedDbStoreKey(storeName, key);
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore !== null) {
      rawStore.deleteRecord(structuredClone(normalizedKey));
      return;
    }

    await withReadwriteStores([storeName], (transaction) => {
      transaction
        .objectStore(storeName)
        .delete(__LEGIT_CAST__<IndexedDbStoreKey, unknown>(normalizedKey));
    });
  }

  async function updateStoreRow(
    storeName: string,
    key: unknown,
    update: (current: unknown) => unknown,
  ): Promise<void> {
    const normalizedKey = normalizeIndexedDbStoreKey(storeName, key);
    const rawStore = getRawFakeIndexedDbStore(storeName);
    if (rawStore !== null) {
      const existingRecord = rawStore.records.get(normalizedKey);
      rawStore.deleteRecord(structuredClone(normalizedKey));
      rawStore.storeRecord({
        key: structuredClone(normalizedKey),
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
        store.get(__LEGIT_CAST__<IndexedDbStoreKey, unknown>(normalizedKey)),
      );
      if (
        storeName === INDEXED_DB_ENTRY_STORE ||
        storeName === INDEXED_DB_NAMESPACE_POLICY_STORE
      ) {
        store.put(
          update(currentValue),
          __LEGIT_CAST__<IDBValidKey, unknown>(normalizedKey),
        );
      } else {
        store.put(update(currentValue));
      }
    });
  }

  function readLogicalStorageEntry<T>(
    flatKey: string,
  ): Promise<StorageCacheEntry<T> | null> {
    const parsed = parseFlatStorageKey(flatKey);
    if (parsed === null) return Promise.resolve(null);

    const record = getEntryRecord(parsed.scope, parsed.key);
    if (record === null) return Promise.resolve(null);

    const metadata = getManagedMetadataFromEntryRecord(parsed.key, record);
    return Promise.resolve({
      data: __LEGIT_CAST__<T, unknown>(
        normalizeLogicalPayload(
          parsed.scope,
          expandEntryValue(parsed.scope, record),
          metadata,
        ),
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
    const version = entry.version ?? 1;
    enqueueWrite(async () => {
      await putEntryRecord(parsed.scope, {
        customMetadata,
        key: parsed.key,
        lastAccessAt: entry.timestamp,
        sizeBytes: estimateEntrySizeBytes({
          customMetadata,
          lastAccessAt: entry.timestamp,
          scope: parsed.scope,
          value: entry.data,
          version,
        }),
        value: entry.data,
        version,
      });
    });
  }

  function setPayloadValue(key: string, value: unknown): void {
    const parsed = parseFlatStorageKey(key);
    if (parsed === null) return;

    enqueueWrite(async () => {
      const existing = getEntryRecord(parsed.scope, parsed.key);
      const customMetadata =
        existing === null
          ? buildCustomMetadata(parsed.scope, value)
          : getCustomMetadataFromEntryRecord(existing);
      const lastAccessAt = existing?.a ?? Date.now();
      const version = existing?.v ?? 1;
      await putEntryRecord(parsed.scope, {
        customMetadata,
        key: parsed.key,
        lastAccessAt,
        sizeBytes: estimateEntrySizeBytes({
          customMetadata,
          lastAccessAt,
          scope: parsed.scope,
          value,
          version,
        }),
        value,
        version,
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
      const existingValue = expandEntryValue(parsed.scope, existing);

      await putEntryRecord(parsed.scope, {
        customMetadata: metadata.customMetadata,
        key: parsed.key,
        lastAccessAt: metadata.lastAccessAt,
        sizeBytes:
          metadata.sizeBytes ??
          estimateEntrySizeBytes({
            customMetadata: metadata.customMetadata,
            lastAccessAt: metadata.lastAccessAt,
            scope: parsed.scope,
            value: existingValue,
            version: metadata.version,
          }),
        value: existingValue,
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
    return Promise.resolve(
      record === null
        ? null
        : getManagedMetadataFromEntryRecord(parsed.key, record),
    );
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
      DOCUMENT_PERSISTED_ENTRY_KEY,
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
                typeof entry.p === 'string' ? [entry.p] : [],
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
          return Promise.resolve(listEntryKeys(listQueryItemNamespace));
        },
        listStoredQueryKeys() {
          return Promise.resolve(listEntryKeys(listQueryQueryNamespace));
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
                p: params,
                ...(queryOptions.hasMore === true ? { h: true } : {}),
                i: items.map(normalizeQueryItemRef),
              },
              {
                timestamp: queryOptions.timestamp,
                version: queryOptions.version,
              },
            ),
          );
          return storageKey;
        },
        setItemStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(listQueryItemNamespace, policy),
        setQueryStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(listQueryQueryNamespace, policy),
      },
    };
  }

  const adapter = baseAdapter;
  const baseOpenNamespace = baseAdapter.openNamespace.bind(baseAdapter);
  const baseReadProtectedStorageKeys =
    baseAdapter.readProtectedStorageKeys.bind(baseAdapter);
  const baseSyncSessionProtectedKeys =
    baseAdapter.syncSessionProtectedKeys.bind(baseAdapter);
  const baseClearSession = baseAdapter.clearSession.bind(baseAdapter);
  const baseResetForTests = baseAdapter.resetForTests?.bind(baseAdapter);

  adapter.openNamespace = function openNamespaceForTests<
    TValue,
    TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
    const namespace = baseOpenNamespace<TValue, TCustomMetadata>(scope);
    return {
      async get(key, getOptions) {
        await flushWrites();
        return namespace.get(key, getOptions);
      },
      async getMany(keys, getManyOptions) {
        await flushWrites();
        return namespace.getMany(keys, getManyOptions);
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
  };
  adapter.readProtectedStorageKeys = async (sessionKey) => {
    await flushWrites();
    return baseReadProtectedStorageKeys(sessionKey);
  };
  adapter.syncSessionProtectedKeys = async (
    sessionKey,
    protectedKeys,
    previousProtectedKeys,
  ) => {
    await flushWrites();
    return baseSyncSessionProtectedKeys(
      sessionKey,
      protectedKeys,
      previousProtectedKeys,
    );
  };
  adapter.clearSession = async (sessionKey) => {
    await flushWrites();
    return baseClearSession(sessionKey);
  };
  adapter.resetForTests = () => {
    cleanupRemoveKnownRecordsFailures.clear();
    baseResetForTests?.();
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
        .flatMap((operation) =>
          operation.type === 'listManagedMetadata' &&
          operation.usedIndex === 'key'
            ? [operation.scope]
            : [],
        );
    },
    get operations() {
      return instrumentationOperations.slice(instrumentationStartIndex);
    },
    get payloadGetManyRequests() {
      return instrumentationOperations
        .slice(readStartIndex)
        .flatMap((operation) =>
          operation.type === 'readManagedEntries' && operation.keys.length > 1
            ? [
                operation.keys.map((key) =>
                  getLogicalStorageKey(operation.scope, key),
                ),
              ]
            : [],
        );
    },
    get payloadGetRequests() {
      return instrumentationOperations
        .slice(readStartIndex)
        .flatMap((operation) =>
          operation.type === 'readManagedEntries' && operation.keys.length === 1
            ? operation.keys.map((key) =>
                getLogicalStorageKey(operation.scope, key),
              )
            : [],
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

export function createIndexedDbPersistentStorageTestStore(
  options: IndexedDbPersistentStorageTestStoreOptions = {},
): IndexedDbPersistentStorageTestStore {
  return createIndexedDbPersistentStorageTestStoreInternal(options);
}
