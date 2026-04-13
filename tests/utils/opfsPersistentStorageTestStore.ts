import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getPayloadRecordKey,
  PAYLOAD_RECORD_PREFIX,
} from '../../src/persistentStorage/asyncStorageShared';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../src/persistentStorage/documentEntryKey';
import {
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  joinPath,
  OPFS_ROOT_DIR,
  parseFileNameInfo,
  resolveHashedPayloadRecordKeyFromValue,
} from '../../src/persistentStorage/opfsFileNaming';
import { getSerializedStringSize } from '../../src/persistentStorage/persistenceUtils';
import type {
  AsyncStorageNamespaceScope,
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
      key: DOCUMENT_PERSISTED_ENTRY_KEY,
    };
  }

  return null;
}

type LogicalRecordLocation = {
  key: string;
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

function compactLogicalPayload(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
): unknown {
  const record = getRecord(value);

  switch (scope.kind) {
    case 'document':
    case 'collection.item':
    case 'listQuery.item':
      return record !== null && 'd' in record ? record.d : value;
    case 'listQuery.query':
      return record !== null && Array.isArray(record.i) ? record.i : value;
    default:
      return value;
  }
}

type RawManagedMetadataRecord = { a: number; v?: number } & Record<
  string,
  unknown
>;

type ManagedMetadataRecord = {
  customMetadata: Record<string, unknown>;
  key: string;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
  writtenAt: number;
};

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
    ...(metadata.sizeBytes !== undefined ? { z: metadata.sizeBytes } : {}),
    ...(metadata.version !== 1 ? { v: metadata.version } : {}),
    ...metadata.customMetadata,
  };
}

function estimateManagedEntrySizeBytes(args: {
  customMetadata: Record<string, unknown>;
  lastAccessAt: number;
  rawValue: string;
  version: number;
}): number {
  return (
    getSerializedStringSize(args.rawValue) +
    getSerializedStringSize(
      JSON.stringify(
        serializeManagedMetadataRecord({
          key: '__size__',
          writtenAt: args.lastAccessAt,
          lastAccessAt: args.lastAccessAt,
          version: args.version,
          customMetadata: args.customMetadata,
        }),
      ),
    )
  );
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
      ([entryKey]) => entryKey !== 'a' && entryKey !== 'v',
    ),
  );

  return {
    key,
    writtenAt: record.a,
    lastAccessAt: record.a,
    ...(typeof record.z === 'number' ? { sizeBytes: record.z } : {}),
    version: typeof record.v === 'number' ? record.v : 1,
    customMetadata,
  };
}

type ManagedIndexRecord = {
  entries: Map<string, ManagedMetadataRecord>;
  staticPolicy: Record<string, unknown> | null;
};

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

  return { entries, staticPolicy: getRecord(record?.s) };
}

type RawManagedIndexRecord = {
  e: Record<string, RawManagedMetadataRecord>;
  s: Record<string, unknown> | undefined;
};

