import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { parseAsyncStorageRecordKey } from '../../src/persistentStorage/asyncStorageShared';
import {
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  getPayloadRecordKey,
  OPFS_ROOT_DIR,
  parseFileNameKindAlias,
  parseRecordKindAlias,
} from '../../src/persistentStorage/opfsFileNaming';
import {
  type IndexedDbPersistentStorageOperation,
} from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import {
  type IndexedDbPersistentStorageTestStore,
  getCurrentIndexedDbPersistentStorageTestStore,
} from './indexedDbPersistentStorageTestStore';
import {
  getParsedLocalStorageValue as baseGetParsedLocalStorageValue,
  startPersistentStorageOperationCapture as baseStartPersistentStorageOperationCapture,
} from './persistentStorageOptimizationTestUtils';
const OPFS_FILE_NAME_REGEX =
  /^(?<kindPart>[^.]+)\.(?<entryPart>.+)\.(?<recordPart>[^.]+)\.json$/u;
const OPFS_PATH_PLACEHOLDER_REGEX = /<([^<>]*)>/gu;
const HASHED_OPFS_SCOPE_KINDS = new Set<AsyncStorageNamespaceScope['kind']>([
  'collection.item',
  'listQuery.item',
  'listQuery.query',
]);

function getStringByteSize(value: string): number {
  return value.length * 2;
}

const secondsFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});

function formatTime(ms: number): string {
  if (ms === 0) return '0';
  if (ms >= 1000) return `${secondsFormatter.format(ms / 1000)}s`;
  return `${ms}ms`;
}

function getScopeLabel(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
}

