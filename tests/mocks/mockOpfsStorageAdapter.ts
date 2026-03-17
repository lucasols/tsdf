/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/require-await, @ls-stack/use-top-level-regex, @ls-stack/improved-no-unnecessary-condition -- This in-memory test adapter intentionally favors concise fixture code over production-style lint constraints. */
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import type {
  AsyncStorageAdapter,
  AsyncStorageNamespaceCommitArgs,
  AsyncStorageNamespaceCommitUpsert,
  AsyncStorageEntryMetadata,
  AsyncStorageMaintenanceState,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceScope,
  PersistedCollectionItemData,
  PersistedDocumentData,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';
import { getSessionProtectedKeysSnapshot } from '../../src/persistentStorage/offline/sessionProtectionRegistry';
import {
  getProtectedKeysStorageScope,
  parseProtectedKeys,
  PROTECTED_KEYS_STORAGE_ENTRY_KEY,
} from '../../src/persistentStorage/offline/protectedKeysPersistence';
import { scheduleIdleCleanup } from '../../src/persistentStorage/scheduleIdleCleanup';
import type { PersistentTestStoreScope } from '../utils/persistentStorageTestStore';
import { createInMemoryPersistentTestStore } from '../utils/persistentStorageTestStore';

type MockOpfsStorageAdapterOptions = {
  readDelayMs?: number;
  storeName?: string;
  sessionKey?: string;
  initialState?: {
    document?: MockOpfsInitialScope['document'];
    collection?: MockOpfsInitialScope['collection'];
    listQuery?: MockOpfsInitialScope['listQuery'];
    rawEntries?: Record<string, unknown>;
  };
};

type MetadataListRequest = {
  scope: AsyncStorageNamespaceScope;
  cursor: string | null;
  limit: number | null;
  order: AsyncStorageMetadataOrder;
};

export type MockOpfsOperation =
  | {
      type: 'get';
      scope: AsyncStorageNamespaceScope;
      key: string;
      flatKey: string;
      touch: 'never' | 'coarse' | 'force';
      exists: boolean;
    }
  | {
      type: 'getMany';
      scope: AsyncStorageNamespaceScope;
      keys: string[];
      flatKeys: string[];
      touch: 'never' | 'coarse' | 'force';
      hitCount: number;
    }
  | {
      type: 'commit';
      scope: AsyncStorageNamespaceScope;
      upserts: string[];
      removes: string[];
      touches: Array<{ key: string; lastAccessAt: number | null }>;
    }
  | {
      type: 'listMetadata';
      scope: AsyncStorageNamespaceScope;
      cursor: string | null;
      limit: number | null;
      order: AsyncStorageMetadataOrder;
      resultCount: number;
      nextCursor: string | null;
    }
  | { type: 'clear'; scope: AsyncStorageNamespaceScope; removedKeys: string[] }
  | { type: 'readMaintenanceState' }
  | {
      type: 'tryAcquireStartupCleanupLease';
      holderId: string;
      ttlMs: number;
      acquired: boolean;
    }
  | { type: 'finishStartupCleanup'; holderId: string; finishedAt: number };

type MockOpfsStorageAdapterBase = {
  adapter: AsyncStorageAdapter;
  storage: ReturnType<typeof createInMemoryPersistentTestStore>['storage'];
  scope: ReturnType<typeof createInMemoryPersistentTestStore>['scope'];
  readRequests: string[];
  payloadGetRequests: string[];
  payloadGetManyRequests: string[][];
  metadataListRequests: MetadataListRequest[];
  legacyListKeysFallbackRequests: string[];
  operations: MockOpfsOperation[];
  scopeReadRequests: () => string[];
  clearReadRequests: () => void;
  clearInstrumentation: () => void;
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
};

const DEFAULT_MAINTENANCE_STATE: AsyncStorageMaintenanceState = {
  lastSuccessfulCleanupAt: null,
  startupCleanupLease: null,
};

const OPFS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const OPFS_STARTUP_CLEANUP_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const OPFS_STARTUP_CLEANUP_LEASE_TTL_MS = 60 * 1000;
const OPFS_RECENCY_BUCKET_MS = 6 * 60 * 60 * 1000;
const ASYNC_COMMIT_DEBOUNCE_MS = 40;

type ListQueryItemRef = string | { tableId: string; id: number | string };

function normalizeListQueryItemRef(item: ListQueryItemRef): string {
  if (typeof item === 'string') return item;
  return getCompositeKey(`${item.tableId}||${item.id}`);
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function createCacheEntry<T>(
  data: T,
  options: { timestamp?: number; version?: number } = {},
): StorageCacheEntry<T> {
  return {
    data,
    timestamp: options.timestamp ?? Date.now(),
    version: options.version ?? 1,
  };
}

function normalizeDocumentEntry<T>(
  entry: StorageCacheEntry<unknown>,
): StorageCacheEntry<PersistedDocumentData<T>> {
  const value = entry.data;
  if (typeof value === 'object' && value !== null && 'd' in value) {
    return { ...entry, data: { data: value.d as T } };
  }

  return entry as StorageCacheEntry<PersistedDocumentData<T>>;
}

function normalizeCollectionItemEntry<T>(
  entry: StorageCacheEntry<unknown>,
): StorageCacheEntry<PersistedCollectionItemData<T>> {
  const value = entry.data;
  if (
    typeof value === 'object' &&
    value !== null &&
    'd' in value &&
    'p' in value
  ) {
    return { ...entry, data: { data: value.d as T, payload: value.p } };
  }

  return entry as StorageCacheEntry<PersistedCollectionItemData<T>>;
}

function normalizeListQueryItemEntry<T>(
  entry: StorageCacheEntry<unknown>,
): StorageCacheEntry<PersistedListQueryItemData<T>> {
  const value = entry.data;
  if (
    typeof value === 'object' &&
    value !== null &&
    'd' in value &&
    'p' in value
  ) {
    return {
      ...entry,
      data: {
        data: value.d as T,
        payload: value.p,
        ...('lf' in value && Array.isArray(value.lf)
          ? { loadedFields: value.lf }
          : {}),
      },
    };
  }

  return entry as StorageCacheEntry<PersistedListQueryItemData<T>>;
}

function normalizeListQueryEntry(
  entry: StorageCacheEntry<unknown>,
): StorageCacheEntry<PersistedListQueryData> {
  const value = entry.data;
  if (
    typeof value === 'object' &&
    value !== null &&
    'p' in value &&
    'i' in value &&
    Array.isArray(value.i)
  ) {
    return {
      ...entry,
      data: {
        payload: value.p,
        items: value.i,
        hasMore: 'h' in value && value.h === true,
      },
    };
  }

  return entry as StorageCacheEntry<PersistedListQueryData>;
}

function bucketId(timestamp: number): number {
  return Math.floor(timestamp / OPFS_RECENCY_BUCKET_MS);
}

function serializeProtectedRefForScope(
  scope: AsyncStorageNamespaceScope,
  key: string,
): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind, key]);
}

