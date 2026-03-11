/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/require-await, @ls-stack/use-top-level-regex, @ls-stack/improved-no-unnecessary-condition -- This in-memory test adapter intentionally favors concise fixture code over production-style lint constraints. */
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import type {
  AsyncStorageAdapter,
  AsyncStorageEntryMetadata,
  AsyncStorageMaintenanceState,
  AsyncStorageMetadataOrder,
  AsyncStorageNamespaceHandle,
  AsyncStorageNamespaceScope,
  StorageCacheEntry,
  StorageAdapter,
} from '../../src/persistentStorage/types';
import type {
  PersistedCollectionItemData,
  PersistedDocumentData,
  PersistedListQueryData,
  PersistedListQueryItemData,
} from '../../src/persistentStorage/types';
import type { PersistentTestStoreScope } from '../utils/persistentStorageTestStore';

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

type MockStorage = {
  writeRaw: (key: string, raw: string) => void;
  writeValue: <T>(key: string, value: T) => void;
  readEntry: <T>(key: string) => T | null;
  remove: (key: string) => void;
  listKeys: (prefix: string) => string[];
  has: (key: string) => boolean;
  getRaw: (key: string) => string | null;
};

type MockOpfsStorageAdapterBase = {
  adapter: StorageAdapter;
  storage: MockStorage;
  scope: (storeName: string, sessionKey: string) => PersistentTestStoreScope;
  readRequests: string[];
  scopeReadRequests: () => string[];
  clearReadRequests: () => void;
  getRaw: (key: string) => string | null;
  has: (key: string) => boolean;
  setRaw: (key: string, raw: string) => void;
  setValue: <T>(key: string, value: T) => void;
};

const DEFAULT_MAINTENANCE_STATE: AsyncStorageMaintenanceState = {
  lastSuccessfulCleanupAt: null,
  startupCleanupLease: null,
};

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

type ListQueryItemRef = string | { tableId: string; id: number | string };

function normalizeListQueryItemRef(item: ListQueryItemRef): string {
  if (typeof item === 'string') return item;
  return getCompositeKey(`${item.tableId}||${item.id}`);
}

type ListQuerySeedItemOptions = {
  timestamp?: number;
  version?: number;
  loadedFields?: string[];
};

function createScopeHelpers(
  storage: MockStorage,
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
        options?: ListQuerySeedItemOptions,
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

type ParsedFlatKey = { scope: AsyncStorageNamespaceScope; key: string };

function parseFlatStorageKey(key: string): ParsedFlatKey | null {
  let match =
    /^tsdf\.([^.]+)\.(.+?)\.collection\.item\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.listQuery\.item\.(.+)$/.exec(key) ??
    /^tsdf\.([^.]+)\.(.+?)\.listQuery\.query\.(.+)$/.exec(key);

  if (match) {
    const sessionKey = match[1];
    const storeName = match[2];
    const entryKey = match[3];
    if (!sessionKey || !storeName || !entryKey) {
      return null;
    }
    if (key.includes('.collection.item.')) {
      return {
        scope: { sessionKey, storeName, kind: 'collection.item' },
        key: entryKey,
      };
    }
    if (key.includes('.listQuery.item.')) {
      return {
        scope: { sessionKey, storeName, kind: 'listQuery.item' },
        key: entryKey,
      };
    }
    return {
      scope: { sessionKey, storeName, kind: 'listQuery.query' },
      key: entryKey,
    };
  }

  match = /^tsdf\.([^.]+)\.__offline__\.protected$/.exec(key);
  if (match) {
    const sessionKey = match[1];
    if (!sessionKey) return null;
    return {
      scope: {
        sessionKey,
        storeName: '__offline__',
        kind: '__internal.protected',
      },
      key: 'registry',
    };
  }

  match = /^tsdf\.([^.]+)\.__offline__\.session$/.exec(key);
  if (match) {
    const sessionKey = match[1];
    if (!sessionKey) return null;
    return {
      scope: { sessionKey, storeName: '__offline__', kind: 'document' },
      key: 'session',
    };
  }

  match = /^tsdf\.([^.]+)\.(.+)$/.exec(key);
  if (!match) return null;
  const sessionKey = match[1];
  const storeName = match[2];
  if (!sessionKey || !storeName) return null;

  return {
    scope: { sessionKey, storeName, kind: 'document' },
    key: 'document',
  };
}

function getNamespaceId(scope: AsyncStorageNamespaceScope): string {
  return JSON.stringify([scope.sessionKey, scope.storeName, scope.kind]);
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
    case '__internal.protected':
      return `tsdf.${scope.sessionKey}.__offline__.protected`;
    default:
      return `tsdf.${scope.sessionKey}.${scope.storeName}.${scope.kind}.${key}`;
  }
}

