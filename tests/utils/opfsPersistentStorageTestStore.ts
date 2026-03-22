/* eslint-disable @typescript-eslint/consistent-type-assertions, @ls-stack/use-top-level-regex -- test helper intentionally optimizes for compact fixture code. */
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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

const OPFS_ROOT_DIR = 'tsdf';
const JSON_FILE_EXTENSION = '.json';
const PAYLOAD_RECORD_PREFIX = '__tsdf_payload__:';
const METADATA_RECORD_PREFIX = '__tsdf_meta__:';
const INTERNAL_REGISTRY_KEY = 'registry';
const INTERNAL_ASYNC_SCOPE: AsyncStorageNamespaceScope = {
  sessionKey: '__tsdf_async__',
  storeName: '__tsdf_async__',
  kind: '__internal.protected',
};

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodePathSegment(value: string): string {
  return decodeURIComponent(value);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function itemKey(payload: string): string {
  return getCompositeKey(payload);
}

function listQueryItemKey(tableId: string, id: number | string): string {
  return getCompositeKey(`${tableId}||${id}`);
}

function listQueryQueryKey(params: unknown): string {
  return getCompositeKey(params);
}

function getPayloadRecordKey(key: string): string {
  return `${PAYLOAD_RECORD_PREFIX}${key}`;
}

function getMetadataRecordKey(key: string): string {
  return `${METADATA_RECORD_PREFIX}${key}`;
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
  let match =
    /^tsdf\.([^.]+)\.(.+?)\.ci\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.li\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.lq\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oq\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oc\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oe\.(.+)$/.exec(key);

  if (match?.[1] && match[2] && match[3]) {
    const [, sessionKey, storeName, entryKey] = match;
    const suffix = key.includes('.ci.')
      ? 'collection.item'
      : key.includes('.li.')
        ? 'listQuery.item'
        : key.includes('.lq.')
          ? 'listQuery.query'
          : key.includes('.oq.')
            ? 'offline.queue'
            : key.includes('.oc.')
              ? 'offline.conflict'
              : 'offline.entity';

    return {
      scope: {
        sessionKey,
        storeName,
        kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(
          suffix,
        ),
      },
      key: entryKey,
    };
  }

  match = /^tsdf\.([^.]+)\._o_\.p$/.exec(key);
  if (match?.[1]) {
    return {
      scope: { sessionKey: match[1], storeName: '_o_.p', kind: 'document' },
      key: 'document',
    };
  }

  match = /^tsdf\.([^.]+)\.__offline__\.session$/.exec(key);
  if (match?.[1]) {
    return {
      scope: {
        sessionKey: match[1],
        storeName: '__offline__',
        kind: 'document',
      },
      key: 'session',
    };
  }

  match = /^tsdf\.([^.]+)\.(.+)$/.exec(key);
  if (match?.[1] && match[2]) {
    return {
      scope: { sessionKey: match[1], storeName: match[2], kind: 'document' },
      key: 'document',
    };
  }

  return null;
}

type LogicalRecordLocation = {
  metadataRecordKey: string;
  payloadRecordKey: string;
  scope: AsyncStorageNamespaceScope;
};

function getLogicalRecordLocation(key: string): LogicalRecordLocation | null {
  const parsed = parseFlatStorageKey(key);
  if (parsed === null) return null;

  return {
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
  sizeBytes?: number;
  version: number;
  writtenAt: number;
};

function createManagedMetadataRecord(
  scope: AsyncStorageNamespaceScope,
  key: string,
  entry: StorageCacheEntry<unknown>,
): ManagedMetadataRecord {
  const raw = safeStringify(entry.data);
  return {
    key,
    writtenAt: entry.timestamp,
    lastAccessAt: entry.timestamp,
    version: entry.version ?? 1,
    ...(raw !== null ? { sizeBytes: raw.length } : {}),
    customMetadata: buildCustomMetadata(scope, entry.data),
  };
}

function parseManagedMetadataRecord(
  value: unknown,
): ManagedMetadataRecord | null {
  const record = getRecord(value);
  if (
    record === null ||
    typeof record.key !== 'string' ||
    typeof record.writtenAt !== 'number' ||
    typeof record.lastAccessAt !== 'number' ||
    typeof record.version !== 'number'
  ) {
    return null;
  }

  return {
    key: record.key,
    writtenAt: record.writtenAt,
    lastAccessAt: record.lastAccessAt,
    version: record.version,
    ...(typeof record.sizeBytes === 'number'
      ? { sizeBytes: record.sizeBytes }
      : {}),
    customMetadata: getRecord(record.customMetadata) ?? {},
  };
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

function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment !== '').join('/');
}

function scopeDirPath(scope: AsyncStorageNamespaceScope): string {
  return joinPath(
    OPFS_ROOT_DIR,
    encodePathSegment(scope.sessionKey),
    encodePathSegment(scope.storeName),
    encodePathSegment(scope.kind),
  );
}

function fileNameForKey(key: string): string {
  return `${encodePathSegment(key)}${JSON_FILE_EXTENSION}`;
}

function filePathForRecord(
  scope: AsyncStorageNamespaceScope,
  key: string,
): string {
  return joinPath(scopeDirPath(scope), fileNameForKey(key));
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
    .listEntries(scopeDirPath(scope))
    .flatMap((entry) => {
      if (!entry.startsWith('file:')) return [];
      const fileName = entry.slice('file:'.length);
      if (!fileName.endsWith(JSON_FILE_EXTENSION)) return [];
      return [
        decodePathSegment(fileName.slice(0, -JSON_FILE_EXTENSION.length)),
      ];
    })
    .sort(compareStrings);
}

function readRegisteredNamespaces(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
): AsyncStorageNamespaceScope[] {
  const raw = readRawRecord(
    mockBrowserOpfs,
    INTERNAL_ASYNC_SCOPE,
    INTERNAL_REGISTRY_KEY,
  );
  if (raw === null) return [];

  const record = getRecord(parseJson<unknown>(raw));
  if (record === null || !Array.isArray(record.namespaces)) {
    return [];
  }

  const namespaces: AsyncStorageNamespaceScope[] = [];
  for (const entry of record.namespaces) {
    const namespace = getRecord(entry);
    if (
      namespace === null ||
      typeof namespace.sessionKey !== 'string' ||
      typeof namespace.storeName !== 'string' ||
      typeof namespace.kind !== 'string'
    ) {
      continue;
    }

    namespaces.push({
      sessionKey: namespace.sessionKey,
      storeName: namespace.storeName,
      kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(
        namespace.kind,
      ),
    });
  }

  return namespaces;
}

function writeRegisteredNamespaces(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  namespaces: AsyncStorageNamespaceScope[],
): void {
  writeRawRecord(
    mockBrowserOpfs,
    INTERNAL_ASYNC_SCOPE,
    INTERNAL_REGISTRY_KEY,
    JSON.stringify({ namespaces }),
  );
}

function ensureNamespaceRegistered(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
): void {
  if (
    scope.sessionKey === INTERNAL_ASYNC_SCOPE.sessionKey &&
    scope.storeName === INTERNAL_ASYNC_SCOPE.storeName &&
    scope.kind === INTERNAL_ASYNC_SCOPE.kind
  ) {
    return;
  }

  const existing = readRegisteredNamespaces(mockBrowserOpfs);
  if (
    existing.some(
      (entry) =>
        entry.sessionKey === scope.sessionKey &&
        entry.storeName === scope.storeName &&
        entry.kind === scope.kind,
    )
  ) {
    return;
  }

  writeRegisteredNamespaces(mockBrowserOpfs, [...existing, scope]);
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

  const payload = parseJson<unknown>(payloadRaw);
  const metadata = parseManagedMetadataRecord(parseJson<unknown>(metadataRaw));
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

  return parseManagedMetadataRecord(parseJson<unknown>(raw));
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
    typeof value === 'string' ? value : JSON.stringify(value),
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

function parseScopeFromDirPath(
  path: string,
): AsyncStorageNamespaceScope | null {
  const pathSegments = path.split('/');
  if (pathSegments.length !== 4 || pathSegments[0] !== OPFS_ROOT_DIR) {
    return null;
  }

  const encodedSessionKey = pathSegments[1];
  const encodedStoreName = pathSegments[2];
  const encodedKind = pathSegments[3];
  if (
    encodedSessionKey === undefined ||
    encodedStoreName === undefined ||
    encodedKind === undefined
  ) {
    return null;
  }

  return {
    sessionKey: decodePathSegment(encodedSessionKey),
    storeName: decodePathSegment(encodedStoreName),
    kind: __LEGIT_CAST__<AsyncStorageNamespaceScope['kind'], string>(
      decodePathSegment(encodedKind),
    ),
  };
}

function parseTrackedDirPath(
  path: string,
): { path: string; scope: AsyncStorageNamespaceScope | null } | null {
  const pathSegments = path.split('/');
  if (pathSegments[0] !== OPFS_ROOT_DIR) return null;

  return { path, scope: parseScopeFromDirPath(path) };
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

  const scope = parseScopeFromDirPath(pathSegments.join('/'));
  if (scope === null || !fileName.endsWith(JSON_FILE_EXTENSION)) {
    return null;
  }

  const key = decodePathSegment(fileName.slice(0, -JSON_FILE_EXTENSION.length));
  return { path, scope, record: getInstrumentedRecord(scope, key) };
}

function isAppStoreFilePath(path: string): boolean {
  const pathSegments = path.split('/');
  if (pathSegments.length < 5 || pathSegments[0] !== OPFS_ROOT_DIR) {
    return false;
  }

  const encodedSessionKey = pathSegments[1];
  const encodedStoreName = pathSegments[2];
  if (encodedSessionKey === undefined || encodedStoreName === undefined) {
    return false;
  }

  const sessionKey = decodePathSegment(encodedSessionKey);
  const storeName = decodePathSegment(encodedStoreName);
  if (
    sessionKey === INTERNAL_ASYNC_SCOPE.sessionKey &&
    storeName === INTERNAL_ASYNC_SCOPE.storeName
  ) {
    return false;
  }

  return storeName !== '_o_.p';
}

export type MockOpfsOperation =
  | {
      created: boolean;
      exists: boolean;
      path: string;
      scope: AsyncStorageNamespaceScope | null;
      time: number;
      type: 'ensureDir' | 'openDir';
    }
  | {
      created: boolean;
      exists: boolean;
      path: string;
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'ensureFile' | 'openFile';
    }
  | ({
      path: string;
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
      time: number;
    } & (
      | { type: 'readFile'; valueByteSize: number }
      | {
          type: 'writeFile';
          valueChanged: boolean;
          valueByteSizeAfter: number;
          valueByteSizeBefore: number;
        }
    ))
  | {
      exists: boolean;
      path: string;
      record: InstrumentedRecord;
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'deleteFile';
    }
  | {
      entries: string[];
      path: string;
      scope: AsyncStorageNamespaceScope | null;
      time: number;
      type: 'listDir';
    }
  | {
      exists: boolean;
      path: string;
      scope: AsyncStorageNamespaceScope | null;
      time: number;
      type: 'deleteDir';
    };

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
      if (fileContext === null) return null;
      return { ...operation, ...fileContext };
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
    operation.record.recordKind === 'payload' &&
    operation.record.logicalKey !== null
      ? [operation.record.logicalKey]
      : [],
  );
}

