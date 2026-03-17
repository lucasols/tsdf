/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/require-await, @ls-stack/use-top-level-regex, @ls-stack/improved-no-unnecessary-condition -- This in-memory test adapter intentionally favors concise fixture code over production-style lint constraints. */
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import type {
  AsyncStorageAdapter,
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
  StorageAdapter,
} from '../../src/persistentStorage/types';
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
  adapter: StorageAdapter;
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
      return 'payload' in value ? { payload: value.payload } : {};
    case 'listQuery.item':
      return 'payload' in value ? { payload: value.payload } : {};
    case 'listQuery.query':
      return {
        payload: 'payload' in value ? value.payload : undefined,
        items: Array.isArray((value as PersistedListQueryData).items)
          ? (value as PersistedListQueryData).items
          : [],
        hasMore:
          'hasMore' in value &&
          (value as PersistedListQueryData).hasMore === true,
      };
    default:
      return {};
  }
}

type ParsedFlatKey = { scope: AsyncStorageNamespaceScope; key: string };

function parseFlatStorageKey(key: string): ParsedFlatKey | null {
  let match =
    /^tsdf\.([^.]+)\.(.+?)\.collection\.item\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.listQuery\.item\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.listQuery\.query\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.offline\.queue\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.offline\.conflict\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.offline\.entity\.(.+)$/.exec(key);

  if (match) {
    const [fullMatch, sessionKey, storeName, entryKey] = match;
    if (!sessionKey || !storeName || !entryKey) {
      return null;
    }

    const kind = fullMatch.includes('.collection.item.')
      ? 'collection.item'
      : fullMatch.includes('.listQuery.item.')
        ? 'listQuery.item'
        : fullMatch.includes('.listQuery.query.')
          ? 'listQuery.query'
          : fullMatch.includes('.offline.queue.')
            ? 'offline.queue'
            : fullMatch.includes('.offline.conflict.')
              ? 'offline.conflict'
              : 'offline.entity';

    return { scope: { sessionKey, storeName, kind }, key: entryKey };
  }

  match = /^tsdf\.([^.]+)\.__offline__\.protected$/.exec(key);
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
      return `tsdf.${scope.sessionKey}.${scope.storeName}.collection.item.${key}`;
    case 'listQuery.item':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.listQuery.item.${key}`;
    case 'listQuery.query':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.listQuery.query.${key}`;
    case 'offline.queue':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.offline.queue.${key}`;
    case 'offline.conflict':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.offline.conflict.${key}`;
    case 'offline.entity':
      return `tsdf.${scope.sessionKey}.${scope.storeName}.offline.entity.${key}`;
    case '__internal.protected':
      return `tsdf.${scope.sessionKey}.__offline__.protected`;
  }
}

