import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../src/persistentStorage/asyncStorageAdapter';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from '../../src/persistentStorage/documentEntryKey';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  buildFileName,
  decodePathSegment,
  encodePathSegment,
  getPayloadRecordKey,
  OPFS_ROOT_DIR,
  parseFileNameKindAlias,
  parseRecordKey,
  parseRecordKindAlias,
} from '../../src/persistentStorage/opfsFileNaming';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import type { MockBrowserOpfsEnvironment } from '../mocks/mockBrowserOpfs';
import { readMockBrowserOpfsFileForTests } from '../mocks/mockBrowserOpfs';
import {
  createOpfsPersistentStorageTestStore,
  type MockOpfsOperation,
  type OpfsPersistentStorageTestStore,
} from './opfsPersistentStorageTestStore';

const LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX = 'li';
const LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX = 'lq';
const COLLECTION_STORAGE_ENTRY_PREFIX = 'ci';
const OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX = 'oq';
const OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX = 'oc';
const OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX = 'oe';
const MANAGED_PERSISTENT_PREFIXES = ['tsdf._m.r.', 'tsdf.__lsm__.r.'] as const;
const MANAGED_PERSISTENT_SPECIAL_KEYS: Readonly<Record<string, string>> = {
  'tsdf._m.l': 'lease',
  'tsdf.__lsm__.l': 'lease',
  'tsdf._m.g': 'global maintenance',
  [ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY]: 'async global maintenance',
} as const;
const MANIFEST_PART = '.manifest.';
const OPFS_FILE_NAME_REGEX =
  /^(?<kindPart>[^.]+)\.(?<entryPart>.+)\.(?<recordPart>[^.]+)\.json$/u;
const OPFS_PATH_PLACEHOLDER_REGEX = /<([^<>]*)>/gu;
const HASHED_OPFS_SCOPE_KINDS = new Set<AsyncStorageNamespaceScope['kind']>([
  'collection.item',
  'listQuery.item',
  'listQuery.query',
]);
const STORAGE_ENTRY_MARKERS = [
  COLLECTION_STORAGE_ENTRY_PREFIX,
  LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX,
  LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX,
  OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX,
  OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX,
  OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX,
] as const;

function describePersistentStorageKey(key: string): string | null {
  const specialKeyDescription = MANAGED_PERSISTENT_SPECIAL_KEYS[key];
  if (specialKeyDescription !== undefined) return specialKeyDescription;

  const managedKeyDescription = describeManagedPersistentStorageKey(key);
  if (managedKeyDescription !== null) return managedKeyDescription;

  if (!key.startsWith('tsdf.')) return null;

  const payloadKeyDescription = describePersistentStoragePayloadKey(key);
  if (payloadKeyDescription !== null) return payloadKeyDescription;

  return withOfflinePrefix(
    describeEntryKind(key),
    describeOfflineStorageType(key),
  );
}

function describeManagedPersistentStorageKey(key: string): string | null {
  const managedPrefix = MANAGED_PERSISTENT_PREFIXES.find((prefix) =>
    key.startsWith(prefix),
  );
  if (managedPrefix === undefined) return null;

  const identity = key.slice(managedPrefix.length);
  const labelKind = getManagedStorageEntryLabelKind(identity);
  if (identity.endsWith('.m') || identity.endsWith('.manifest')) {
    return getNamespaceIndexLabel(labelKind);
  }

  const manifestMarkerIndex = identity.indexOf(MANIFEST_PART);
  if (manifestMarkerIndex >= 0) {
    const shardIndex = identity.slice(
      manifestMarkerIndex + MANIFEST_PART.length,
    );

    return `${getNamespaceIndexLabel(labelKind)} shard ${shardIndex || '?'}`;
  }

  return withOfflinePrefix(
    `root, ${describeRootKind(identity)}`,
    describeOfflineStorageType(identity),
  );
}

function describePersistentStoragePayloadKey(key: string): string | null {
  const scopedEntryDescription =
    formatScopedPersistentStorageEntryDescription(key);
  if (scopedEntryDescription !== null) return scopedEntryDescription;

  return 'entry data';
}

function formatScopedPersistentStorageEntryDescription(
  key: string,
): string | null {
  const matchedEntry = matchPersistentStorageEntryKey(key);
  if (matchedEntry === null) return null;

  const labelKind = getStorageEntryLabelKind(matchedEntry.prefix);
  if (labelKind === null || matchedEntry.userKey.length === 0) return null;

  return formatStorageEntryDescription(matchedEntry.userKey, labelKind);
}

function matchPersistentStorageEntryKey(
  key: string,
): { prefix: string; userKey: string } | null {
  for (const prefix of STORAGE_ENTRY_MARKERS) {
    const marker = `.${prefix}.`;
    const markerIndex = key.indexOf(marker, 'tsdf.'.length);
    if (markerIndex === -1) continue;

    return { prefix, userKey: key.slice(markerIndex + marker.length) };
  }

  return null;
}

function describeEntryKind(key: string): string {
  if (key.includes(`.${LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX}.`)) {
    return 'query entry';
  }

  if (key.includes(`.${LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX}.`)) {
    return 'item entry';
  }

  if (key.includes(`.${COLLECTION_STORAGE_ENTRY_PREFIX}.`)) {
    return 'collection entry';
  }

  return 'entry';
}

function describeRootKind(identity: string): 'single' | 'namespace' | 'root' {
  if (identity.startsWith('s:') || identity.startsWith('single:')) {
    return 'single';
  }

  if (identity.startsWith('n:') || identity.startsWith('namespace:')) {
    return 'namespace';
  }

  return 'root';
}

function withOfflinePrefix(label: string, offlineType: string | null): string {
  return offlineType ? `${label}, ${offlineType}` : label;
}