type StoredNamespaceEntry = {
  value: unknown;
  metadata: AsyncStorageEntryMetadata<Record<string, unknown>>;
};

function toLegacyRaw(
  scope: AsyncStorageNamespaceScope,
  entry: StoredNamespaceEntry,
): string {
  const { metadata, value } = entry;

  switch (scope.kind) {
    case 'document':
      return JSON.stringify({
        data: value as PersistedDocumentData<unknown>,
        timestamp: metadata.writtenAt,
        version: metadata.version,
      } satisfies StorageCacheEntry<PersistedDocumentData<unknown>>);
    case 'collection.item':
      return JSON.stringify({
        data: {
          data: (value as { data: unknown }).data,
          payload: metadata.payload,
        },
        timestamp: metadata.writtenAt,
        version: metadata.version,
      } satisfies StorageCacheEntry<PersistedCollectionItemData<unknown>>);
    case 'listQuery.item':
      return JSON.stringify({
        data: {
          data: (value as { data: unknown }).data,
          payload: metadata.payload,
          loadedFields: (value as { loadedFields?: string[] }).loadedFields,
        },
        timestamp: metadata.writtenAt,
        version: metadata.version,
      } satisfies StorageCacheEntry<PersistedListQueryItemData<unknown>>);
    case 'listQuery.query':
      return JSON.stringify({
        data: {
          payload: metadata.payload,
          items: (metadata.items ?? []) as string[],
          hasMore: Boolean(metadata.hasMore),
        },
        timestamp: metadata.writtenAt,
        version: metadata.version,
      } satisfies StorageCacheEntry<PersistedListQueryData>);
    case '__internal.protected':
      return JSON.stringify({
        data: value as { keys: string[] },
        timestamp: metadata.writtenAt,
        version: metadata.version,
      } satisfies StorageCacheEntry<{ keys: string[] }>);
    default:
      return JSON.stringify({
        data: value,
        timestamp: metadata.writtenAt,
        version: metadata.version,
      });
  }
}

