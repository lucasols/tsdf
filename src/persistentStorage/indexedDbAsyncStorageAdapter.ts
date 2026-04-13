import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { isObject } from '@ls-stack/utils/typeGuards';
import { createAsyncStorageAdapter } from './asyncStorageAdapter';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  compareMetadata,
  encodePersistedAsyncNamespaceKind,
  getNamespaceId,
  getPersistedNamespaceId,
  getPayloadRecordKey,
  normalizeStaticPolicy,
  parsePersistedAsyncNamespaceKind,
  parseAsyncStorageRecordKey,
  serializeProtectedRef,
} from './asyncStorageShared';
import type {
  AsyncStorageAdapter,
  AsyncStorageDiscoveredScope,
  AsyncStorageDriver,
  AsyncStorageDriverSetEntry,
  AsyncStorageEntryMetadata,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceCommitArgs,
  AsyncStorageNamespaceGetResult,
  AsyncStorageNamespaceScope,
  AsyncStorageNamespaceStaticPolicy,
} from './types';

export const DEFAULT_INDEXED_DB_NAME =
  'tsdf-persistent-storage-compact-alpha-reset';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_ENTRY_STORE = 'entries';
const INDEXED_DB_NAMESPACE_POLICY_STORE = 'namespacePolicies';
const INDEXED_DB_META_STORE = 'meta';
const INDEXED_DB_MAINTENANCE_META_KEY = 'maintenance';

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
    args: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
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

  const loadedFields = recordValue.f;
  return (
    typeof recordValue.i === 'string' &&
    typeof recordValue.a === 'number' &&
    'd' in recordValue &&
    (recordValue.v === undefined || typeof recordValue.v === 'number') &&
    (recordValue.z === undefined || typeof recordValue.z === 'number') &&
    (recordValue.m === undefined || isObject(recordValue.m)) &&
    (recordValue.g === undefined || typeof recordValue.g === 'string') &&
    (recordValue.o === undefined || recordValue.o === 1) &&
    (loadedFields === undefined ||
      (loadedFields instanceof Array &&
        loadedFields.every((value) => typeof value === 'string'))) &&
    (recordValue.h === undefined || recordValue.h === 1)
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
): Pick<IndexedDbEntryRecord, 'd' | 'f' | 'h'> {
  void scope;
  return { d: value };
}

function expandEntryValue(
  scope: AsyncStorageNamespaceScope,
  record: IndexedDbEntryRecord,
): unknown {
  void scope;
  return record.d;
}

function openRequestAsPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () =>
      // WORKAROUND: DOM IndexedDB requests expose `result` as `unknown`/`any`;
      // callers choose the expected shape at each read boundary.
      resolve(__LEGIT_CAST__<T, unknown>(request.result));
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed.'));
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