function describeOfflineStorageType(value: string): string | null {
  if (value.includes('._o_.s')) return 'offline session status';

  if (value.includes('._o_.p')) return 'offline protected keys';

  if (value.includes(`.${OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX}.`)) {
    return 'offline queue';
  }

  if (value.includes(`.${OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX}.`)) {
    return 'offline conflict';
  }

  if (value.includes(`.${OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX}.`)) {
    return 'offline entity';
  }

  return null;
}

function formatPersistentStorageKey(key: string | null): string {
  if (typeof key !== 'string') return '<non-string>';

  const description = describePersistentStorageKey(key);
  if (description === null) return key;

  return `${key} (${description})`;
}

function formatPersistentStorageKeyParts(key: string | null): {
  main: string;
  detail?: string;
} {
  if (typeof key !== 'string') {
    return { main: formatPersistentStorageKey(key) };
  }

  const description = describePersistentStorageKey(key);
  if (description === null) return { main: key };

  return { main: key, detail: `(${description})` };
}

function formatByteSize(byteSize: number): string {
  return `${(byteSize / 1024).toFixed(2)} kb`;
}

function getStringByteSize(value: string): number {
  return value.length * 2;
}

const secondsFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 3,
});
const LEADING_SLASHES_REGEX = /^\/+/;

function formatTimeMs(ms: number): string {
  if (ms === 0) return '0';
  if (ms >= 1000) return `${secondsFormatter.format(ms / 1000)}s`;
  return `${ms}ms`;
}

function formatRelativeTime(
  ms: number,
  previousMs: number | undefined,
): string {
  if (previousMs !== undefined && ms === previousMs) return '.';
  return formatTimeMs(ms);
}

export type PersistentStorageOperation =
  | {
      time: number;
      type: 'getItem';
      exists: boolean;
      key: string | null;
      rawValue: string | null;
      valueByteSize: number | null;
    }
  | {
      time: number;
      type: 'setItem';
      existsBefore: boolean;
      valueChanged: boolean;
      key: string;
      rawValueAfter: string;
      valueByteSizeBefore: number | null;
      valueByteSizeAfter: number;
    }
  | { time: number; type: 'removeItem'; existsBefore: boolean; key: string }
  | { time: number; type: 'key'; index: number; key: string | null }
  | { time: number; type: 'clear' };

function getOperationKey(operation: PersistentStorageOperation): string | null {
  if (operation.type === 'clear') return null;
  return operation.key;
}

const TIMELINE_DUPLICATE_OPERATION_THRESHOLD_MS = 10;
const REPEATED_UNCHANGED_READ_WARNING = '⚠️ REPEATED READ <10ms UNCHANGED';
const DUPLICATE_UNNECESSARY_WRITE_WARNING =
  '⚠️ DUPLICATE WRITE <10ms UNCHANGED';
const DUPLICATE_OPEN_WARNING = '⚠️ DUPLICATE OPEN';

type ReadTimelineSnapshot = {
  rawValue: string | null;
  target: string | null;
  time: number;
};

function getRepeatedReadWarning(
  readWindow: readonly ReadTimelineSnapshot[],
  currentRead: ReadTimelineSnapshot | null,
): string | undefined {
  if (currentRead === null || currentRead.target === null) return undefined;
  if (currentRead.rawValue === null) return undefined;

  const hasMatchingRead = readWindow.some(
    (previousRead) =>
      previousRead.target === currentRead.target &&
      previousRead.rawValue !== null &&
      previousRead.rawValue === currentRead.rawValue &&
      currentRead.time - previousRead.time <
        TIMELINE_DUPLICATE_OPERATION_THRESHOLD_MS,
  );
  if (!hasMatchingRead) return undefined;

  return REPEATED_UNCHANGED_READ_WARNING;
}

type WriteTimelineSnapshot = {
  rawValueAfter: string;
  target: string | null;
  time: number;
  valueChanged: boolean;
};

function getDuplicateWriteWarning(
  writeWindow: readonly WriteTimelineSnapshot[],
  currentWrite: WriteTimelineSnapshot | null,
): string | undefined {
  if (currentWrite === null || currentWrite.target === null) return undefined;
  if (currentWrite.valueChanged) return undefined;

  const hasMatchingWrite = writeWindow.some(
    (previousWrite) =>
      previousWrite.target === currentWrite.target &&
      previousWrite.rawValueAfter === currentWrite.rawValueAfter &&
      currentWrite.time - previousWrite.time <
        TIMELINE_DUPLICATE_OPERATION_THRESHOLD_MS,
  );
  if (!hasMatchingWrite) return undefined;

  return DUPLICATE_UNNECESSARY_WRITE_WARNING;
}

function getSnapshotsInWindow<T extends { time: number }>(
  window: readonly T[],
  currentTime: number,
): T[] {
  return window.filter(
    (entry) =>
      currentTime - entry.time < TIMELINE_DUPLICATE_OPERATION_THRESHOLD_MS,
  );
}

function appendTimelineWarning(
  detail: string | undefined,
  warning: string | undefined,
): string | undefined {
  if (warning === undefined) return detail;
  if (detail === undefined) return warning;
  return `${detail} ${warning}`;
}

