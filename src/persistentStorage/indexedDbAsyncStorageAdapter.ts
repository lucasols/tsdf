import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject } from '@ls-stack/utils/typeGuards';
import { asPossiblyUndefined } from '@ls-stack/utils/typingFnUtils';
import {
  emitTSDFDebugLog,
  getTSDFDebugTimingMs,
  type TSDFDebugLogger,
} from '../debug';
import {
  type AsyncStorageManagedDriverCapabilities,
  createAsyncStorageAdapter,
  estimateManagedAsyncStorageEntrySizeBytes,
} from './asyncStorageAdapter';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  compareMetadata,
  encodePersistedAsyncNamespaceKind,
  getNamespaceId,
  getPersistedNamespaceId,
  getPayloadRecordKey,
  matchesConditionalRemove,
  normalizeStaticPolicy,
  parsePersistedAsyncNamespaceKind,
  parseAsyncStorageRecordKey,
  serializeProtectedRef,
} from './asyncStorageShared';
import { serializeJsonForStorage } from './persistenceUtils';
import type {
  AsyncStorageAdapter,
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageEntryMetadata,
  AsyncStorageMetadataOrder,
  ManagedAsyncStorageNamespaceCommitArgs,
  AsyncStorageNamespaceGetResult,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
} from './types';

const DEFAULT_INDEXED_DB_NAME = 'tsdf-persistent-storage-compact-alpha-reset';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_ENTRY_STORE = 'entries';
const INDEXED_DB_NAMESPACE_POLICY_STORE = 'namespacePolicies';
const INDEXED_DB_META_STORE = 'meta';
const INDEXED_DB_MAINTENANCE_META_KEY = 'maintenance';
/**
 * How often a pending open request or transaction is checked for progress.
 * It is given up after two consecutive checks without a single IndexedDB
 * event, i.e. after 30s to 45s without progress. Progress is what is
 * measured, not total duration, so a large batch on a slow device is never
 * cut short.
 */
const INDEXED_DB_STALL_CHECK_INTERVAL_MS = 15_000;
/**
 * Errors that say the connection (not the data or the quota) failed: the
 * connection was closed or is closing (`InvalidStateError`), the browser's
 * storage process went away (`UnknownError`, e.g. WebKit's "Connection to
 * Indexed Database server lost"), a transaction was aborted under the
 * operation (`AbortError`), or the operation stalled (`TimeoutError`).
 */
const INDEXED_DB_CONNECTION_ERROR_NAMES = new Set([
  'AbortError',
  'InvalidStateError',
  'TimeoutError',
  'UnknownError',
]);

function isIndexedDbConnectionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    INDEXED_DB_CONNECTION_ERROR_NAMES.has(error.name)
  );
}

/**
 * IndexedDB events delivered to this page's adapters so far. While it keeps
 * growing the browser's storage backend is answering, so an operation that
 * is merely queued behind a long-running one is not mistaken for a stalled
 * one.
 */
let indexedDbEventCount = 0;

/**
 * Gives up on an open request or transaction when IndexedDB stopped
 * answering: some browsers leave operations pending forever, without any
 * event, after a tab was backgrounded.
 */
class IndexedDbStallWatch {
  /** Reject the promises still waiting on the watched operation. */
  readonly rejecters: Array<(error: Error) => void> = [];

  readonly #transaction: IDBTransaction | null;
  #checkedEventCount = indexedDbEventCount;
  #checkedAt = 0;
  #stalledChecks = 0;
  #timer: ReturnType<typeof setTimeout>;

  constructor(transaction: IDBTransaction | null) {
    this.#transaction = transaction;
    this.#timer = setTimeout(this.#check, INDEXED_DB_STALL_CHECK_INTERVAL_MS);
    // Independent of how the operation's own code exits: the watch ends
    // exactly when the browser says the transaction did.
    transaction?.addEventListener('complete', this.stop);
    transaction?.addEventListener('abort', this.stop);
  }

  readonly stop = (): void => {
    clearTimeout(this.#timer);
  };

  readonly #check = (): void => {
    // Only time during which the page was running and visible counts. A
    // hidden tab may have its storage paused, and a check that fires late
    // means the page itself was not running (frozen tab, sleeping device,
    // throttled timers), so IndexedDB had no chance to answer either. An
    // operation is therefore never given up the moment a page resumes.
    const now = Date.now();
    const firedLate =
      this.#checkedAt !== 0 &&
      now - this.#checkedAt > INDEXED_DB_STALL_CHECK_INTERVAL_MS * 1.5;
    if (
      indexedDbEventCount !== this.#checkedEventCount ||
      firedLate ||
      asPossiblyUndefined(globalThis.document)?.visibilityState === 'hidden'
    ) {
      this.#stalledChecks = 0;
    } else {
      this.#stalledChecks += 1;
    }
    this.#checkedEventCount = indexedDbEventCount;
    this.#checkedAt = now;

    if (this.#stalledChecks < 2) {
      this.#timer = setTimeout(this.#check, INDEXED_DB_STALL_CHECK_INTERVAL_MS);
      return;
    }

    try {
      // An aborted transaction can no longer commit behind the retry's back.
      this.#transaction?.abort();
    } catch {
      // Already committing or finished: it cannot take new requests either.
    }

    const error = new Error(
      'IndexedDB operation made no progress; treating the connection as lost.',
    );
    error.name = 'TimeoutError';
    // The events of a stalled operation may never arrive, so its promises are
    // settled here instead of waiting for them.
    for (const reject of this.rejecters) {
      reject(error);
    }
  };
}

type IndexedDbManagedMetadataRecord = {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
};

type IndexedDbManagedIndexState = {
  entries: Map<string, IndexedDbManagedMetadataRecord> | null;
  exists: boolean;
  staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
  valid: boolean;
};

type IndexedDbManagedMetadataFilter = { equals: unknown; key: string };

type IndexedDbTestOperation =
  | {
      order: AsyncStorageMetadataOrder;
      resultKeys: string[];
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'listManagedMetadata';
      usedIndex: 'group' | 'key' | 'lru';
    }
  | {
      keys: string[];
      resultKeys: string[];
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'readManagedEntries';
    }
  | {
      removes: string[];
      scope: AsyncStorageNamespaceScope;
      staticPolicyChanged: boolean;
      time: number;
      touches: string[];
      type: 'applyManagedCommit';
      upserts: string[];
    }
  | {
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'clearManagedNamespace';
    }
  | {
      scopeIds: string[];
      sessionKey?: string;
      time: number;
      type: 'listScopesWithKnownRecordKeys';
    }
  | {
      exists: boolean;
      keyCount: number;
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'readManagedIndexState';
      valid: boolean;
    }
  | {
      keys: string[];
      scope: AsyncStorageNamespaceScope;
      time: number;
      type: 'removeManagedRecords';
    }
  | {
      keyCount: number;
      scope: AsyncStorageNamespaceScope;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
      time: number;
      type: 'persistManagedIndexState';
    }
  | {
      sessionKey: string;
      time: number;
      type: 'readProtectedStorageKeys';
      values: string[];
    }
  | {
      sessionKey: string;
      time: number;
      type: 'syncSessionProtectedKeys';
      values: string[];
    };

type IndexedDbDriverInstrumentation = {
  onApplyManagedCommit?: (
    scope: AsyncStorageNamespaceScope,
    args: ManagedAsyncStorageNamespaceCommitArgs<
      unknown,
      Record<string, unknown>
    >,
  ) => void;
  onClearManagedNamespace?: (scope: AsyncStorageNamespaceScope) => void;
  onPersistNamespaceIndexState?: (
    scope: AsyncStorageNamespaceScope,
    state: {
      entries: Map<string, IndexedDbManagedMetadataRecord>;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
    },
  ) => void;
  onRemoveMany?: (scope: AsyncStorageNamespaceScope, keys: string[]) => void;
  operations: IndexedDbTestOperation[];
  record: (operation: IndexedDbTestOperation) => void;
  reset: () => void;
};

type ScopePrimaryKey = [string, string, string];