function encodeCursor(offset: number): string {
  return JSON.stringify({ offset });
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;

  const parsed = parseJson<{ offset?: number }>(cursor);
  return typeof parsed?.offset === 'number' ? parsed.offset : 0;
}

function buildCustomMetadata(
  scope: AsyncStorageNamespaceScope,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};

  switch (scope.kind) {
    case 'collection.item':
      return 'p' in value
        ? { p: value.p }
        : 'payload' in value
          ? { p: value.payload }
          : {};
    case 'listQuery.item':
      return 'p' in value
        ? { p: value.p }
        : 'payload' in value
          ? { p: value.payload }
          : {};
    case 'listQuery.query':
      return {
        ...('p' in value
          ? { p: value.p }
          : 'payload' in value
            ? { p: value.payload }
            : {}),
        ...(Array.isArray((value as { i?: unknown }).i)
          ? { i: (value as { i: string[] }).i }
          : Array.isArray((value as PersistedListQueryData).items)
            ? { i: (value as PersistedListQueryData).items }
            : {}),
        ...('h' in value && value.h === true
          ? { h: true }
          : 'hasMore' in value &&
              (value as PersistedListQueryData).hasMore === true
            ? { h: true }
            : {}),
      };
    default:
      return {};
  }
}

type ParsedFlatKey = { scope: AsyncStorageNamespaceScope; key: string };

