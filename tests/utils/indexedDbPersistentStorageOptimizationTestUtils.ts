import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  encodePersistedAsyncNamespaceKind,
  getPersistedNamespaceId,
  parseAsyncStorageRecordKey,
} from '../../src/persistentStorage/asyncStorageShared';
import { type IndexedDbPersistentStorageOperation } from '../../src/persistentStorage/indexedDbAsyncStorageAdapter';
import type {
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
} from '../../src/persistentStorage/types';
import { parseAsyncStorageNamespaceKind } from '../../src/persistentStorage/types';
import {
  type IndexedDbPersistentStorageTestStore,
  type ManagedMetadataRecord,
  getCurrentIndexedDbPersistentStorageTestStore,
  serializeManagedMetadataRecord,
  serializeTestStaticPolicy,
} from './indexedDbPersistentStorageTestStore';
import {
  getParsedLocalStorageValue as baseGetParsedLocalStorageValue,
  startPersistentStorageOperationCapture as baseStartPersistentStorageOperationCapture,
} from './persistentStorageOptimizationTestUtils';

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

  if (typeof value === 'object') {
    return `JSON object | ${formatCompactByteSize(
      getApproximateValueSize(value) ?? 0,
    )}`;
  }

  return Object.prototype.toString.call(value);
}

function compareUnknownValues(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
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

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
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
    rows: Array<{ key: unknown; value: unknown }>;
  }>;
  version: number;
};

export async function getIndexedDbStructureSnapshot(
  mockAdapter: IndexedDbPersistentStorageTestStore,
): Promise<IndexedDbStructureSnapshot> {
  await flushIndexedDbWrites(mockAdapter);
  const rawStructure = await mockAdapter.indexedDb.inspectStructure();

  return {
    stores: rawStructure.stores
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((store) => ({
        autoIncrement: store.autoIncrement,
        indexes: store.indexes
          .slice()
          .sort((left, right) => left.name.localeCompare(right.name)),
        keyPath: store.keyPath,
        name: store.name,
        rowCount: store.rows.length,
        rows: store.rows
          .slice()
          .sort((left, right) => compareUnknownValues(left.key, right.key))
          .map((row) => ({
            key: row.key,
            value: summarizeIndexedDbValue(row.value),
          })),
      })),
    version: rawStructure.version,
  };
}

type IndexedDbRowReference = { key: unknown; storeName: string };

export async function getParsedIndexedDbRecordData<T = unknown>(
  mockAdapterOrReference:
    | IndexedDbPersistentStorageTestStore
    | IndexedDbRowReference,
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
  const normalizedReference =
    reference.storeName === 'entries' &&
    Array.isArray(reference.key) &&
    reference.key.length === 4 &&
    typeof reference.key[0] === 'string' &&
    typeof reference.key[1] === 'string' &&
    typeof reference.key[2] === 'string' &&
    typeof reference.key[3] === 'string' &&
    parseAsyncStorageNamespaceKind(reference.key[2]) !== null
      ? {
          ...reference,
          key: [
            getPersistedNamespaceId({
              kind: parseAsyncStorageNamespaceKind(reference.key[2])!,
              sessionKey: reference.key[0],
              storeName: reference.key[1],
            }),
            reference.key[3],
          ],
        }
      : reference.storeName === 'namespacePolicies' &&
          Array.isArray(reference.key) &&
          reference.key.length === 3 &&
          typeof reference.key[0] === 'string' &&
          typeof reference.key[1] === 'string' &&
          typeof reference.key[2] === 'string' &&
          parseAsyncStorageNamespaceKind(reference.key[2]) !== null
        ? {
            ...reference,
            key: [
              reference.key[0],
              reference.key[1],
              encodePersistedAsyncNamespaceKind(
                parseAsyncStorageNamespaceKind(reference.key[2])!,
              ),
            ],
          }
        : reference;

  await flushIndexedDbWrites(mockAdapter);
  const row = await mockAdapter.indexedDb.getRow(
    normalizedReference.storeName,
    normalizedReference.key,
  );

  return __LEGIT_CAST__<T | null, unknown>(row === null ? null : row);
}