function createScopePrimaryKey(
  scope: AsyncStorageNamespaceScope,
): ScopePrimaryKey {
  return [
    scope.sessionKey,
    scope.storeName,
    encodePersistedAsyncNamespaceKind(scope.kind),
  ];
}

type EntryPrimaryKey = [string, string];

function createEntryPrimaryKey(
  scope: AsyncStorageNamespaceScope,
  key: string,
): EntryPrimaryKey {
  return [createScopeId(scope.sessionKey, scope.storeName, scope.kind), key];
}

function createScopeKeyRange(scope: AsyncStorageNamespaceScope): IDBKeyRange {
  return IDBKeyRange.bound(
    createEntryPrimaryKey(scope, ''),
    createEntryPrimaryKey(scope, '\uffff'),
  );
}

function createScopeLastAccessRange(
  scope: AsyncStorageNamespaceScope,
): IDBKeyRange {
  const scopeId = createScopeId(scope.sessionKey, scope.storeName, scope.kind);
  return IDBKeyRange.bound(
    [scopeId, Number.MIN_SAFE_INTEGER],
    [scopeId, Number.MAX_SAFE_INTEGER],
  );
}

function createScopeGroupRange(
  scope: AsyncStorageNamespaceScope,
  group: string,
): IDBKeyRange {
  return IDBKeyRange.only([
    createScopeId(scope.sessionKey, scope.storeName, scope.kind),
    group,
  ]);
}

function createScopeOfflineProtectedRange(
  scope: AsyncStorageNamespaceScope,
): IDBKeyRange {
  return IDBKeyRange.only([
    createScopeId(scope.sessionKey, scope.storeName, scope.kind),
    1,
  ]);
}

function createScopePolicyKey(
  scope: AsyncStorageNamespaceScope,
): ScopePrimaryKey {
  return createScopePrimaryKey(scope);
}

function createScopeId(
  sessionKey: string,
  storeName: string,
  kind: AsyncStorageNamespaceScope['kind'],
): string {
  return getPersistedNamespaceId({ sessionKey, storeName, kind });
}

function getScopeFromPrimaryKey(
  key: unknown,
): AsyncStorageNamespaceScope | null {
  if (!Array.isArray(key) || key.length < 3) return null;

  const [sessionKey, storeName, rawKind] = key;
  if (typeof sessionKey !== 'string' || typeof storeName !== 'string') {
    return null;
  }

  const kind =
    typeof rawKind === 'string'
      ? parsePersistedAsyncNamespaceKind(rawKind)
      : null;
  if (kind === null) return null;

  return { kind, sessionKey, storeName };
}

function getEntryKeyFromPrimaryKey(key: unknown): string | null {
  if (!Array.isArray(key) || key.length < 2) return null;
  return typeof key[1] === 'string' ? key[1] : null;
}

type IndexedDbCustomMetadataFields = {
  extraMetadata?: Record<string, unknown>;
  group?: string;
  offlineProtected?: true;
  payload?: unknown;
};

function splitCustomMetadata(
  customMetadata: Record<string, unknown> | undefined,
): IndexedDbCustomMetadataFields {
  if (customMetadata === undefined) return {};

  const { g, o, p, ...rest } = customMetadata;
  return {
    ...(typeof g === 'string' ? { group: g } : {}),
    ...(o === true ? { offlineProtected: true as const } : {}),
    ...('p' in customMetadata ? { payload: p } : {}),
    ...(Object.keys(rest).length > 0 ? { extraMetadata: rest } : {}),
  };
}

function mergeCustomMetadata(
  fields: IndexedDbCustomMetadataFields,
): Record<string, unknown> | undefined {
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
  g?: string;
  i: string;
  m?: Record<string, unknown>;
  o?: 1;
  p?: unknown;
  v?: number;
  z?: number;
};

function getCustomMetadataFromEntryRecord(
  record: IndexedDbEntryRecord,
): Record<string, unknown> | undefined {
  return mergeCustomMetadata({
    extraMetadata: record.m,
    group: record.g,
    offlineProtected: record.o === 1 ? true : undefined,
    payload: record.p,
  });
}

function toMetadataRecord(
  record: IndexedDbEntryRecord,
): IndexedDbManagedMetadataRecord {
  const customMetadata = getCustomMetadataFromEntryRecord(record);

  return {
    lastAccessAt: record.a,
    ...(typeof record.z === 'number' ? { sizeBytes: record.z } : {}),
    version: record.v ?? 1,
    ...(customMetadata ? { customMetadata } : {}),
  };
}

function toPublicMetadata(
  key: string,
  record: IndexedDbEntryRecord,
): AsyncStorageEntryMetadata<Record<string, unknown>> {
  return {
    customMetadata: getCustomMetadataFromEntryRecord(record) ?? {},
    key,
    lastAccessAt: record.a,
    payloadRef: getPayloadRecordKey(key),
    ...(typeof record.z === 'number' ? { sizeBytes: record.z } : {}),
    version: record.v ?? 1,
    writtenAt: record.a,
  };
}

const INDEXED_DB_ENTRY_RECORD_KEYS = new Set([
  'a',
  'd',
  'g',
  'i',
  'm',
  'o',
  'p',
  'v',
  'z',
]);

const INDEXED_DB_NAMESPACE_POLICY_RECORD_KEYS = new Set(['p', 's']);

function toRecordValue(value: unknown): Record<string, unknown> {
  // WORKAROUND: IndexedDB returns untyped object payloads, and callers only use
  // this after confirming the value is a non-array object.
  return __LEGIT_CAST__<Record<string, unknown>, unknown>(value);
}

function toEntryRecordValue(value: unknown): IndexedDbEntryRecord {
  // WORKAROUND: IndexedDB returns untyped entry rows, and callers only use this
  // after validating the row shape with isValidEntryRecord.
  return __LEGIT_CAST__<IndexedDbEntryRecord, unknown>(value);
}

type IndexedDbPersistedStaticPolicy = { b?: number; k?: string[] };

type IndexedDbNamespacePolicyRecord = {
  p: IndexedDbPersistedStaticPolicy | null;
  s: string;
};

function toNamespacePolicyRecordValue(
  value: unknown,
): IndexedDbNamespacePolicyRecord {
  // WORKAROUND: IndexedDB returns untyped namespace-policy rows, and callers
  // only use this after validating the row shape with isValidNamespacePolicyRecord.
  return __LEGIT_CAST__<IndexedDbNamespacePolicyRecord, unknown>(value);
}

function parseIndexedDbPersistedStaticPolicy(
  value: unknown,
): AsyncStorageNamespaceStaticPolicy | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) return undefined;

  const record = toRecordValue(value);
  if (Object.keys(record).some((key) => key !== 'b' && key !== 'k')) {
    return undefined;
  }

  const rawMaxBytes = record.b;
  if (
    rawMaxBytes !== undefined &&
    (typeof rawMaxBytes !== 'number' ||
      !Number.isInteger(rawMaxBytes) ||
      rawMaxBytes < 0)
  ) {
    return undefined;
  }

  const validatedPinnedKeys =
    record.k === undefined ? undefined : validateStringArray(record.k);
  if (validatedPinnedKeys === null) return undefined;

  return normalizeStaticPolicy({
    ...(typeof record.b === 'number' ? { maxBytes: record.b } : {}),
    ...(validatedPinnedKeys !== undefined
      ? { pinnedKeys: validatedPinnedKeys }
      : {}),
  });
}

function serializeIndexedDbPersistedStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): IndexedDbPersistedStaticPolicy | null {
  const normalizedPolicy = normalizeStaticPolicy(policy);
  if (normalizedPolicy === null) return null;

  return {
    ...(normalizedPolicy.maxBytes !== undefined
      ? { b: normalizedPolicy.maxBytes }
      : {}),
    ...(normalizedPolicy.pinnedKeys !== undefined &&
    normalizedPolicy.pinnedKeys.length > 0
      ? { k: normalizedPolicy.pinnedKeys }
      : {}),
  };
}

function validateStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    result.push(entry);
  }
  return result;
}