function formatValues(values: unknown[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function formatStructuredStringValues(values: string[]): string {
  return `[${values
    .map((value) => {
      const parsed = safeJsonParse(value);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);

      return JSON.stringify(value);
    })
    .join(', ')}]`;
}

function formatManagedRecordKeys(keys: string[]): string {
  return formatValues(
    keys.map((key) => {
      const parsedKey = parseAsyncStorageRecordKey(key);
      if (parsedKey.recordKind === 'payload') {
        return parsedKey.userKey;
      }

      if (parsedKey.rawKey === '_i') return '@scope';

      return parsedKey.rawKey;
    }),
  );
}

function formatOperation(
  operation: IndexedDbPersistentStorageOperation,
  captureStartedAt: number,
): string {
  const time = formatTime(Math.max(0, operation.time - captureStartedAt));

  switch (operation.type) {
    case 'applyManagedCommit':
      return `${time} | ✍️ tx(entries, namespacePolicies).commit scope=${getScopeLabel(
        operation.scope,
      )} put=${formatValues(
        operation.upserts,
      )} delete=${formatValues(operation.removes)} touch=${formatValues(
        operation.touches,
      )}${operation.staticPolicyChanged ? ' static-policy' : ''}`;
    case 'clearManagedNamespace':
      return `${time} | 🧹 tx(entries, namespacePolicies).clear scope=${getScopeLabel(
        operation.scope,
      )}`;
    case 'listManagedMetadata':
      return `${time} | 🔎 ${
        operation.usedIndex === 'group'
          ? 'entries.byScopeGroup'
          : operation.usedIndex === 'lru'
            ? 'entries.byScopeLastAccessAt'
            : 'entries.primaryKey'
      } scope=${getScopeLabel(operation.scope)} order=${operation.order} -> ${formatValues(
        operation.resultKeys,
      )}`;
    case 'listScopesWithKnownRecordKeys':
      return `${time} | 🗂️ scan(entries.bySession, namespacePolicies.bySession) session=${
        operation.sessionKey === undefined
          ? '*'
          : JSON.stringify(operation.sessionKey)
      } -> ${formatStructuredStringValues(operation.scopeIds)}`;
    case 'readManagedIndexState':
      return `${time} | 📖 scope-state entries+namespacePolicies scope=${getScopeLabel(
        operation.scope,
      )} -> keys=${operation.keyCount} exists=${operation.exists ? 'yes' : 'no'} valid=${operation.valid ? 'yes' : 'no'}`;
    case 'removeManagedRecords':
      return `${time} | 🗑️ tx(entries, namespacePolicies).delete scope=${getScopeLabel(
        operation.scope,
      )} keys=${formatManagedRecordKeys(operation.keys)}`;
    case 'readManagedEntries':
      return `${time} | 📖 entries.getMany scope=${getScopeLabel(
        operation.scope,
      )} keys=${formatValues(operation.keys)} -> ${formatValues(
        operation.resultKeys,
      )}`;
    case 'persistManagedIndexState':
      return `${time} | ✍️ tx(entries, namespacePolicies).persistScopeState scope=${getScopeLabel(
        operation.scope,
      )} keys=${operation.keyCount}${
        operation.staticPolicy === null ? '' : ' static-policy'
      }`;
    case 'readProtectedStorageKeys':
      return `${time} | 🛡️ entries.bySessionOfflineProtected session=${JSON.stringify(
        operation.sessionKey,
      )} -> ${formatStructuredStringValues(operation.values)}`;
    case 'syncSessionProtectedKeys':
      return `${time} | 🛡️ protected.sync session=${JSON.stringify(
        operation.sessionKey,
      )} -> ${formatStructuredStringValues(operation.values)}`;
  }
}

type IndexedDbStructureSnapshot = {
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
    rowCount: number;
    rows: Array<{
      key: unknown;
      value: unknown;
    }>;
  }>;
  version: number;
};

export type IndexedDbRowReference = {
  key: unknown;
  storeName: string;
};

function formatCompactByteSize(byteSize: number): string {
  return `${(byteSize / 1024).toFixed(1)} kb`;
}

function getApproximateValueSize(value: unknown): number | null {
  if (typeof value === 'string') return getStringByteSize(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;

  try {
    return getStringByteSize(JSON.stringify(value));
  } catch {
    return null;
  }
}

function truncateStringValue(value: string, maxLength = 40): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function summarizeIndexedDbValue(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value}n`;

  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    const isStructuredJsonString =
      typeof parsed === 'object' && parsed !== null;

    if (isStructuredJsonString) {
      return `JSON string | ${formatCompactByteSize(
        getApproximateValueSize(value) ?? 0,
      )}`;
    }

    if (value.length <= 80) return JSON.stringify(value);

    return `${JSON.stringify(truncateStringValue(value))} | ${formatCompactByteSize(
      getApproximateValueSize(value) ?? 0,
    )}`;
  }

  if (value instanceof Date) return value.toISOString();

  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob
  ) {
    return `binary | ${formatCompactByteSize(getApproximateValueSize(value) ?? 0)}`;
  }

  if (Array.isArray(value)) {
    return `JSON array | ${formatCompactByteSize(
      getApproximateValueSize(value) ?? 0,
    )}`;
  }

  if (typeof value === 'object') {
    return `JSON object | ${formatCompactByteSize(
      getApproximateValueSize(value) ?? 0,
    )}`;
  }

  return String(value);
}

function compareUnknownValues(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function areIndexedDbKeysEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function flushIndexedDbWrites(
  mockAdapter: IndexedDbPersistentStorageTestStore,
): Promise<void> {
  try {
    await mockAdapter.flushIndexedDbCommits();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('timers APIs are not mocked')
    ) {
      await mockAdapter.flushPendingWrites();
      return;
    }

    throw error;
  }
}

export async function getIndexedDbStructureSnapshot(
  mockAdapter: IndexedDbPersistentStorageTestStore,
): Promise<IndexedDbStructureSnapshot> {
  await flushIndexedDbWrites(mockAdapter);
  const inspection = await mockAdapter.driver.__inspectStructureForTests();
  const stores = inspection.stores.map((store) => ({
    autoIncrement: store.autoIncrement,
    indexes: store.indexes,
    keyPath: store.keyPath,
    name: store.name,
    rowCount: store.rows.length,
    rows: store.rows
      .map((row) => ({
        key: row.key,
        value: summarizeIndexedDbValue(row.value),
      }))
      .sort((left, right) => compareUnknownValues(left.key, right.key)),
  }));

  return {
    stores,
    version: inspection.version,
  };
}

export async function getParsedIndexedDbRecordData<T = unknown>(
  mockAdapterOrReference: IndexedDbPersistentStorageTestStore | IndexedDbRowReference,
  maybeReference?: IndexedDbRowReference,
): Promise<T | null> {
  const mockAdapter =
    maybeReference === undefined
      ? getCurrentIndexedDbPersistentStorageTestStore()
      : __LEGIT_CAST__<IndexedDbPersistentStorageTestStore, unknown>(
          mockAdapterOrReference,
        );
  const reference =
    maybeReference === undefined
      ? __LEGIT_CAST__<IndexedDbRowReference, unknown>(mockAdapterOrReference)
      : maybeReference;

  await flushIndexedDbWrites(mockAdapter);
  const inspection = await mockAdapter.driver.__inspectStructureForTests();
  const store = inspection.stores.find(
    (entry) => entry.name === reference.storeName,
  );
  const row = store?.rows.find((entry) =>
    areIndexedDbKeysEqual(entry.key, reference.key)
  );

  return __LEGIT_CAST__<T | null, unknown>(row?.value ?? null);
}

export function getParsedTsdfIndexedDbRecordData<T = unknown>(
  mockAdapterOrPath: IndexedDbPersistentStorageTestStore | string,
  maybePath?: string,
): T | null {
  const mockAdapter =
    typeof mockAdapterOrPath === 'string'
      ? getCurrentIndexedDbPersistentStorageTestStore()
      : mockAdapterOrPath;
  const path =
    typeof mockAdapterOrPath === 'string' ? mockAdapterOrPath : maybePath;
  if (path === undefined) {
    throw new Error('Expected IndexedDB record path.');
  }

  const resolvedPath = resolvePlaceholderHashedOpfsFilePath(path);
  const raw =
    mockAdapter.getCachedPseudoFileMap().get(path) ??
    mockAdapter.getCachedPseudoFileMap().get(resolvedPath);
  if (raw === undefined) return null;
  return __LEGIT_CAST__<T | null, unknown>(
    compactDocumentOpfsIndexSnapshotValue(path, safeJsonParse(raw) ?? raw),
  );
}

function compactDocumentOpfsIndexSnapshotValue(
  filePath: string,
  value: unknown,
): unknown {
  if (!filePath.endsWith('/d._i.r.json') || typeof value !== 'object' || value === null) {
    return value;
  }

  const record = __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
  const entries = record.e;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    return value;
  }

  const entriesRecord = __LEGIT_CAST__<Record<string, unknown>, unknown>(entries);
  const keys = Object.keys(entriesRecord);
  if (keys.length !== 1 || keys[0] !== 'document') return value;

  return { ...record, e: [entriesRecord.document] };
}

function resolvePlaceholderHashedOpfsFilePath(filePath: string): string {
  const pathSegments = filePath.split('/');
  const fileName = pathSegments.pop();
  const storeName = pathSegments.pop();
  const sessionKey = pathSegments.pop();
  const rootDir = pathSegments.pop();
  if (
    fileName === undefined ||
    storeName === undefined ||
    sessionKey === undefined ||
    rootDir !== OPFS_ROOT_DIR
  ) {
    return filePath;
  }

  const parsedFileName = OPFS_FILE_NAME_REGEX.exec(fileName);
  if (parsedFileName?.groups === undefined) return filePath;

  const kind = parseFileNameKindAlias(parsedFileName.groups.kindPart ?? '');
  const recordKind = parseRecordKindAlias(
    parsedFileName.groups.recordPart ?? '',
  );
  if (
    kind === null ||
    recordKind !== 'payload' ||
    !HASHED_OPFS_SCOPE_KINDS.has(kind)
  ) {
    return filePath;
  }

  const entryPart = parsedFileName.groups.entryPart ?? '';
  if (entryPart.startsWith('h~')) return filePath;

  const userKey = entryPart.includes('<')
    ? entryPart.replace(
        OPFS_PATH_PLACEHOLDER_REGEX,
        (_match, value: string) => value,
      )
    : decodePathSegment(entryPart);

  return [
    OPFS_ROOT_DIR,
    encodePathSegment(decodePathSegment(sessionKey)),
    encodePathSegment(decodePathSegment(storeName)),
    buildFileName(
      {
        sessionKey: decodePathSegment(sessionKey),
        storeName: decodePathSegment(storeName),
        kind,
      },
      getPayloadRecordKey(userKey),
    ),
  ].join('/');
}

export type IndexedDbPersistentStorageOperationCaptureResult = {
  operations: string[];
  timelineString: string;
};

export function startIndexedDbPersistentStorageOperationCapture(
  mockAdapter: IndexedDbPersistentStorageTestStore,
): { finish: () => IndexedDbPersistentStorageOperationCaptureResult } {
  mockAdapter.clearInstrumentation();
  const captureStartedAt = Date.now();

  return {
    finish() {
      const operations = mockAdapter.operations
        .map((operation, index) => ({
          index,
          operation,
        }))
        .sort(
          (left, right) =>
            left.operation.time - right.operation.time || left.index - right.index,
        )
        .map(({ operation }) => formatOperation(operation, captureStartedAt));

      return {
        operations,
        timelineString:
          operations.length === 0 ? 'empty' : `"\n${operations.join('\n')}\n"`,
      };
    },
  };
}

export function getParsedLocalStorageValue<T = unknown>(
  key: string,
): T | null {
  return baseGetParsedLocalStorageValue(key);
}

export function startPersistentStorageOperationCapture() {
  return baseStartPersistentStorageOperationCapture();
}