function serializeManagedIndexRecord(
  entries: ReadonlyMap<string, ManagedMetadataRecord>,
  staticPolicy: Record<string, unknown> | null = null,
): RawManagedIndexRecord {
  return {
    e: Object.fromEntries(
      [...entries.entries()].map(([key, metadata]) => [
        key,
        serializeManagedMetadataRecord(metadata),
      ]),
    ),
    s: staticPolicy ?? undefined,
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
      key,
      writtenAt: record.lastAccessAt,
      lastAccessAt: record.lastAccessAt,
      ...(typeof record.sizeBytes === 'number'
        ? { sizeBytes: record.sizeBytes }
        : {}),
      version: record.version,
      customMetadata: getRecord(record.customMetadata) ?? {},
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
      return metadata?.customMetadata !== undefined &&
        'p' in metadata.customMetadata
        ? {
            data: record !== null && 'd' in record ? record.d : value,
            payload: metadata.customMetadata.p,
            ...(Array.isArray(metadata.customMetadata.f)
              ? { loadedFields: metadata.customMetadata.f }
              : record !== null && 'lf' in record && Array.isArray(record.lf)
                ? { loadedFields: record.lf }
                : {}),
          }
        : value;
    case 'listQuery.query':
      return metadata?.customMetadata !== undefined &&
        'p' in metadata.customMetadata &&
        (Array.isArray(value) || (record !== null && Array.isArray(record.i)))
        ? {
            payload: metadata.customMetadata.p,
            items: Array.isArray(value) ? value : record?.i,
            hasMore:
              metadata.customMetadata.h === true ||
              (record !== null && record.h === true),
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

function readManagedIndexRecord(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
): ManagedIndexRecord | null {
  const raw = readRawRecord(
    mockBrowserOpfs,
    scope,
    ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  );
  if (raw === null) return null;

  return __LEGIT_CAST__<ManagedIndexRecord | null, unknown>(
    parseManagedIndexRecord(safeJsonParse(raw)),
  );
}

function readNamespaceIndex(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
): Map<string, ManagedMetadataRecord> {
  return (
    readManagedIndexRecord(mockBrowserOpfs, scope)?.entries ??
    new Map<string, ManagedMetadataRecord>()
  );
}

function readNamespaceStaticPolicy(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
): Record<string, unknown> | null {
  return readManagedIndexRecord(mockBrowserOpfs, scope)?.staticPolicy ?? null;
}

function setNamespaceStaticPolicy(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
  policy: Record<string, unknown>,
): void {
  const current = readManagedIndexRecord(mockBrowserOpfs, scope);
  if (current === null) {
    throw new Error(
      `Missing namespace index at ${filePathForRecord(scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY)}`,
    );
  }

  writeNamespaceIndex(mockBrowserOpfs, scope, current.entries, policy);
}

function writeNamespaceIndex(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  scope: AsyncStorageNamespaceScope,
  entries: ReadonlyMap<string, ManagedMetadataRecord>,
  staticPolicy: Record<string, unknown> | null = readNamespaceStaticPolicy(
    mockBrowserOpfs,
    scope,
  ),
): void {
  if (entries.size === 0) {
    removeRawRecord(mockBrowserOpfs, scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    return;
  }

  writeRawRecord(
    mockBrowserOpfs,
    scope,
    ASYNC_NAMESPACE_INDEX_RECORD_KEY,
    JSON.stringify(serializeManagedIndexRecord(entries, staticPolicy)),
  );
}

function readNamespaceIndexFromSnapshot(
  fileContentsByPath: ReadonlyMap<string, string>,
  scope: AsyncStorageNamespaceScope,
): Map<string, ManagedMetadataRecord> {
  const raw = fileContentsByPath.get(
    filePathForRecord(scope, ASYNC_NAMESPACE_INDEX_RECORD_KEY),
  );
  if (raw === undefined) return new Map<string, ManagedMetadataRecord>();

  return (
    __LEGIT_CAST__<ManagedIndexRecord | null, unknown>(
      parseManagedIndexRecord(safeJsonParse(raw)),
    )?.entries ?? new Map<string, ManagedMetadataRecord>()
  );
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
      const parsed = parseFileNameInfo(fileName);
      if (parsed === null || parsed.kind !== scope.kind) return [];

      const key = resolveParsedRecordKey(
        mockBrowserOpfs,
        joinPath(storeDirPath(scope), fileName),
        new Map(),
        new Map(),
        scope,
        fileName,
        parsed.key,
      );
      return key === null ? [] : [key];
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
  const rawValue = JSON.stringify(
    compactLogicalPayload(parsed.scope, entry.data),
  );
  writeRawRecord(
    mockBrowserOpfs,
    parsed.scope,
    getPayloadRecordKey(parsed.key),
    rawValue,
  );
  const sizeBytes =
    parsed.scope.kind === 'document'
      ? undefined
      : estimateManagedEntrySizeBytes({
          rawValue,
          lastAccessAt: entry.timestamp,
          version: entry.version ?? 1,
          customMetadata: buildCustomMetadata(parsed.scope, entry.data),
        });
  const nextEntries = readNamespaceIndex(mockBrowserOpfs, parsed.scope);
  nextEntries.set(parsed.key, {
    key: parsed.key,
    writtenAt: entry.timestamp,
    lastAccessAt: entry.timestamp,
    version: entry.version ?? 1,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    customMetadata: buildCustomMetadata(parsed.scope, entry.data),
  });
  writeNamespaceIndex(mockBrowserOpfs, parsed.scope, nextEntries);
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
  const metadata = readNamespaceIndex(mockBrowserOpfs, parsed.scope).get(
    parsed.key,
  );
  if (payloadRaw === null || metadata === undefined) return null;

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

function readLogicalMetadata(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  flatKey: string,
): ManagedMetadataRecord | null {
  const location = getLogicalRecordLocation(flatKey);
  if (location === null) return null;

  const raw = readRawRecord(
    mockBrowserOpfs,
    location.scope,
    ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  );
  if (raw === null) return null;

  return (
    parseManagedIndexRecord(safeJsonParse(raw))?.entries.get(location.key) ??
    null
  );
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
  const nextEntries = readNamespaceIndex(mockBrowserOpfs, location.scope);
  if (typeof value === 'string') {
    writeRawRecord(
      mockBrowserOpfs,
      location.scope,
      ASYNC_NAMESPACE_INDEX_RECORD_KEY,
      value,
    );
    return;
  }

  const normalized = normalizeMetadataValue(location.key, value);
  const parsed = parseManagedMetadataRecord(normalized, location.key);
  if (parsed === null) return;
  nextEntries.set(location.key, parsed);
  writeNamespaceIndex(mockBrowserOpfs, location.scope, nextEntries);
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
  const nextEntries = readNamespaceIndex(mockBrowserOpfs, location.scope);
  nextEntries.delete(location.key);
  writeNamespaceIndex(mockBrowserOpfs, location.scope, nextEntries);
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

type RecordKind = 'payload' | 'internal';

type InstrumentedRecord = {
  key: string;
  logicalKey: string | null;
  recordKind: RecordKind;
};

function getInstrumentedRecord(
  scope: AsyncStorageNamespaceScope,
  key: string | null,
  defaultRecordKind: Exclude<RecordKind, 'internal'> = 'payload',
): InstrumentedRecord {
  if (key === null) {
    return { key: '', logicalKey: null, recordKind: defaultRecordKind };
  }

  if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
    const userKey = key.slice(PAYLOAD_RECORD_PREFIX.length);
    return {
      key,
      logicalKey: getLogicalStorageKey(scope, userKey),
      recordKind: 'payload',
    };
  }

  if (key === ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
    return {
      key,
      logicalKey: `tsdf.${scope.sessionKey}.${scope.storeName}.${scope.kind}.index`,
      recordKind: 'internal',
    };
  }

  return { key, logicalKey: null, recordKind: 'internal' };
}

function parseFileContext(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  path: string,
  fileContentsByPath: ReadonlyMap<string, string>,
  resolvedRecordKeysByPath: Map<string, string>,
): {
  path: string;
  record: InstrumentedRecord;
  scope: AsyncStorageNamespaceScope;
} | null {
  const pathSegments = path.split('/');
  const fileName = pathSegments.pop();
  if (fileName === undefined) return null;

  const store = parseStoreFromDirPath(pathSegments.join('/'));
  const parsedRecord = parseFileNameInfo(fileName);
  if (store === null || parsedRecord === null) {
    return null;
  }

  const scope = {
    ...store,
    kind: parsedRecord.kind,
  } satisfies AsyncStorageNamespaceScope;
  const key = resolveParsedRecordKey(
    mockBrowserOpfs,
    path,
    fileContentsByPath,
    resolvedRecordKeysByPath,
    scope,
    fileName,
    parsedRecord.key,
  );
  if (key !== null) {
    resolvedRecordKeysByPath.set(path, key);
  }
  return { path, scope, record: getInstrumentedRecord(scope, key, 'payload') };
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
    | { readRaw: string; type: 'readFile'; valueByteSize: number }
    | {
        writeRaw: string;
        type: 'writeFile';
        valueChanged: boolean;
        valueByteSizeAfter: number;
        valueByteSizeBefore: number;
      }
    | {
        errorName: string;
        phase: 'close' | 'createWritable';
        type: 'writeFileFailed';
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
        | { readRaw: string; type: 'readFile'; valueByteSize: number }
        | {
            writeRaw: string;
            type: 'writeFile';
            valueChanged: boolean;
            valueByteSizeAfter: number;
            valueByteSizeBefore: number;
          }
        | {
            errorName: string;
            phase: 'close' | 'createWritable';
            type: 'writeFileFailed';
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
      method: 'entries' | 'keys' | 'values';
      scope: AsyncStorageNamespaceScope | null;
      type: 'listDir';
    })
  | (MockOpfsBaseOperation & {
      deleted: boolean;
      exists: boolean;
      recursive: boolean;
      scope: AsyncStorageNamespaceScope | null;
      type: 'deleteDir';
    });

function enrichRawOperation(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  operation: RawMockBrowserOpfsOperation,
  fileContentsByPath: Map<string, string>,
  resolvedRecordKeysByPath: Map<string, string>,
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
    case 'writeFileFailed':
    case 'deleteFile': {
      if (operation.type === 'writeFile' || operation.type === 'ensureFile') {
        const nextRaw = mockBrowserOpfs.readFile(operation.path);
        if (nextRaw !== null) {
          fileContentsByPath.set(operation.path, nextRaw);
        }
      }

      const fileContext = parseFileContext(
        mockBrowserOpfs,
        operation.path,
        fileContentsByPath,
        resolvedRecordKeysByPath,
      );
      if (operation.type === 'deleteFile') {
        fileContentsByPath.delete(operation.path);
      }
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
      const parsedRecord = parseFileNameInfo(entry.slice('file:'.length));
      if (parsedRecord === null || seenKinds.has(parsedRecord.kind)) continue;

      seenKinds.add(parsedRecord.kind);
      scopes.push({ ...store, kind: parsedRecord.kind });
    }

    return scopes;
  });
}

function resolveParsedRecordKey(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  path: string,
  fileContentsByPath: ReadonlyMap<string, string>,
  resolvedRecordKeysByPath: Map<string, string>,
  scope: AsyncStorageNamespaceScope,
  fileName: string,
  key: string | null,
): string | null {
  if (key !== null) return key;

  const raw = fileContentsByPath.get(path) ?? mockBrowserOpfs.readFile(path);
  if (raw !== null) {
    const resolvedKey = resolveHashedPayloadRecordKeyFromValue(
      scope,
      safeJsonParse(raw),
    );
    if (
      resolvedKey !== null &&
      buildFileName(scope, resolvedKey) === fileName
    ) {
      return resolvedKey;
    }
  }

  for (const entryKey of readNamespaceIndexFromSnapshot(
    fileContentsByPath,
    scope,
  ).keys()) {
    const payloadRecordKey = getPayloadRecordKey(entryKey);
    if (buildFileName(scope, payloadRecordKey) === fileName) {
      return payloadRecordKey;
    }
  }

  return resolvedRecordKeysByPath.get(path) ?? null;
}

function snapshotDirectoryFiles(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
  dirPath: string,
  filesByPath: Map<string, string>,
): void {
  for (const entry of mockBrowserOpfs.listEntries(dirPath)) {
    if (entry.startsWith('dir:')) {
      snapshotDirectoryFiles(
        mockBrowserOpfs,
        joinPath(dirPath, entry.slice('dir:'.length)),
        filesByPath,
      );
      continue;
    }

    if (!entry.startsWith('file:')) continue;

    const filePath = joinPath(dirPath, entry.slice('file:'.length));
    const raw = mockBrowserOpfs.readFile(filePath);
    if (raw !== null) {
      filesByPath.set(filePath, raw);
    }
  }
}

function snapshotOpfsFiles(
  mockBrowserOpfs: MockBrowserOpfsEnvironment,
): Map<string, string> {
  const filesByPath = new Map<string, string>();
  snapshotDirectoryFiles(mockBrowserOpfs, OPFS_ROOT_DIR, filesByPath);
  return filesByPath;
}

function backfillKnownRecords(
  operations: readonly MockOpfsOperation[],
): MockOpfsOperation[] {
  const knownRecordByPath = new Map<string, InstrumentedRecord>();

  for (const operation of operations) {
    if (
      !('record' in operation) ||
      operation.record.recordKind === 'internal'
    ) {
      continue;
    }

    knownRecordByPath.set(operation.path, operation.record);
  }

  return operations.map((operation) => {
    if (
      !('record' in operation) ||
      operation.record.recordKind !== 'internal'
    ) {
      return operation;
    }

    const knownRecord = knownRecordByPath.get(operation.path);
    return knownRecord ? { ...operation, record: knownRecord } : operation;
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

export type OpfsPersistentStorageTestStoreOptions = {
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

    function listStoredKeysForNamespace(
      namespace: AsyncStorageNamespaceScope,
    ): string[] {
      return [...readNamespaceIndex(mockBrowserOpfs, namespace).keys()].sort(
        (left, right) => left.localeCompare(right),
      );
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
        setStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(
            mockBrowserOpfs,
            collectionNamespace,
            policy,
          ),
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
        setItemStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(
            mockBrowserOpfs,
            listQueryItemNamespace,
            policy,
          ),
        setQueryStaticPolicy: (policy) =>
          setNamespaceStaticPolicy(
            mockBrowserOpfs,
            listQueryQueryNamespace,
            policy,
          ),
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
          const entry = createStorageCacheEntry(
            {
              i: items.map(normalizeQueryItemRef),
              ...(queryOptions.hasMore === true ? { h: true } : {}),
            },
            {
              timestamp: queryOptions.timestamp,
              version: queryOptions.version,
            },
          );
          setValue(storageKey, entry);
          const rawValue = JSON.stringify(
            compactLogicalPayload(listQueryQueryNamespace, entry.data),
          );
          setMetadataValue(mockBrowserOpfs, storageKey, {
            lastAccessAt: entry.timestamp,
            version: entry.version,
            sizeBytes: estimateManagedEntrySizeBytes({
              rawValue,
              lastAccessAt: entry.timestamp,
              version: entry.version ?? 1,
              customMetadata: {
                ...(queryOptions.hasMore === true ? { h: true } : {}),
                p: params,
              },
            }),
            customMetadata: {
              ...(queryOptions.hasMore === true ? { h: true } : {}),
              p: params,
            },
          });
          return storageKey;
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
  let instrumentationFileSnapshot = snapshotOpfsFiles(mockBrowserOpfs);
  let readFileSnapshot = snapshotOpfsFiles(mockBrowserOpfs);

  function getCurrentOperations(): MockOpfsOperation[] {
    const fileContentsByPath = new Map(instrumentationFileSnapshot);
    const resolvedRecordKeysByPath = new Map<string, string>();
    return backfillKnownRecords(
      mockBrowserOpfs.operations
        .slice(instrumentationStartIndex)
        .flatMap((operation) => {
          const enriched = enrichRawOperation(
            mockBrowserOpfs,
            operation,
            fileContentsByPath,
            resolvedRecordKeysByPath,
          );
          return enriched === null ? [] : [enriched];
        }),
    );
  }

  function getCurrentReadOperations(): MockOpfsOperation[] {
    const fileContentsByPath = new Map(readFileSnapshot);
    const resolvedRecordKeysByPath = new Map<string, string>();
    return backfillKnownRecords(
      mockBrowserOpfs.operations.slice(readStartIndex).flatMap((operation) => {
        const enriched = enrichRawOperation(
          mockBrowserOpfs,
          operation,
          fileContentsByPath,
          resolvedRecordKeysByPath,
        );
        return enriched === null ? [] : [enriched];
      }),
    );
  }

  return {
    mockBrowserOpfs,
    storage: {
      getRaw,
      has: hasLogicalStorageEntry,
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
      readFileSnapshot = snapshotOpfsFiles(mockBrowserOpfs);
    },
    clearInstrumentation() {
      instrumentationStartIndex = mockBrowserOpfs.operations.length;
      readStartIndex = mockBrowserOpfs.operations.length;
      instrumentationFileSnapshot = snapshotOpfsFiles(mockBrowserOpfs);
      readFileSnapshot = instrumentationFileSnapshot;
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