function formatPersistentStorageOperation(
  operation: PersistentStorageOperation,
  keyIdMap: Map<string, number>,
  warning?: string,
): string {
  const key = getOperationKey(operation);
  const keyId = key !== null ? keyIdMap.get(key) : undefined;

  switch (operation.type) {
    case 'getItem': {
      const keyParts = formatPersistentStorageKeyParts(operation.key);
      if (operation.valueByteSize !== null) {
        return formatWrappedPersistentStorageOperationLabel(
          `📖 ${operation.exists ? '✅' : '❌'}`,
          keyId,
          keyParts.main,
          appendTimelineWarning(
            `${keyParts.detail ?? ''} | ${formatByteSize(operation.valueByteSize)}`.trim(),
            warning,
          ),
        );
      }
      return formatWrappedPersistentStorageOperationLabel(
        `📖 ${operation.exists ? '✅' : '❌'}`,
        keyId,
        keyParts.main,
        appendTimelineWarning(keyParts.detail, warning),
      );
    }
    case 'setItem': {
      const unchangedFlag = !operation.valueChanged ? ' ⚠️ UNCHANGED' : '';
      const keyParts = formatPersistentStorageKeyParts(operation.key);
      const before =
        operation.valueByteSizeBefore !== null
          ? formatByteSize(operation.valueByteSizeBefore)
          : '❌';
      return formatWrappedPersistentStorageOperationLabel(
        `✍️ ${operation.existsBefore ? '✅' : '❌'}->✅`,
        keyId,
        keyParts.main,
        appendTimelineWarning(
          `${keyParts.detail ?? ''} | ${before} -> ${formatByteSize(
            operation.valueByteSizeAfter,
          )}${unchangedFlag}`.trim(),
          warning,
        ),
      );
    }
    case 'removeItem': {
      const keyParts = formatPersistentStorageKeyParts(operation.key);
      return formatWrappedPersistentStorageOperationLabel(
        `🗑️ ${operation.existsBefore ? '✅' : '❌'}->❌`,
        keyId,
        keyParts.main,
        keyParts.detail,
      );
    }
    case 'key': {
      const keyParts = formatPersistentStorageKeyParts(operation.key);
      return formatWrappedPersistentStorageOperationLabel(
        `🔑[${operation.index}] ${operation.key === null ? '❌' : '✅'}`,
        keyId,
        keyParts.main,
        keyParts.detail,
      );
    }
    case 'clear':
      return '🧹';
  }
}

function formatTableString(
  rows: Array<{ cols: string[]; type?: 'default' | 'gap' }>,
): string {
  if (rows.length === 0) return '';

  const colWidths: number[] = [];
  for (const { cols } of rows) {
    for (const [index, col] of cols.entries()) {
      colWidths[index] = Math.max(colWidths[index] ?? 0, col.length);
    }
  }

  return rows
    .map(({ cols, type }) => {
      if (type === 'gap') return `${' '.repeat((colWidths[0] ?? 0) + 1)}·`;

      return cols
        .map((col, index) => col.padEnd(colWidths[index] ?? 0))
        .join(' | ')
        .trimEnd();
    })
    .join('\n');
}

type TimelineLabel = { endTime: number; label: string; time: number };

export function getPersistentStorageOperationTimelineString(
  operations: readonly PersistentStorageOperation[],
): string {
  if (operations.length === 0) return 'empty';

  const keyIdMap = new Map<string, number>();
  let nextKeyId = 1;

  for (const operation of operations) {
    const key = getOperationKey(operation);
    if (key !== null && !keyIdMap.has(key)) {
      keyIdMap.set(key, nextKeyId++);
    }
  }

  const timelineEntries: TimelineLabel[] = [];
  let readWindow: ReadTimelineSnapshot[] = [];
  let writeWindow: WriteTimelineSnapshot[] = [];

  for (const operation of operations) {
    const currentRead =
      operation.type === 'getItem'
        ? {
            rawValue: operation.rawValue,
            target: operation.key,
            time: operation.time,
          }
        : null;
    const currentWrite =
      operation.type === 'setItem'
        ? {
            rawValueAfter: operation.rawValueAfter,
            target: operation.key,
            time: operation.time,
            valueChanged: operation.valueChanged,
          }
        : null;
    const warning =
      operation.type === 'getItem'
        ? getRepeatedReadWarning(readWindow, currentRead)
        : operation.type === 'setItem'
          ? getDuplicateWriteWarning(writeWindow, currentWrite)
          : undefined;

    timelineEntries.push({
      endTime: operation.time,
      label: formatPersistentStorageOperation(operation, keyIdMap, warning),
      time: operation.time,
    });

    if (currentRead !== null) {
      readWindow = [
        ...getSnapshotsInWindow(readWindow, currentRead.time),
        currentRead,
      ];
    }
    if (currentWrite !== null) {
      writeWindow = [
        ...getSnapshotsInWindow(writeWindow, currentWrite.time),
        currentWrite,
      ];
    }
  }

  return getTimelineString(timelineEntries, { showEndMarker: false });
}

const PERSISTENT_TIMELINE_WRAP_AT = 68;
const PERSISTENT_TIMELINE_DETAIL_PREFIX = '   └ ';
const TIMELINE_GAP_THRESHOLD_MS = 20;

function formatWrappedPersistentStorageOperationLabel(
  prefix: string,
  id: number | undefined,
  value: string,
  detail?: string,
): string {
  const mainLine = formatWrappedOperationMainLine(prefix, id, value);
  if (detail === undefined) return mainLine;

  const fullLine = `${mainLine} ${detail}`;
  return fullLine.length > PERSISTENT_TIMELINE_WRAP_AT
    ? `${mainLine}\n${PERSISTENT_TIMELINE_DETAIL_PREFIX}${detail}`
    : fullLine;
}

function formatWrappedOperationMainLine(
  prefix: string,
  id: number | undefined,
  value: string,
): string {
  if (id === undefined) return `${prefix} ${value}`;

  const [icon, ...rest] = prefix.split(' ');
  const prefixAfterId = rest.join(' ').trim();

  return prefixAfterId.length > 0
    ? `${icon} #${id} ${prefixAfterId} ${value}`
    : `${icon} #${id} ${value}`;
}