function isValidEntryRecord(record: unknown): boolean {
  if (!isObject(record)) return false;
  const recordValue = toRecordValue(record);

  if (
    Object.keys(recordValue).some(
      (key) => !INDEXED_DB_ENTRY_RECORD_KEYS.has(key),
    )
  ) {
    return false;
  }

  return (
    typeof recordValue.i === 'string' &&
    typeof recordValue.a === 'number' &&
    'd' in recordValue &&
    (recordValue.v === undefined || typeof recordValue.v === 'number') &&
    (recordValue.z === undefined || typeof recordValue.z === 'number') &&
    (recordValue.m === undefined || isObject(recordValue.m)) &&
    (recordValue.g === undefined || typeof recordValue.g === 'string') &&
    (recordValue.o === undefined || recordValue.o === 1)
  );
}

function isValidNamespacePolicyRecord(record: unknown): boolean {
  if (!isObject(record)) return false;
  const recordValue = toRecordValue(record);
  if (
    Object.keys(recordValue).some(
      (key) => !INDEXED_DB_NAMESPACE_POLICY_RECORD_KEYS.has(key),
    )
  ) {
    return false;
  }

  if (typeof recordValue.s !== 'string' || !('p' in recordValue)) {
    return false;
  }

  return (
    recordValue.p === null ||
    parseIndexedDbPersistedStaticPolicy(recordValue.p) !== undefined
  );
}

function getStaticPolicyFromScopeRecord(
  record: IndexedDbNamespacePolicyRecord | undefined,
): AsyncStorageNamespaceStaticPolicy | null {
  if (record === undefined) return null;

  return parseIndexedDbPersistedStaticPolicy(record.p) ?? null;
}

function compactEntryValue(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
): Pick<IndexedDbEntryRecord, 'd'> {
  void scope;
  return { d: value };
}

function estimateIndexedDbManagedEntrySizeBytes(args: {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  serializedValue?: string;
  value: unknown;
  version: number;
}): number {
  return estimateManagedAsyncStorageEntrySizeBytes(
    args.serializedValue ?? serializeJsonForStorage(args.value).rawValue,
    args.lastAccessAt,
    args.version,
    args.customMetadata,
  );
}

function expandEntryValue(
  scope: AsyncStorageNamespaceScope,
  record: IndexedDbEntryRecord,
): unknown {
  void scope;
  return record.d;
}