function parseFlatStorageKey(key: string): ParsedFlatKey | null {
  let match =
    /^tsdf\.([^.]+)\.(.+?)\.collection\.item\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.ci\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.listQuery\.item\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.li\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.listQuery\.query\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.lq\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.offline\.queue\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oq\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.offline\.conflict\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oc\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.offline\.entity\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.oe\.(.+)$/.exec(key);

  if (match) {
    const [fullMatch, sessionKey, storeName, entryKey] = match;
    if (!sessionKey || !storeName || !entryKey) {
      return null;
    }

    const kind =
      fullMatch.includes('.collection.item.') || fullMatch.includes('.ci.')
        ? 'collection.item'
        : fullMatch.includes('.listQuery.item.') || fullMatch.includes('.li.')
          ? 'listQuery.item'
          : fullMatch.includes('.listQuery.query.') ||
              fullMatch.includes('.lq.')
            ? 'listQuery.query'
            : fullMatch.includes('.offline.queue.') ||
                fullMatch.includes('.oq.')
              ? 'offline.queue'
              : fullMatch.includes('.offline.conflict.') ||
                  fullMatch.includes('.oc.')
                ? 'offline.conflict'
                : 'offline.entity';

    return { scope: { sessionKey, storeName, kind }, key: entryKey };
  }

  match =
    /^tsdf\.([^.]+)\._o_\.p$/.exec(key) ??
    /^tsdf\.([^.]+)\.__offline__\.protected$/.exec(key);
  if (match?.[1]) {
    return {
      scope: {
        sessionKey: match[1],
        storeName: '__offline__',
        kind: '__internal.protected',
      },
      key: 'registry',
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
  if (!match?.[1] || !match[2]) return null;

  return {
    scope: { sessionKey: match[1], storeName: match[2], kind: 'document' },
    key: 'document',
  };
}

function getFlatKey(scope: AsyncStorageNamespaceScope, key: string): string {
  switch (scope.kind) {
    case 'document':
      return scope.storeName === '__offline__' && key === 'session'
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

function getNamespacePrefix(scope: AsyncStorageNamespaceScope): string {
  switch (scope.kind) {
    case 'document':
      return scope.storeName === '__offline__'
        ? `tsdf.${scope.sessionKey}.__offline__.`
        : `tsdf.${scope.sessionKey}.${scope.storeName}`;
    case '__internal.protected':
      return `tsdf.${scope.sessionKey}._o_.p`;
    default:
      return getFlatKey(scope, '');
  }
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

function createScopeHelpers(
  storage: ReturnType<typeof createInMemoryPersistentTestStore>['storage'],
  storeName: string,
  sessionKey: string,
): PersistentTestStoreScope {
  const documentStorageKey = `tsdf.${sessionKey}.${storeName}`;

  function collectionItemKey(payload: string): string {
    return getCompositeKey(payload);
  }

  function collectionItemStorageKey(payload: string): string {
    return `tsdf.${sessionKey}.${storeName}.ci.${collectionItemKey(payload)}`;
  }

  function listQueryItemPayload(tableId: string, id: number | string): string {
    return `${tableId}||${id}`;
  }

  function listQueryItemKey(tableId: string, id: number | string): string {
    return getCompositeKey(listQueryItemPayload(tableId, id));
  }

  function listQueryItemStorageKey(
    tableId: string,
    id: number | string,
  ): string {
    return `tsdf.${sessionKey}.${storeName}.li.${listQueryItemKey(tableId, id)}`;
  }

  function listQueryStorageKey(params: unknown): string {
    return `tsdf.${sessionKey}.${storeName}.lq.${getCompositeKey(params)}`;
  }

  function readRequiredEntry<T>(key: string): T {
    const entry = storage.readEntry<T>(key);
    if (entry === null) {
      throw new Error(`Missing persistent test entry for ${key}`);
    }

    return entry;
  }

  return {
    document: {
      storageKey: () => documentStorageKey,
      seed<T>(data: T, options?: { timestamp?: number; version?: number }) {
        storage.writeValue(
          documentStorageKey,
          createCacheEntry({ d: data }, options),
        );
        return documentStorageKey;
      },
      readEntry<T>() {
        return normalizeDocumentEntry<T>(
          readRequiredEntry<StorageCacheEntry<unknown>>(documentStorageKey),
        );
      },
      readData<T>() {
        const entry =
          storage.readEntry<StorageCacheEntry<unknown>>(documentStorageKey);
        return entry ? normalizeDocumentEntry<T>(entry).data.data : null;
      },
      getRawData(kind: 'entry' | 'manifest') {
        if (kind === 'entry') {
          return parseJson(storage.getRaw(documentStorageKey) ?? 'null');
        }

        return null;
      },
    },
    storage,
    collection: {
      itemKey: collectionItemKey,
      itemStorageKey: collectionItemStorageKey,
      seedItem<T>(
        payload: string,
        data: T,
        options?: { timestamp?: number; version?: number },
      ) {
        const key = collectionItemStorageKey(payload);
        storage.writeValue(
          key,
          createCacheEntry({ d: data, p: payload }, options),
        );
        return key;
      },
      readItemEntry<T>(payload: string) {
        return normalizeCollectionItemEntry<T>(
          readRequiredEntry<StorageCacheEntry<unknown>>(
            collectionItemStorageKey(payload),
          ),
        );
      },
      readItemData<T>(payload: string) {
        const entry = storage.readEntry<StorageCacheEntry<unknown>>(
          collectionItemStorageKey(payload),
        );
        return entry ? normalizeCollectionItemEntry<T>(entry).data.data : null;
      },
    },
    listQuery: {
      itemKey: listQueryItemKey,
      itemStorageKey: listQueryItemStorageKey,
      queryStorageKey: listQueryStorageKey,
      seedItem<T>(
        tableId: string,
        id: number | string,
        data: T,
        options?: {
          timestamp?: number;
          version?: number;
          loadedFields?: string[];
        },
      ) {
        const payload = listQueryItemPayload(tableId, id);
        const itemKey = listQueryItemKey(tableId, id);
        const storageKey = listQueryItemStorageKey(tableId, id);

        storage.writeValue(
          storageKey,
          createCacheEntry(
            {
              d: data,
              p: payload,
              ...(options?.loadedFields ? { lf: options.loadedFields } : {}),
            },
            options,
          ),
        );

        return { itemKey, payload, storageKey };
      },
      seedQuery(
        params: unknown,
        items: ListQueryItemRef[],
        options?: { timestamp?: number; version?: number; hasMore?: boolean },
      ) {
        const key = listQueryStorageKey(params);
        storage.writeValue(
          key,
          createCacheEntry(
            {
              p: params,
              i: items.map(normalizeListQueryItemRef),
              ...(options?.hasMore ? { h: true } : {}),
            },
            options,
          ),
        );
        return key;
      },
      readItemEntry<T>(tableId: string, id: number | string) {
        return normalizeListQueryItemEntry<T>(
          readRequiredEntry<StorageCacheEntry<unknown>>(
            listQueryItemStorageKey(tableId, id),
          ),
        );
      },
      readItemData<T>(tableId: string, id: number | string) {
        const entry = storage.readEntry<StorageCacheEntry<unknown>>(
          listQueryItemStorageKey(tableId, id),
        );
        return entry ? normalizeListQueryItemEntry<T>(entry).data.data : null;
      },
      readQueryEntry(params: unknown) {
        return normalizeListQueryEntry(
          readRequiredEntry<StorageCacheEntry<unknown>>(
            listQueryStorageKey(params),
          ),
        );
      },
    },
  };
}

type MockOpfsInitialScope = {
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
      loadedFields?: string[];
      timestamp?: number;
      version?: number;
    }>;
    queries?: Array<{
      params: unknown;
      items: Array<string | { tableId: string; id: number | string }>;
      hasMore?: boolean;
      timestamp?: number;
      version?: number;
    }>;
  };
};

function applyInitialScope(
  scope: PersistentTestStoreScope,
  initialScope: MockOpfsInitialScope,
) {
  if (initialScope.document) {
    scope.document.seed(initialScope.document.data, initialScope.document);
  }

  for (const item of initialScope.collection ?? []) {
    scope.collection.seedItem(item.payload, item.data, item);
  }

  for (const item of initialScope.listQuery?.items ?? []) {
    scope.listQuery.seedItem(item.tableId, item.id, item.data, item);
  }

  for (const query of initialScope.listQuery?.queries ?? []) {
    scope.listQuery.seedQuery(query.params, query.items, query);
  }
}

type MetadataState = {
  version: number;
  writtenAt: number;
  lastAccessAt: number;
  sizeBytes: number;
  customMetadata: Record<string, unknown>;
};

type PendingNamespaceCommit = {
  scope: AsyncStorageNamespaceScope;
  cancelFlush: (() => void) | null;
  flushPromise: Promise<void> | null;
  removes: Set<string>;
  touches: Map<string, number>;
  upserts: Map<
    string,
    AsyncStorageNamespaceCommitUpsert<unknown, Record<string, unknown>>
  >;
  waiters: Array<{ reject: (error: unknown) => void; resolve: () => void }>;
};

export function createMockOpfsStorageAdapter(
  options: MockOpfsStorageAdapterOptions & {
    storeName: string;
    sessionKey: string;
  },
): MockOpfsStorageAdapterBase & PersistentTestStoreScope;
export function createMockOpfsStorageAdapter(
  options?: MockOpfsStorageAdapterOptions,
): MockOpfsStorageAdapterBase;

export function createMockOpfsStorageAdapter({
  readDelayMs = 0,
  storeName,
  sessionKey,
  initialState,
}: MockOpfsStorageAdapterOptions = {}): MockOpfsStorageAdapterBase &
  Partial<PersistentTestStoreScope> {
  const persistentStore = createInMemoryPersistentTestStore();
  const metadataByFlatKey = new Map<string, MetadataState>();
  const payloadGetRequests: string[] = [];
  const payloadGetManyRequests: string[][] = [];
  const metadataListRequests: MetadataListRequest[] = [];
  const legacyListKeysFallbackRequests: string[] = [];
  const operations: MockOpfsOperation[] = [];
  let maintenanceState: AsyncStorageMaintenanceState = {
    ...DEFAULT_MAINTENANCE_STATE,
  };
  let startupCleanupScheduled = false;
  const pendingNamespaceCommits = new Map<string, PendingNamespaceCommit>();
  const recentTouchedBuckets = new Map<string, string>();

  const scopePrefix =
    storeName && sessionKey ? `tsdf.${sessionKey}.${storeName}.` : null;

  async function waitForReadDelay(): Promise<void> {
    if (readDelayMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, readDelayMs);
    });
  }

  function getNamespaceCommitKey(scope: AsyncStorageNamespaceScope): string {
    return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
  }

  function getTouchGuardKey(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): string {
    return `${getNamespaceCommitKey(scope)}::${key}`;
  }

  function getOrCreatePendingNamespaceCommit(
    scope: AsyncStorageNamespaceScope,
  ): PendingNamespaceCommit {
    const commitKey = getNamespaceCommitKey(scope);
    const existing = pendingNamespaceCommits.get(commitKey);
    if (existing) return existing;

    const created: PendingNamespaceCommit = {
      scope,
      cancelFlush: null,
      flushPromise: null,
      removes: new Set(),
      touches: new Map(),
      upserts: new Map(),
      waiters: [],
    };
    pendingNamespaceCommits.set(commitKey, created);
    return created;
  }

  function schedulePendingNamespaceFlush(
    pending: PendingNamespaceCommit,
  ): void {
    if (pending.cancelFlush !== null || pending.flushPromise !== null) return;

    const timeoutId = setTimeout(() => {
      pending.cancelFlush = null;
      void flushPendingNamespaceCommit(pending.scope);
    }, ASYNC_COMMIT_DEBOUNCE_MS);

    pending.cancelFlush = () => clearTimeout(timeoutId);
  }

  async function applyCommitToNamespace(
    scope: AsyncStorageNamespaceScope,
    {
      upserts = [],
      removes = [],
      touches = [],
    }: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
  ): Promise<void> {
    const now = Date.now();
    const touchesByKey = new Map(
      touches.map((touch) => [touch.key, touch.lastAccessAt ?? now]),
    );

    for (const key of removes) {
      removeFlatKey(getFlatKey(scope, key));
    }

    for (const upsert of upserts) {
      const flatKey = getFlatKey(scope, upsert.key);
      setFlatValue(
        flatKey,
        createCacheEntry(upsert.value, {
          timestamp: now,
          version: upsert.version,
        }),
      );

      const metadata = metadataByFlatKey.get(flatKey);
      if (!metadata) continue;
      metadata.customMetadata = {
        ...metadata.customMetadata,
        ...(upsert.metadata ?? {}),
      };
      metadata.lastAccessAt = touchesByKey.get(upsert.key) ?? now;
      metadata.writtenAt = now;
      metadata.version = upsert.version;
      metadataByFlatKey.set(flatKey, metadata);
    }

    for (const [key, lastAccessAt] of touchesByKey) {
      touchMetadata(scope, key, lastAccessAt);
    }

    operations.push({
      type: 'commit',
      scope,
      upserts: upserts.map((upsert) => upsert.key),
      removes: [...removes],
      touches: touches.map((touch) => ({
        key: touch.key,
        lastAccessAt: touch.lastAccessAt ?? null,
      })),
    });
  }

  async function flushPendingNamespaceCommit(
    scope: AsyncStorageNamespaceScope,
  ): Promise<void> {
    const commitKey = getNamespaceCommitKey(scope);
    const pending = pendingNamespaceCommits.get(commitKey);
    if (!pending) return;
    if (pending.flushPromise) {
      await pending.flushPromise;
      return;
    }

    pending.cancelFlush?.();
    pending.cancelFlush = null;

    const upserts = [...pending.upserts.values()];
    const removes = [...pending.removes];
    const touches = [...pending.touches.entries()].map(
      ([key, lastAccessAt]) => ({ key, lastAccessAt }),
    );
    const waiters = [...pending.waiters];
    pending.upserts = new Map();
    pending.removes = new Set();
    pending.touches = new Map();
    pending.waiters = [];

    if (upserts.length === 0 && removes.length === 0 && touches.length === 0) {
      pendingNamespaceCommits.delete(commitKey);
      for (const waiter of waiters) {
        waiter.resolve();
      }
      return;
    }

    pending.flushPromise = applyCommitToNamespace(scope, {
      upserts,
      removes,
      touches,
    })
      .then(() => {
        const currentBucket = String(bucketId(Date.now()));
        for (const touch of touches) {
          recentTouchedBuckets.set(
            getTouchGuardKey(scope, touch.key),
            String(bucketId(touch.lastAccessAt)),
          );
        }
        for (const upsert of upserts) {
          recentTouchedBuckets.set(
            getTouchGuardKey(scope, upsert.key),
            currentBucket,
          );
        }
        for (const waiter of waiters) {
          waiter.resolve();
        }
      })
      .catch((error) => {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
        throw error;
      })
      .finally(() => {
        pending.flushPromise = null;
        if (pending.waiters.length === 0) {
          pendingNamespaceCommits.delete(commitKey);
          return;
        }
        schedulePendingNamespaceFlush(pending);
      });

    await pending.flushPromise;
  }

  async function flushAllPendingNamespaceCommits(): Promise<void> {
    await Promise.all(
      [...pendingNamespaceCommits.values()].map(async (pending) =>
        flushPendingNamespaceCommit(pending.scope),
      ),
    );
  }

  function shouldEnqueueTouch(
    scope: AsyncStorageNamespaceScope,
    key: string,
    lastAccessAt: number,
    touchMode: 'never' | 'coarse' | 'force',
    now: number,
  ): boolean {
    if (touchMode === 'never') return false;

    const currentBucket = String(bucketId(now));
    if (
      touchMode !== 'force' &&
      String(bucketId(lastAccessAt)) === currentBucket
    ) {
      return false;
    }

    const touchKey = getTouchGuardKey(scope, key);
    if (recentTouchedBuckets.get(touchKey) === currentBucket) {
      return false;
    }

    const pending = pendingNamespaceCommits.get(getNamespaceCommitKey(scope));
    const pendingTouch = pending?.touches.get(key);
    return (
      pendingTouch === undefined ||
      String(bucketId(pendingTouch)) !== currentBucket
    );
  }

  function queueCommitToNamespace(
    scope: AsyncStorageNamespaceScope,
    args: AsyncStorageNamespaceCommitArgs<unknown, Record<string, unknown>>,
  ): Promise<void> {
    const pending = getOrCreatePendingNamespaceCommit(scope);
    const now = Date.now();

    for (const touch of args.touches ?? []) {
      pending.touches.set(touch.key, touch.lastAccessAt ?? now);
    }

    for (const remove of args.removes ?? []) {
      pending.upserts.delete(remove);
      pending.touches.delete(remove);
      pending.removes.add(remove);
    }

    for (const upsert of args.upserts ?? []) {
      pending.removes.delete(upsert.key);
      pending.upserts.set(upsert.key, upsert);
    }

    schedulePendingNamespaceFlush(pending);

    return new Promise<void>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  async function readProtectedRefs(
    targetSessionKey: string,
  ): Promise<Set<string>> {
    const protectedKeysSnapshot =
      getSessionProtectedKeysSnapshot(targetSessionKey);
    if (protectedKeysSnapshot !== null) {
      return new Set(protectedKeysSnapshot);
    }

    const registryKey = `tsdf.${targetSessionKey}._o_.p`;
    if (!persistentStore.storage.has(registryKey)) {
      return new Set();
    }

    const namespace = createNamespaceHandle<unknown>(
      getProtectedKeysStorageScope(targetSessionKey),
    );
    const entry = await namespace.get(PROTECTED_KEYS_STORAGE_ENTRY_KEY, {
      touch: 'never',
    });
    return new Set(parseProtectedKeys(entry?.value)?.keys ?? []);
  }

  async function performStartupCleanup(): Promise<void> {
    await flushAllPendingNamespaceCommits();
    const protectedRefsBySession = new Map<string, Set<string>>();

    for (const scope of getAllScopes()) {
      if (scope.kind === '__internal.protected') continue;

      const namespace = createNamespaceHandle(scope);
      const protectedRefs =
        protectedRefsBySession.get(scope.sessionKey) ??
        (await readProtectedRefs(scope.sessionKey));
      protectedRefsBySession.set(scope.sessionKey, protectedRefs);
      let cursor: string | null = null;
      const keysToRemove: string[] = [];

      do {
        const page = await namespace.listMetadata({
          cursor,
          limit: 100,
          order: 'key',
        });

        for (const entry of page.entries) {
          const flatKey = getFlatKey(scope, entry.key);
          const serializedRef = serializeProtectedRefForScope(scope, entry.key);
          const isProtected =
            protectedRefs.has(flatKey) || protectedRefs.has(serializedRef);
          const ageMs =
            Date.now() - Math.max(entry.lastAccessAt, entry.writtenAt);

          if (!isProtected && ageMs > OPFS_MAX_AGE_MS) {
            keysToRemove.push(entry.key);
          }
        }

        cursor = page.cursor;
      } while (cursor !== null);

      if (keysToRemove.length > 0) {
        await namespace.commit({ removes: keysToRemove });
      }
    }
  }

  async function runStartupCleanupIfDue(): Promise<void> {
    const now = Date.now();
    if (
      maintenanceState.lastSuccessfulCleanupAt !== null &&
      now - maintenanceState.lastSuccessfulCleanupAt <
        OPFS_STARTUP_CLEANUP_COOLDOWN_MS
    ) {
      return;
    }

    const holderId = 'mock-startup-cleanup';
    const currentLease = maintenanceState.startupCleanupLease;
    if (
      currentLease &&
      currentLease.holderId !== holderId &&
      currentLease.expiresAt > now
    ) {
      return;
    }

    maintenanceState = {
      ...maintenanceState,
      startupCleanupLease: {
        holderId,
        expiresAt: now + OPFS_STARTUP_CLEANUP_LEASE_TTL_MS,
      },
    };

    try {
      await performStartupCleanup();
      maintenanceState = {
        lastSuccessfulCleanupAt: Date.now(),
        startupCleanupLease: null,
      };
    } catch {
      // Leave the lease to expire naturally in tests.
    }
  }

  function scheduleStartupCleanupIfNeeded(): void {
    if (startupCleanupScheduled) return;
    startupCleanupScheduled = true;

    scheduleIdleCleanup(() => {
      void runStartupCleanupIfDue();
    });
  }

  function syncMetadata(flatKey: string): void {
    const parsed = parseFlatStorageKey(flatKey);
    if (!parsed) {
      metadataByFlatKey.delete(flatKey);
      return;
    }

    const entry =
      persistentStore.storage.readEntry<StorageCacheEntry<unknown>>(flatKey);
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.timestamp !== 'number'
    ) {
      metadataByFlatKey.delete(flatKey);
      return;
    }

    const raw = persistentStore.storage.getRaw(flatKey) ?? 'null';
    metadataByFlatKey.set(flatKey, {
      version: typeof entry.version === 'number' ? entry.version : 1,
      writtenAt: entry.timestamp,
      lastAccessAt:
        metadataByFlatKey.get(flatKey)?.lastAccessAt ?? entry.timestamp,
      sizeBytes: raw.length,
      customMetadata: buildCustomMetadata(parsed.scope, entry.data),
    });
  }

  function removeFlatKey(flatKey: string): void {
    persistentStore.storage.remove(flatKey);
    metadataByFlatKey.delete(flatKey);
  }

  function setFlatValue<T>(flatKey: string, value: T): void {
    persistentStore.storage.writeValue(flatKey, value);
    syncMetadata(flatKey);
  }

  function getMetadataEntry(
    scope: AsyncStorageNamespaceScope,
    key: string,
  ): AsyncStorageEntryMetadata<Record<string, unknown>> | null {
    const flatKey = getFlatKey(scope, key);
    syncMetadata(flatKey);
    const metadata = metadataByFlatKey.get(flatKey);
    if (!metadata) return null;

    return {
      key,
      payloadRef: flatKey,
      writtenAt: metadata.writtenAt,
      lastAccessAt: metadata.lastAccessAt,
      sizeBytes: metadata.sizeBytes,
      version: metadata.version,
      ...metadata.customMetadata,
    };
  }

  function getNamespaceKeys(scope: AsyncStorageNamespaceScope): string[] {
    const prefix = getNamespacePrefix(scope);
    return filterAndMap(persistentStore.storage.listKeys(prefix), (flatKey) => {
      const entry = parseFlatStorageKey(flatKey);
      return entry &&
        entry.scope.kind === scope.kind &&
        entry.scope.sessionKey === scope.sessionKey &&
        entry.scope.storeName === scope.storeName
        ? entry.key
        : false;
    });
  }

  function getAllScopes(): AsyncStorageNamespaceScope[] {
    const parsedEntries = filterAndMap(
      persistentStore.storage.listKeys('tsdf.'),
      (flatKey) => parseFlatStorageKey(flatKey) ?? false,
    );
    const scopes: AsyncStorageNamespaceScope[] = [];
    const seenScopes = new Set<string>();

    for (const entry of parsedEntries) {
      const scopeKey = `${entry.scope.sessionKey}::${entry.scope.storeName}::${entry.scope.kind}`;
      if (seenScopes.has(scopeKey)) continue;
      seenScopes.add(scopeKey);
      scopes.push(entry.scope);
    }

    return scopes;
  }

  function touchMetadata(
    scope: AsyncStorageNamespaceScope,
    key: string,
    lastAccessAt: number,
  ): void {
    const flatKey = getFlatKey(scope, key);
    const metadata = metadataByFlatKey.get(flatKey);
    if (!metadata) return;
    metadata.lastAccessAt = lastAccessAt;
    metadataByFlatKey.set(flatKey, metadata);
  }

  const scopedHelpers =
    storeName && sessionKey
      ? createScopeHelpers(persistentStore.storage, storeName, sessionKey)
      : null;

  for (const [key, value] of Object.entries(initialState?.rawEntries ?? {})) {
    if (typeof value === 'string') {
      persistentStore.storage.writeRaw(key, value);
    } else {
      persistentStore.storage.writeValue(key, value);
    }
    syncMetadata(key);
  }

  if (initialState) {
    if (!scopedHelpers || storeName === undefined || sessionKey === undefined) {
      throw new Error(
        'createMockOpfsStorageAdapter initialState requires storeName and sessionKey',
      );
    }

    applyInitialScope(scopedHelpers, {
      storeName,
      sessionKey,
      ...initialState,
    });

    for (const flatKey of persistentStore.storage.listKeys('tsdf.')) {
      syncMetadata(flatKey);
    }
  }

  function createNamespaceHandle<TValue>(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageNamespaceHandle<TValue> {
    async function readOne(
      key: string,
      options: { touch?: 'never' | 'coarse' | 'force' } = {},
      recordRequest = true,
    ) {
      await flushPendingNamespaceCommit(scope);
      const flatKey = getFlatKey(scope, key);
      const touchMode = options.touch ?? 'coarse';
      if (recordRequest) {
        payloadGetRequests.push(flatKey);
      }
      await waitForReadDelay();

      const entry =
        persistentStore.storage.readEntry<StorageCacheEntry<TValue>>(flatKey);
      const metadata = getMetadataEntry(scope, key);
      const exists = entry !== null && metadata !== null;
      operations.push({
        type: 'get',
        scope,
        key,
        flatKey,
        touch: touchMode,
        exists,
      });
      if (!entry || !metadata) return null;

      const now = Date.now();
      const shouldTouch = shouldEnqueueTouch(
        scope,
        key,
        metadata.lastAccessAt,
        touchMode,
        now,
      );

      if (shouldTouch) {
        void queueCommitToNamespace(scope, {
          touches: [{ key, lastAccessAt: now }],
        });
      }

      return { value: entry.data, metadata };
    }

    return {
      get(key, options) {
        return readOne(key, options);
      },
      async getMany(keys, options) {
        const flatKeys = keys.map((key) => getFlatKey(scope, key));
        payloadGetManyRequests.push(flatKeys);
        const entries = await Promise.all(
          keys.map((key) => readOne(key, options, true)),
        );
        operations.push({
          type: 'getMany',
          scope,
          keys: [...keys],
          flatKeys,
          touch: options?.touch ?? 'coarse',
          hitCount: entries.filter((entry) => entry !== null).length,
        });
        return entries;
      },
      async commit({ upserts = [], removes = [], touches = [] }) {
        await queueCommitToNamespace(scope, { upserts, removes, touches });
      },
      async listMetadata({ cursor = null, limit = null, order = 'key' } = {}) {
        await flushPendingNamespaceCommit(scope);
        metadataListRequests.push({ scope, cursor, limit, order });

        const offset = decodeCursor(cursor);
        const keys = getNamespaceKeys(scope);
        const entries = filterAndMap(
          keys,
          (key) => getMetadataEntry(scope, key) ?? false,
        ).sort((left, right) => compareMetadata(left, right, order));

        const pageSize = Math.max(1, (limit ?? entries.length) || 1);
        const nextEntries = entries.slice(offset, offset + pageSize);
        const nextCursor =
          offset + nextEntries.length >= entries.length
            ? null
            : encodeCursor(offset + nextEntries.length);

        operations.push({
          type: 'listMetadata',
          scope,
          cursor,
          limit,
          order,
          resultCount: nextEntries.length,
          nextCursor,
        });

        return { entries: nextEntries, cursor: nextCursor };
      },
      async clear() {
        await flushPendingNamespaceCommit(scope);
        const removedKeys = getNamespaceKeys(scope);
        operations.push({ type: 'clear', scope, removedKeys });
        for (const key of removedKeys) {
          removeFlatKey(getFlatKey(scope, key));
        }
      },
    };
  }

  const adapter = {
    kind: 'async',
    openNamespace(scope: AsyncStorageNamespaceScope) {
      scheduleStartupCleanupIfNeeded();
      return createNamespaceHandle(scope);
    },
    async readMaintenanceState() {
      operations.push({ type: 'readMaintenanceState' });
      return { ...maintenanceState };
    },
    async tryAcquireStartupCleanupLease({
      holderId,
      ttlMs,
    }: {
      holderId: string;
      ttlMs: number;
    }) {
      const now = Date.now();
      const currentLease = maintenanceState.startupCleanupLease;

      if (
        currentLease &&
        currentLease.holderId !== holderId &&
        currentLease.expiresAt > now
      ) {
        operations.push({
          type: 'tryAcquireStartupCleanupLease',
          holderId,
          ttlMs,
          acquired: false,
        });
        return false;
      }

      maintenanceState = {
        ...maintenanceState,
        startupCleanupLease: { holderId, expiresAt: now + ttlMs },
      };

      operations.push({
        type: 'tryAcquireStartupCleanupLease',
        holderId,
        ttlMs,
        acquired: true,
      });

      return true;
    },
    async finishStartupCleanup({
      holderId,
      finishedAt,
    }: {
      holderId: string;
      finishedAt: number;
    }) {
      if (
        maintenanceState.startupCleanupLease &&
        maintenanceState.startupCleanupLease.holderId !== holderId
      ) {
        return;
      }

      maintenanceState = {
        lastSuccessfulCleanupAt: finishedAt,
        startupCleanupLease: null,
      };

      operations.push({ type: 'finishStartupCleanup', holderId, finishedAt });
    },
    resetForTests() {
      startupCleanupScheduled = false;
      maintenanceState = { ...DEFAULT_MAINTENANCE_STATE };
      pendingNamespaceCommits.clear();
      recentTouchedBuckets.clear();
    },
  } as AsyncStorageAdapter;

  return {
    adapter,
    storage: persistentStore.storage,
    scope: persistentStore.scope,
    ...(scopedHelpers ?? {}),
    readRequests: payloadGetRequests,
    payloadGetRequests,
    payloadGetManyRequests,
    metadataListRequests,
    legacyListKeysFallbackRequests,
    operations,
    scopeReadRequests() {
      if (!scopePrefix) {
        return [...payloadGetRequests];
      }

      return payloadGetRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    clearReadRequests() {
      payloadGetRequests.length = 0;
      payloadGetManyRequests.length = 0;
    },
    clearInstrumentation() {
      payloadGetRequests.length = 0;
      payloadGetManyRequests.length = 0;
      metadataListRequests.length = 0;
      legacyListKeysFallbackRequests.length = 0;
      operations.length = 0;
    },
    getRaw(key: string) {
      return persistentStore.storage.getRaw(key);
    },
    has(key: string) {
      return persistentStore.storage.has(key);
    },
    setRaw(key: string, raw: string) {
      persistentStore.storage.writeRaw(key, raw);
      syncMetadata(key);
    },
    setValue<T>(key: string, value: T) {
      setFlatValue(key, value);
    },
  };
}