export type PersistentStorageOperationCapture = {
  finish: () => {
    timelineString: string;
    operations: readonly PersistentStorageOperation[];
  };
};

export function startPersistentStorageOperationCapture(): PersistentStorageOperationCapture {
  const operations: PersistentStorageOperation[] = [];
  const startedAt = Date.now();
  const originalGetItem = localStorage.getItem.bind(localStorage);
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);
  const originalKey = localStorage.key.bind(localStorage);
  const originalClear = localStorage.clear.bind(localStorage);
  const getItemSpy = vi.spyOn(localStorage, 'getItem');
  const setItemSpy = vi.spyOn(localStorage, 'setItem');
  const removeItemSpy = vi.spyOn(localStorage, 'removeItem');
  const keySpy = vi.spyOn(localStorage, 'key');
  const clearSpy = vi.spyOn(localStorage, 'clear');
  getItemSpy.mockClear();
  setItemSpy.mockClear();
  removeItemSpy.mockClear();
  keySpy.mockClear();
  clearSpy.mockClear();
  getItemSpy.mockImplementation((key: string): string | null => {
    const value = originalGetItem(key);
    operations.push({
      time: Date.now() - startedAt,
      type: 'getItem',
      key,
      exists: value !== null,
      rawValue: value,
      valueByteSize: value !== null ? value.length * 2 : null,
    });
    return value;
  });
  setItemSpy.mockImplementation((key: string, value: string): void => {
    const existingValue = originalGetItem(key);
    operations.push({
      time: Date.now() - startedAt,
      type: 'setItem',
      key,
      existsBefore: existingValue !== null,
      rawValueAfter: value,
      valueChanged: existingValue !== value,
      valueByteSizeBefore:
        existingValue !== null ? existingValue.length * 2 : null,
      valueByteSizeAfter: value.length * 2,
    });
    originalSetItem(key, value);
  });
  removeItemSpy.mockImplementation((key: string): void => {
    operations.push({
      time: Date.now() - startedAt,
      type: 'removeItem',
      key,
      existsBefore: originalGetItem(key) !== null,
    });
    originalRemoveItem(key);
  });
  keySpy.mockImplementation((index: number): string | null => {
    const key = originalKey(index);
    operations.push({ time: Date.now() - startedAt, type: 'key', index, key });
    return key;
  });
  clearSpy.mockImplementation((): void => {
    operations.push({ time: Date.now() - startedAt, type: 'clear' });
    originalClear();
  });

  return {
    finish() {
      const finishedOperations = [...operations];
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
      removeItemSpy.mockRestore();
      keySpy.mockRestore();
      clearSpy.mockRestore();
      return {
        timelineString:
          getPersistentStorageOperationTimelineString(finishedOperations),
        operations: finishedOperations,
      };
    },
  };
}

export function getParsedLocalStorageValue<T = unknown>(key: string): T | null {
  const value = localStorage.getItem(key);
  if (value === null) return null;

  return __LEGIT_CAST__<T | null, unknown>(safeJsonParse(value) ?? value);
}

function compactDocumentOpfsIndexSnapshotValue(
  filePath: string,
  value: unknown,
): unknown {
  if (!filePath.endsWith('/d._i.r.json')) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }

  const record = __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
  const entries = record.e;
  if (
    typeof entries !== 'object' ||
    entries === null ||
    Array.isArray(entries)
  ) {
    return value;
  }

  const entriesRecord = __LEGIT_CAST__<Record<string, unknown>, unknown>(
    entries,
  );
  const keys = Object.keys(entriesRecord);
  if (keys.length !== 1 || keys[0] !== DOCUMENT_PERSISTED_ENTRY_KEY) {
    return value;
  }

  return { ...record, e: [entriesRecord[DOCUMENT_PERSISTED_ENTRY_KEY]] };
}

