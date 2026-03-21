import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { vi } from 'vitest';
import { createMockOpfsStorageAdapter } from '../mocks/mockOpfsStorageAdapter';

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

export const startPersistentStorageReadCapture =
  startPersistentStorageOperationCapture;

export function getParsedLocalStorageValue<T = unknown>(key: string): T | null {
  const value = localStorage.getItem(key);
  if (value === null) return null;

  return __LEGIT_CAST__<T | null, unknown>(safeJsonParse(value));
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

function getOpfsPersistentStorageOperationTimelineString(
  operations: Array<{ time: number; label: string }>,
): string {
  if (operations.length === 0) return 'empty';

  const rows: Array<{ cols: string[] }> = [{ cols: ['time', ''] }];
  let previousTime: number | undefined;

  for (const operation of operations) {
    rows.push({
      cols: [formatRelativeTime(operation.time, previousTime), operation.label],
    });
    previousTime = operation.time;
  }

  return ['\n', formatTableString(rows), '\n'].join('');
}

function formatOpfsPath(scope: {
  sessionKey: string;
  storeName: string;
  kind: string;
}): string {
  return `${scope.sessionKey}/${scope.storeName}/${scope.kind}`;
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

function formatGlobalPayloadKey(key: string): string {
  return key === 'tsdf.__tsdf_async__._o_.p'
    ? `${key} (protected registry payload)`
    : key.includes('._o_.p')
      ? `${key} (protected registry payload)`
      : `${key} (payload)`;
}

function formatGlobalMetadataKey(key: string): string {
  return key === 'tsdf.__tsdf_async__._o_.p'
    ? `${key} (protected registry metadata)`
    : key.includes('._o_.p')
      ? `${key} (protected registry metadata)`
      : `${key} (metadata)`;
}

export type PersistentStorageReadBreakdown = {
  metadataReads: string[];
  scopedPayloadReads: string[];
  externalPayloadReads: string[];
  payloadBatchReads: string[][];
  metadataBatchReads: string[][];
  listKeyScans: string[];
  legacyFallbackReads: string[];
};

function createEmptyPersistentStorageReadBreakdown(): PersistentStorageReadBreakdown {
  return {
    metadataReads: [],
    scopedPayloadReads: [],
    externalPayloadReads: [],
    payloadBatchReads: [],
    metadataBatchReads: [],
    listKeyScans: [],
    legacyFallbackReads: [],
  };
}

export type OpfsPersistentStorageOperationCaptureResult = {
  operations: string[];
  timelineString: string;
};

function buildOpfsOperationCaptureResult(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
): OpfsPersistentStorageOperationCaptureResult {
  function formatRecord(record: {
    key: string;
    logicalKey: string | null;
    recordKind: 'payload' | 'metadata' | 'internal';
  }): string {
    if (record.recordKind === 'payload' && record.logicalKey !== null) {
      return formatGlobalPayloadKey(record.logicalKey);
    }

    if (record.recordKind === 'metadata' && record.logicalKey !== null) {
      return formatGlobalMetadataKey(record.logicalKey);
    }

    return describeOpfsInternalRecord(record.key);
  }

  function formatScopedRecord(
    scope: { sessionKey: string; storeName: string; kind: string },
    record: {
      key: string;
      logicalKey: string | null;
      recordKind: 'payload' | 'metadata' | 'internal';
    },
  ): string {
    return `${formatOpfsPath(scope)}/${record.key} (${formatRecord(record)})`;
  }

  function formatOperationLabel(
    operation: (typeof mockAdapter.operations)[number],
  ): string {
    switch (operation.type) {
      case 'get':
        return `📖 ${operation.exists ? '✅' : '❌'} ${formatScopedRecord(
          operation.scope,
          operation.record,
        )}`;
      case 'getMany':
        return `📚 ${formatOpfsPath(operation.scope)} hits=${operation.hitCount}/${operation.records.length} ${JSON.stringify(
          operation.records.map((record) =>
            formatScopedRecord(operation.scope, record),
          ),
        )}`;
      case 'set':
        return `✍️ ${formatScopedRecord(operation.scope, operation.record)}`;
      case 'setMany':
        return `✍️ ${formatOpfsPath(operation.scope)} ${JSON.stringify(
          operation.records.map((record) =>
            formatScopedRecord(operation.scope, record),
          ),
        )}`;
      case 'remove':
        return `🗑️ ${formatScopedRecord(operation.scope, operation.record)}`;
      case 'removeMany':
        return `🗑️ ${formatOpfsPath(operation.scope)} ${JSON.stringify(
          operation.records.map((record) =>
            formatScopedRecord(operation.scope, record),
          ),
        )}`;
      case 'listKeys':
        return `🗂️ ${formatOpfsPath(operation.scope)} keys=${JSON.stringify(
          operation.keys,
        )}`;
      case 'clear':
        return `🧹 ${formatOpfsPath(operation.scope)} removes=${JSON.stringify(
          operation.removedKeys,
        )}`;
    }
  }

  const operations = [
    ...mockAdapter.operations.map(formatOperationLabel),
    ...mockAdapter.legacyListKeysFallbackRequests.map(
      (prefix) => `🗂️ legacyListKeys ${prefix}`,
    ),
  ];
  const timelineString = getOpfsPersistentStorageOperationTimelineString([
    ...mockAdapter.operations.map((operation) => ({
      time: operation.time,
      label: formatOperationLabel(operation),
    })),
    ...mockAdapter.legacyListKeysFallbackRequests.map((prefix) => ({
      time: 0,
      label: `🗂️ legacyListKeys ${prefix}`,
    })),
  ]);

  return { operations, timelineString };
}

type OpfsCaptureArgs = { storeName: string; sessionKey: string };

function buildScopedOpfsReadBreakdown(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
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
  const metadataReads = mockAdapter.operations.flatMap((operation) => {
    switch (operation.type) {
      case 'get':
        return operation.record.recordKind === 'metadata' &&
          operation.record.logicalKey !== null
          ? [formatMetadataLogicalKey(operation.record.logicalKey)]
          : [];
      case 'getMany':
        return operation.records.flatMap((record) =>
          record.recordKind === 'metadata' && record.logicalKey !== null
            ? [formatMetadataLogicalKey(record.logicalKey)]
            : [],
        );
      default:
        return [];
    }
  });
  const metadataBatchReads = mockAdapter.operations.flatMap((operation) =>
    operation.type === 'getMany'
      ? [
          operation.records.flatMap((record) =>
            record.recordKind === 'metadata' && record.logicalKey !== null
              ? [formatMetadataLogicalKey(record.logicalKey)]
              : [],
          ),
        ].filter((records) => records.length > 0)
      : [],
  );

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
    listKeyScans: mockAdapter.listKeysRequests.map(
      (scope) => `${scope.sessionKey}/${scope.storeName}/${scope.kind}`,
    ),
    legacyFallbackReads: [...mockAdapter.legacyListKeysFallbackRequests],
  };
}

export type PersistentStorageOperationSummary =
  OpfsPersistentStorageOperationCaptureResult & {
    breakdown: PersistentStorageReadBreakdown;
  };

export function startOpfsPersistentStorageOperationCapture(
  mockAdapter: ReturnType<typeof createMockOpfsStorageAdapter>,
  args?: OpfsCaptureArgs,
): { finish: () => PersistentStorageOperationSummary } {
  mockAdapter.clearInstrumentation();

  return {
    finish() {
      const operationsResult = buildOpfsOperationCaptureResult(mockAdapter);

      const summary: PersistentStorageOperationSummary = {
        ...operationsResult,
        breakdown:
          args === undefined
            ? createEmptyPersistentStorageReadBreakdown()
            : buildScopedOpfsReadBreakdown(mockAdapter, args),
      };

      Object.defineProperty(summary, 'timelineString', {
        value: operationsResult.timelineString,
        enumerable: false,
        configurable: true,
        writable: false,
      });

      return summary;
    },
  };
}