function openRequestAsPromise<T>(
  watch: IndexedDbStallWatch,
  request: IDBRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    watch.rejecters.push(reject);
    request.onsuccess = () => {
      indexedDbEventCount += 1;
      // WORKAROUND: DOM IndexedDB requests expose `result` as `unknown`/`any`;
      // callers choose the expected shape at each read boundary.
      resolve(__LEGIT_CAST__<T, unknown>(request.result));
    };
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(
  transaction: IDBTransaction,
  watch: IndexedDbStallWatch,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    watch.rejecters.push(reject);
    transaction.oncomplete = () => {
      indexedDbEventCount += 1;
      resolve();
    };
    transaction.onerror = (event) =>
      reject(
        transaction.error ??
          // A request the operation did not await failed. Its error is the
          // one that tells a lost connection from a data or quota problem.
          (event.target instanceof IDBRequest ? event.target.error : null) ??
          new Error('IndexedDB transaction failed.'),
      );
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function iterateCursor<T>(
  watch: IndexedDbStallWatch,
  request: IDBRequest<IDBCursorWithValue | null>,
  callback: (cursor: IDBCursorWithValue) => T | Promise<T>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    watch.rejecters.push(reject);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB cursor request failed.'));
    request.onsuccess = async () => {
      indexedDbEventCount += 1;
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

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB deleteDatabase failed.'));
    request.onblocked = () => resolve();
    request.onsuccess = () => resolve();
  });
}

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

type IndexedDbMetaRecord = { k: string; v: unknown };

async function getMaintenanceState(
  database: IDBDatabase,
): Promise<{ lastSuccessfulCleanupAt: number | null }> {
  const transaction = database.transaction(INDEXED_DB_META_STORE, 'readonly');
  const watch = new IndexedDbStallWatch(transaction);
  const store = transaction.objectStore(INDEXED_DB_META_STORE);
  const value = await openRequestAsPromise<IndexedDbMetaRecord | undefined>(
    watch,
    store.get(INDEXED_DB_MAINTENANCE_META_KEY),
  );
  await transactionDone(transaction, watch);

  const recordValue = value?.v;
  if (!isObject(recordValue)) {
    return { lastSuccessfulCleanupAt: null };
  }
  const metadataRecord = toRecordValue(recordValue);
  if (!('lca' in metadataRecord)) {
    return { lastSuccessfulCleanupAt: null };
  }

  const lastSuccessfulCleanupAt = metadataRecord.lca;
  return {
    lastSuccessfulCleanupAt:
      typeof lastSuccessfulCleanupAt === 'number' ||
      lastSuccessfulCleanupAt === null
        ? lastSuccessfulCleanupAt
        : null,
  };
}

async function setMaintenanceState(
  database: IDBDatabase,
  value: { lastSuccessfulCleanupAt: number | null },
): Promise<void> {
  const transaction = database.transaction(INDEXED_DB_META_STORE, 'readwrite');
  const watch = new IndexedDbStallWatch(transaction);
  transaction
    .objectStore(INDEXED_DB_META_STORE)
    .put({
      k: INDEXED_DB_MAINTENANCE_META_KEY,
      v: { lca: value.lastSuccessfulCleanupAt },
    } satisfies IndexedDbMetaRecord);
  await transactionDone(transaction, watch);
}

class IndexedDbAsyncStorageDriver implements AsyncStorageDriver {
  debugLogger?: TSDFDebugLogger;

  readonly __tsdfManagedStorage: Required<
    Pick<
      AsyncStorageManagedDriverCapabilities,
      | 'applyManagedCommit'
      | 'clearManagedNamespace'
      | 'listManagedKeys'
      | 'listManagedMetadata'
      | 'persistNamespaceIndexState'
      | 'readProtectedStorageKeys'
      | 'readManagedEntries'
      | 'readNamespaceIndexState'
      | 'syncSessionProtectedKeys'
    >
  > = {
    applyManagedCommit: this.applyManagedCommit.bind(this),
    clearManagedNamespace: this.clearManagedNamespace.bind(this),
    listManagedKeys: this.listManagedKeys.bind(this),
    listManagedMetadata: this.listManagedMetadata.bind(this),
    persistNamespaceIndexState: this.persistNamespaceIndexState.bind(this),
    readProtectedStorageKeys: this.readProtectedStorageKeys.bind(this),
    readManagedEntries: this.readManagedEntries.bind(this),
    readNamespaceIndexState: this.readNamespaceIndexState.bind(this),
    syncSessionProtectedKeys: this.syncSessionProtectedKeys.bind(this),
  };

  #database: IDBDatabase | null = null;
  #databasePromise: Promise<IDBDatabase> | null = null;
  readonly #instrumentation: IndexedDbDriverInstrumentation | undefined;

  readonly databaseName: string;

  constructor(
    databaseName: string = DEFAULT_INDEXED_DB_NAME,
    instrumentation: IndexedDbDriverInstrumentation | undefined = undefined,
  ) {
    this.databaseName = databaseName;
    this.#instrumentation = instrumentation;
  }

  async get(scope: AsyncStorageNamespaceScope, key: string): Promise<unknown> {
    const parsedKey = parseAsyncStorageRecordKey(key);
    if (parsedKey.recordKind === 'payload') {
      const entry = await this.#getEntry(scope, parsedKey.userKey);
      return entry === null ? null : expandEntryValue(scope, entry);
    }

    if (parsedKey.rawKey !== ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
      return null;
    }

    const state = await this.readNamespaceIndexState(scope);
    if (!state.exists || !state.valid || state.entries === null) {
      return null;
    }

    return {
      e: Object.fromEntries(
        [...state.entries.entries()].map(([entryKey, metadata]) => [
          entryKey,
          {
            a: metadata.lastAccessAt,
            ...(metadata.version !== 1 ? { v: metadata.version } : {}),
            ...(metadata.sizeBytes !== undefined
              ? { z: metadata.sizeBytes }
              : {}),
            ...(metadata.customMetadata ?? {}),
          },
        ]),
      ),
      ...(state.staticPolicy !== null ? { s: state.staticPolicy } : {}),
    };
  }

  async set(
    scope: AsyncStorageNamespaceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    await this.setMany(scope, [{ key, value }]);
  }

  async remove(scope: AsyncStorageNamespaceScope, key: string): Promise<void> {
    await this.removeMany(scope, [key]);
  }

  async getMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<unknown[]> {
    return Promise.all(keys.map((key) => this.get(scope, key)));
  }

  async setMany(
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const parsedKey = parseAsyncStorageRecordKey(entry.key);
      if (parsedKey.recordKind === 'payload') {
        const existing = await this.#getEntry(scope, parsedKey.userKey);
        const lastAccessAt = existing?.a ?? Date.now();
        await this.#putEntryRecord(scope, {
          customMetadata:
            existing === null
              ? undefined
              : getCustomMetadataFromEntryRecord(existing),
          key: parsedKey.userKey,
          lastAccessAt,
          value: entry.value,
          version: existing?.v ?? 1,
        });
        continue;
      }

      if (parsedKey.rawKey === ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
        const state = this.#parsePersistedIndexState(entry.value);
        if (state !== null) {
          await this.persistNamespaceIndexState(scope, state);
        }
      }
    }
  }

  async removeMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    isRetry = false,
  ): Promise<void> {
    let database: IDBDatabase | undefined;
    try {
      const startTime =
        import.meta.env.DEV && this.debugLogger ? getTSDFDebugTimingMs() : null;
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readwrite',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );

      let removedAnyEntry = false;
      let removedScope = false;
      for (const key of keys) {
        const parsedKey = parseAsyncStorageRecordKey(key);
        if (parsedKey.recordKind === 'payload') {
          entryStore.delete(createEntryPrimaryKey(scope, parsedKey.userKey));
          removedAnyEntry = true;
          continue;
        }

        if (parsedKey.rawKey === ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
          policyStore.delete(createScopePolicyKey(scope));
          removedScope = true;
        }
      }

      if (removedAnyEntry && !removedScope) {
        const countRequest = entryStore.count(createScopeKeyRange(scope));
        countRequest.onsuccess = () => {
          if (countRequest.result === 0) {
            policyStore.delete(createScopePolicyKey(scope));
          }
        };
      }

      await transactionDone(transaction, watch);
      if (import.meta.env.DEV && this.debugLogger) {
        this.#logAdapterOperation(scope, 'delete-records', startTime, {
          keyCount: keys.length,
          objectStores: [
            INDEXED_DB_ENTRY_STORE,
            INDEXED_DB_NAMESPACE_POLICY_STORE,
          ],
        });
      }
      this.#instrumentation?.onRemoveMany?.(scope, keys);
      this.#instrumentation?.record({
        keys: [...keys].sort((left, right) => left.localeCompare(right)),
        scope,
        time: Date.now(),
        type: 'removeManagedRecords',
      });
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.removeMany(scope, keys, true);
    }
  }

  async listKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    const state = await this.readNamespaceIndexState(scope);
    if (!state.exists || state.entries === null) return [];

    const keys = [...state.entries.keys()].map((key) =>
      getPayloadRecordKey(key),
    );
    keys.push(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    return keys.sort((left, right) => left.localeCompare(right));
  }

  async clear(scope: AsyncStorageNamespaceScope): Promise<void> {
    await this.clearManagedNamespace(scope);
  }

  async listScopes(sessionKey?: string): Promise<AsyncStorageNamespaceScope[]> {
    return (await this.listScopesWithKnownRecordKeys(sessionKey)).map(
      ({ scope }) => scope,
    );
  }

  async listScopesWithKnownRecordKeys(
    sessionKey?: string,
    isRetry = false,
  ): Promise<AsyncStorageDiscoveredScope[]> {
    let database: IDBDatabase | undefined;
    try {
      const startTime =
        import.meta.env.DEV && this.debugLogger ? getTSDFDebugTimingMs() : null;
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readonly',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      const discoveredScopes: AsyncStorageDiscoveredScope[] = [];
      const policyRequest =
        sessionKey === undefined
          ? policyStore.openCursor()
          : policyStore
              .index('bySession')
              .openCursor(IDBKeyRange.only(sessionKey));
      await iterateCursor(watch, policyRequest, async (cursor) => {
        const scope = getScopeFromPrimaryKey(cursor.primaryKey);
        if (scope === null) return;
        const keys = new Set<string>([ASYNC_NAMESPACE_INDEX_RECORD_KEY]);

        await iterateCursor(
          watch,
          entryStore.openCursor(createScopeKeyRange(scope)),
          (entryCursor) => {
            const entryKey = getEntryKeyFromPrimaryKey(entryCursor.primaryKey);
            if (entryKey === null) return;
            keys.add(getPayloadRecordKey(entryKey));
          },
        );

        discoveredScopes.push({
          knownRecordKeys: [...keys].sort((left, right) =>
            left.localeCompare(right),
          ),
          scope,
        });
      });

      await transactionDone(transaction, watch);
      if (import.meta.env.DEV && this.debugLogger) {
        this.#logAdapterOperation(undefined, 'list-scopes', startTime, {
          count: discoveredScopes.length,
          objectStores: [
            INDEXED_DB_ENTRY_STORE,
            INDEXED_DB_NAMESPACE_POLICY_STORE,
          ],
          ...(sessionKey !== undefined ? { sessionKey } : {}),
        });
      }

      discoveredScopes.sort((left, right) =>
        getNamespaceId(left.scope).localeCompare(getNamespaceId(right.scope)),
      );

      this.#instrumentation?.record({
        scopeIds: discoveredScopes.map(({ scope }) => getNamespaceId(scope)),
        ...(sessionKey !== undefined ? { sessionKey } : {}),
        time: Date.now(),
        type: 'listScopesWithKnownRecordKeys',
      });

      return discoveredScopes;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.listScopesWithKnownRecordKeys(sessionKey, true);
    }
  }

  async readManagedEntries<TValue>(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
    isRetry = false,
  ): Promise<
    Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null
    >
  > {
    let database: IDBDatabase | undefined;
    try {
      const startTime =
        import.meta.env.DEV && this.debugLogger ? getTSDFDebugTimingMs() : null;
      database = await this.#getDatabase();
      const transaction = database.transaction(
        INDEXED_DB_ENTRY_STORE,
        'readonly',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const store = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const uniqueKeys = [...new Set(keys)];
      const result = new Map<
        string,
        AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null
      >();

      await Promise.all(
        uniqueKeys.map(async (key) => {
          const record = await openRequestAsPromise<
            IndexedDbEntryRecord | undefined
          >(watch, store.get(createEntryPrimaryKey(scope, key)));
          if (!isValidEntryRecord(record)) {
            result.set(key, null);
            return;
          }
          const entryRecord = toEntryRecordValue(record);

          result.set(key, {
            metadata: toPublicMetadata(key, entryRecord),
            // WORKAROUND: IndexedDB payload values cross the untyped storage
            // boundary as unknown and are only rebound to the caller's TValue here.
            value: __LEGIT_CAST__<TValue, unknown>(
              expandEntryValue(scope, entryRecord),
            ),
          });
        }),
      );
      await transactionDone(transaction, watch);
      if (import.meta.env.DEV && this.debugLogger) {
        this.#logAdapterOperation(scope, 'read-records', startTime, {
          hitCount: [...result.values()].filter((value) => value !== null)
            .length,
          keyCount: uniqueKeys.length,
          objectStores: [INDEXED_DB_ENTRY_STORE],
        });
      }

      this.#instrumentation?.record({
        keys: uniqueKeys,
        resultKeys: [...result.entries()]
          .flatMap(([key, value]) => (value === null ? [] : [key]))
          .sort((left, right) => left.localeCompare(right)),
        scope,
        time: Date.now(),
        type: 'readManagedEntries',
      });

      return result;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.readManagedEntries<TValue>(scope, keys, true);
    }
  }

  async listManagedMetadata(
    scope: AsyncStorageNamespaceScope,
    args: {
      filter?: IndexedDbManagedMetadataFilter;
      order?: AsyncStorageMetadataOrder;
    } = {},
    isRetry = false,
  ): Promise<AsyncStorageEntryMetadata<Record<string, unknown>>[]> {
    let database: IDBDatabase | undefined;
    try {
      const startTime =
        import.meta.env.DEV && this.debugLogger ? getTSDFDebugTimingMs() : null;
      const order = args.order ?? 'key';
      database = await this.#getDatabase();
      const transaction = database.transaction(
        INDEXED_DB_ENTRY_STORE,
        'readonly',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const store = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const entries: AsyncStorageEntryMetadata<Record<string, unknown>>[] = [];
      let usedIndex: 'group' | 'key' | 'lru' = 'key';

      if (
        args.filter?.key === 'g' &&
        typeof args.filter.equals === 'string' &&
        order === 'key'
      ) {
        usedIndex = 'group';
        await iterateCursor(
          watch,
          store
            .index('byScopeGroup')
            .openCursor(createScopeGroupRange(scope, args.filter.equals)),
          (cursor) => {
            const record = cursor.value;
            const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
            if (!isValidEntryRecord(record) || entryKey === null) return;
            entries.push(
              toPublicMetadata(entryKey, toEntryRecordValue(record)),
            );
          },
        );
      } else if (order === 'lru-asc' || order === 'lru-desc') {
        usedIndex = 'lru';
        await iterateCursor(
          watch,
          store
            .index('byScopeLastAccessAt')
            .openCursor(
              createScopeLastAccessRange(scope),
              order === 'lru-desc' ? 'prev' : 'next',
            ),
          (cursor) => {
            const record = cursor.value;
            const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
            if (!isValidEntryRecord(record) || entryKey === null) return;
            entries.push(
              toPublicMetadata(entryKey, toEntryRecordValue(record)),
            );
          },
        );
      } else {
        await iterateCursor(
          watch,
          store.openCursor(createScopeKeyRange(scope)),
          (cursor) => {
            const record = cursor.value;
            const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
            if (!isValidEntryRecord(record) || entryKey === null) return;
            entries.push(
              toPublicMetadata(entryKey, toEntryRecordValue(record)),
            );
          },
        );
      }

      await transactionDone(transaction, watch);

      const filter = args.filter;
      const filteredEntries =
        filter === undefined
          ? entries
          : entries.filter(
              (entry) => entry.customMetadata[filter.key] === filter.equals,
            );

      if (usedIndex !== 'lru') {
        filteredEntries.sort((left, right) =>
          compareMetadata(left, right, order),
        );
      }
      if (import.meta.env.DEV && this.debugLogger) {
        this.#logAdapterOperation(scope, 'list-record-metadata', startTime, {
          count: filteredEntries.length,
          objectStores: [INDEXED_DB_ENTRY_STORE],
          order,
          usedIndex,
        });
      }

      this.#instrumentation?.record({
        order,
        resultKeys: filteredEntries.map((entry) => entry.key),
        scope,
        time: Date.now(),
        type: 'listManagedMetadata',
        usedIndex,
      });

      return filteredEntries;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.listManagedMetadata(scope, args, true);
    }
  }

  async listManagedKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    const entries = await this.listManagedMetadata(scope, { order: 'key' });
    return entries.map((entry) => entry.key);
  }

  async clearManagedNamespace(
    scope: AsyncStorageNamespaceScope,
    isRetry = false,
  ): Promise<void> {
    let database: IDBDatabase | undefined;
    try {
      const startTime =
        import.meta.env.DEV && this.debugLogger ? getTSDFDebugTimingMs() : null;
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readwrite',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      // One range delete instead of a cursor walk: fewer requests, and both
      // are issued in the frame that created the transaction.
      entryStore.delete(createScopeKeyRange(scope));
      policyStore.delete(createScopePolicyKey(scope));
      await transactionDone(transaction, watch);
      if (import.meta.env.DEV && this.debugLogger) {
        this.#logAdapterOperation(scope, 'clear-records', startTime, {
          objectStores: [
            INDEXED_DB_ENTRY_STORE,
            INDEXED_DB_NAMESPACE_POLICY_STORE,
          ],
        });
      }

      this.#instrumentation?.onClearManagedNamespace?.(scope);
      this.#instrumentation?.record({
        scope,
        time: Date.now(),
        type: 'clearManagedNamespace',
      });
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.clearManagedNamespace(scope, true);
    }
  }

  async applyManagedCommit(
    scope: AsyncStorageNamespaceScope,
    args: ManagedAsyncStorageNamespaceCommitArgs<
      unknown,
      Record<string, unknown>
    >,
    helpers: {
      mergeOfflineProtectionMetadata: (
        key: string,
        nextCustomMetadata: Record<string, unknown> | undefined,
        currentCustomMetadata: Record<string, unknown> | undefined,
      ) => Record<string, unknown> | undefined;
    },
    isRetry = false,
  ): Promise<ReadonlySet<string>> {
    let database: IDBDatabase | undefined;
    try {
      const startTime =
        import.meta.env.DEV && this.debugLogger ? getTSDFDebugTimingMs() : null;
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readwrite',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      const upserts = args.upserts ?? [];
      const removes = [...new Set(args.removes ?? [])];
      const conditionalRemoves = args.conditionalRemoves ?? [];
      const touches = args.touches ?? [];
      const scopeId = createScopeId(
        scope.sessionKey,
        scope.storeName,
        scope.kind,
      );
      const uniqueKeys = [
        ...new Set([
          ...removes,
          ...conditionalRemoves.map((remove) => remove.key),
          ...touches.map((touch) => touch.key),
          ...upserts.map((upsert) => upsert.key),
        ]),
      ];
      const existingEntries = new Map<string, IndexedDbEntryRecord>();
      const now = Date.now();
      const touchTimestamps = new Map(
        touches.map((touch) => [touch.key, touch.lastAccessAt ?? now]),
      );
      const rawScopeRecord = await openRequestAsPromise<unknown>(
        watch,
        policyStore.get(createScopePolicyKey(scope)),
      );
      const existingStaticPolicy = isValidNamespacePolicyRecord(rawScopeRecord)
        ? getStaticPolicyFromScopeRecord(
            toNamespacePolicyRecordValue(rawScopeRecord),
          )
        : null;

      await Promise.all(
        uniqueKeys.map(async (key) => {
          const record = await openRequestAsPromise<
            IndexedDbEntryRecord | undefined
          >(watch, entryStore.get(createEntryPrimaryKey(scope, key)));
          if (isValidEntryRecord(record)) {
            existingEntries.set(key, toEntryRecordValue(record));
          }
        }),
      );

      // Checked inside the same readwrite transaction as the removal.
      const staleConditionalRemoveKeys = new Set<string>();
      for (const remove of conditionalRemoves) {
        const existing = existingEntries.get(remove.key);
        // Already removed.
        if (existing === undefined) continue;
        if (
          matchesConditionalRemove(
            remove,
            existing.a,
            existing.z,
            existing.v ?? 1,
            existing.o === 1,
          )
        ) {
          removes.push(remove.key);
        } else {
          staleConditionalRemoveKeys.add(remove.key);
        }
      }

      for (const key of removes) {
        entryStore.delete(createEntryPrimaryKey(scope, key));
      }

      const upsertKeySet = new Set(upserts.map((upsert) => upsert.key));
      for (const upsert of upserts) {
        const existing = existingEntries.get(upsert.key);
        const customMetadata = helpers.mergeOfflineProtectionMetadata(
          upsert.key,
          upsert.metadata,
          existing === undefined
            ? undefined
            : getCustomMetadataFromEntryRecord(existing),
        );
        const { extraMetadata, group, offlineProtected, payload } =
          splitCustomMetadata(customMetadata);
        const nextLastAccessAt =
          touchTimestamps.get(upsert.key) ?? existing?.a ?? now;
        const sizeBytes =
          scope.kind !== 'document'
            ? estimateIndexedDbManagedEntrySizeBytes({
                customMetadata,
                lastAccessAt: nextLastAccessAt,
                serializedValue: upsert.serializedValue,
                value: upsert.value,
                version: upsert.version,
              })
            : undefined;
        const compactValue = compactEntryValue(scope, upsert.value);
        await openRequestAsPromise(
          watch,
          entryStore.put(
            {
              a: nextLastAccessAt,
              ...compactValue,
              ...(group !== undefined ? { g: group } : {}),
              i: scopeId,
              ...(extraMetadata !== undefined ? { m: extraMetadata } : {}),
              ...(offlineProtected === true ? { o: 1 as const } : {}),
              ...(payload !== undefined ? { p: payload } : {}),
              ...(upsert.version !== 1 ? { v: upsert.version } : {}),
              ...(sizeBytes !== undefined ? { z: sizeBytes } : {}),
            } satisfies IndexedDbEntryRecord,
            createEntryPrimaryKey(scope, upsert.key),
          ),
        );
      }

      for (const touch of touches) {
        if (upsertKeySet.has(touch.key)) continue;
        const existing = existingEntries.get(touch.key);
        if (existing === undefined) continue;
        const nextLastAccessAt = touch.lastAccessAt ?? now;
        if (existing.a === nextLastAccessAt) continue;
        await openRequestAsPromise(
          watch,
          entryStore.put(
            { ...existing, a: nextLastAccessAt } satisfies IndexedDbEntryRecord,
            createEntryPrimaryKey(scope, touch.key),
          ),
        );
      }

      const normalizedStaticPolicy =
        'staticPolicy' in args
          ? normalizeStaticPolicy(args.staticPolicy)
          : undefined;
      const remainingCount = await openRequestAsPromise<number>(
        watch,
        entryStore.count(createScopeKeyRange(scope)),
      );

      if (remainingCount === 0) {
        policyStore.delete(createScopePolicyKey(scope));
      } else {
        await openRequestAsPromise(
          watch,
          policyStore.put(
            {
              p: serializeIndexedDbPersistedStaticPolicy(
                normalizedStaticPolicy ?? existingStaticPolicy,
              ),
              s: scope.sessionKey,
            } satisfies IndexedDbNamespacePolicyRecord,
            createScopePolicyKey(scope),
          ),
        );
      }

      await transactionDone(transaction, watch);
      if (import.meta.env.DEV && this.debugLogger) {
        this.#logAdapterOperation(scope, 'write-records', startTime, {
          objectStores: [
            INDEXED_DB_ENTRY_STORE,
            INDEXED_DB_NAMESPACE_POLICY_STORE,
          ],
          removes: removes.length,
          touches: touches.length,
          upserts: upserts.length,
        });
      }

      this.#instrumentation?.onApplyManagedCommit?.(scope, args);
      this.#instrumentation?.record({
        removes,
        scope,
        staticPolicyChanged: 'staticPolicy' in args,
        time: Date.now(),
        touches: touches
          .map((touch) => touch.key)
          .sort((left, right) => left.localeCompare(right)),
        type: 'applyManagedCommit',
        upserts: upserts
          .map((upsert) => upsert.key)
          .sort((left, right) => left.localeCompare(right)),
      });
      return staleConditionalRemoveKeys;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.applyManagedCommit(scope, args, helpers, true);
    }
  }

  async readNamespaceIndexState(
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys_?: string[] | null,
    isRetry = false,
  ): Promise<IndexedDbManagedIndexState> {
    let database: IDBDatabase | undefined;
    try {
      void knownRecordKeys_;
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readonly',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      const entries = new Map<string, IndexedDbManagedMetadataRecord>();
      let invalidEntryCount = 0;

      // Both reads are issued in the frame that created the transaction.
      const [rawPolicy] = await Promise.all([
        openRequestAsPromise<unknown>(
          watch,
          policyStore.get(createScopePolicyKey(scope)),
        ),
        iterateCursor(
          watch,
          entryStore.openCursor(createScopeKeyRange(scope)),
          (cursor) => {
            const record = cursor.value;
            const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
            if (!isValidEntryRecord(record)) {
              invalidEntryCount += 1;
              return;
            }

            if (entryKey === null) {
              invalidEntryCount += 1;
              return;
            }

            entries.set(entryKey, toMetadataRecord(toEntryRecordValue(record)));
          },
        ),
      ]);
      await transactionDone(transaction, watch);

      if (invalidEntryCount > 0) {
        const result = {
          entries: null,
          exists: entries.size > 0 || rawPolicy !== undefined,
          staticPolicy: null,
          valid: false,
        };
        this.#instrumentation?.record({
          exists: result.exists,
          keyCount: entries.size,
          scope,
          time: Date.now(),
          type: 'readManagedIndexState',
          valid: result.valid,
        });
        return result;
      }

      if (rawPolicy !== undefined && !isValidNamespacePolicyRecord(rawPolicy)) {
        const result = {
          entries: null,
          exists: true,
          staticPolicy: null,
          valid: false,
        };
        this.#instrumentation?.record({
          exists: result.exists,
          keyCount: entries.size,
          scope,
          time: Date.now(),
          type: 'readManagedIndexState',
          valid: result.valid,
        });
        return result;
      }

      const exists = rawPolicy !== undefined || entries.size > 0;
      if (
        (rawPolicy === undefined && entries.size > 0) ||
        (rawPolicy !== undefined && entries.size === 0)
      ) {
        const result = {
          entries: null,
          exists,
          staticPolicy: null,
          valid: false,
        };
        this.#instrumentation?.record({
          exists: result.exists,
          keyCount: entries.size,
          scope,
          time: Date.now(),
          type: 'readManagedIndexState',
          valid: result.valid,
        });
        return result;
      }

      const result = {
        entries,
        exists: rawPolicy !== undefined,
        staticPolicy: getStaticPolicyFromScopeRecord(
          rawPolicy === undefined
            ? undefined
            : toNamespacePolicyRecordValue(rawPolicy),
        ),
        valid: true,
      };
      this.#instrumentation?.record({
        exists: result.exists,
        keyCount: result.entries.size,
        scope,
        time: Date.now(),
        type: 'readManagedIndexState',
        valid: result.valid,
      });
      return result;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.readNamespaceIndexState(scope, knownRecordKeys_, true);
    }
  }

  async persistNamespaceIndexState(
    scope: AsyncStorageNamespaceScope,
    state: {
      entries: Map<string, IndexedDbManagedMetadataRecord>;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
    },
    isRetry = false,
  ): Promise<void> {
    let database: IDBDatabase | undefined;
    try {
      database = await this.#getDatabase();
      const existingEntries = new Map<string, IndexedDbEntryRecord>();
      const readTransaction = database.transaction(
        INDEXED_DB_ENTRY_STORE,
        'readonly',
      );
      const readWatch = new IndexedDbStallWatch(readTransaction);
      const readStore = readTransaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const desiredKeys = [...state.entries.keys()];

      await Promise.all(
        desiredKeys.map(async (key) => {
          const existing = await openRequestAsPromise<
            IndexedDbEntryRecord | undefined
          >(readWatch, readStore.get(createEntryPrimaryKey(scope, key)));
          if (isValidEntryRecord(existing)) {
            existingEntries.set(key, toEntryRecordValue(existing));
          }
        }),
      );
      await transactionDone(readTransaction, readWatch);

      const writeTransaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readwrite',
      );
      const writeWatch = new IndexedDbStallWatch(writeTransaction);
      const entryStore = writeTransaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = writeTransaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );

      for (const [key, metadata] of state.entries.entries()) {
        const existing = existingEntries.get(key);
        if (existing === undefined) continue;
        const { extraMetadata, group, offlineProtected, payload } =
          splitCustomMetadata(metadata.customMetadata);

        entryStore.put(
          {
            ...existing,
            a: metadata.lastAccessAt,
            ...(group !== undefined ? { g: group } : {}),
            ...(group === undefined ? { g: undefined } : {}),
            ...(extraMetadata !== undefined ? { m: extraMetadata } : {}),
            ...(extraMetadata === undefined ? { m: undefined } : {}),
            ...(offlineProtected === true ? { o: 1 as const } : {}),
            ...(offlineProtected !== true ? { o: undefined } : {}),
            ...(payload !== undefined ? { p: payload } : {}),
            ...(payload === undefined ? { p: undefined } : {}),
            ...(metadata.version !== 1 ? { v: metadata.version } : {}),
            ...(metadata.version === 1 ? { v: undefined } : {}),
            ...(metadata.sizeBytes !== undefined
              ? { z: metadata.sizeBytes }
              : {}),
            ...(metadata.sizeBytes === undefined ? { z: undefined } : {}),
          } satisfies IndexedDbEntryRecord,
          createEntryPrimaryKey(scope, key),
        );
      }

      if (state.entries.size === 0) {
        policyStore.delete(createScopePolicyKey(scope));
      } else {
        policyStore.put(
          {
            p: serializeIndexedDbPersistedStaticPolicy(state.staticPolicy),
            s: scope.sessionKey,
          } satisfies IndexedDbNamespacePolicyRecord,
          createScopePolicyKey(scope),
        );
      }

      await transactionDone(writeTransaction, writeWatch);
      this.#instrumentation?.onPersistNamespaceIndexState?.(scope, state);
      this.#instrumentation?.record({
        keyCount: state.entries.size,
        scope,
        staticPolicy: state.staticPolicy,
        time: Date.now(),
        type: 'persistManagedIndexState',
      });
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.persistNamespaceIndexState(scope, state, true);
    }
  }

  async readProtectedStorageKeys(
    sessionKey: string,
    isRetry = false,
  ): Promise<string[]> {
    let database: IDBDatabase | undefined;
    try {
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readonly',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      const values: string[] = [];
      const scopeRequest = policyStore
        .index('bySession')
        .openCursor(IDBKeyRange.only(sessionKey));
      await iterateCursor(watch, scopeRequest, async (scopeCursor) => {
        const scope = getScopeFromPrimaryKey(scopeCursor.primaryKey);
        if (scope === null) return;

        await iterateCursor(
          watch,
          entryStore
            .index('byScopeOfflineProtected')
            .openCursor(createScopeOfflineProtectedRange(scope)),
          (entryCursor) => {
            const entryKey = getEntryKeyFromPrimaryKey(entryCursor.primaryKey);
            const record = entryCursor.value;
            if (!isValidEntryRecord(record) || entryKey === null) return;
            values.push(serializeProtectedRef({ ...scope, key: entryKey }));
          },
        );
      });
      await transactionDone(transaction, watch);

      this.#instrumentation?.record({
        sessionKey,
        time: Date.now(),
        type: 'readProtectedStorageKeys',
        values: [...values].sort((left, right) => left.localeCompare(right)),
      });

      return values;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.readProtectedStorageKeys(sessionKey, true);
    }
  }

  async syncSessionProtectedKeys(
    sessionKey: string,
    protectedKeys: Iterable<string>,
    isRetry = false,
  ): Promise<void> {
    let database: IDBDatabase | undefined;
    try {
      const nextProtectedKeys = new Set(protectedKeys);
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readwrite',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const store = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );

      await iterateCursor(
        watch,
        policyStore.index('bySession').openCursor(IDBKeyRange.only(sessionKey)),
        async (scopeCursor) => {
          const scope = getScopeFromPrimaryKey(scopeCursor.primaryKey);
          if (scope === null) return;

          await iterateCursor(
            watch,
            store.openCursor(createScopeKeyRange(scope)),
            (cursor) => {
              const record = cursor.value;
              const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
              if (!isValidEntryRecord(record) || entryKey === null) return;
              const entryRecord = toEntryRecordValue(record);

              const ref = serializeProtectedRef({ ...scope, key: entryKey });
              const shouldProtect = nextProtectedKeys.has(ref);
              if ((entryRecord.o === 1) === shouldProtect) return;

              const nextRecord = {
                ...entryRecord,
                ...(shouldProtect ? { o: 1 as const } : { o: undefined }),
              } satisfies IndexedDbEntryRecord;
              cursor.update(nextRecord);
            },
          );
        },
      );
      await transactionDone(transaction, watch);

      this.#instrumentation?.record({
        sessionKey,
        time: Date.now(),
        type: 'syncSessionProtectedKeys',
        values: [...nextProtectedKeys].sort((left, right) =>
          left.localeCompare(right),
        ),
      });
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.syncSessionProtectedKeys(sessionKey, protectedKeys, true);
    }
  }

  async readMaintenanceState(): Promise<{
    lastSuccessfulCleanupAt: number | null;
  }> {
    return getMaintenanceState(await this.#getDatabase());
  }

  async writeMaintenanceState(value: {
    lastSuccessfulCleanupAt: number | null;
  }): Promise<void> {
    await setMaintenanceState(await this.#getDatabase(), value);
  }

  async __resetForTests(): Promise<void> {
    if (this.#database !== null) this.#dropDatabase(this.#database);
    await deleteDatabase(this.databaseName);
    this.#instrumentation?.reset();
  }

  async __inspectStructureForTests(): Promise<IndexedDbStructureInspection> {
    const database = await this.#getDatabase();
    const stores: IndexedDbStructureInspection['stores'] = [];

    for (const storeName of [...database.objectStoreNames].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const transaction = database.transaction(storeName, 'readonly');
      const watch = new IndexedDbStallWatch(transaction);
      const store = transaction.objectStore(storeName);
      const indexes = [...store.indexNames]
        .sort((left, right) => left.localeCompare(right))
        .map((indexName) => {
          const index = store.index(indexName);

          return {
            keyPath: index.keyPath,
            multiEntry: index.multiEntry,
            name: index.name,
            unique: index.unique,
          };
        });
      const [keys, values] = await Promise.all([
        openRequestAsPromise<unknown[]>(watch, store.getAllKeys()),
        openRequestAsPromise<unknown[]>(watch, store.getAll()),
      ]);
      await transactionDone(transaction, watch);

      stores.push({
        autoIncrement: store.autoIncrement,
        indexes,
        keyPath: store.keyPath,
        name: storeName,
        rows: keys.map((key, index) => ({ key, value: values[index] })),
      });
    }

    return { stores, version: database.version };
  }

  async #getEntry(
    scope: AsyncStorageNamespaceScope,
    key: string,
    isRetry = false,
  ): Promise<IndexedDbEntryRecord | null> {
    let database: IDBDatabase | undefined;
    try {
      database = await this.#getDatabase();
      const transaction = database.transaction(
        INDEXED_DB_ENTRY_STORE,
        'readonly',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const record = await openRequestAsPromise<
        IndexedDbEntryRecord | undefined
      >(
        watch,
        transaction
          .objectStore(INDEXED_DB_ENTRY_STORE)
          .get(createEntryPrimaryKey(scope, key)),
      );
      await transactionDone(transaction, watch);
      return isValidEntryRecord(record) ? toEntryRecordValue(record) : null;
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.#getEntry(scope, key, true);
    }
  }

  async #putEntryRecord(
    scope: AsyncStorageNamespaceScope,
    args: {
      customMetadata?: Record<string, unknown>;
      key: string;
      lastAccessAt: number;
      value: unknown;
      version: number;
    },
    isRetry = false,
  ): Promise<void> {
    let database: IDBDatabase | undefined;
    try {
      database = await this.#getDatabase();
      const transaction = database.transaction(
        [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
        'readwrite',
      );
      const watch = new IndexedDbStallWatch(transaction);
      const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
      const policyStore = transaction.objectStore(
        INDEXED_DB_NAMESPACE_POLICY_STORE,
      );
      const { extraMetadata, group, offlineProtected, payload } =
        splitCustomMetadata(args.customMetadata);
      const sizeBytes =
        scope.kind !== 'document'
          ? estimateIndexedDbManagedEntrySizeBytes({
              customMetadata: args.customMetadata,
              lastAccessAt: args.lastAccessAt,
              value: args.value,
              version: args.version,
            })
          : undefined;
      const compactValue = compactEntryValue(scope, args.value);
      entryStore.put(
        {
          a: args.lastAccessAt,
          ...compactValue,
          ...(group !== undefined ? { g: group } : {}),
          i: createScopeId(scope.sessionKey, scope.storeName, scope.kind),
          ...(extraMetadata !== undefined ? { m: extraMetadata } : {}),
          ...(offlineProtected === true ? { o: 1 as const } : {}),
          ...(payload !== undefined ? { p: payload } : {}),
          ...(args.version !== 1 ? { v: args.version } : {}),
          ...(sizeBytes !== undefined ? { z: sizeBytes } : {}),
        } satisfies IndexedDbEntryRecord,
        createEntryPrimaryKey(scope, args.key),
      );
      // The policy rewrite depends on a read, so it is issued from that
      // read's own callback rather than after an await.
      const policyRequest: IDBRequest<unknown> = policyStore.get(
        createScopePolicyKey(scope),
      );
      policyRequest.onsuccess = () => {
        indexedDbEventCount += 1;
        const existingScopeRecord = policyRequest.result;
        policyStore.put(
          {
            p: serializeIndexedDbPersistedStaticPolicy(
              getStaticPolicyFromScopeRecord(
                isValidNamespacePolicyRecord(existingScopeRecord)
                  ? toNamespacePolicyRecordValue(existingScopeRecord)
                  : undefined,
              ),
            ),
            s: scope.sessionKey,
          } satisfies IndexedDbNamespacePolicyRecord,
          createScopePolicyKey(scope),
        );
      };
      await transactionDone(transaction, watch);
    } catch (error) {
      if (!this.#shouldRetry(error, database, isRetry)) throw error;
      return this.#putEntryRecord(scope, args, true);
    }
  }

  #parsePersistedIndexState(
    value: unknown,
  ): {
    entries: Map<string, IndexedDbManagedMetadataRecord>;
    staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
  } | null {
    if (!isObject(value)) return null;
    const recordValue = toRecordValue(value);
    const rawEntries = recordValue.e;
    if (!isObject(rawEntries)) return null;
    const rawEntriesRecord = toRecordValue(rawEntries);

    const entries = new Map<string, IndexedDbManagedMetadataRecord>();
    for (const [key, rawMetadata] of Object.entries(rawEntriesRecord)) {
      if (!isObject(rawMetadata)) return null;
      const rawMetadataRecord = toRecordValue(rawMetadata);
      if (typeof rawMetadataRecord.a !== 'number') return null;

      const customMetadata = Object.fromEntries(
        Object.entries(rawMetadataRecord).filter(
          ([metadataKey]) =>
            metadataKey !== 'a' && metadataKey !== 'v' && metadataKey !== 'z',
        ),
      );
      entries.set(key, {
        ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
        lastAccessAt: rawMetadataRecord.a,
        ...(typeof rawMetadataRecord.z === 'number'
          ? { sizeBytes: rawMetadataRecord.z }
          : {}),
        version:
          typeof rawMetadataRecord.v === 'number' ? rawMetadataRecord.v : 1,
      });
    }

    const staticPolicy = parseIndexedDbPersistedStaticPolicy(recordValue.s);
    if (staticPolicy === undefined) return null;

    return { entries, staticPolicy };
  }

  async #getDatabase(): Promise<IDBDatabase> {
    if (this.#databasePromise !== null) {
      return this.#databasePromise;
    }

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, INDEXED_DB_VERSION);
      // Also bounds a request left pending by `blocked`, which needs no
      // handler of its own: it only means another connection has not closed
      // yet, and the request still succeeds once it does.
      const watch = new IndexedDbStallWatch(null);
      watch.rejecters.push(reject);
      request.onupgradeneeded = () => {
        indexedDbEventCount += 1;
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

        const policyStore = database.createObjectStore(
          INDEXED_DB_NAMESPACE_POLICY_STORE,
        );
        policyStore.createIndex('bySession', 's', { unique: false });

        if (!database.objectStoreNames.contains(INDEXED_DB_META_STORE)) {
          database.createObjectStore(INDEXED_DB_META_STORE, { keyPath: 'k' });
        }
      };
      request.onerror = () => {
        watch.stop();
        reject(request.error ?? new Error('IndexedDB open failed.'));
      };
      request.onsuccess = () => {
        watch.stop();
        const database = request.result;
        if (this.#databasePromise !== opening) {
          // Given up on as stalled: nobody is waiting for this connection.
          database.close();
          return;
        }

        // The browser closed the connection, or another tab wants to upgrade
        // or delete the database and is blocked until this one lets go.
        // Either way the next operation opens a new connection.
        database.onclose = () => this.#dropDatabase(database);
        database.onversionchange = () => this.#dropDatabase(database);
        this.#database = database;
        resolve(database);
      };
    });

    this.#databasePromise = opening;
    // A failed open is not kept: the next operation opens again.
    opening.catch(() => {
      if (this.#databasePromise === opening) this.#databasePromise = null;
    });

    return opening;
  }

  #dropDatabase(database: IDBDatabase): void {
    if (this.#database === database) {
      this.#database = null;
      this.#databasePromise = null;
    }
    database.close();
  }

  /**
   * Whether a failed operation should run once more on a new connection.
   *
   * Every operation of this driver is safe to repeat: each one is a single
   * atomic transaction (or a sequence of them) that reads what it needs inside
   * the transaction and writes whole values, deletes, or flags derived from
   * its arguments, so applying it after an attempt that did or did not commit
   * leaves the same data. Quota, data and version errors are not connection
   * errors and are never retried.
   */
  #shouldRetry(
    error: unknown,
    database: IDBDatabase | undefined,
    isRetry: boolean,
  ): boolean {
    if (!isIndexedDbConnectionError(error)) return false;
    if (database !== undefined) this.#dropDatabase(database);
    return !isRetry;
  }

  #logAdapterOperation(
    scope: AsyncStorageNamespaceScope | undefined,
    adapterOperation: string,
    startTime: number | null,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    if (!import.meta.env.DEV) return;
    if (startTime === null) return;
    if (!this.debugLogger) return;

    const status =
      typeof details.status === 'string' ? details.status : 'success';

    emitTSDFDebugLog(this.debugLogger, {
      area: 'persistent-storage',
      level: 'log',
      message: `persistent storage adapter ${adapterOperation} ${status}`,
      operation: 'adapter-operation',
      details: {
        adapter: 'async',
        adapterName: 'indexeddb',
        adapterOperation,
        databaseName: this.databaseName,
        durationMs: getTSDFDebugTimingMs() - startTime,
        status,
        ...(scope !== undefined
          ? {
              namespaceKind: scope.kind,
              sessionKey: scope.sessionKey,
              storeName: scope.storeName,
            }
          : {}),
        ...details,
      },
    });
  }
}

/** Options for creating the IndexedDB persistent storage adapter. */
export type IndexedDbPersistentStorageOptions = {
  /** IndexedDB database name used by the adapter. */
  databaseName?: string;
};

export function createIndexedDbPersistentStorage(
  options: IndexedDbPersistentStorageOptions = {},
): AsyncStorageAdapter {
  return createAsyncStorageAdapter(
    new IndexedDbAsyncStorageDriver(options.databaseName),
  );
}

type IndexedDbPersistentStorageInternalOptions =
  IndexedDbPersistentStorageOptions & {
    instrumentation?: IndexedDbDriverInstrumentation;
  };

export function createIndexedDbPersistentStorageForTests(
  options: IndexedDbPersistentStorageInternalOptions = {},
): { adapter: AsyncStorageAdapter; driver: IndexedDbAsyncStorageDriver } {
  const driver = new IndexedDbAsyncStorageDriver(
    options.databaseName,
    options.instrumentation,
  );
  return { adapter: createAsyncStorageAdapter(driver), driver };
}

export type IndexedDbPersistentStorageOperation = IndexedDbTestOperation;