function fromLegacyRaw(
  scope: AsyncStorageNamespaceScope,
  key: string,
  raw: string,
): StoredNamespaceEntry | null {
  const entry = parseJson<StorageCacheEntry<unknown>>(raw);
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const metadataBase = {
    key,
    payloadRef: `legacy:${getNamespaceId(scope)}:${key}`,
    writtenAt: entry.timestamp ?? Date.now(),
    lastAccessAt: entry.timestamp ?? Date.now(),
    sizeBytes: raw.length,
    version: entry.version ?? 1,
  };

  switch (scope.kind) {
    case 'document':
      return { value: entry.data, metadata: metadataBase };
    case 'collection.item': {
      const data = entry.data as PersistedCollectionItemData<unknown>;
      return {
        value: { data: data?.data },
        metadata: { ...metadataBase, payload: data?.payload },
      };
    }
    case 'listQuery.item': {
      const data = entry.data as PersistedListQueryItemData<unknown>;
      return {
        value: { data: data?.data, loadedFields: data?.loadedFields },
        metadata: { ...metadataBase, payload: data?.payload },
      };
    }
    case 'listQuery.query': {
      const data = entry.data as PersistedListQueryData;
      return {
        value: {},
        metadata: {
          ...metadataBase,
          payload: data?.payload,
          items: data?.items ?? [],
          hasMore: data?.hasMore ?? false,
        },
      };
    }
    case '__internal.protected':
      return { value: entry.data, metadata: metadataBase };
    default:
      return { value: entry.data, metadata: metadataBase };
  }
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
  const rawEntries = new Map<string, string>();
  const namespaceEntries = new Map<string, Map<string, StoredNamespaceEntry>>();
  const readRequests: string[] = [];
  const scopePrefix =
    storeName && sessionKey ? `tsdf.${sessionKey}.${storeName}.` : null;
  let payloadSeq = 0;
  let maintenanceState: AsyncStorageMaintenanceState = {
    ...DEFAULT_MAINTENANCE_STATE,
  };

  function getNamespaceMap(scope: AsyncStorageNamespaceScope) {
    const namespaceId = getNamespaceId(scope);
    let entries = namespaceEntries.get(namespaceId);

    if (!entries) {
      entries = new Map();
      namespaceEntries.set(namespaceId, entries);
    }

    return entries;
  }

  function syncFlatEntry(scope: AsyncStorageNamespaceScope, key: string): void {
    const namespaceEntry = getNamespaceMap(scope).get(key);
    const flatKey = getFlatKey(scope, key);

    if (!namespaceEntry) {
      rawEntries.delete(flatKey);
      return;
    }

    rawEntries.set(flatKey, toLegacyRaw(scope, namespaceEntry));
  }

  function writeParsedEntry(key: string, raw: string): void {
    rawEntries.set(key, raw);
    const parsedKey = parseFlatStorageKey(key);
    if (!parsedKey) return;

    const namespaceEntry = fromLegacyRaw(parsedKey.scope, parsedKey.key, raw);
    if (!namespaceEntry) return;

    getNamespaceMap(parsedKey.scope).set(parsedKey.key, namespaceEntry);
    syncFlatEntry(parsedKey.scope, parsedKey.key);
  }

  const storage: MockStorage = {
    writeRaw(key: string, raw: string) {
      writeParsedEntry(key, raw);
    },
    writeValue<T>(key: string, value: T) {
      writeParsedEntry(key, JSON.stringify(value));
    },
    readEntry<T>(key: string): T | null {
      const raw = rawEntries.get(key);
      if (raw === undefined) return null;
      return parseJson<T>(raw);
    },
    remove(key: string) {
      rawEntries.delete(key);
      const parsedKey = parseFlatStorageKey(key);
      if (!parsedKey) return;
      getNamespaceMap(parsedKey.scope).delete(parsedKey.key);
    },
    listKeys(prefix: string): string[] {
      return [...rawEntries.keys()].filter((key) => key.startsWith(prefix));
    },
    has(key: string) {
      return rawEntries.has(key);
    },
    getRaw(key: string) {
      return rawEntries.get(key) ?? null;
    },
  };

  async function waitForReadDelay() {
    if (readDelayMs <= 0) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, readDelayMs);
    });
  }

  function listNamespaceMetadata(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageEntryMetadata<Record<string, unknown>>[] {
    return [...getNamespaceMap(scope).values()].map((entry) => entry.metadata);
  }

  const asyncAdapter: AsyncStorageAdapter = {
    openNamespace<
      TValue,
      TCustomMetadata extends Record<string, unknown> = Record<string, never>,
    >(
      scope: AsyncStorageNamespaceScope,
    ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata> {
      return {
        async get(key, options = {}) {
          const result = await this.getMany([key], options);
          return result[0] ?? null;
        },

        async getMany(keys, options = {}) {
          if (keys.length === 0) return [];

          for (const key of keys) {
            readRequests.push(getFlatKey(scope, key));
          }

          await waitForReadDelay();

          const now = Date.now();
          const results = keys.map((key) => {
            const entry = getNamespaceMap(scope).get(key);
            if (!entry) return null;

            const touchMode = options.touch ?? 'coarse';
            const nextAccessBucket = Math.floor(now / (6 * 60 * 60 * 1000));
            const prevAccessBucket = Math.floor(
              entry.metadata.lastAccessAt / (6 * 60 * 60 * 1000),
            );

            if (
              touchMode === 'force' ||
              (touchMode === 'coarse' && nextAccessBucket !== prevAccessBucket)
            ) {
              entry.metadata.lastAccessAt = now;
              syncFlatEntry(scope, key);
            }

            return {
              value: entry.value as TValue,
              metadata:
                entry.metadata as AsyncStorageEntryMetadata<TCustomMetadata>,
            };
          });

          return results;
        },

        async commit(args) {
          const upserts = args.upserts ?? [];
          const removes = new Set(args.removes ?? []);
          const touches = new Map(
            (args.touches ?? []).map((touch) => [
              touch.key,
              touch.lastAccessAt,
            ]),
          );
          const namespaceMap = getNamespaceMap(scope);
          const now = Date.now();

          for (const key of removes) {
            namespaceMap.delete(key);
            syncFlatEntry(scope, key);
          }

          for (const [key, lastAccessAt] of touches) {
            const existing = namespaceMap.get(key);
            if (!existing || removes.has(key)) continue;
            existing.metadata.lastAccessAt = lastAccessAt ?? now;
            syncFlatEntry(scope, key);
          }

          for (const upsert of upserts) {
            const existing = namespaceMap.get(upsert.key);
            const rawValue = JSON.stringify(upsert.value);
            namespaceMap.set(upsert.key, {
              value: upsert.value,
              metadata: {
                key: upsert.key,
                payloadRef: `mock-payload-${payloadSeq++}`,
                writtenAt: now,
                lastAccessAt:
                  touches.get(upsert.key) ??
                  existing?.metadata.lastAccessAt ??
                  now,
                sizeBytes: rawValue.length,
                version: upsert.version,
                ...(upsert.metadata ?? {}),
              },
            });
            syncFlatEntry(scope, upsert.key);
          }
        },

        async listMetadata(args = {}) {
          const order = args.order ?? 'key';
          const limit = Math.max(1, args.limit ?? 100);
          const offset = args.cursor
            ? (parseJson<{
                offset?: number;
                order?: AsyncStorageMetadataOrder;
              }>(args.cursor)?.offset ?? 0)
            : 0;

          const entries = listNamespaceMetadata(scope).sort((left, right) => {
            if (order === 'key') return left.key.localeCompare(right.key);

            if (left.lastAccessAt !== right.lastAccessAt) {
              return order === 'lru-asc'
                ? left.lastAccessAt - right.lastAccessAt
                : right.lastAccessAt - left.lastAccessAt;
            }

            return left.key.localeCompare(right.key);
          });

          const nextEntries = entries.slice(offset, offset + limit);
          const cursor =
            offset + nextEntries.length >= entries.length
              ? null
              : JSON.stringify({ offset: offset + nextEntries.length, order });

          return {
            entries:
              nextEntries as AsyncStorageEntryMetadata<TCustomMetadata>[],
            cursor,
          };
        },

        async clear() {
          for (const key of [...getNamespaceMap(scope).keys()]) {
            getNamespaceMap(scope).delete(key);
            syncFlatEntry(scope, key);
          }
        },
      };
    },

    async readMaintenanceState() {
      return {
        lastSuccessfulCleanupAt: maintenanceState.lastSuccessfulCleanupAt,
        startupCleanupLease: maintenanceState.startupCleanupLease
          ? { ...maintenanceState.startupCleanupLease }
          : null,
      };
    },

    async tryAcquireStartupCleanupLease({ holderId, ttlMs }) {
      const now = Date.now();
      const currentLease = maintenanceState.startupCleanupLease;

      if (
        currentLease &&
        currentLease.holderId !== holderId &&
        currentLease.expiresAt > now
      ) {
        return false;
      }

      maintenanceState = {
        ...maintenanceState,
        startupCleanupLease: { holderId, expiresAt: now + ttlMs },
      };
      return true;
    },

    async finishStartupCleanup({ holderId, finishedAt }) {
      const currentLease = maintenanceState.startupCleanupLease;
      if (currentLease && currentLease.holderId !== holderId) {
        return;
      }

      maintenanceState = {
        lastSuccessfulCleanupAt: finishedAt,
        startupCleanupLease: null,
      };
    },
  };

  const scopeFactory = (name: string, session: string) =>
    createScopeHelpers(storage, name, session);
  const scopedHelpers =
    storeName && sessionKey ? scopeFactory(storeName, sessionKey) : null;

  for (const [key, value] of Object.entries(initialState?.rawEntries ?? {})) {
    if (typeof value === 'string') {
      storage.writeRaw(key, value);
    } else {
      storage.writeValue(key, value);
    }
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
  }

  return {
    adapter: asyncAdapter,
    storage,
    scope: scopeFactory,
    ...(scopedHelpers ?? {}),
    readRequests,
    scopeReadRequests() {
      if (!scopePrefix) {
        return [...readRequests];
      }

      return readRequests.map((key) =>
        key.startsWith(scopePrefix) ? key.slice(scopePrefix.length) : key,
      );
    },
    clearReadRequests() {
      readRequests.length = 0;
    },
    getRaw(key: string) {
      return storage.getRaw(key);
    },
    has(key: string) {
      return storage.has(key);
    },
    setRaw(key: string, raw: string) {
      storage.writeRaw(key, raw);
    },
    setValue<T>(key: string, value: T) {
      storage.writeValue(key, value);
    },
  };
}