function toManagedMetadataRecord(value: unknown): ManagedMetadataRecord | null {
  const record = getObjectRecord(value);
  if (
    record === null ||
    typeof record.a !== 'number' ||
    ('v' in record && record.v !== undefined && typeof record.v !== 'number')
  ) {
    return null;
  }

  const customMetadata: Record<string, unknown> = {
    ...(getObjectRecord(record.m) ?? {}),
    ...(typeof record.g === 'string' ? { g: record.g } : {}),
    ...(record.o === 1 ? { o: true } : {}),
    ...('p' in record ? { p: record.p } : {}),
  };

  return {
    customMetadata,
    key: '',
    lastAccessAt: record.a,
    version: typeof record.v === 'number' ? record.v : 1,
    writtenAt: record.a,
  };
}

export async function getIndexedDbNamespaceSnapshot(
  mockAdapter: IndexedDbPersistentStorageTestStore,
  scope: AsyncStorageNamespaceScope,
): Promise<{
  entries: Record<string, Record<string, unknown>>;
  staticPolicy?: Record<string, unknown>;
} | null> {
  await flushIndexedDbWrites(mockAdapter);
  const [entryRows, namespacePolicy] = await Promise.all([
    mockAdapter.indexedDb.listRows('entries'),
    mockAdapter.indexedDb.getRow('namespacePolicies', [
      scope.sessionKey,
      scope.storeName,
      encodePersistedAsyncNamespaceKind(scope.kind),
    ]),
  ]);

  const serializedEntries: Array<[string, Record<string, unknown>]> = entryRows
    .filter(
      (row) =>
        Array.isArray(row.key) && row.key[0] === getPersistedNamespaceId(scope),
    )
    .flatMap((row) => {
      const metadata = toManagedMetadataRecord(row.value);
      const entryKey =
        Array.isArray(row.key) && typeof row.key[1] === 'string'
          ? row.key[1]
          : null;
      return metadata === null || entryKey === null
        ? []
        : ([
            [
              entryKey,
              serializeManagedMetadataRecord({ ...metadata, key: entryKey }),
            ],
          ] satisfies Array<[string, Record<string, unknown>]>);
    })
    .sort(([left], [right]) => left.localeCompare(right));

  const entries = Object.fromEntries(serializedEntries);

  const policyRecord = getObjectRecord(namespacePolicy);
  const serializedPolicy = serializeTestStaticPolicy(
    policyRecord?.p === null
      ? null
      : __LEGIT_CAST__<
          AsyncStorageNamespaceStaticPolicy | null | undefined,
          unknown
        >(policyRecord?.p),
  );

  if (Object.keys(entries).length === 0 && serializedPolicy === null) {
    return null;
  }

  return {
    entries,
    ...(serializedPolicy === null ? {} : { staticPolicy: serializedPolicy }),
  };
}

export async function getIndexedDbPayloadSnapshot<T = unknown>(
  mockAdapter: IndexedDbPersistentStorageTestStore,
  args: { key: string; scope: AsyncStorageNamespaceScope },
): Promise<T | null> {
  const row = await getParsedIndexedDbRecordData<Record<string, unknown>>(
    mockAdapter,
    {
      key: [getPersistedNamespaceId(args.scope), args.key],
      storeName: 'entries',
    },
  );

  return __LEGIT_CAST__<T | null, unknown>(row?.d ?? null);
}

type IndexedDbPersistentStorageOperationCaptureResult = {
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
        .map((operation, index) => ({ index, operation }))
        .sort(
          (left, right) =>
            left.operation.time - right.operation.time ||
            left.index - right.index,
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

export function getParsedLocalStorageValue<T = unknown>(key: string): T | null {
  return baseGetParsedLocalStorageValue(key);
}

export function startPersistentStorageOperationCapture() {
  return baseStartPersistentStorageOperationCapture();
}