function getListKeysRequests(
  operations: readonly MockOpfsOperation[],
): AsyncStorageNamespaceScope[] {
  return operations.flatMap((operation) =>
    operation.type === 'listDir' && operation.scope !== null
      ? [operation.scope]
      : [],
  );
}

export type OpfsPersistentStorageTestStore = ReturnType<
  typeof createOpfsPersistentStorageTestStore
>;

type RawOpfsLogicalFileContents = { metadata: unknown; payload: unknown };

export type OpfsPersistentStorageTestStoreScope = {
  document: {
    namespace: AsyncStorageNamespaceScope;
    registerNamespace: () => void;
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
    registerNamespace: () => void;
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
    registerItemNamespace: () => void;
    registerQueryNamespace: () => void;
    registerNamespaces: () => void;
    itemKey: (tableId: string, id: number | string) => string;
    itemStorageKey: (tableId: string, id: number | string) => string;
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
  legacyListKeysFallbackRequests: string[];
  operations: MockOpfsOperation[];
  scopeReadRequests: (args?: {
    storeName: string;
    sessionKey: string;
  }) => string[];
  clearReadRequests: () => void;
  clearInstrumentation: () => void;
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  readEntryFiles: (key: string) => RawOpfsLogicalFileContents | null;
  scope: (
    storeName: string,
    sessionKey: string,
  ) => OpfsPersistentStorageTestStoreScope;
  registerNamespace: (scope: AsyncStorageNamespaceScope) => void;
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
    const parsed = parseJson<unknown>(raw);
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

  function readLogicalFileContents(
    key: string,
  ): RawOpfsLogicalFileContents | null {
    const location = getLogicalRecordLocation(key);
    if (location === null) return null;

    const payloadRaw = readRawRecord(
      mockBrowserOpfs,
      location.scope,
      location.payloadRecordKey,
    );
    const metadataRaw = readRawRecord(
      mockBrowserOpfs,
      location.scope,
      location.metadataRecordKey,
    );

    return {
      payload: payloadRaw === null ? null : parseJson<unknown>(payloadRaw),
      metadata: metadataRaw === null ? null : parseJson<unknown>(metadataRaw),
    };
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
        registerNamespace: () =>
          ensureNamespaceRegistered(mockBrowserOpfs, documentNamespace),
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
        registerNamespace: () =>
          ensureNamespaceRegistered(mockBrowserOpfs, collectionNamespace),
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
        registerItemNamespace: () =>
          ensureNamespaceRegistered(mockBrowserOpfs, listQueryItemNamespace),
        registerQueryNamespace: () =>
          ensureNamespaceRegistered(mockBrowserOpfs, listQueryQueryNamespace),
        registerNamespaces: () => {
          ensureNamespaceRegistered(mockBrowserOpfs, listQueryItemNamespace);
          ensureNamespaceRegistered(mockBrowserOpfs, listQueryQueryNamespace);
        },
        itemKey: listQueryItemKey,
        itemStorageKey: listQueryItemStorageKey,
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
    get legacyListKeysFallbackRequests() {
      return [];
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
    readEntryFiles: readLogicalFileContents,
    scope: createScope,
    registerNamespace: (scope: AsyncStorageNamespaceScope) =>
      ensureNamespaceRegistered(mockBrowserOpfs, scope),
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
        return raw === null ? null : parseJson<unknown>(raw);
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