export function getParsedOpfsFileData<T = unknown>(filePath: string): T | null {
  const raw =
    readMockBrowserOpfsFileForTests(filePath) ??
    readMockBrowserOpfsFileForTests(
      resolvePlaceholderHashedOpfsFilePath(filePath),
    );
  if (raw === null) return null;

  return __LEGIT_CAST__<T | null, unknown>(
    compactDocumentOpfsIndexSnapshotValue(filePath, safeJsonParse(raw) ?? raw),
  );
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

export function getParsedOpfsNamespaceValue<T = unknown>(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  scope: AsyncStorageNamespaceScope,
  key: string,
): T | null {
  return __LEGIT_CAST__<T | null, unknown>(
    mockAdapter.rawNamespace.get(scope, key),
  );
}

type StorageTreeNode = {
  children: Map<string, StorageTreeNode>;
  ownByteSize: number;
  totalByteSize: number;
};

function createStorageTreeNode(): StorageTreeNode {
  return { children: new Map(), ownByteSize: 0, totalByteSize: 0 };
}

type StorageEntryLabelKind =
  | 'collectionItemKey'
  | 'listQueryItemKey'
  | 'listQueryQueryKey'
  | 'queueKey'
  | 'conflictKey'
  | 'entityKey';

function getNamespaceIndexLabel(
  labelKind: StorageEntryLabelKind | null,
): string {
  switch (labelKind) {
    case 'listQueryItemKey':
      return 'items index';
    case 'listQueryQueryKey':
      return 'queries index';
    default:
      return 'namespace index';
  }
}

function getPayloadDataLabel(labelKind: StorageEntryLabelKind | null): string {
  switch (labelKind) {
    case 'listQueryItemKey':
      return 'item data';
    case 'listQueryQueryKey':
      return 'query data';
    default:
      return 'entry data';
  }
}

function getStorageEntryLabelKind(value: string): StorageEntryLabelKind | null {
  switch (value) {
    case 'collection.item':
    case 'ci':
      return 'collectionItemKey';
    case 'listQuery.item':
    case 'li':
      return 'listQueryItemKey';
    case 'listQuery.query':
    case 'lq':
      return 'listQueryQueryKey';
    case 'offline.queue':
    case 'oq':
      return 'queueKey';
    case 'offline.conflict':
    case 'oc':
      return 'conflictKey';
    case 'offline.entity':
    case 'oe':
      return 'entityKey';
    default:
      return null;
  }
}

function formatStorageEntryLabel(value: string): string {
  return `<${value}>`;
}

function formatStorageEntryDescription(
  value: string,
  labelKind: StorageEntryLabelKind | null,
): string {
  const label = formatStorageEntryLabel(value);
  return `${getPayloadDataLabel(labelKind)}, ${label}`;
}

function getManagedStorageEntryLabelKind(
  identity: string,
): StorageEntryLabelKind | null {
  for (const prefix of STORAGE_ENTRY_MARKERS) {
    if (
      identity.includes(`.${prefix}.m`) ||
      identity.includes(`.${prefix}.manifest.`)
    ) {
      return getStorageEntryLabelKind(prefix);
    }
  }

  return null;
}

function addTreePath(
  root: StorageTreeNode,
  pathSegments: readonly string[],
  leafByteSize: number,
): void {
  if (pathSegments.length === 0) return;

  addTreePathSegment(root, pathSegments, leafByteSize);
}

function addTreePathSegment(
  parent: StorageTreeNode,
  [pathSegment, ...restPathSegments]: readonly string[],
  leafByteSize: number,
): number {
  if (pathSegment === undefined) return 0;

  let child = parent.children.get(pathSegment);
  let addedByteSize = 0;

  if (child === undefined) {
    child = createStorageTreeNode();
    parent.children.set(pathSegment, child);

    const pathSegmentByteSize = getStringByteSize(pathSegment);
    child.ownByteSize += pathSegmentByteSize;
    child.totalByteSize += pathSegmentByteSize;
    addedByteSize += pathSegmentByteSize;
  }

  if (restPathSegments.length === 0) {
    child.ownByteSize += leafByteSize;
    child.totalByteSize += leafByteSize;
    addedByteSize += leafByteSize;
  } else {
    addedByteSize += addTreePathSegment(child, restPathSegments, leafByteSize);
  }

  parent.totalByteSize += addedByteSize;
  return addedByteSize;
}

function formatStorageTree(
  node: StorageTreeNode,
  options: { collapseSingleChildChains: boolean },
): string[] {
  const entries = [...node.children.entries()].sort(([leftName], [rightName]) =>
    leftName.localeCompare(rightName),
  );

  return entries.flatMap(([name, child], index) =>
    formatStorageTreeNode({
      child,
      isLast: index === entries.length - 1,
      isRootLevel: true,
      name,
      options,
      prefix: '',
    }),
  );
}

function collapseStorageTreeChain(args: {
  child: StorageTreeNode;
  name: string;
}): { name: string; terminalChild: StorageTreeNode } {
  let currentName = args.name;
  let currentChild = args.child;

  while (currentChild.children.size === 1) {
    const [nextName, nextChild] = [...currentChild.children.entries()][0] ?? [];
    if (nextName === undefined || nextChild === undefined) break;

    currentName = `${currentName}.${nextName}`;
    currentChild = nextChild;
  }

  return { name: currentName, terminalChild: currentChild };
}

function formatStorageTreeNode(args: {
  child: StorageTreeNode;
  isLast: boolean;
  isRootLevel: boolean;
  name: string;
  options: { collapseSingleChildChains: boolean };
  prefix: string;
}): string[] {
  const collapsed = args.options.collapseSingleChildChains
    ? collapseStorageTreeChain({ child: args.child, name: args.name })
    : { name: args.name, terminalChild: args.child };
  const line = args.isRootLevel
    ? `${collapsed.name} (${formatByteSize(args.child.totalByteSize)})`
    : `${args.prefix}${args.isLast ? '└' : '├'} ${collapsed.name} (${formatByteSize(
        args.child.totalByteSize,
      )})`;

  const childPrefix = args.isRootLevel
    ? ''
    : `${args.prefix}${args.isLast ? '  ' : '│ '}`;
  const childEntries = [...collapsed.terminalChild.children.entries()].sort(
    ([leftName], [rightName]) => leftName.localeCompare(rightName),
  );

  return [
    line,
    ...childEntries.flatMap(([name, child], index) =>
      formatStorageTreeNode({
        child,
        isLast: index === childEntries.length - 1,
        isRootLevel: false,
        name,
        options: args.options,
        prefix: childPrefix,
      }),
    ),
  ];
}

function getStorageTreeString(
  root: StorageTreeNode,
  options: { collapseSingleChildChains: boolean },
): string {
  const lines = formatStorageTree(root, options);
  return lines.length === 0 ? 'empty' : lines.join('\n');
}

function getOpfsTreeFileSegments(fileName: string): string[] {
  return [fileName];
}

function addOpfsDirectoryToTree(args: {
  dirPath: string;
  pathSegments: string[];
  root: StorageTreeNode;
  storage: OpfsPersistentStorageTestStore['mockBrowserOpfs'];
}): void {
  const entries = args.storage.listEntries(args.dirPath);

  for (const entry of entries) {
    if (entry.startsWith('dir:')) {
      const rawName = entry.slice('dir:'.length);
      addOpfsDirectoryToTree({
        dirPath: `${args.dirPath}/${rawName}`,
        pathSegments: [...args.pathSegments, decodePathSegment(rawName)],
        root: args.root,
        storage: args.storage,
      });
      continue;
    }

    if (!entry.startsWith('file:')) continue;

    const fileName = entry.slice('file:'.length);
    const raw = args.storage.readFile(`${args.dirPath}/${fileName}`);
    if (raw === null) continue;

    addTreePath(
      args.root,
      [...args.pathSegments, ...getOpfsTreeFileSegments(fileName)],
      getStringByteSize(raw),
    );
  }
}

export function getLocalStorageTree(): string {
  const root = createStorageTreeNode();
  const keys = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index);
    return key === null ? [] : [key];
  })
    .flat()
    .sort((left, right) => left.localeCompare(right));

  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value === null) continue;

    addTreePath(root, key.split('.'), getStringByteSize(value));
  }

  return getStorageTreeString(root, { collapseSingleChildChains: true });
}