function getNamespacePrefix(scope: AsyncStorageNamespaceScope): string {
  switch (scope.kind) {
    case 'document':
      return scope.storeName === '__offline__'
        ? `tsdf.${scope.sessionKey}.__offline__.`
        : `tsdf.${scope.sessionKey}.${scope.storeName}`;
    case '__internal.protected':
      return `tsdf.${scope.sessionKey}.__offline__.protected`;
    default:
      return `tsdf.${scope.sessionKey}.${scope.storeName}.${scope.kind}.`;
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
    return `tsdf.${sessionKey}.${storeName}.collection.item.${collectionItemKey(payload)}`;
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
    return `tsdf.${sessionKey}.${storeName}.listQuery.item.${listQueryItemKey(tableId, id)}`;
  }

  function listQueryStorageKey(params: unknown): string {
    return `tsdf.${sessionKey}.${storeName}.listQuery.query.${getCompositeKey(params)}`;
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
          createCacheEntry<PersistedDocumentData<T>>({ data }, options),
        );
        return documentStorageKey;
      },
      readEntry<T>() {
        return readRequiredEntry<StorageCacheEntry<PersistedDocumentData<T>>>(
          documentStorageKey,
        );
      },
      readData<T>() {
        return (
          storage.readEntry<StorageCacheEntry<PersistedDocumentData<T>>>(
            documentStorageKey,
          )?.data.data ?? null
        );
      },
    },
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
          createCacheEntry<PersistedCollectionItemData<T>>(
            { data, payload },
            options,
          ),
        );
        return key;
      },
      readItemEntry<T>(payload: string) {
        return readRequiredEntry<
          StorageCacheEntry<PersistedCollectionItemData<T>>
        >(collectionItemStorageKey(payload));
      },
      readItemData<T>(payload: string) {
        return (
          storage.readEntry<StorageCacheEntry<PersistedCollectionItemData<T>>>(
            collectionItemStorageKey(payload),
          )?.data.data ?? null
        );
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
          createCacheEntry<PersistedListQueryItemData<T>>(
            { data, payload, loadedFields: options?.loadedFields },
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
          createCacheEntry<PersistedListQueryData>(
            {
              payload: params,
              items: items.map(normalizeListQueryItemRef),
              hasMore: options?.hasMore ?? false,
            },
            options,
          ),
        );
        return key;
      },
      readItemEntry<T>(tableId: string, id: number | string) {
        return readRequiredEntry<
          StorageCacheEntry<PersistedListQueryItemData<T>>
        >(listQueryItemStorageKey(tableId, id));
      },
      readItemData<T>(tableId: string, id: number | string) {
        return (
          storage.readEntry<StorageCacheEntry<PersistedListQueryItemData<T>>>(
            listQueryItemStorageKey(tableId, id),
          )?.data.data ?? null
        );
      },
      readQueryEntry(params: unknown) {
        return readRequiredEntry<StorageCacheEntry<PersistedListQueryData>>(
          listQueryStorageKey(params),
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

  const scopePrefix =
    storeName && sessionKey ? `tsdf.${sessionKey}.${storeName}.` : null;

  async function waitForReadDelay(): Promise<void> {
    if (readDelayMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, readDelayMs);
    });
  }

  async function readProtectedRefs(sessionKey: string): Promise<Set<string>> {
    const registryKey = `tsdf.${sessionKey}.__offline__.protected`;
    if (!persistentStore.storage.has(registryKey)) {
      return new Set();
    }

    const namespace = createNamespaceHandle<{ keys: string[] }>({
      sessionKey,
      storeName: '__offline__',
      kind: '__internal.protected',
    });
    const entry = await namespace.get('registry', { touch: 'never' });
    return new Set(entry?.value.keys ?? []);
  }

  async function performStartupCleanup(): Promise<void> {
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
      typeof entry.timestamp !== 'number' ||
      typeof entry.version !== 'number'
    ) {
      metadataByFlatKey.delete(flatKey);
      return;
    }

    const raw = persistentStore.storage.getRaw(flatKey) ?? 'null';
    metadataByFlatKey.set(flatKey, {
      version: entry.version,
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
    return persistentStore.storage
      .listKeys(prefix)
      .map((flatKey) => parseFlatStorageKey(flatKey))
      .filter(
        (entry): entry is ParsedFlatKey => entry?.scope.kind === scope.kind,
      )
      .filter((entry) => {
        return (
          entry.scope.sessionKey === scope.sessionKey &&
          entry.scope.storeName === scope.storeName
        );
      })
      .map((entry) => entry.key);
  }

  function getAllScopes(): AsyncStorageNamespaceScope[] {
    return [...persistentStore.storage.listKeys('tsdf.')]
      .map((flatKey) => parseFlatStorageKey(flatKey))
      .filter((entry): entry is ParsedFlatKey => entry !== null)
      .reduce<AsyncStorageNamespaceScope[]>((scopes, entry) => {
        if (
          scopes.some(
            (scope) =>
              scope.sessionKey === entry.scope.sessionKey &&
              scope.storeName === entry.scope.storeName &&
              scope.kind === entry.scope.kind,
          )
        ) {
          return scopes;
        }

        scopes.push(entry.scope);
        return scopes;
      }, []);
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
      const shouldTouch =
        touchMode === 'force' ||
        (touchMode === 'coarse' &&
          bucketId(metadata.lastAccessAt) !== bucketId(now));

      if (shouldTouch) {
        touchMetadata(scope, key, now);
      }

      return {
        value: entry.data,
        metadata: {
          ...metadata,
          ...(shouldTouch ? { lastAccessAt: now } : {}),
        },
      };
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
          if (touchesByKey.has(upsert.key)) {
            metadata.lastAccessAt =
              touchesByKey.get(upsert.key) ?? metadata.lastAccessAt;
          } else {
            metadata.lastAccessAt = now;
          }
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
      },
      async listMetadata({ cursor = null, limit = null, order = 'key' } = {}) {
        metadataListRequests.push({ scope, cursor, limit, order });

        const offset = decodeCursor(cursor);
        const keys = getNamespaceKeys(scope);
        const entries = keys
          .map((key) => getMetadataEntry(scope, key))
          .filter(
            (
              entry,
            ): entry is AsyncStorageEntryMetadata<Record<string, unknown>> =>
              entry !== null,
          )
          .sort((left, right) => compareMetadata(left, right, order));

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
