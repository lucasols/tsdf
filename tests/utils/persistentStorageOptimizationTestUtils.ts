import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';
import { ASYNC_MAINTENANCE_LOCAL_STORAGE_KEY } from '../../src/persistentStorage/asyncStorageAdapter';
import type { AsyncStorageNamespaceScope } from '../../src/persistentStorage/types';
import {
  createOpfsPersistentStorageTestStore,
  type MockOpfsOperation,
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

function describePersistentStorageKey(key: string): string | null {
  const specialKeyDescription = MANAGED_PERSISTENT_SPECIAL_KEYS[key];
  if (specialKeyDescription !== undefined) return specialKeyDescription;

  const managedPrefix = MANAGED_PERSISTENT_PREFIXES.find((prefix) =>
    key.startsWith(prefix),
  );
  if (managedPrefix === undefined) {
    return key.startsWith('tsdf.')
      ? withOfflinePrefix(
          describeEntryKind(key),
          describeOfflineStorageType(key),
        )
      : null;
  }

  const identity = key.slice(managedPrefix.length);
  if (identity.endsWith('.m') || identity.endsWith('.manifest')) {
    return withOfflinePrefix(
      `root, ${describeRootKind(identity)}, manifest`,
      describeOfflineStorageType(identity),
    );
  }

  const manifestMarkerIndex = identity.indexOf(MANIFEST_PART);
  if (manifestMarkerIndex >= 0) {
    const rootIdentity = identity.slice(0, manifestMarkerIndex);
    const shardIndex = identity.slice(
      manifestMarkerIndex + MANIFEST_PART.length,
    );
    return withOfflinePrefix(
      `root, ${describeRootKind(rootIdentity)}, manifest shard ${
        shardIndex || '?'
      }`,
      describeOfflineStorageType(rootIdentity),
    );
  }

  return withOfflinePrefix(
    `root, ${describeRootKind(identity)}`,
    describeOfflineStorageType(identity),
  );
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

function formatPersistentStorageKey(
  key: string | null,
  keyId: number | undefined,
): string {
  if (typeof key !== 'string') return '<non-string>';

  const idPrefix = keyId !== undefined ? `#${keyId} ` : '';
  const description = describePersistentStorageKey(key);
  if (description === null) return `${idPrefix}${key}`;

  return `${idPrefix}${key} (${description})`;
}

function formatByteSize(byteSize: number): string {
  return `${(byteSize / 1024).toFixed(2)} kb`;
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
      valueByteSize: number | null;
    }
  | {
      time: number;
      type: 'setItem';
      existsBefore: boolean;
      valueChanged: boolean;
      key: string;
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

function formatPersistentStorageOperation(
  operation: PersistentStorageOperation,
  keyIdMap: Map<string, number>,
): string {
  const key = getOperationKey(operation);
  const keyId = key !== null ? keyIdMap.get(key) : undefined;

  switch (operation.type) {
    case 'getItem': {
      const base = `📖 ${operation.exists ? '✅' : '❌'} ${formatPersistentStorageKey(operation.key, keyId)}`;
      if (operation.valueByteSize !== null) {
        return `${base} | ${formatByteSize(operation.valueByteSize)}`;
      }
      return base;
    }
    case 'setItem': {
      const unchangedFlag = !operation.valueChanged ? ' ⚠️ UNCHANGED' : '';
      const base = `✍️ ${operation.existsBefore ? '✅' : '❌'}->✅ ${formatPersistentStorageKey(operation.key, keyId)}`;
      const before =
        operation.valueByteSizeBefore !== null
          ? formatByteSize(operation.valueByteSizeBefore)
          : '❌';
      return `${base} | ${before} -> ${formatByteSize(operation.valueByteSizeAfter)}${unchangedFlag}`;
    }
    case 'removeItem':
      return `🗑️ ${operation.existsBefore ? '✅' : '❌'}->❌ ${formatPersistentStorageKey(operation.key, keyId)}`;
    case 'key':
      return `🔑[${operation.index}] ${operation.key === null ? '❌' : '✅'} ${formatPersistentStorageKey(operation.key, keyId)}`;
    case 'clear':
      return '🧹';
  }
}

function formatTableString(rows: Array<{ cols: string[] }>): string {
  if (rows.length === 0) return '';

  const colWidths: number[] = [];
  for (const { cols } of rows) {
    for (const [index, col] of cols.entries()) {
      colWidths[index] = Math.max(colWidths[index] ?? 0, col.length);
    }
  }

  return rows
    .map(({ cols }) =>
      cols
        .map((col, index) => col.padEnd(colWidths[index] ?? 0))
        .join(' | ')
        .trimEnd(),
    )
    .join('\n');
}

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

  const rows: Array<{ cols: string[] }> = [{ cols: ['time', ''] }];
  let previousTime: number | undefined;

  for (const operation of operations) {
    rows.push({
      cols: [
        formatRelativeTime(operation.time, previousTime),
        formatPersistentStorageOperation(operation, keyIdMap),
      ],
    });
    previousTime = operation.time;
  }

  return ['\n', formatTableString(rows), '\n'].join('');
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

  return __LEGIT_CAST__<T | null, unknown>(safeJsonParse(value));
}

export function getParsedOpfsEntryFiles(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  key: string,
): { metadata: unknown; payload: unknown } | null {
  return mockAdapter.readEntryFiles(key);
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

function stripScopePrefix(
  storeName: string,
  sessionKey: string,
  key: string,
): string {
  const documentKey = `tsdf.${sessionKey}.${storeName}`;
  if (key === documentKey) return storeName;

  const prefix = `${documentKey}.`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

type TimedLabel = { endTime: number; label: string; time: number };

function sortTimedLabels(operations: readonly TimedLabel[]): TimedLabel[] {
  return operations
    .map((operation, index) => ({ ...operation, index }))
    .sort((left, right) => {
      if (left.time !== right.time) return left.time - right.time;
      return left.index - right.index;
    })
    .map(({ endTime, time, label }) => ({ endTime, time, label }));
}

function formatTimedLabelTable(operations: TimedLabel[]): string {
  if (operations.length === 0) return 'empty';

  const rows: Array<{ cols: string[] }> = [{ cols: ['time', ''] }];
  let previousTime: number | undefined;

  for (const operation of operations) {
    const [firstLine = '', ...extraLines] = operation.label.split('\n');
    rows.push({
      cols: [formatRelativeTime(operation.time, previousTime), firstLine],
    });
    for (const extraLine of extraLines) {
      rows.push({ cols: ['', extraLine] });
    }
    previousTime = operation.time;
  }

  rows.push({
    cols: [
      formatTimeMs(
        Math.max(...operations.map((operation) => operation.endTime)),
      ),
      'end',
    ],
  });

  return formatTableString(rows);
}

function getOpfsPersistentStorageOperationTimelineString(
  operations: TimedLabel[],
): string {
  if (operations.length === 0) return 'empty';

  return ['\n', formatTimedLabelTable(operations), '\n'].join('');
}

const OPFS_TIMELINE_WRAP_AT = 80;
const OPFS_TIMELINE_DETAIL_PREFIX = '   └ ';

function formatWrappedOpfsOperationLabel(
  prefix: string,
  path: string,
  detail?: string,
): string {
  const normalizedPath = stripOpfsRootPrefix(path);
  const mainLine = `${prefix} ${normalizedPath}`;
  if (detail === undefined) return mainLine;

  const fullLine = `${mainLine} ${detail}`;
  return fullLine.length > OPFS_TIMELINE_WRAP_AT
    ? `${mainLine}\n${OPFS_TIMELINE_DETAIL_PREFIX}${detail}`
    : fullLine;
}

function formatOpfsPath(scope: {
  sessionKey: string;
  storeName: string;
  kind: string;
}): string {
  return `${scope.sessionKey}/${scope.storeName}/${scope.kind}`;
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
    case 'maintenance':
      return 'global maintenance';
    case 'registry':
      return 'internal registry';
    default:
      return 'internal record';
  }
}

function formatGlobalRecordKey(
  key: string,
  kind: 'payload' | 'metadata',
): string {
  return key.includes('._o_.p')
    ? `${key} (protected registry ${kind})`
    : `${key} (${kind})`;
}

export type PersistentStorageReadBreakdown = {
  metadataReads: string[];
  scopedPayloadReads: string[];
  externalPayloadReads: string[];
  payloadBatchReads: string[][];
  metadataBatchReads: string[][];
  listKeyScans: string[];
};

function createEmptyPersistentStorageReadBreakdown(): PersistentStorageReadBreakdown {
  return {
    metadataReads: [],
    scopedPayloadReads: [],
    externalPayloadReads: [],
    payloadBatchReads: [],
    metadataBatchReads: [],
    listKeyScans: [],
  };
}

function formatRecordLabel(record: {
  key: string;
  logicalKey: string | null;
  recordKind: 'payload' | 'metadata' | 'internal';
}): string {
  if (record.recordKind === 'payload' && record.logicalKey !== null) {
    return formatGlobalRecordKey(record.logicalKey, 'payload');
  }

  if (record.recordKind === 'metadata' && record.logicalKey !== null) {
    return formatGlobalRecordKey(record.logicalKey, 'metadata');
  }

  return describeOpfsInternalRecord(record.key);
}

function formatOpfsFileDescription(operation: MockOpfsOperation): string {
  if ('record' in operation) {
    return formatRecordLabel(operation.record);
  }

  const pathSegments = operation.path.split('/');
  if (pathSegments[0] !== 'tsdf') return 'untracked file';
  if (pathSegments.length === 2) return 'untracked root file';
  if (pathSegments.length === 3) return 'untracked session file';
  if (pathSegments.length === 4) return 'untracked store file';
  return 'untracked file';
}

function formatOpfsOperationLabel(operation: MockOpfsOperation): string {
  switch (operation.type) {
    case 'openDir':
      return formatWrappedOpfsOperationLabel(
        `📂 dir-open ${operation.exists ? '✅' : '❌'}`,
        operation.path,
        `(${describeOpfsDirectoryPath(operation.path)})`,
      );
    case 'ensureDir':
      return formatWrappedOpfsOperationLabel(
        `📁 dir-open-or-create ${operation.created ? '🆕' : '✅'}`,
        operation.path,
        `(${describeOpfsDirectoryPath(operation.path)})`,
      );
    case 'openFile':
      return formatWrappedOpfsOperationLabel(
        `📄 file-open ${operation.exists ? '✅' : '❌'}`,
        operation.path,
        `(${formatOpfsFileDescription(operation)})`,
      );
    case 'ensureFile':
      return formatWrappedOpfsOperationLabel(
        `📄 file-open-or-create ${operation.created ? '🆕' : '✅'}`,
        operation.path,
        `(${formatOpfsFileDescription(operation)})`,
      );
    case 'readFile':
      return formatWrappedOpfsOperationLabel(
        '📖',
        operation.path,
        `(${formatOpfsFileDescription(operation)}) | ${formatByteSize(
          operation.valueByteSize,
        )}`,
      );
    case 'writeFile':
      return formatWrappedOpfsOperationLabel(
        '✍️',
        operation.path,
        `(${formatOpfsFileDescription(operation)}) | ${formatByteSize(
          operation.valueByteSizeBefore,
        )} -> ${formatByteSize(operation.valueByteSizeAfter)}${
          operation.valueChanged ? '' : ' ⚠️ UNCHANGED'
        }`,
      );
    case 'deleteFile':
      return formatWrappedOpfsOperationLabel(
        `🗑️ ${operation.exists ? '✅' : '❌'}`,
        operation.path,
        `(${formatOpfsFileDescription(operation)})`,
      );
    case 'listDir':
      return formatWrappedOpfsOperationLabel(
        '🗂️ list-dir',
        operation.path,
        `(${describeOpfsDirectoryPath(operation.path)}) entries=${JSON.stringify(
          operation.entries,
        )}`,
      );
    case 'deleteDir':
      return formatWrappedOpfsOperationLabel(
        `🧹 del-dir ${operation.deleted ? '✅' : '❌'}`,
        operation.path,
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
  const verboseTimelineEntries: TimedLabel[] = [];

  for (const operation of mockAdapter.operations) {
    verboseTimelineEntries.push({
      endTime: Math.max(0, operation.time - captureStartedAt),
      time: Math.max(0, operation.startedTime - captureStartedAt),
      label: formatOpfsOperationLabel(operation),
    });
  }

  const sortedVerboseTimelineEntries = sortTimedLabels(verboseTimelineEntries);
  const operations = sortedVerboseTimelineEntries.map((entry) => entry.label);
  const timelineString = getOpfsPersistentStorageOperationTimelineString(
    sortedVerboseTimelineEntries,
  );

  return { operations, timelineString };
}

type OpfsCaptureArgs = { storeName: string; sessionKey: string };

function buildScopedOpfsReadBreakdown(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  args: OpfsCaptureArgs,
): PersistentStorageReadBreakdown {
  const scopedPrefix = `tsdf.${args.sessionKey}.${args.storeName}.`;
  const protectedRegistryKey = `tsdf.${args.sessionKey}._o_.p`;

  function formatPayloadKey(key: string): {
    scope: 'scoped' | 'external';
    value: string;
  } {
    if (key === protectedRegistryKey) {
      return {
        scope: 'external',
        value: `${key} (protected registry payload)`,
      };
    }

    if (key === `tsdf.${args.sessionKey}.${args.storeName}`) {
      return { scope: 'scoped', value: 'document payload' };
    }

    if (key.startsWith(scopedPrefix)) {
      return {
        scope: 'scoped',
        value: `${stripScopePrefix(args.storeName, args.sessionKey, key)} (payload)`,
      };
    }

    return { scope: 'external', value: `${key} (payload)` };
  }

  function formatMetadataLogicalKey(key: string): string {
    if (key === protectedRegistryKey) {
      return `${key} (protected registry metadata)`;
    }

    if (key === `tsdf.${args.sessionKey}.${args.storeName}`) {
      return 'document metadata';
    }

    if (key.startsWith(scopedPrefix)) {
      return `${stripScopePrefix(args.storeName, args.sessionKey, key)} (metadata)`;
    }

    return `${key} (metadata)`;
  }

  const payloadReads = mockAdapter.payloadGetRequests.map(formatPayloadKey);
  const metadataReads = mockAdapter.operations.flatMap((operation) =>
    operation.type === 'readFile' &&
    'record' in operation &&
    operation.record.recordKind === 'metadata' &&
    operation.record.logicalKey !== null
      ? [formatMetadataLogicalKey(operation.record.logicalKey)]
      : [],
  );
  const metadataBatchReads: string[][] = [];
  let currentMetadataBatch: string[] = [];

  for (const operation of mockAdapter.operations) {
    if (
      operation.type === 'readFile' &&
      'record' in operation &&
      operation.record.recordKind === 'metadata' &&
      operation.record.logicalKey !== null
    ) {
      currentMetadataBatch.push(
        formatMetadataLogicalKey(operation.record.logicalKey),
      );
      continue;
    }

    if (currentMetadataBatch.length > 0) {
      metadataBatchReads.push(currentMetadataBatch);
      currentMetadataBatch = [];
    }
  }

  if (currentMetadataBatch.length > 0) {
    metadataBatchReads.push(currentMetadataBatch);
  }

  return {
    metadataReads,
    scopedPayloadReads: payloadReads
      .filter((entry) => entry.scope === 'scoped')
      .map((entry) => entry.value),
    externalPayloadReads: payloadReads
      .filter((entry) => entry.scope === 'external')
      .map((entry) => entry.value),
    payloadBatchReads: mockAdapter.payloadGetManyRequests.map((keys) =>
      keys.map((key) => formatPayloadKey(key).value),
    ),
    metadataBatchReads,
    listKeyScans: mockAdapter.listKeysRequests.map((scope) =>
      formatOpfsPath(scope),
    ),
  };
}

export type PersistentStorageOperationSummary =
  OpfsPersistentStorageOperationCaptureResult & {
    breakdown: PersistentStorageReadBreakdown;
  };

export function startOpfsPersistentStorageOperationCapture(
  mockAdapter: ReturnType<typeof createOpfsPersistentStorageTestStore>,
  args?: OpfsCaptureArgs,
): { finish: () => PersistentStorageOperationSummary } {
  mockAdapter.clearInstrumentation();
  const captureStartedAt = mockAdapter.mockBrowserOpfs.getElapsedTime();

  return {
    finish() {
      const summary: PersistentStorageOperationSummary = {
        ...buildOpfsOperationCaptureResult(mockAdapter, captureStartedAt),
        breakdown:
          args === undefined
            ? createEmptyPersistentStorageReadBreakdown()
            : buildScopedOpfsReadBreakdown(mockAdapter, args),
      };

      return summary;
    },
  };
}