export function getOpfsDirTree(
  source:
    | ReturnType<typeof createOpfsPersistentStorageTestStore>
    | MockBrowserOpfsEnvironment,
): string {
  const root = createStorageTreeNode();
  const storage = 'mockBrowserOpfs' in source ? source.mockBrowserOpfs : source;
  const rootEntries = storage.listEntries('');
  const asyncGlobalMaintenance = localStorage.getItem(
    ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY,
  );

  if (rootEntries.length === 0 && asyncGlobalMaintenance === null) {
    return 'empty';
  }

  if (rootEntries.length > 0) {
    for (const entry of rootEntries) {
      if (entry.startsWith('dir:')) {
        const rawName = entry.slice('dir:'.length);
        const decodedName = decodePathSegment(rawName);

        addOpfsDirectoryToTree({
          dirPath: rawName,
          pathSegments: [decodedName],
          root,
          storage,
        });
        continue;
      }

      if (!entry.startsWith('file:')) continue;

      const fileName = entry.slice('file:'.length);
      const raw = storage.readFile(fileName);
      if (raw === null) continue;

      addTreePath(root, [fileName], getStringByteSize(raw));
    }
  }

  if (asyncGlobalMaintenance !== null) {
    addTreePath(
      root,
      [OPFS_ROOT_DIR, 'tsdf._am.g*'],
      getStringByteSize(asyncGlobalMaintenance),
    );
  }

  return getStorageTreeString(root, { collapseSingleChildChains: false });
}

function sortTimedEntries<T extends { endTime: number; time: number }>(
  operations: readonly T[],
): T[] {
  return operations
    .map((operation, index) => [operation, index] as const)
    .sort(([left, leftIndex], [right, rightIndex]) => {
      if (left.time !== right.time) return left.time - right.time;
      return leftIndex - rightIndex;
    })
    .map(([operation]) => operation);
}

function formatTimelineTable(
  operations: TimelineLabel[],
  options: { showEndMarker: boolean },
): string {
  if (operations.length === 0) return 'empty';

  const rows: Array<{ cols: string[]; type?: 'default' | 'gap' }> = [
    { cols: ['time', ''] },
  ];
  let previousTime: number | undefined;

  for (const operation of operations) {
    if (
      previousTime !== undefined &&
      operation.time - previousTime > TIMELINE_GAP_THRESHOLD_MS
    ) {
      rows.push({ cols: ['', ''], type: 'gap' });
    }

    const [firstLine = '', ...extraLines] = operation.label.split('\n');
    rows.push({
      cols: [formatRelativeTime(operation.time, previousTime), firstLine],
    });
    for (const extraLine of extraLines) {
      rows.push({ cols: ['', extraLine] });
    }
    previousTime = operation.time;
  }

  if (options.showEndMarker) {
    const endTime = Math.max(
      ...operations.map((operation) => operation.endTime),
    );

    if (
      previousTime !== undefined &&
      endTime - previousTime > TIMELINE_GAP_THRESHOLD_MS
    ) {
      rows.push({ cols: ['', ''], type: 'gap' });
    }

    rows.push({ cols: [formatTimeMs(endTime), 'end'] });
  }

  return formatTableString(rows);
}

function getTimelineString(
  operations: TimelineLabel[],
  options: { showEndMarker: boolean },
): string {
  if (operations.length === 0) return 'empty';

  return ['\n', formatTimelineTable(operations, options), '\n'].join('');
}

function getOpfsPersistentStorageOperationTimelineString(
  operations: TimelineLabel[],
): string {
  return getTimelineString(operations, { showEndMarker: true });
}

function formatWrappedOpfsOperationLabel(
  prefix: string,
  id: number | undefined,
  value: string,
  detail?: string,
): string {
  const mainLine = formatWrappedOperationMainLine(prefix, id, value);
  if (detail === undefined) return mainLine;

  const fullLine = `${mainLine} ${detail}`;
  return fullLine.length > PERSISTENT_TIMELINE_WRAP_AT
    ? `${mainLine}\n${PERSISTENT_TIMELINE_DETAIL_PREFIX}${detail}`
    : fullLine;
}

function formatOpfsOperationPath(path: string): string {
  return stripOpfsRootPrefix(path);
}

function stripOpfsRootPrefix(path: string): string {
  return path.replace(LEADING_SLASHES_REGEX, '');
}

function describeOpfsDirectoryPath(path: string): string {
  const pathSegments = stripOpfsRootPrefix(path)
    .split('/')
    .filter((segment) => segment.length > 0);

  switch (pathSegments.length) {
    case 1:
      return 'root directory';
    case 2:
      return 'session directory';
    case 3:
      return 'store directory';
    default:
      return 'scope directory';
  }
}

function describeOpfsInternalRecord(key: string): string {
  switch (key) {
    case ASYNC_NAMESPACE_INDEX_RECORD_KEY:
      return 'namespace index';
    case 'maintenance':
      return 'global maintenance';
    case 'registry':
      return 'internal registry';
    default:
      return 'internal record';
  }
}

