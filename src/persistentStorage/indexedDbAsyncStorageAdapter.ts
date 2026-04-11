import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getNamespaceId,
  getPayloadRecordKey,
  parseAsyncStorageRecordKey,
} from './asyncStorageShared';
import { createAsyncStorageAdapter } from './asyncStorageAdapter';
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
import { parseAsyncStorageNamespaceKind } from './types';

export const DEFAULT_INDEXED_DB_NAME = 'tsdf-persistent-storage-compact';
const INDEXED_DB_VERSION = 1;
const INDEXED_DB_ENTRY_STORE = 'entries';
const INDEXED_DB_NAMESPACE_POLICY_STORE = 'namespacePolicies';
const INDEXED_DB_META_STORE = 'meta';
const INDEXED_DB_MAINTENANCE_META_KEY = 'maintenance';










type IndexedDbManagedMetadataRecord = {
  customMetadata?: Record<string, unknown>;
  lastAccessAt: number;
  version: number;
};

type IndexedDbManagedIndexState = {
  entries: Map<string, IndexedDbManagedMetadataRecord> | null;
  exists: boolean;
  staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
  valid: boolean;
};

type IndexedDbManagedMetadataFilter = {
  equals: unknown;
  key: string;
};

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
  onRemoveMany?: (
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ) => void;
  operations: IndexedDbTestOperation[];
  record: (operation: IndexedDbTestOperation) => void;
  reset: () => void;
};





type ScopePrimaryKey = [string, string, AsyncStorageNamespaceScope['kind']];

function createScopePrimaryKey(scope: AsyncStorageNamespaceScope): ScopePrimaryKey {
  return [scope.sessionKey, scope.storeName, scope.kind];
}

type EntryPrimaryKey = [
  string,
  string,
  AsyncStorageNamespaceScope['kind'],
  string,
];

function createEntryPrimaryKey(
  scope: AsyncStorageNamespaceScope,
  key: string,
): EntryPrimaryKey {
  return [scope.sessionKey, scope.storeName, scope.kind, key];
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
  return IDBKeyRange.bound(
    [scope.sessionKey, scope.storeName, scope.kind, Number.MIN_SAFE_INTEGER, ''],
    [scope.sessionKey, scope.storeName, scope.kind, Number.MAX_SAFE_INTEGER, '\uffff'],
  );
}

function createScopeGroupRange(
  scope: AsyncStorageNamespaceScope,
  group: string,
): IDBKeyRange {
  return IDBKeyRange.bound(
    [scope.sessionKey, scope.storeName, scope.kind, group, ''],
    [scope.sessionKey, scope.storeName, scope.kind, group, '\uffff'],
  );
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
  return getNamespaceId({ sessionKey, storeName, kind });
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
    typeof rawKind === 'string' ? parseAsyncStorageNamespaceKind(rawKind) : null;
  if (kind === null) return null;

  return { kind, sessionKey, storeName };
}

function getEntryFromPrimaryKey(
  key: unknown,
): { key: string; scope: AsyncStorageNamespaceScope } | null {
  if (!Array.isArray(key) || key.length < 4) return null;

  const scope = getScopeFromPrimaryKey(key);
  const entryKey = key[3];
  if (scope === null || typeof entryKey !== 'string') return null;

  return { key: entryKey, scope };
}

type IndexedDbEntryRecord = {
  a: number;
  d: unknown;
  g?: string;
  k: string;
  m?: Record<string, unknown>;
  n: string;
  o: 0 | 1;
  s: string;
  t: AsyncStorageNamespaceScope['kind'];
  v: number;
};

function toMetadataRecord(
  record: IndexedDbEntryRecord,
): IndexedDbManagedMetadataRecord {
  return {
    lastAccessAt: record.a,
    version: record.v,
    ...(record.m ? { customMetadata: record.m } : {}),
  };
}

function toPublicMetadata(
  record: IndexedDbEntryRecord,
): AsyncStorageEntryMetadata<Record<string, unknown>> {
  return {
    customMetadata: record.m ?? {},
    key: record.k,
    lastAccessAt: record.a,
    payloadRef: getPayloadRecordKey(record.k),
    version: record.v,
    writtenAt: record.a,
  };
}