async function iterateCursor<T>(
  request: IDBRequest<IDBCursorWithValue | null>,
  callback: (cursor: IDBCursorWithValue) => T | Promise<T>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB cursor request failed.'));
    request.onsuccess = async () => {
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
  const store = transaction.objectStore(INDEXED_DB_META_STORE);
  const value = await openRequestAsPromise<IndexedDbMetaRecord | undefined>(
    store.get(INDEXED_DB_MAINTENANCE_META_KEY),
  );
  await transactionDone(transaction);

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
  transaction
    .objectStore(INDEXED_DB_META_STORE)
    .put({
      k: INDEXED_DB_MAINTENANCE_META_KEY,
      v: { lca: value.lastSuccessfulCleanupAt },
    } satisfies IndexedDbMetaRecord);
  await transactionDone(transaction);
}

export class IndexedDbAsyncStorageDriver implements AsyncStorageDriver {
  readonly __tsdfManagedStorage = {
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

  #databasePromise: Promise<IDBDatabase> | null = null;

  constructor(
    readonly databaseName: string = DEFAULT_INDEXED_DB_NAME,
    private readonly instrumentation?: IndexedDbDriverInstrumentation,
  ) {}

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
  ): Promise<void> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
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

    await transactionDone(transaction);
    this.instrumentation?.onRemoveMany?.(scope, keys);
    this.instrumentation?.record({
      keys: [...keys].sort((left, right) => left.localeCompare(right)),
      scope,
      time: Date.now(),
      type: 'removeManagedRecords',
    });
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
  ): Promise<AsyncStorageDiscoveredScope[]> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readonly',
    );
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
    await iterateCursor(policyRequest, async (cursor) => {
      const scope = getScopeFromPrimaryKey(cursor.primaryKey);
      if (scope === null) return;
      const keys = new Set<string>([ASYNC_NAMESPACE_INDEX_RECORD_KEY]);

      await iterateCursor(
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

    await transactionDone(transaction);

    discoveredScopes.sort((left, right) =>
      getNamespaceId(left.scope).localeCompare(getNamespaceId(right.scope)),
    );

    this.instrumentation?.record({
      scopeIds: discoveredScopes.map(({ scope }) => getNamespaceId(scope)),
      ...(sessionKey !== undefined ? { sessionKey } : {}),
      time: Date.now(),
      type: 'listScopesWithKnownRecordKeys',
    });

    return discoveredScopes;
  }

  async readManagedEntries<TValue>(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<
    Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null
    >
  > {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      INDEXED_DB_ENTRY_STORE,
      'readonly',
    );
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
        >(store.get(createEntryPrimaryKey(scope, key)));
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
    await transactionDone(transaction);

    this.instrumentation?.record({
      keys: uniqueKeys,
      resultKeys: [...result.entries()]
        .flatMap(([key, value]) => (value === null ? [] : [key]))
        .sort((left, right) => left.localeCompare(right)),
      scope,
      time: Date.now(),
      type: 'readManagedEntries',
    });

    return result;
  }

  async listManagedMetadata(
    scope: AsyncStorageNamespaceScope,
    args: {
      filter?: IndexedDbManagedMetadataFilter;
      order?: AsyncStorageMetadataOrder;
    } = {},
  ): Promise<AsyncStorageEntryMetadata<Record<string, unknown>>[]> {
    const order = args.order ?? 'key';
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      INDEXED_DB_ENTRY_STORE,
      'readonly',
    );
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
        store
          .index('byScopeGroup')
          .openCursor(createScopeGroupRange(scope, args.filter.equals)),
        (cursor) => {
          const record = cursor.value;
          const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
          if (!isValidEntryRecord(record) || entryKey === null) return;
          entries.push(toPublicMetadata(entryKey, toEntryRecordValue(record)));
        },
      );
    } else if (order === 'lru-asc' || order === 'lru-desc') {
      usedIndex = 'lru';
      await iterateCursor(
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
          entries.push(toPublicMetadata(entryKey, toEntryRecordValue(record)));
        },
      );
    } else {
      await iterateCursor(
        store.openCursor(createScopeKeyRange(scope)),
        (cursor) => {
          const record = cursor.value;
          const entryKey = getEntryKeyFromPrimaryKey(cursor.primaryKey);
          if (!isValidEntryRecord(record) || entryKey === null) return;
          entries.push(toPublicMetadata(entryKey, toEntryRecordValue(record)));
        },
      );
    }

    await transactionDone(transaction);

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

    this.instrumentation?.record({
      order,
      resultKeys: filteredEntries.map((entry) => entry.key),
      scope,
      time: Date.now(),
      type: 'listManagedMetadata',
      usedIndex,
    });

    return filteredEntries;
  }

  async listManagedKeys(scope: AsyncStorageNamespaceScope): Promise<string[]> {
    const entries = await this.listManagedMetadata(scope, { order: 'key' });
    return entries.map((entry) => entry.key);
  }

  async clearManagedNamespace(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
    const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(
      INDEXED_DB_NAMESPACE_POLICY_STORE,
    );
    await iterateCursor(
      entryStore.openCursor(createScopeKeyRange(scope)),
      (cursor) => {
        cursor.delete();
      },
    );
    policyStore.delete(createScopePolicyKey(scope));
    await transactionDone(transaction);

    this.instrumentation?.onClearManagedNamespace?.(scope);
    this.instrumentation?.record({
      scope,
      time: Date.now(),
      type: 'clearManagedNamespace',
    });
  }

  async applyManagedCommit(
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
    helpers: {
      mergeOfflineProtectionMetadata: (
        key: string,
        nextCustomMetadata: Record<string, unknown> | undefined,
        currentCustomMetadata: Record<string, unknown> | undefined,
      ) => Record<string, unknown> | undefined;
    },
  ): Promise<void> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
    const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(
      INDEXED_DB_NAMESPACE_POLICY_STORE,
    );
    const upserts = args.upserts ?? [];
    const removes = [...new Set(args.removes ?? [])];
    const touches = args.touches ?? [];
    const scopeId = createScopeId(
      scope.sessionKey,
      scope.storeName,
      scope.kind,
    );
    const uniqueKeys = [
      ...new Set([
        ...removes,
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
        >(entryStore.get(createEntryPrimaryKey(scope, key)));
        if (isValidEntryRecord(record)) {
          existingEntries.set(key, toEntryRecordValue(record));
        }
      }),
    );

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
      const compactValue = compactEntryValue(scope, upsert.value);
      await openRequestAsPromise(
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
            ...(typeof upsert.sizeBytes === 'number'
              ? { z: upsert.sizeBytes }
              : {}),
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
      entryStore.count(createScopeKeyRange(scope)),
    );

    if (remainingCount === 0) {
      policyStore.delete(createScopePolicyKey(scope));
    } else {
      await openRequestAsPromise(
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

    await transactionDone(transaction);

    this.instrumentation?.onApplyManagedCommit?.(scope, args);
    this.instrumentation?.record({
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
  }

  async readNamespaceIndexState(
    scope: AsyncStorageNamespaceScope,
    knownRecordKeys_?: string[] | null,
  ): Promise<IndexedDbManagedIndexState> {
    void knownRecordKeys_;
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readonly',
    );
    const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(
      INDEXED_DB_NAMESPACE_POLICY_STORE,
    );
    const entries = new Map<string, IndexedDbManagedMetadataRecord>();
    let invalidEntryCount = 0;

    await iterateCursor(
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
    );

    const rawPolicy = await openRequestAsPromise<unknown>(
      policyStore.get(createScopePolicyKey(scope)),
    );
    await transactionDone(transaction);

    if (invalidEntryCount > 0) {
      const result = {
        entries: null,
        exists: entries.size > 0 || rawPolicy !== undefined,
        staticPolicy: null,
        valid: false,
      };
      this.instrumentation?.record({
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
      this.instrumentation?.record({
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
      this.instrumentation?.record({
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
    this.instrumentation?.record({
      exists: result.exists,
      keyCount: result.entries.size,
      scope,
      time: Date.now(),
      type: 'readManagedIndexState',
      valid: result.valid,
    });
    return result;
  }

  async persistNamespaceIndexState(
    scope: AsyncStorageNamespaceScope,
    state: {
      entries: Map<string, IndexedDbManagedMetadataRecord>;
      staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
    },
  ): Promise<void> {
    const database = await this.#getDatabase();
    const existingEntries = new Map<string, IndexedDbEntryRecord>();
    const readTransaction = database.transaction(
      INDEXED_DB_ENTRY_STORE,
      'readonly',
    );
    const readStore = readTransaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const desiredKeys = [...state.entries.keys()];

    await Promise.all(
      desiredKeys.map(async (key) => {
        const existing = await openRequestAsPromise<
          IndexedDbEntryRecord | undefined
        >(readStore.get(createEntryPrimaryKey(scope, key)));
        if (isValidEntryRecord(existing)) {
          existingEntries.set(key, toEntryRecordValue(existing));
        }
      }),
    );
    await transactionDone(readTransaction);

    const writeTransaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
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

    await transactionDone(writeTransaction);
    this.instrumentation?.onPersistNamespaceIndexState?.(scope, state);
    this.instrumentation?.record({
      keyCount: state.entries.size,
      scope,
      staticPolicy: state.staticPolicy,
      time: Date.now(),
      type: 'persistManagedIndexState',
    });
  }

  async readProtectedStorageKeys(sessionKey: string): Promise<string[]> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readonly',
    );
    const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(
      INDEXED_DB_NAMESPACE_POLICY_STORE,
    );
    const values: string[] = [];
    const scopeRequest = policyStore
      .index('bySession')
      .openCursor(IDBKeyRange.only(sessionKey));
    await iterateCursor(scopeRequest, async (scopeCursor) => {
      const scope = getScopeFromPrimaryKey(scopeCursor.primaryKey);
      if (scope === null) return;

      await iterateCursor(
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
    await transactionDone(transaction);

    this.instrumentation?.record({
      sessionKey,
      time: Date.now(),
      type: 'readProtectedStorageKeys',
      values: [...values].sort((left, right) => left.localeCompare(right)),
    });

    return values;
  }

  async syncSessionProtectedKeys(
    sessionKey: string,
    protectedKeys: Iterable<string>,
  ): Promise<void> {
    const nextProtectedKeys = new Set(protectedKeys);
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
    const store = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(
      INDEXED_DB_NAMESPACE_POLICY_STORE,
    );

    await iterateCursor(
      policyStore.index('bySession').openCursor(IDBKeyRange.only(sessionKey)),
      async (scopeCursor) => {
        const scope = getScopeFromPrimaryKey(scopeCursor.primaryKey);
        if (scope === null) return;

        await iterateCursor(
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
    await transactionDone(transaction);

    this.instrumentation?.record({
      sessionKey,
      time: Date.now(),
      type: 'syncSessionProtectedKeys',
      values: [...nextProtectedKeys].sort((left, right) =>
        left.localeCompare(right),
      ),
    });
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
    if (this.#databasePromise !== null) {
      const database = await this.#databasePromise;
      database.close();
      this.#databasePromise = null;
    }
    await deleteDatabase(this.databaseName);
    this.instrumentation?.reset();
  }

  async __inspectStructureForTests(): Promise<IndexedDbStructureInspection> {
    const database = await this.#getDatabase();
    const stores: IndexedDbStructureInspection['stores'] = [];

    for (const storeName of [...database.objectStoreNames].sort((left, right) =>
      left.localeCompare(right),
    )) {
      const transaction = database.transaction(storeName, 'readonly');
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
        openRequestAsPromise<unknown[]>(store.getAllKeys()),
        openRequestAsPromise<unknown[]>(store.getAll()),
      ]);
      await transactionDone(transaction);

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
  ): Promise<IndexedDbEntryRecord | null> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      INDEXED_DB_ENTRY_STORE,
      'readonly',
    );
    const record = await openRequestAsPromise<IndexedDbEntryRecord | undefined>(
      transaction
        .objectStore(INDEXED_DB_ENTRY_STORE)
        .get(createEntryPrimaryKey(scope, key)),
    );
    await transactionDone(transaction);
    return isValidEntryRecord(record) ? toEntryRecordValue(record) : null;
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
  ): Promise<void> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
    const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(
      INDEXED_DB_NAMESPACE_POLICY_STORE,
    );
    const existingScopeRecord = await openRequestAsPromise<unknown>(
      policyStore.get(createScopePolicyKey(scope)),
    );
    const { extraMetadata, group, offlineProtected, payload } =
      splitCustomMetadata(args.customMetadata);
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
      } satisfies IndexedDbEntryRecord,
      createEntryPrimaryKey(scope, args.key),
    );
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
    await transactionDone(transaction);
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

    this.#databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, INDEXED_DB_VERSION);
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

        const policyStore = database.createObjectStore(
          INDEXED_DB_NAMESPACE_POLICY_STORE,
        );
        policyStore.createIndex('bySession', 's', { unique: false });

        if (!database.objectStoreNames.contains(INDEXED_DB_META_STORE)) {
          database.createObjectStore(INDEXED_DB_META_STORE, { keyPath: 'k' });
        }
      };
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed.'));
      request.onsuccess = () => resolve(request.result);
    });

    return this.#databasePromise;
  }
}

export type IndexedDbPersistentStorageOptions = { databaseName?: string };

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