function formatGlobalRecordKey(key: string): string {
  const kindLabel = 'entry data';
  return key.includes('._o_.p')
    ? `${key} (protected registry ${kindLabel})`
    : `${key} (${kindLabel})`;
}

function isPlainDocumentLogicalKey(
  scope: AsyncStorageNamespaceScope,
  logicalKey: string,
): boolean {
  return (
    scope.kind === 'document' &&
    logicalKey === `tsdf.${scope.sessionKey}.${scope.storeName}`
  );
}

function formatScopedRecordKeyLabel(
  scope: AsyncStorageNamespaceScope,
  recordKey: string,
): { description: string; userKey: string } | null {
  const parsedRecordKey = parseRecordKey(recordKey);
  if (parsedRecordKey.recordKind === 'raw') return null;

  const labelKind = getStorageEntryLabelKind(scope.kind);
  if (labelKind === null) return null;

  return {
    description: formatStorageEntryDescription(
      parsedRecordKey.userKey,
      labelKind,
    ),
    userKey: parsedRecordKey.userKey,
  };
}

function formatRecordLabel(
  record: {
    key: string;
    logicalKey: string | null;
    recordKind: 'payload' | 'internal';
  },
  scope: AsyncStorageNamespaceScope | null,
): string {
  if (
    scope !== null &&
    record.logicalKey !== null &&
    isPlainDocumentLogicalKey(scope, record.logicalKey)
  ) {
    return record.recordKind === 'payload' ? 'entry data' : 'internal';
  }

  if (scope !== null) {
    if (record.recordKind === 'payload') {
      const labelKind = getStorageEntryLabelKind(scope.kind);
      if (labelKind !== null) {
        const scopedRecordLabel = formatScopedRecordKeyLabel(scope, record.key);
        return scopedRecordLabel?.description ?? getPayloadDataLabel(labelKind);
      }
    }

    if (
      record.recordKind === 'internal' &&
      record.key === ASYNC_NAMESPACE_INDEX_RECORD_KEY
    ) {
      return getNamespaceIndexLabel(getStorageEntryLabelKind(scope.kind));
    }

    const scopedRecordLabel = formatScopedRecordKeyLabel(scope, record.key);
    if (scopedRecordLabel !== null) {
      return scopedRecordLabel.description;
    }
  }

  if (record.recordKind === 'payload' && record.logicalKey !== null) {
    return formatGlobalRecordKey(record.logicalKey);
  }

  return describeOpfsInternalRecord(record.key);
}

function formatOpfsFileDescription(operation: MockOpfsOperation): string {
  if ('record' in operation) {
    return formatRecordLabel(operation.record, operation.scope);
  }

  const pathSegments = operation.path.split('/');
  if (pathSegments[0] !== 'tsdf') return 'untracked file';
  if (pathSegments.length === 2) return 'untracked root file';
  if (pathSegments.length === 3) return 'untracked session file';
  if (pathSegments.length === 4) return 'untracked store file';
  return 'untracked file';
}

function formatOpfsOperationLabel(
  operation: MockOpfsOperation,
  pathIdMap: Map<string, number>,
  warning?: string,
): string {
  const pathId =
    operation.type === 'openFile' ||
    operation.type === 'ensureFile' ||
    operation.type === 'readFile' ||
    operation.type === 'writeFile' ||
    operation.type === 'writeFileFailed' ||
    operation.type === 'deleteFile'
      ? pathIdMap.get(stripOpfsRootPrefix(operation.path))
      : undefined;

  switch (operation.type) {
    case 'openDir':
      return formatWrappedOpfsOperationLabel(
        `📂 dir-open ${operation.exists ? '✅' : '❌'}`,
        undefined,
        formatOpfsOperationPath(operation.path),
        appendTimelineWarning(
          `(${describeOpfsDirectoryPath(operation.path)})`,
          warning,
        ),
      );
    case 'ensureDir':
      return formatWrappedOpfsOperationLabel(
        `📁 dir-open-or-create ${operation.created ? '🆕' : '✅'}`,
        undefined,
        formatOpfsOperationPath(operation.path),
        appendTimelineWarning(
          `(${describeOpfsDirectoryPath(operation.path)})`,
          warning,
        ),
      );
    case 'openFile':
      return formatWrappedOpfsOperationLabel(
        `👁️ file-open ${operation.exists ? '✅' : '❌'}`,
        pathId,
        formatOpfsOperationPath(operation.path),
        appendTimelineWarning(
          `(${formatOpfsFileDescription(operation)})`,
          warning,
        ),
      );
    case 'ensureFile':
      return formatWrappedOpfsOperationLabel(
        `👁️ file-open-or-create ${operation.created ? '🆕' : '✅'}`,
        pathId,
        formatOpfsOperationPath(operation.path),
        appendTimelineWarning(
          `(${formatOpfsFileDescription(operation)})`,
          warning,
        ),
      );
    case 'readFile':
      return formatWrappedOpfsOperationLabel(
        '📖',
        pathId,
        formatOpfsOperationPath(operation.path),
        appendTimelineWarning(
          `(${formatOpfsFileDescription(operation)}) | ${formatByteSize(
            operation.valueByteSize,
          )}`,
          warning,
        ),
      );
    case 'writeFile':
      return formatWrappedOpfsOperationLabel(
        '✍️',
        pathId,
        formatOpfsOperationPath(operation.path),
        appendTimelineWarning(
          `(${formatOpfsFileDescription(operation)}) | ${formatByteSize(
            operation.valueByteSizeBefore,
          )} -> ${formatByteSize(operation.valueByteSizeAfter)}${
            operation.valueChanged ? '' : ' ⚠️ UNCHANGED'
          }`,
          warning,
        ),
      );
    case 'writeFileFailed':
      return formatWrappedOpfsOperationLabel(
        `✍️ ❌ retryable-${operation.phase}`,
        pathId,
        formatOpfsOperationPath(operation.path),
        `(${formatOpfsFileDescription(operation)}) | ${operation.errorName}`,
      );
    case 'deleteFile':
      return formatWrappedOpfsOperationLabel(
        `🗑️ ${operation.exists ? '✅' : '❌'}`,
        pathId,
        formatOpfsOperationPath(operation.path),
        `(${formatOpfsFileDescription(operation)})`,
      );
    case 'listDir':
      return formatWrappedOpfsOperationLabel(
        `🗂️ list-dir-${operation.method}`,
        undefined,
        formatOpfsOperationPath(operation.path),
        `(${describeOpfsDirectoryPath(operation.path)}) entries=${JSON.stringify(
          operation.entries,
        )}`,
      );
    case 'deleteDir':
      return formatWrappedOpfsOperationLabel(
        `🧹 del-dir${operation.recursive ? ' recursive' : ''} ${operation.deleted ? '✅' : '❌'}`,
        undefined,
        formatOpfsOperationPath(operation.path),
        `(${describeOpfsDirectoryPath(operation.path)})`,
      );
  }
}

