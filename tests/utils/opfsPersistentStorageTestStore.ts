import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  getMetadataRecordKey,
  getPayloadRecordKey,
  joinPath,
  METADATA_RECORD_PREFIX,
  OPFS_ROOT_DIR,
  parseFileName,
  PAYLOAD_RECORD_PREFIX,
} from '../../src/persistentStorage/opfsFileNaming';
import type {
  AsyncStorageNamespaceScope,
  PersistedCollectionItemData,
  PersistedDocumentData,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import {
  createMockBrowserOpfs,
  type MockBrowserOpfsEnvironment,
  type MockBrowserOpfsOperation as RawMockBrowserOpfsOperation,
} from '../mocks/mockBrowserOpfs';

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

type StorageSeedOptions = { timestamp?: number; version?: number };

type ListQuerySeedItemOptions = StorageSeedOptions & {
  loadedFields?: string[];
};

type ListQueryItemRef = string | { tableId: string; id: number | string };

type ParsedFlatKey = { scope: AsyncStorageNamespaceScope; key: string };

function parseFlatStorageKey(key: string): ParsedFlatKey | null {
  const prefix = 'tsdf.';
  if (!key.startsWith(prefix)) return null;

  const withoutPrefix = key.slice(prefix.length);

  if (withoutPrefix.endsWith('._o_.p')) {
    const sessionKey = withoutPrefix.slice(0, -'._o_.p'.length);
    return {
      scope: { sessionKey, storeName: '_o_.p', kind: 'document' },
      key: 'document',
    };
  }

  if (withoutPrefix.endsWith('.__offline__.session')) {
    const sessionKey = withoutPrefix.slice(0, -'.__offline__.session'.length);
    return {
      scope: { sessionKey, storeName: '__offline__', kind: 'document' },
      key: 'session',
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
    if (lastSeparatorIndex < 0 || entryKey.length === 0) {
      return null;
    }

    return {
      scope: {
        sessionKey: beforeMarker.slice(0, lastSeparatorIndex),
        storeName: beforeMarker.slice(lastSeparatorIndex + 1),
        kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(kind),
      },
      key: entryKey,
    };
  }

  const lastSeparatorIndex = withoutPrefix.lastIndexOf('.');
  if (lastSeparatorIndex > 0) {
    return {
      scope: {
        sessionKey: withoutPrefix.slice(0, lastSeparatorIndex),
        storeName: withoutPrefix.slice(lastSeparatorIndex + 1),
        kind: 'document',
      },
      key: 'document',
    };
  }

  return null;
}

type LogicalRecordLocation = {
  key: string;
  metadataRecordKey: string;
  payloadRecordKey: string;
  scope: AsyncStorageNamespaceScope;
};

function getLogicalRecordLocation(key: string): LogicalRecordLocation | null {
  const parsed = parseFlatStorageKey(key);
  if (parsed === null) return null;

  return {
    key: parsed.key,
    scope: parsed.scope,
    payloadRecordKey: getPayloadRecordKey(parsed.key),
    metadataRecordKey: getMetadataRecordKey(parsed.key),
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
        ...(Array.isArray(record.items)
          ? { i: record.items }
          : Array.isArray(record.i)
            ? { i: record.i }
            : {}),
        ...(record.hasMore === true || record.h === true ? { h: true } : {}),
      };
    default:
      return {};
  }
}

type ManagedMetadataRecord = {
  customMetadata: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  version: number;
  writtenAt: number;
};

type RawManagedMetadataRecord = { a: number; v: number } & Record<
  string,
  unknown
>;

function serializeManagedMetadataRecord(
  metadata: ManagedMetadataRecord,
): RawManagedMetadataRecord {
  if ('a' in metadata.customMetadata || 'v' in metadata.customMetadata) {
    throw new Error(
      '[TSDF] Async storage custom metadata cannot use reserved keys "a" or "v".',
    );
  }

  return {
    a: metadata.lastAccessAt,
    v: metadata.version,
    ...metadata.customMetadata,
  };
}

function createManagedMetadataRecord(
  scope: AsyncStorageNamespaceScope,
  key: string,
  entry: StorageCacheEntry<unknown>,
): RawManagedMetadataRecord {
  return {
    a: entry.timestamp,
    v: entry.version ?? 1,
    ...buildCustomMetadata(scope, entry.data),
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
    typeof record.v !== 'number'
  ) {
    return null;
  }

  const customMetadata = Object.fromEntries(
    Object.entries(record).filter(
      ([entryKey]) => entryKey !== 'a' && entryKey !== 'v',
    ),
  );

  return {
    key,
    writtenAt: record.a,
    lastAccessAt: record.a,
    version: record.v,
    customMetadata,
  };
}

function normalizeMetadataValue(key: string, value: unknown): unknown {
  const record = getRecord(value);
  if (record === null) return value;

  if (typeof record.a === 'number' && typeof record.v === 'number') {
    return value;
  }

  if (
    typeof record.lastAccessAt === 'number' &&
    typeof record.version === 'number'
  ) {
    return serializeManagedMetadataRecord({
      key,
      writtenAt: record.lastAccessAt,
      lastAccessAt: record.lastAccessAt,
      version: record.version,
      customMetadata: getRecord(record.customMetadata) ?? {},
    });
  }

  return value;
}

function normalizeLogicalPayload(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
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
      return 'p' in record && 'i' in record && Array.isArray(record.i)
        ? { payload: record.p, items: record.i, hasMore: record.h === true }
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

function readRawRecord(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
  key: string,
): string | null {
  return mockBrowserOpfs.readFile(filePathForRecord(scope, key));
}

function writeRawRecord(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
  key: string,
  raw: string,
): void {
  mockBrowserOpfs.writeFile(filePathForRecord(scope, key), raw);
}

function removeRawRecord(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
  key: string,
): void {
  mockBrowserOpfs.removeFile(filePathForRecord(scope, key));
}

function listRawKeys(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
): string[] {
  return mockBrowserOpfs
    .listEntries(storeDirPath(scope))
    .flatMap((entry) => {
      if (!entry.startsWith('file:')) return [];
      const fileName = entry.slice('file:'.length);
      const parsed = parseFileName(fileName);
      if (parsed === null || parsed.kind !== scope.kind) return [];
      return [parsed.key];
    })
    .sort((left, right) => left.localeCompare(right));
}

function writeLogicalStorageEntry(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  flatKey: string,
  value: unknown,
): void {
  const parsed = parseFlatStorageKey(flatKey);
  if (parsed === null) return;

  const entry = __LEGIT_CAST__<StorageCacheEntry<unknown>, unknown>(value);
  writeRawRecord(
    mockBrowserOpfs,
    parsed.scope,
    getPayloadRecordKey(parsed.key),
    JSON.stringify(entry.data),
  );
  writeRawRecord(
    mockBrowserOpfs,
    parsed.scope,
    getMetadataRecordKey(parsed.key),
    JSON.stringify(
      createManagedMetadataRecord(parsed.scope, parsed.key, entry),
    ),
  );
}

function readLogicalStorageEntry<T>(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  flatKey: string,
): StorageCacheEntry<T> | null {
  const parsed = parseFlatStorageKey(flatKey);
  if (parsed === null) return null;

  const payloadRaw = readRawRecord(
    mockBrowserOpfs,
    parsed.scope,
    getPayloadRecordKey(parsed.key),
  );
  const metadataRaw = readRawRecord(
    mockBrowserOpfs,
    parsed.scope,
    getMetadataRecordKey(parsed.key),
  );
  if (payloadRaw === null || metadataRaw === null) return null;

  const payload = safeJsonParse(payloadRaw);
  const metadata = parseManagedMetadataRecord(
    safeJsonParse(metadataRaw),
    parsed.key,
  );
  if (payload === null || metadata === null) {
    return null;
  }

  return {
    data: __LEGIT_CAST__<T, unknown>(
      normalizeLogicalPayload(parsed.scope, payload),
    ),
    timestamp: metadata.lastAccessAt,
    version: metadata.version,
  };
}

function readLogicalMetadata(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  flatKey: string,
): ManagedMetadataRecord | null {
  const location = getLogicalRecordLocation(flatKey);
  if (location === null) return null;

  const raw = readRawRecord(
    mockBrowserOpfs,
    location.scope,
    location.metadataRecordKey,
  );
  if (raw === null) return null;

  return parseManagedMetadataRecord(safeJsonParse(raw), location.key);
}

function setPayloadValue(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  key: string,
  value: unknown,
): void {
  const location = getLogicalRecordLocation(key);
  if (location === null) return;

  writeRawRecord(
    mockBrowserOpfs,
    location.scope,
    location.payloadRecordKey,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

function setMetadataValue(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  key: string,
  value: unknown,
): void {
  const location = getLogicalRecordLocation(key);
  if (location === null) return;

  writeRawRecord(
    mockBrowserOpfs,
    location.scope,
    location.metadataRecordKey,
    typeof value === 'string'
      ? value
      : JSON.stringify(normalizeMetadataValue(location.key, value)),
  );
}

function removePayloadValue(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  key: string,
): void {
  const location = getLogicalRecordLocation(key);
  if (location === null) return;
  removeRawRecord(mockBrowserOpfs, location.scope, location.payloadRecordKey);
}

function removeMetadataValue(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  key: string,
): void {
  const location = getLogicalRecordLocation(key);
  if (location === null) return;
  removeRawRecord(mockBrowserOpfs, location.scope, location.metadataRecordKey);
}

function parseStoreFromDirPath(
  path: string,
): Pick<AsyncStorageNamespaceScope, 'sessionKey' | 'storeName'> | null {
  const pathSegments = path.split('/');
  if (pathSegments.length !== 3 || pathSegments[0] !== OPFS_ROOT_DIR) {
    return null;
  }

  const encodedSessionKey = pathSegments[1];
  const encodedStoreName = pathSegments[2];
  if (encodedSessionKey === undefined || encodedStoreName === undefined) {
    return null;
  }

  return {
    sessionKey: decodePathSegment(encodedSessionKey),
    storeName: decodePathSegment(encodedStoreName),
  };
}

function parseTrackedDirPath(
  path: string,
): { path: string; scope: AsyncStorageNamespaceScope | null } | null {
  const pathSegments = path.split('/');
  if (pathSegments[0] !== OPFS_ROOT_DIR) return null;

  return { path, scope: null };
}

type RecordKind = 'payload' | 'metadata' | 'internal';

type InstrumentedRecord = {
  key: string;
  logicalKey: string | null;
  recordKind: RecordKind;
};

function getInstrumentedRecord(
  scope: AsyncStorageNamespaceScope,
  key: string,
): InstrumentedRecord {
  if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
    const userKey = key.slice(PAYLOAD_RECORD_PREFIX.length);
    return {
      key,
      logicalKey: getLogicalStorageKey(scope, userKey),
      recordKind: 'payload',
    };
  }

  if (key.startsWith(METADATA_RECORD_PREFIX)) {
    const userKey = key.slice(METADATA_RECORD_PREFIX.length);
    return {
      key,
      logicalKey: getLogicalStorageKey(scope, userKey),
      recordKind: 'metadata',
    };
  }

  return { key, logicalKey: null, recordKind: 'internal' };
}

function parseFileContext(
  path: string,
): {
  path: string;
  record: InstrumentedRecord;
  scope: AsyncStorageNamespaceScope;
} | null {
  const pathSegments = path.split('/');
  const fileName = pathSegments.pop();
  if (fileName === undefined) return null;

  const store = parseStoreFromDirPath(pathSegments.join('/'));
  const parsedRecord = parseFileName(fileName);
  if (store === null || parsedRecord === null) {
    return null;
  }

  const scope = {
    ...store,
    kind: parsedRecord.kind,
  } satisfies AsyncStorageNamespaceScope;
  return {
    path,
    scope,
    record: getInstrumentedRecord(scope, parsedRecord.key),
  };
}

function isAppStoreFilePath(path: string): boolean {
  const pathSegments = path.split('/');
  if (pathSegments.length < 4 || pathSegments[0] !== OPFS_ROOT_DIR) {
    return false;
  }

  const encodedStoreName = pathSegments[2];
  if (encodedStoreName === undefined) return false;

  const storeName = decodePathSegment(encodedStoreName);

  return storeName !== '_o_.p';
}

type MockOpfsBaseOperation = {
  path: string;
  startedTime: number;
  time: number;
};

type UntrackedMockOpfsFileOperation = MockOpfsBaseOperation & {
  fileName: string;
  scope: null;
} & (
    | { created: boolean; exists: boolean; type: 'ensureFile' | 'openFile' }
    | { type: 'readFile'; valueByteSize: number }
    | {
        type: 'writeFile';
        valueChanged: boolean;
        valueByteSizeAfter: number;
        valueByteSizeBefore: number;
      }
    | { exists: boolean; type: 'deleteFile' }
  );

export type MockOpfsOperation =
  | (MockOpfsBaseOperation & {
      created: boolean;
      exists: boolean;
      scope: AsyncStorageNamespaceScope | null;
      type: 'ensureDir' | 'openDir';
    })
  | (MockOpfsBaseOperation & {
      created: boolean;
      exists: boolean;
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
      type: 'ensureFile' | 'openFile';
    })
  | (MockOpfsBaseOperation & {
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
    } & (
        | { type: 'readFile'; valueByteSize: number }
        | {
            type: 'writeFile';
            valueChanged: boolean;
            valueByteSizeAfter: number;
            valueByteSizeBefore: number;
          }
      ))
  | (MockOpfsBaseOperation & {
      exists: boolean;
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
      type: 'deleteFile';
    })
  | UntrackedMockOpfsFileOperation
  | (MockOpfsBaseOperation & {
      entries: string[];
      scope: AsyncStorageNamespaceScope | null;
      type: 'listDir';
    })
  | (MockOpfsBaseOperation & {
      deleted: boolean;
      exists: boolean;
      scope: AsyncStorageNamespaceScope | null;
      type: 'deleteDir';
    });

function enrichRawOperation(
  operation: RawMockBrowserOpfsOperation,
): MockOpfsOperation | null {
  switch (operation.type) {
    case 'openDir':
    case 'ensureDir': {
      const dirContext = parseTrackedDirPath(operation.path);
      if (dirContext === null) return null;
      return { ...operation, ...dirContext };
    }
    case 'deleteDir': {
      const dirContext = parseTrackedDirPath(operation.path);
      if (dirContext === null) return null;
      return { ...operation, ...dirContext };
    }
    case 'openFile':
    case 'ensureFile':
    case 'readFile':
    case 'writeFile':
    case 'deleteFile': {
      const fileContext = parseFileContext(operation.path);
      if (fileContext !== null) {
        return { ...operation, ...fileContext };
      }

      const pathSegments = operation.path.split('/');
      const fileName = pathSegments.pop();
      if (fileName === undefined || pathSegments[0] !== OPFS_ROOT_DIR) {
        return null;
      }

      return { ...operation, fileName, scope: null };
    }
    case 'listDir': {
      const dirContext = parseTrackedDirPath(operation.path);
      if (dirContext === null) return null;
      return { ...operation, ...dirContext };
    }
  }
}

function getPayloadReadGroups(
  operations: readonly MockOpfsOperation[],
): string[][] {
  const groups: string[][] = [];
  let currentGroup: string[] = [];

  for (const operation of operations) {
    if (
      operation.type === 'readFile' &&
      'record' in operation &&
      operation.record.recordKind === 'payload'
    ) {
      if (operation.record.logicalKey !== null) {
        currentGroup.push(operation.record.logicalKey);
      }
      continue;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function getPayloadReadRequests(
  operations: readonly MockOpfsOperation[],
): string[] {
  return operations.flatMap((operation) =>
    operation.type === 'readFile' &&
    'record' in operation &&
    operation.record.recordKind === 'payload' &&
    operation.record.logicalKey !== null
      ? [operation.record.logicalKey]
      : [],
  );
}

function getListKeysRequests(
  operations: readonly MockOpfsOperation[],
): AsyncStorageNamespaceScope[] {
  return operations.flatMap((operation) => {
    if (operation.type !== 'listDir') return [];

    const store = parseStoreFromDirPath(operation.path);
    if (store === null) return [];

    const seenKinds = new Set<AsyncStorageNamespaceScope['kind']>();
    const scopes: AsyncStorageNamespaceScope[] = [];

    for (const entry of operation.entries) {
      if (!entry.startsWith('file:')) continue;
      const parsedRecord = parseFileName(entry.slice('file:'.length));
      if (parsedRecord === null || seenKinds.has(parsedRecord.kind)) continue;

      seenKinds.add(parsedRecord.kind);
      scopes.push({ ...store, kind: parsedRecord.kind });
    }

    return scopes;
  });
}

export type OpfsPersistentStorageTestStore = ReturnType<
  typeof createOpfsPersistentStorageTestStore
>;

export type OpfsPersistentStorageTestStoreScope = {
  document: {
    namespace: AsyncStorageNamespaceScope;
    storageKey: () => string;
    seed: <T>(data: T, options?: StorageSeedOptions) => string;
    readEntry: <T>() => StorageCacheEntry<PersistedDocumentData<T>>;
    readData: <T>() => T | null;
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
    seedItem: <T>(
      payload: string,
      data: T,
      options?: StorageSeedOptions,
    ) => string;
    readItemEntry: <T>(
      payload: string,
    ) => StorageCacheEntry<PersistedCollectionItemData<T>>;
    readItemData: <T>(payload: string) => T | null;
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
    readItemEntry: <T>(
      tableId: string,
      id: number | string,
    ) => StorageCacheEntry<PersistedListQueryItemData<T>>;
    readItemData: <T>(tableId: string, id: number | string) => T | null;
    readQueryEntry: (
      params: unknown,
    ) => StorageCacheEntry<PersistedListQueryData>;
  };
};

export type OpfsPersistentStorageTestStoreOptions = {
  readDelayMs?: number;
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
};

export function createOpfsPersistentStorageTestStore(
  options: OpfsPersistentStorageTestStoreOptions = {},
): {
  mockBrowserOpfs: MockBrowserOpfsEnvironment;
  storage: {
    getRaw: (key: string) => string | null;
    has: (key: string) => boolean;
    readEntry: <T>(key: string) => StorageCacheEntry<T> | null;
    readMetadata: (key: string) => ManagedMetadataRecord | null;
    writeRaw: (key: string, raw: string) => void;
    writeValue: <T>(key: string, value: T) => void;
    writePayload: (key: string, value: unknown) => void;
    writeMetadata: (key: string, value: unknown) => void;
    removePayload: (key: string) => void;
    removeMetadata: (key: string) => void;
  };
  payloadGetRequests: string[];
  payloadGetManyRequests: string[][];
  listKeysRequests: AsyncStorageNamespaceScope[];
  operations: MockOpfsOperation[];
  scopeReadRequests: (args?: {
    storeName: string;
    sessionKey: string;
  }) => string[];
  clearReadRequests: () => void;
  clearInstrumentation: () => void;
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  scope: (
    storeName: string,
    sessionKey: string,
  ) => OpfsPersistentStorageTestStoreScope;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
  setPayload: (key: string, value: unknown) => void;
  setMetadata: (key: string, value: unknown) => void;
  readMetadata: (key: string) => ManagedMetadataRecord | null;
  removePayload: (key: string) => void;
  removeMetadata: (key: string) => void;
  rawNamespace: {
    get: (scope: AsyncStorageNamespaceScope, key: string) => unknown;
    listKeys: (scope: AsyncStorageNamespaceScope) => string[];
    remove: (scope: AsyncStorageNamespaceScope, key: string) => void;
    set: (
      scope: AsyncStorageNamespaceScope,
      key: string,
      value: unknown,
    ) => void;
  };
} {
  const mockBrowserOpfs = createMockBrowserOpfs();
  const readDelayMs = options.readDelayMs ?? 0;

  if (readDelayMs > 0) {
    mockBrowserOpfs.setDynamicReadDelay(isAppStoreFilePath, readDelayMs);
  }

  function setRaw(key: string, raw: string): void {
    const parsed = safeJsonParse(raw);
    if (parsed !== null) {
      writeLogicalStorageEntry(mockBrowserOpfs, key, parsed);
    }
  }

  function setValue<T>(key: string, value: T): void {
    writeLogicalStorageEntry(mockBrowserOpfs, key, value);
  }

  function getRaw(key: string): string | null {
    const value = readLogicalStorageEntry(mockBrowserOpfs, key);
    return value === null ? null : JSON.stringify(value);
  }

  function hasLogicalStorageEntry(key: string): boolean {
    return readLogicalStorageEntry(mockBrowserOpfs, key) !== null;
  }

  function readRequiredLogicalStorageEntry<T>(
    key: string,
  ): StorageCacheEntry<T> {
    const entry = readLogicalStorageEntry<T>(mockBrowserOpfs, key);
    if (entry === null) {
      throw new Error(`Missing persistent test entry for ${key}`);
    }

    return entry;
  }

  function createScope(
    storeName: string,
    sessionKey: string,
  ): OpfsPersistentStorageTestStoreScope {
    const documentNamespace = {
      sessionKey,
      storeName,
      kind: 'document',
    } satisfies AsyncStorageNamespaceScope;
    const collectionNamespace = {
      sessionKey,
      storeName,
      kind: 'collection.item',
    } satisfies AsyncStorageNamespaceScope;
    const listQueryItemNamespace = {
      sessionKey,
      storeName,
      kind: 'listQuery.item',
    } satisfies AsyncStorageNamespaceScope;
    const listQueryQueryNamespace = {
      sessionKey,
      storeName,
      kind: 'listQuery.query',
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

    function listStoredKeysForNamespace(
      namespace: AsyncStorageNamespaceScope,
    ): string[] {
      return listRawKeys(mockBrowserOpfs, namespace)
        .filter((key) => key.startsWith(METADATA_RECORD_PREFIX))
        .map((key) => key.slice(METADATA_RECORD_PREFIX.length));
    }

    return {
      document: {
        namespace: documentNamespace,
        storageKey: () => documentStorageKey,
        seed<T>(data: T, seedOptions?: StorageSeedOptions) {
          setValue(
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
        readEntry<T>() {
          return readRequiredLogicalStorageEntry<PersistedDocumentData<T>>(
            documentStorageKey,
          );
        },
        readData<T>() {
          return (
            readLogicalStorageEntry<PersistedDocumentData<T>>(
              mockBrowserOpfs,
              documentStorageKey,
            )?.data.data ?? null
          );
        },
        setPayload: (value: unknown) =>
          setPayloadValue(mockBrowserOpfs, documentStorageKey, value),
        setMetadata: (value: unknown) =>
          setMetadataValue(mockBrowserOpfs, documentStorageKey, value),
        removePayload: () =>
          removePayloadValue(mockBrowserOpfs, documentStorageKey),
        removeMetadata: () =>
          removeMetadataValue(mockBrowserOpfs, documentStorageKey),
      },
      collection: {
        namespace: collectionNamespace,
        itemKey,
        itemStorageKey: collectionItemStorageKey,
        listStoredPayloads() {
          return listStoredKeysForNamespace(collectionNamespace).flatMap(
            (key) => {
              const metadata = readLogicalMetadata(
                mockBrowserOpfs,
                getLogicalStorageKey(collectionNamespace, key),
              );

              return typeof metadata?.customMetadata.p === 'string'
                ? [metadata.customMetadata.p]
                : [];
            },
          );
        },
        seedItem<T>(
          payload: string,
          data: T,
          seedOptions?: StorageSeedOptions,
        ) {
          const storageKey = collectionItemStorageKey(payload);
          setValue(
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
        readItemEntry<T>(payload: string) {
          return readRequiredLogicalStorageEntry<
            PersistedCollectionItemData<T>
          >(collectionItemStorageKey(payload));
        },
        readItemData<T>(payload: string) {
          return (
            readLogicalStorageEntry<PersistedCollectionItemData<T>>(
              mockBrowserOpfs,
              collectionItemStorageKey(payload),
            )?.data.data ?? null
          );
        },
      },
      listQuery: {
        itemNamespace: listQueryItemNamespace,
        queryNamespace: listQueryQueryNamespace,
        itemKey: listQueryItemKey,
        itemStorageKey: listQueryItemStorageKey,
        queryKey: listQueryQueryKey,
        queryStorageKey: listQueryStorageKey,
        listStoredItemKeys: () =>
          listStoredKeysForNamespace(listQueryItemNamespace),
        listStoredQueryKeys: () =>
          listStoredKeysForNamespace(listQueryQueryNamespace),
        seedItem<T>(
          tableId: string,
          id: number | string,
          data: T,
          seedOptions?: ListQuerySeedItemOptions,
        ) {
          const payload = rawListQueryItemPayload(tableId, id);
          const entryKey = listQueryItemKey(tableId, id);
          const storageKey = listQueryItemStorageKey(tableId, id);
          setValue(
            storageKey,
            createStorageCacheEntry(
              {
                d: data,
                p: payload,
                ...(seedOptions?.loadedFields !== undefined
                  ? { lf: seedOptions.loadedFields }
                  : {}),
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
          setValue(
            storageKey,
            createStorageCacheEntry(
              {
                p: params,
                i: items.map(normalizeQueryItemRef),
                ...(queryOptions.hasMore === true ? { h: true } : {}),
              },
              {
                timestamp: queryOptions.timestamp,
                version: queryOptions.version,
              },
            ),
          );
          return storageKey;
        },
        readItemEntry<T>(tableId: string, id: number | string) {
          return readRequiredLogicalStorageEntry<PersistedListQueryItemData<T>>(
            listQueryItemStorageKey(tableId, id),
          );
        },
        readItemData<T>(tableId: string, id: number | string) {
          return (
            readLogicalStorageEntry<PersistedListQueryItemData<T>>(
              mockBrowserOpfs,
              listQueryItemStorageKey(tableId, id),
            )?.data.data ?? null
          );
        },
        readQueryEntry(params: unknown) {
          return readRequiredLogicalStorageEntry<PersistedListQueryData>(
            listQueryStorageKey(params),
          );
        },
      },
    };
  }

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
        setRaw(key, value);
      } else {
        setValue(key, value);
      }
    }
  }

  seedInitialState();

  let instrumentationStartIndex = mockBrowserOpfs.operations.length;
  let readStartIndex = mockBrowserOpfs.operations.length;

  function getCurrentOperations(): MockOpfsOperation[] {
    return mockBrowserOpfs.operations
      .slice(instrumentationStartIndex)
      .flatMap((operation) => {
        const enriched = enrichRawOperation(operation);
        return enriched === null ? [] : [enriched];
      });
  }

  function getCurrentReadOperations(): MockOpfsOperation[] {
    return mockBrowserOpfs.operations
      .slice(readStartIndex)
      .flatMap((operation) => {
        const enriched = enrichRawOperation(operation);
        return enriched === null ? [] : [enriched];
      });
  }

  return {
    mockBrowserOpfs,
    storage: {
      getRaw,
      has: hasLogicalStorageEntry,
      readEntry: <T>(key: string) =>
        readLogicalStorageEntry<T>(mockBrowserOpfs, key),
      readMetadata: (key: string) => readLogicalMetadata(mockBrowserOpfs, key),
      writeRaw: setRaw,
      writeValue: setValue,
      writePayload: (key: string, value: unknown) =>
        setPayloadValue(mockBrowserOpfs, key, value),
      writeMetadata: (key: string, value: unknown) =>
        setMetadataValue(mockBrowserOpfs, key, value),
      removePayload: (key: string) => removePayloadValue(mockBrowserOpfs, key),
      removeMetadata: (key: string) =>
        removeMetadataValue(mockBrowserOpfs, key),
    },
    get payloadGetRequests() {
      return getPayloadReadRequests(getCurrentReadOperations());
    },
    get payloadGetManyRequests() {
      return getPayloadReadGroups(getCurrentReadOperations());
    },
    get listKeysRequests() {
      return getListKeysRequests(getCurrentOperations());
    },
    get operations() {
      return getCurrentOperations();
    },
    scopeReadRequests(args?: { storeName: string; sessionKey: string }) {
      const payloadGetRequests = getPayloadReadRequests(
        getCurrentReadOperations(),
      );
      if (args === undefined) return payloadGetRequests;

      const scopePrefix = `tsdf.${args.sessionKey}.${args.storeName}.`;

      return payloadGetRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    clearReadRequests() {
      readStartIndex = mockBrowserOpfs.operations.length;
    },
    clearInstrumentation() {
      instrumentationStartIndex = mockBrowserOpfs.operations.length;
      readStartIndex = mockBrowserOpfs.operations.length;
    },
    getRaw,
    has: hasLogicalStorageEntry,
    scope: createScope,
    setRaw,
    setValue,
    setPayload: (key: string, value: unknown) =>
      setPayloadValue(mockBrowserOpfs, key, value),
    setMetadata: (key: string, value: unknown) =>
      setMetadataValue(mockBrowserOpfs, key, value),
    readMetadata: (key: string) => readLogicalMetadata(mockBrowserOpfs, key),
    removePayload: (key: string) => removePayloadValue(mockBrowserOpfs, key),
    removeMetadata: (key: string) => removeMetadataValue(mockBrowserOpfs, key),
    rawNamespace: {
      get(scope: AsyncStorageNamespaceScope, key: string) {
        const raw = readRawRecord(mockBrowserOpfs, scope, key);
        return raw === null ? null : safeJsonParse(raw);
      },
      listKeys(scope: AsyncStorageNamespaceScope) {
        return listRawKeys(mockBrowserOpfs, scope);
      },
      remove(scope: AsyncStorageNamespaceScope, key: string) {
        removeRawRecord(mockBrowserOpfs, scope, key);
      },
      set(scope: AsyncStorageNamespaceScope, key: string, value: unknown) {
        writeRawRecord(
          mockBrowserOpfs,
          scope,
          key,
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      },
    },
  };
}