function normalizeStaticPolicy(
  policy: AsyncStorageNamespaceStaticPolicy | null | undefined,
): AsyncStorageNamespaceStaticPolicy | null {
  if (policy === undefined || policy === null) return null;

  const maxEntries =
    typeof policy.maxEntries === 'number' &&
    Number.isInteger(policy.maxEntries) &&
    policy.maxEntries >= 0
      ? policy.maxEntries
      : undefined;
  const pinnedKeys = Array.isArray(policy.pinnedKeys)
    ? [...new Set(policy.pinnedKeys)].sort((left, right) =>
        left.localeCompare(right),
      )
    : [];

  if (maxEntries === undefined && pinnedKeys.length === 0) {
    return null;
  }

  return {
    ...(maxEntries !== undefined ? { maxEntries } : {}),
    ...(pinnedKeys.length > 0 ? { pinnedKeys } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEntryRecord(record: unknown): record is IndexedDbEntryRecord {
  if (!isRecord(record)) return false;

  return (
    typeof record.s === 'string' &&
    typeof record.n === 'string' &&
    typeof record.t === 'string' &&
    typeof record.k === 'string' &&
    typeof record.a === 'number' &&
    typeof record.v === 'number' &&
    (record.m === undefined || isRecord(record.m)) &&
    (record.g === undefined || typeof record.g === 'string') &&
    (record.o === 0 || record.o === 1)
  );
}

type IndexedDbNamespacePolicyRecord = {
  n: string;
  p: AsyncStorageNamespaceStaticPolicy | null;
  s: string;
  t: AsyncStorageNamespaceScope['kind'];
};

function isValidNamespacePolicyRecord(
  record: unknown,
): record is IndexedDbNamespacePolicyRecord {
  if (!isRecord(record)) return false;

  return (
    typeof record.s === 'string' &&
    typeof record.n === 'string' &&
    typeof record.t === 'string' &&
    // WORKAROUND: Static policies come from IndexedDB's untyped DOM surface, so
    // we validate the unknown value before treating it as a policy candidate.
    normalizeStaticPolicy(
      __LEGIT_CAST__<AsyncStorageNamespaceStaticPolicy | null | undefined, unknown>(
        record.p,
      ),
    ) !== undefined
  );
}

function compareMetadata(
  left: AsyncStorageEntryMetadata<Record<string, unknown>>,
  right: AsyncStorageEntryMetadata<Record<string, unknown>>,
  order: AsyncStorageMetadataOrder,
): number {
  if (order === 'key') {
    return left.key.localeCompare(right.key);
  }

  if (left.lastAccessAt !== right.lastAccessAt) {
    return order === 'lru-asc'
      ? left.lastAccessAt - right.lastAccessAt
      : right.lastAccessAt - left.lastAccessAt;
  }

  return left.key.localeCompare(right.key);
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

type IndexedDbMetaRecord = {
  k: string;
  v: unknown;
};

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
    rows: Array<{
      key: unknown;
      value: unknown;
    }>;
  }>;
  version: number;
};

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
  if (!isRecord(recordValue) || !('lca' in recordValue)) {
    return { lastSuccessfulCleanupAt: null };
  }

  const lastSuccessfulCleanupAt = recordValue.lca;
  return {
    lastSuccessfulCleanupAt:
      typeof lastSuccessfulCleanupAt === 'number' || lastSuccessfulCleanupAt === null
        ? lastSuccessfulCleanupAt
        : null,
  };
}

async function setMaintenanceState(
  database: IDBDatabase,
  value: { lastSuccessfulCleanupAt: number | null },
): Promise<void> {
  const transaction = database.transaction(INDEXED_DB_META_STORE, 'readwrite');
  transaction.objectStore(INDEXED_DB_META_STORE).put({
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
      return entry?.d ?? null;
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
          customMetadata: existing?.m,
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
    const policyStore = transaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);

    let removedAnyEntry = false;
    let removedPolicy = false;
    for (const key of keys) {
      const parsedKey = parseAsyncStorageRecordKey(key);
      if (parsedKey.recordKind === 'payload') {
        entryStore.delete(createEntryPrimaryKey(scope, parsedKey.userKey));
        removedAnyEntry = true;
        continue;
      }

      if (parsedKey.rawKey === ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
        policyStore.delete(createScopePolicyKey(scope));
        removedPolicy = true;
      }
    }

    if (removedAnyEntry && !removedPolicy) {
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

    const keys = [...state.entries.keys()].map((key) => getPayloadRecordKey(key));
    if (state.exists) {
      keys.push(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    }
    return keys.sort((left, right) => left.localeCompare(right));
  }

  async clear(scope: AsyncStorageNamespaceScope): Promise<void> {
    await this.clearManagedNamespace(scope);
  }

  async listScopes(sessionKey?: string): Promise<AsyncStorageNamespaceScope[]> {
    return (
      await this.listScopesWithKnownRecordKeys(sessionKey)
    ).map(({ scope }) => scope);
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
    const policyStore = transaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);
    const scopesById = new Map<
      string,
      { keys: Set<string>; scope: AsyncStorageNamespaceScope }
    >();

    const entryRequest =
      sessionKey === undefined
        ? entryStore.openCursor()
        : entryStore.index('bySession').openCursor(IDBKeyRange.only(sessionKey));
    await iterateCursor(entryRequest, (cursor) => {
      const record = cursor.value;
      const parsedEntry = isValidEntryRecord(record)
        ? {
            key: record.k,
            scope: {
              kind: record.t,
              sessionKey: record.s,
              storeName: record.n,
            } satisfies AsyncStorageNamespaceScope,
          }
        : getEntryFromPrimaryKey(cursor.primaryKey);
      if (parsedEntry === null) return;

      const { key, scope } = parsedEntry;
      const scopeId = createScopeId(scope.sessionKey, scope.storeName, scope.kind);
      const existing = scopesById.get(scopeId);
      if (existing !== undefined) {
        existing.keys.add(getPayloadRecordKey(key));
        existing.keys.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
        return;
      }

      scopesById.set(scopeId, {
        keys: new Set([
          getPayloadRecordKey(key),
          ASYNC_NAMESPACE_INDEX_RECORD_KEY,
        ]),
        scope,
      });
    });

    const policyRequest =
      sessionKey === undefined
        ? policyStore.openCursor()
        : policyStore.index('bySession').openCursor(IDBKeyRange.only(sessionKey));
    await iterateCursor(policyRequest, (cursor) => {
      const record = cursor.value;
      const scope = isValidNamespacePolicyRecord(record)
        ? ({
            kind: record.t,
            sessionKey: record.s,
            storeName: record.n,
          } satisfies AsyncStorageNamespaceScope)
        : getScopeFromPrimaryKey(cursor.primaryKey);
      if (scope === null) return;

      const scopeId = createScopeId(scope.sessionKey, scope.storeName, scope.kind);
      const existing = scopesById.get(scopeId);
      if (existing !== undefined) {
        existing.keys.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
        return;
      }

      scopesById.set(scopeId, {
        keys: new Set([ASYNC_NAMESPACE_INDEX_RECORD_KEY]),
        scope,
      });
    });

    await transactionDone(transaction);

    const discoveredScopes = [...scopesById.values()]
      .map(({ keys, scope }) => ({
        knownRecordKeys: [...keys].sort((left, right) => left.localeCompare(right)),
        scope,
      }))
      .sort((left, right) =>
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
    Map<string, AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null>
  > {
    const database = await this.#getDatabase();
    const transaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readonly');
    const store = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const uniqueKeys = [...new Set(keys)];
    const result = new Map<
      string,
      AsyncStorageNamespaceGetResult<TValue, Record<string, unknown>> | null
    >();

    await Promise.all(
      uniqueKeys.map(async (key) => {
        const record = await openRequestAsPromise<IndexedDbEntryRecord | undefined>(
          store.get(createEntryPrimaryKey(scope, key)),
        );
        if (!isValidEntryRecord(record)) {
          result.set(key, null);
          return;
        }

        result.set(key, {
          metadata: toPublicMetadata(record),
          // WORKAROUND: IndexedDB payload values cross the untyped storage
          // boundary as unknown and are only rebound to the caller's TValue here.
          value: __LEGIT_CAST__<TValue, unknown>(record.d),
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
    const transaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readonly');
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
        store.index('byScopeGroup').openCursor(
          createScopeGroupRange(scope, args.filter.equals),
        ),
        (cursor) => {
          const record = cursor.value;
          if (!isValidEntryRecord(record)) return;
          entries.push(toPublicMetadata(record));
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
          if (!isValidEntryRecord(record)) return;
          entries.push(toPublicMetadata(record));
        },
      );
    } else {
      await iterateCursor(store.openCursor(createScopeKeyRange(scope)), (cursor) => {
        const record = cursor.value;
        if (!isValidEntryRecord(record)) return;
        entries.push(toPublicMetadata(record));
      });
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
      filteredEntries.sort((left, right) => compareMetadata(left, right, order));
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

  async clearManagedNamespace(scope: AsyncStorageNamespaceScope): Promise<void> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
    const entryStore = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = transaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);
    await iterateCursor(entryStore.openCursor(createScopeKeyRange(scope)), (cursor) => {
      cursor.delete();
    });
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
    const policyStore = transaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);
    const upserts = args.upserts ?? [];
    const removes = [...new Set(args.removes ?? [])];
    const touches = args.touches ?? [];
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

    await Promise.all(
      uniqueKeys.map(async (key) => {
        const record = await openRequestAsPromise<IndexedDbEntryRecord | undefined>(
          entryStore.get(createEntryPrimaryKey(scope, key)),
        );
        if (isValidEntryRecord(record)) {
          existingEntries.set(key, record);
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
        existing?.m,
      );
      const nextLastAccessAt =
        touchTimestamps.get(upsert.key) ?? existing?.a ?? now;
      await openRequestAsPromise(
        entryStore.put({
          a: nextLastAccessAt,
          d: upsert.value,
          g: typeof customMetadata?.g === 'string' ? customMetadata.g : undefined,
          k: upsert.key,
          m: customMetadata,
          n: scope.storeName,
          o: customMetadata?.o === true ? 1 : 0,
          s: scope.sessionKey,
          t: scope.kind,
          v: upsert.version,
        } satisfies IndexedDbEntryRecord),
      );
    }

    for (const touch of touches) {
      if (upsertKeySet.has(touch.key)) continue;
      const existing = existingEntries.get(touch.key);
      if (existing === undefined) continue;
      const nextLastAccessAt = touch.lastAccessAt ?? now;
      if (existing.a === nextLastAccessAt) continue;
      await openRequestAsPromise(
        entryStore.put({
          ...existing,
          a: nextLastAccessAt,
        } satisfies IndexedDbEntryRecord),
      );
    }

    const normalizedStaticPolicy =
      'staticPolicy' in args ? normalizeStaticPolicy(args.staticPolicy) : undefined;
    const remainingCount = await openRequestAsPromise<number>(
      entryStore.count(createScopeKeyRange(scope)),
    );

    if (remainingCount === 0) {
      policyStore.delete(createScopePolicyKey(scope));
    } else if ('staticPolicy' in args) {
      if (normalizedStaticPolicy === null) {
        policyStore.delete(createScopePolicyKey(scope));
      } else if (normalizedStaticPolicy !== undefined) {
        await openRequestAsPromise(
          policyStore.put({
            n: scope.storeName,
            p: normalizedStaticPolicy,
            s: scope.sessionKey,
            t: scope.kind,
          } satisfies IndexedDbNamespacePolicyRecord),
        );
      }
    }

    await transactionDone(transaction);

    this.instrumentation?.onApplyManagedCommit?.(scope, args);
    this.instrumentation?.record({
      removes,
      scope,
      staticPolicyChanged: 'staticPolicy' in args,
      time: Date.now(),
      touches: touches.map((touch) => touch.key).sort((left, right) =>
        left.localeCompare(right),
      ),
      type: 'applyManagedCommit',
      upserts: upserts.map((upsert) => upsert.key).sort((left, right) =>
        left.localeCompare(right),
      ),
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
    const policyStore = transaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);
    const entries = new Map<string, IndexedDbManagedMetadataRecord>();
    let valid = true;

    await iterateCursor(entryStore.openCursor(createScopeKeyRange(scope)), (cursor) => {
      const record = cursor.value;
      if (!isValidEntryRecord(record)) {
        valid = false;
        return;
      }

      entries.set(record.k, toMetadataRecord(record));
    });

    const rawPolicy = await openRequestAsPromise<IndexedDbNamespacePolicyRecord | undefined>(
      policyStore.get(createScopePolicyKey(scope)),
    );
    await transactionDone(transaction);

    if (!valid) {
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

    const staticPolicy =
      rawPolicy === undefined ? null : normalizeStaticPolicy(rawPolicy.p);
    const exists = entries.size > 0 || staticPolicy !== null;
    const result = {
      entries,
      exists,
      staticPolicy,
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
    const readTransaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readonly');
    const readStore = readTransaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const desiredKeys = [...state.entries.keys()];

    await Promise.all(
      desiredKeys.map(async (key) => {
        const existing = await openRequestAsPromise<IndexedDbEntryRecord | undefined>(
          readStore.get(createEntryPrimaryKey(scope, key)),
        );
        if (isValidEntryRecord(existing)) {
          existingEntries.set(key, existing);
        }
      }),
    );
    await transactionDone(readTransaction);

    const writeTransaction = database.transaction(
      [INDEXED_DB_ENTRY_STORE, INDEXED_DB_NAMESPACE_POLICY_STORE],
      'readwrite',
    );
    const entryStore = writeTransaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const policyStore = writeTransaction.objectStore(INDEXED_DB_NAMESPACE_POLICY_STORE);

    for (const [key, metadata] of state.entries.entries()) {
      const existing = existingEntries.get(key);
      if (existing === undefined) continue;

      entryStore.put({
        ...existing,
        a: metadata.lastAccessAt,
        g:
          typeof metadata.customMetadata?.g === 'string'
            ? metadata.customMetadata.g
            : undefined,
        m: metadata.customMetadata,
        o: metadata.customMetadata?.o === true ? 1 : 0,
        v: metadata.version,
      } satisfies IndexedDbEntryRecord);
    }

    if (state.entries.size === 0 || state.staticPolicy === null) {
      policyStore.delete(createScopePolicyKey(scope));
    } else {
      policyStore.put({
        n: scope.storeName,
        p: normalizeStaticPolicy(state.staticPolicy),
        s: scope.sessionKey,
        t: scope.kind,
      } satisfies IndexedDbNamespacePolicyRecord);
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
    const transaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readonly');
    const index = transaction.objectStore(INDEXED_DB_ENTRY_STORE).index(
      'bySessionOfflineProtected',
    );
    const values: string[] = [];
    await iterateCursor(
      index.openCursor(
        IDBKeyRange.bound(
          [sessionKey, 1, '', '', ''],
          [sessionKey, 1, '\uffff', '\uffff', '\uffff'],
        ),
      ),
      (cursor) => {
        const record = cursor.value;
        if (!isValidEntryRecord(record)) return;
        values.push(
          JSON.stringify([
            record.s,
            record.n,
            record.t,
            record.k,
          ]),
        );
      },
    );
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
    const transaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readwrite');
    const store = transaction.objectStore(INDEXED_DB_ENTRY_STORE);
    const index = store.index('bySession');

    await iterateCursor(index.openCursor(IDBKeyRange.only(sessionKey)), (cursor) => {
      const record = cursor.value;
      if (!isValidEntryRecord(record)) return;

      const ref = JSON.stringify([
        record.s,
        record.n,
        record.t,
        record.k,
      ]);
      const shouldProtect = nextProtectedKeys.has(ref);
      if ((record.m?.o === true) === shouldProtect) {
        return;
      }

      const nextCustomMetadata = shouldProtect
        ? { ...(record.m ?? {}), o: true }
        : Object.fromEntries(
            Object.entries(record.m ?? {}).filter(
              ([key]) => key !== 'o',
            ),
          );
      cursor.update({
        ...record,
        m:
          Object.keys(nextCustomMetadata).length > 0 ? nextCustomMetadata : undefined,
        o: shouldProtect ? 1 : 0,
      } satisfies IndexedDbEntryRecord);
    });
    await transactionDone(transaction);

    this.instrumentation?.record({
      sessionKey,
      time: Date.now(),
      type: 'syncSessionProtectedKeys',
      values: [...nextProtectedKeys].sort((left, right) => left.localeCompare(right)),
    });
  }

  async readMaintenanceState(): Promise<{ lastSuccessfulCleanupAt: number | null }> {
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
        rows: keys.map((key, index) => ({
          key,
          value: values[index],
        })),
      });
    }

    return {
      stores,
      version: database.version,
    };
  }

  async #getEntry(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): Promise<IndexedDbEntryRecord | null> {
    const database = await this.#getDatabase();
    const transaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readonly');
    const record = await openRequestAsPromise<IndexedDbEntryRecord | undefined>(
      transaction.objectStore(INDEXED_DB_ENTRY_STORE).get(createEntryPrimaryKey(scope, key)),
    );
    await transactionDone(transaction);
    return isValidEntryRecord(record) ? record : null;
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
    const transaction = database.transaction(INDEXED_DB_ENTRY_STORE, 'readwrite');
    transaction.objectStore(INDEXED_DB_ENTRY_STORE).put({
      a: args.lastAccessAt,
      d: args.value,
      g:
        typeof args.customMetadata?.g === 'string' ? args.customMetadata.g : undefined,
      k: args.key,
      m: args.customMetadata,
      n: scope.storeName,
      o: args.customMetadata?.o === true ? 1 : 0,
      s: scope.sessionKey,
      t: scope.kind,
      v: args.version,
    } satisfies IndexedDbEntryRecord);
    await transactionDone(transaction);
  }

  #parsePersistedIndexState(value: unknown): {
    entries: Map<string, IndexedDbManagedMetadataRecord>;
    staticPolicy: AsyncStorageNamespaceStaticPolicy | null;
  } | null {
    if (!isRecord(value)) return null;
    const rawEntries = value.e;
    if (!isRecord(rawEntries)) return null;

    const entries = new Map<string, IndexedDbManagedMetadataRecord>();
    for (const [key, rawMetadata] of Object.entries(rawEntries)) {
      if (!isRecord(rawMetadata) || typeof rawMetadata.a !== 'number') {
        return null;
      }

      const customMetadata = Object.fromEntries(
        Object.entries(rawMetadata).filter(
          ([metadataKey]) => metadataKey !== 'a' && metadataKey !== 'v',
        ),
      );
      entries.set(key, {
        ...(Object.keys(customMetadata).length > 0 ? { customMetadata } : {}),
        lastAccessAt: rawMetadata.a,
        version: typeof rawMetadata.v === 'number' ? rawMetadata.v : 1,
      });
    }

    return {
      entries,
      // WORKAROUND: Persisted namespace policies come from IndexedDB's untyped
      // DOM request surface and must be rebound after normalization.
      staticPolicy: normalizeStaticPolicy(
        __LEGIT_CAST__<AsyncStorageNamespaceStaticPolicy | null | undefined, unknown>(
          value.s,
        ),
      ),
    };
  }

  async #getDatabase(): Promise<IDBDatabase> {
    if (this.#databasePromise !== null) {
      return this.#databasePromise;
    }

    this.#databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, INDEXED_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(INDEXED_DB_ENTRY_STORE)) {
          const store = database.createObjectStore(INDEXED_DB_ENTRY_STORE, {
            keyPath: ['s', 'n', 't', 'k'],
          });
          store.createIndex('bySession', 's', { unique: false });
          store.createIndex(
            'byScopeLastAccessAt',
            ['s', 'n', 't', 'a', 'k'],
            { unique: false },
          );
          store.createIndex(
            'byScopeGroup',
            ['s', 'n', 't', 'g', 'k'],
            { unique: false },
          );
          store.createIndex(
            'bySessionOfflineProtected',
            ['s', 'o', 'n', 't', 'k'],
            { unique: false },
          );
        }

        if (!database.objectStoreNames.contains(INDEXED_DB_NAMESPACE_POLICY_STORE)) {
          const store = database.createObjectStore(
            INDEXED_DB_NAMESPACE_POLICY_STORE,
            { keyPath: ['s', 'n', 't'] },
          );
          store.createIndex('bySession', 's', { unique: false });
        }

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

export type IndexedDbPersistentStorageOptions = {
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
): {
  adapter: AsyncStorageAdapter;
  driver: IndexedDbAsyncStorageDriver;
} {
  const driver = new IndexedDbAsyncStorageDriver(
    options.databaseName,
    options.instrumentation,
  );
  return { adapter: createAsyncStorageAdapter(driver), driver };
}

export type IndexedDbPersistentStorageOperation = IndexedDbTestOperation;