export type OpfsPersistentStorageOperationCaptureResult = {
  operations: string[];
  timelineString: string;
};

function buildOpfsOperationCaptureResult(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  captureStartedAt: number,
): OpfsPersistentStorageOperationCaptureResult {
  const verboseTimelineEntries: Array<{
    endTime: number;
    operation: MockOpfsOperation;
    openedHandle: boolean;
    openKey: string | null;
    readSnapshot: ReadTimelineSnapshot | null;
    time: number;
    writeSnapshot: WriteTimelineSnapshot | null;
  }> = [];
  const pathIdMap = new Map<string, number>();
  let nextPathId = 1;

  for (const operation of mockAdapter.operations) {
    const pathKey =
      operation.type === 'openFile' ||
      operation.type === 'ensureFile' ||
      operation.type === 'readFile' ||
      operation.type === 'writeFile' ||
      operation.type === 'writeFileFailed' ||
      operation.type === 'deleteFile'
        ? stripOpfsRootPrefix(operation.path)
        : null;

    if (pathKey !== null && !pathIdMap.has(pathKey)) {
      pathIdMap.set(pathKey, nextPathId++);
    }

    verboseTimelineEntries.push({
      endTime: Math.max(0, operation.time - captureStartedAt),
      openedHandle:
        operation.type === 'ensureDir' ||
        operation.type === 'ensureFile' ||
        ((operation.type === 'openDir' || operation.type === 'openFile') &&
          operation.exists),
      openKey:
        operation.type === 'openDir' || operation.type === 'ensureDir'
          ? `dir:${stripOpfsRootPrefix(operation.path)}`
          : operation.type === 'openFile' || operation.type === 'ensureFile'
            ? `file:${stripOpfsRootPrefix(operation.path)}`
            : null,
      operation,
      readSnapshot:
        operation.type === 'readFile'
          ? {
              rawValue: operation.readRaw,
              target: stripOpfsRootPrefix(operation.path),
              time: Math.max(0, operation.startedTime - captureStartedAt),
            }
          : null,
      time: Math.max(0, operation.startedTime - captureStartedAt),
      writeSnapshot:
        operation.type === 'writeFile'
          ? {
              rawValueAfter: operation.writeRaw,
              target: stripOpfsRootPrefix(operation.path),
              time: Math.max(0, operation.startedTime - captureStartedAt),
              valueChanged: operation.valueChanged,
            }
          : null,
    });
  }

  const sortedVerboseTimelineEntries = sortTimedEntries(verboseTimelineEntries);
  const timelineEntries: TimelineLabel[] = [];
  const seenOpenKeys = new Set<string>();
  let readWindow: ReadTimelineSnapshot[] = [];
  let writeWindow: WriteTimelineSnapshot[] = [];

  for (const entry of sortedVerboseTimelineEntries) {
    const warning =
      entry.openKey !== null && entry.openedHandle
        ? seenOpenKeys.has(entry.openKey)
          ? DUPLICATE_OPEN_WARNING
          : undefined
        : entry.operation.type === 'readFile'
          ? getRepeatedReadWarning(readWindow, entry.readSnapshot)
          : entry.operation.type === 'writeFile'
            ? getDuplicateWriteWarning(writeWindow, entry.writeSnapshot)
            : undefined;

    timelineEntries.push({
      endTime: entry.endTime,
      label: formatOpfsOperationLabel(entry.operation, pathIdMap, warning),
      time: entry.time,
    });

    if (entry.openKey !== null && entry.openedHandle) {
      seenOpenKeys.add(entry.openKey);
    }
    if (entry.readSnapshot !== null) {
      readWindow = [
        ...getSnapshotsInWindow(readWindow, entry.readSnapshot.time),
        entry.readSnapshot,
      ];
    }
    if (entry.writeSnapshot !== null) {
      writeWindow = [
        ...getSnapshotsInWindow(writeWindow, entry.writeSnapshot.time),
        entry.writeSnapshot,
      ];
    }
  }

  const operations = timelineEntries.map((entry) => entry.label);
  const timelineString =
    getOpfsPersistentStorageOperationTimelineString(timelineEntries);

  return { operations, timelineString };
}

export function startOpfsPersistentStorageOperationCapture(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
): { finish: () => OpfsPersistentStorageOperationCaptureResult } {
  mockAdapter.clearInstrumentation();
  const captureStartedAt = mockAdapter.mockBrowserOpfs.getElapsedTime();

  return {
    finish() {
      return buildOpfsOperationCaptureResult(mockAdapter, captureStartedAt);
    },
  };
}
