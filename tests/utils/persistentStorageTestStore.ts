import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { ItemLoadedFields } from '../../src/listQueryStore/types';
import {
  createCompactListQueryLocalStorageEntry,
  parseCompactListQueryLocalStorageEntry,
} from '../../src/persistentStorage/compactListQueryLocalStorageEntry';
import {
  createCompactLocalStorageEntry,
  parseCompactLocalStorageEntry,
} from '../../src/persistentStorage/compactLocalStorageEntry';
import {
  getManagedLocalStorageManifestKeyForSingle,
  readManagedLocalStorageNamespaceEntryByPayload,
  readManagedLocalStorageSingleEntryByPayload,
  upsertManagedLocalStorageNamespaceEntry,
  upsertManagedLocalStorageSingleEntry,
} from '../../src/persistentStorage/localStorageMetadata';
import type {
  PersistedCollectionItemData,
  PersistedDocumentData,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageCacheEntry,
} from '../../src/persistentStorage/types';

const utf8Encoder = new TextEncoder();

type StorageSeedOptions = { timestamp?: number; version?: number };

type ListQuerySeedItemOptions = StorageSeedOptions & {
  loadedFields?: ItemLoadedFields;
};

type ListQueryItemRef = string | { tableId: string; id: number | string };

type GlobalMaintenanceState = { lastCleanupAt: number | null };

function parseGlobalMaintenanceRaw(
  raw: string | null,
): GlobalMaintenanceState | null {
  const maintenance = safeJsonParse(raw ?? 'null');
  if (
    typeof maintenance !== 'object' ||
    maintenance === null ||
    !('lca' in maintenance)
  ) {
    return null;
  }

  const { lca } = maintenance;
  if (typeof lca !== 'number' && lca !== null) {
    return null;
  }

  return { lastCleanupAt: lca };
}

type PersistentTestStoreStorage = {
  writeRaw: (key: string, raw: string) => void;
  writeValue: <T>(key: string, value: T) => void;
  readEntry: <T>(key: string) => T | null;
  remove: (key: string) => void;
  listKeys: (prefix: string) => string[];
  has: (key: string) => boolean;
  getRaw: (key: string) => string | null;
  getGlobalMaintenanceRaw: () => GlobalMaintenanceState | null;
  storageKind?: 'localStorage' | 'memory';
};

function readRequiredEntry<T>(
  storage: PersistentTestStoreStorage,
  key: string,
): T {
  const entry = storage.readEntry<T>(key);
  if (entry === null) {
    throw new Error(`Missing persistent test entry for ${key}`);
  }

  return entry;
}

function getStoredValueSizeBytes(
  storage: PersistentTestStoreStorage,
  key: string,
): number | undefined {
  const raw = storage.getRaw(key);
  return raw === null ? undefined : utf8Encoder.encode(raw).byteLength;
}

function getLoadedFields(value: unknown): ItemLoadedFields | undefined {
  return value === '*' || Array.isArray(value)
    ? __LEGIT_CAST__<ItemLoadedFields, unknown>(value)
    : undefined;
}

export type PersistentTestStoreScope = {
  document: {
    storageKey: () => string;
    seed: <T>(data: T, options?: StorageSeedOptions) => string;
    readEntry: <T>() => StorageCacheEntry<PersistedDocumentData<T>>;
    readData: <T>() => T | null;
    getRawData: (kind: 'entry' | 'manifest') => unknown;
  };
  storage: PersistentTestStoreStorage;
  collection: {
    itemKey: (payload: string) => string;
    itemStorageKey: (payload: string) => string;
    seedItem: <T>(
      payload: string,
      data: T,
      options?: StorageSeedOptions,
    ) => string;
    readItemEntry: <T>(
      payload: string,
    ) => StorageCacheEntry<PersistedCollectionItemData<T>>;
    readItemData: <T>(payload: string) => T | null;
  };
  listQuery: {
    itemKey: (tableId: string, id: number | string) => string;
    itemStorageKey: (tableId: string, id: number | string) => string;
    queryStorageKey: (params: unknown) => string;
    seedItem: <T>(
      tableId: string,
      id: number | string,
      data: T,
      options?: ListQuerySeedItemOptions,
    ) => { itemKey: string; payload: string; storageKey: string };
    seedQuery: (
      params: unknown,
      items: ListQueryItemRef[],
      options?: StorageSeedOptions & { hasMore?: boolean },
    ) => string;
    readItemEntry: <T>(
      tableId: string,
      id: number | string,
    ) => StorageCacheEntry<PersistedListQueryItemData<T>>;
    readItemData: <T>(tableId: string, id: number | string) => T | null;
    readQueryEntry: (
      params: unknown,
    ) => StorageCacheEntry<PersistedListQueryData>;
  };
};

type PersistentTestStore = {
  storage: PersistentTestStoreStorage;
  scope: (storeName: string, sessionKey: string) => PersistentTestStoreScope;
};

function createPersistentTestStore(
  storage: PersistentTestStoreStorage,
): PersistentTestStore {
  function createCacheEntry<T>(
    data: T,
    options: StorageSeedOptions = {},
  ): StorageCacheEntry<T> {
    if (options.version === undefined) {
      return { data, timestamp: options.timestamp ?? Date.now() };
    }

    return {
      data,
      timestamp: options.timestamp ?? Date.now(),
      version: options.version,
    };
  }

  function readLocalStorageCompactEntry<TData>(
    key: string,
    readMetadata: () => { lastAccessAt: number } | null,
    mapData: (value: Record<string, unknown>) => TData | null,
  ): StorageCacheEntry<TData> | null {
    const parsed = parseCompactLocalStorageEntry(storage.getRaw(key));
    const metadata = readMetadata();
    if (parsed === null || metadata === null) return null;

    const data = mapData(parsed.value);
    if (data === null) return null;

    return {
      data,
      timestamp: metadata.lastAccessAt,
      ...(parsed.version !== undefined ? { version: parsed.version } : {}),
    };
  }

  function createScope(
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

    function rawListQueryItemPayload(
      tableId: string,
      id: number | string,
    ): string {
      return `${tableId}||${id}`;
    }

    function listQueryItemKey(tableId: string, id: number | string): string {
      return getCompositeKey(rawListQueryItemPayload(tableId, id));
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

    function normalizeQueryItemRef(item: ListQueryItemRef): string {
      if (typeof item === 'string') return item;

      return listQueryItemKey(item.tableId, item.id);
    }

    return {
      document: {
        storageKey: () => documentStorageKey,
        seed<T>(data: T, options?: StorageSeedOptions) {
          const entryTimestamp = options?.timestamp ?? Date.now();

          if (storage.storageKind === 'localStorage') {
            storage.writeValue(
              documentStorageKey,
              createCompactLocalStorageEntry({ d: data }, options?.version),
            );
          } else {
            storage.writeValue(
              documentStorageKey,
              createCacheEntry<PersistedDocumentData<T>>({ data }, options),
            );
          }

          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageSingleEntry({
              storageKey: documentStorageKey,
              lastAccessAt: entryTimestamp,
              clearSizeBytes: true,
            });
          }

          return documentStorageKey;
        },
        readEntry<T>() {
          if (storage.storageKind === 'localStorage') {
            const entry = readLocalStorageCompactEntry<
              PersistedDocumentData<T>
            >(
              documentStorageKey,
              () =>
                readManagedLocalStorageSingleEntryByPayload(documentStorageKey),
              (v) =>
                'd' in v ? { data: __LEGIT_CAST__<T, unknown>(v.d) } : null,
            );
            if (entry === null) {
              throw new Error(
                `Missing persistent test entry for ${documentStorageKey}`,
              );
            }

            return entry;
          }

          return readRequiredEntry<StorageCacheEntry<PersistedDocumentData<T>>>(
            storage,
            documentStorageKey,
          );
        },
        readData<T>() {
          if (storage.storageKind === 'localStorage') {
            return (
              readLocalStorageCompactEntry<PersistedDocumentData<T>>(
                documentStorageKey,
                () =>
                  readManagedLocalStorageSingleEntryByPayload(
                    documentStorageKey,
                  ),
                (v) =>
                  'd' in v ? { data: __LEGIT_CAST__<T, unknown>(v.d) } : null,
              )?.data.data ?? null
            );
          }

          return (
            storage.readEntry<StorageCacheEntry<PersistedDocumentData<T>>>(
              documentStorageKey,
            )?.data.data ?? null
          );
        },
        getRawData(kind: 'entry' | 'manifest') {
          if (kind === 'entry') {
            return safeJsonParse(storage.getRaw(documentStorageKey) ?? 'null');
          }

          return safeJsonParse(
            storage.getRaw(
              getManagedLocalStorageManifestKeyForSingle(documentStorageKey),
            ) ?? 'null',
          );
        },
      },
      storage,
      collection: {
        itemKey: collectionItemKey,
        itemStorageKey: collectionItemStorageKey,
        seedItem<T>(payload: string, data: T, options?: StorageSeedOptions) {
          const key = collectionItemStorageKey(payload);
          const entryTimestamp = options?.timestamp ?? Date.now();

          if (storage.storageKind === 'localStorage') {
            storage.writeValue(
              key,
              createCompactLocalStorageEntry(
                { d: data, p: payload },
                options?.version,
              ),
            );
          } else {
            storage.writeValue(
              key,
              createCacheEntry<PersistedCollectionItemData<T>>(
                { data, payload },
                options,
              ),
            );
          }

          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageNamespaceEntry({
              storagePrefix: `tsdf.${sessionKey}.${storeName}.ci.`,
              entryKey: collectionItemKey(payload),
              lastAccessAt: entryTimestamp,
              sizeBytes: getStoredValueSizeBytes(storage, key),
              meta: { p: payload },
            });
          }

          return key;
        },
        readItemEntry<T>(payload: string) {
          if (storage.storageKind === 'localStorage') {
            const key = collectionItemStorageKey(payload);
            const prefix = `tsdf.${sessionKey}.${storeName}.ci.`;
            const entry = readLocalStorageCompactEntry<
              PersistedCollectionItemData<T>
            >(
              key,
              () => readManagedLocalStorageNamespaceEntryByPayload(key, prefix),
              (v) =>
                'd' in v && 'p' in v
                  ? {
                      data: __LEGIT_CAST__<T, unknown>(v.d),
                      payload: __LEGIT_CAST__<string, unknown>(v.p),
                    }
                  : null,
            );
            if (entry === null) {
              throw new Error(`Missing persistent test entry for ${key}`);
            }

            return entry;
          }

          return readRequiredEntry<
            StorageCacheEntry<PersistedCollectionItemData<T>>
          >(storage, collectionItemStorageKey(payload));
        },
        readItemData<T>(payload: string) {
          if (storage.storageKind === 'localStorage') {
            const key = collectionItemStorageKey(payload);
            const prefix = `tsdf.${sessionKey}.${storeName}.ci.`;
            return (
              readLocalStorageCompactEntry<PersistedCollectionItemData<T>>(
                key,
                () =>
                  readManagedLocalStorageNamespaceEntryByPayload(key, prefix),
                (v) =>
                  'd' in v && 'p' in v
                    ? {
                        data: __LEGIT_CAST__<T, unknown>(v.d),
                        payload: __LEGIT_CAST__<string, unknown>(v.p),
                      }
                    : null,
              )?.data.data ?? null
            );
          }

          return (
            storage.readEntry<
              StorageCacheEntry<PersistedCollectionItemData<T>>
            >(collectionItemStorageKey(payload))?.data.data ?? null
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
          const payload = rawListQueryItemPayload(tableId, id);
          const itemKey = listQueryItemKey(tableId, id);
          const storageKey = listQueryItemStorageKey(tableId, id);
          const entryTimestamp = options?.timestamp ?? Date.now();

          if (storage.storageKind === 'localStorage') {
            storage.writeValue(
              storageKey,
              createCompactLocalStorageEntry(
                {
                  d: data,
                  p: payload,
                  ...(options?.loadedFields !== undefined
                    ? { lf: options.loadedFields }
                    : {}),
                },
                options?.version,
              ),
            );
          } else {
            storage.writeValue(
              storageKey,
              createCacheEntry<PersistedListQueryItemData<T>>(
                { data, payload, loadedFields: options?.loadedFields },
                options,
              ),
            );
          }

          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageNamespaceEntry({
              storagePrefix: `tsdf.${sessionKey}.${storeName}.li.`,
              entryKey: itemKey,
              lastAccessAt: entryTimestamp,
              sizeBytes: getStoredValueSizeBytes(storage, storageKey),
              meta: { p: payload },
            });
          }

          return { itemKey, payload, storageKey };
        },
        seedQuery(
          params: unknown,
          items: ListQueryItemRef[],
          options?: StorageSeedOptions & { hasMore?: boolean },
        ) {
          const key = listQueryStorageKey(params);
          const persistedData = {
            payload: params,
            items: items.map(normalizeQueryItemRef),
            hasMore: options?.hasMore ?? false,
          } satisfies PersistedListQueryData;

          if (storage.storageKind === 'localStorage') {
            storage.writeValue(
              key,
              createCompactListQueryLocalStorageEntry({
                lastAccessAt: options?.timestamp ?? Date.now(),
                items: persistedData.items,
                payload: persistedData.payload,
                hasMore: persistedData.hasMore,
                offlineProtected: false,
                version: options?.version,
              }),
            );
          } else {
            const entry = createCacheEntry<PersistedListQueryData>(
              persistedData,
              options,
            );
            storage.writeValue(key, entry);
          }

          return key;
        },
        readItemEntry<T>(tableId: string, id: number | string) {
          if (storage.storageKind === 'localStorage') {
            const key = listQueryItemStorageKey(tableId, id);
            const prefix = `tsdf.${sessionKey}.${storeName}.li.`;
            const entry = readLocalStorageCompactEntry<
              PersistedListQueryItemData<T>
            >(
              key,
              () => readManagedLocalStorageNamespaceEntryByPayload(key, prefix),
              (v) =>
                'd' in v && 'p' in v
                  ? {
                      data: __LEGIT_CAST__<T, unknown>(v.d),
                      payload: __LEGIT_CAST__<string, unknown>(v.p),
                      ...('lf' in v && getLoadedFields(v.lf) !== undefined
                        ? { loadedFields: getLoadedFields(v.lf) }
                        : {}),
                    }
                  : null,
            );
            if (entry === null) {
              throw new Error(`Missing persistent test entry for ${key}`);
            }

            return entry;
          }

          return readRequiredEntry<
            StorageCacheEntry<PersistedListQueryItemData<T>>
          >(storage, listQueryItemStorageKey(tableId, id));
        },
        readItemData<T>(tableId: string, id: number | string) {
          if (storage.storageKind === 'localStorage') {
            const key = listQueryItemStorageKey(tableId, id);
            const prefix = `tsdf.${sessionKey}.${storeName}.li.`;
            return (
              readLocalStorageCompactEntry<PersistedListQueryItemData<T>>(
                key,
                () =>
                  readManagedLocalStorageNamespaceEntryByPayload(key, prefix),
                (v) =>
                  'd' in v && 'p' in v
                    ? {
                        data: __LEGIT_CAST__<T, unknown>(v.d),
                        payload: __LEGIT_CAST__<string, unknown>(v.p),
                        ...('lf' in v && getLoadedFields(v.lf) !== undefined
                          ? { loadedFields: getLoadedFields(v.lf) }
                          : {}),
                      }
                    : null,
              )?.data.data ?? null
            );
          }

          return (
            storage.readEntry<StorageCacheEntry<PersistedListQueryItemData<T>>>(
              listQueryItemStorageKey(tableId, id),
            )?.data.data ?? null
          );
        },
        readQueryEntry(params: unknown) {
          if (storage.storageKind !== 'localStorage') {
            return readRequiredEntry<StorageCacheEntry<PersistedListQueryData>>(
              storage,
              listQueryStorageKey(params),
            );
          }

          const storageKey = listQueryStorageKey(params);
          const entry = parseCompactListQueryLocalStorageEntry(
            storage.getRaw(storageKey),
          );
          if (entry === null) {
            throw new Error(`Missing persistent test entry for ${storageKey}`);
          }

          return {
            data: {
              payload: entry.payload,
              items: entry.items,
              hasMore: entry.hasMore,
            },
            timestamp: entry.lastAccessAt,
            ...(entry.version !== undefined ? { version: entry.version } : {}),
          };
        },
      },
    };
  }

  return { storage, scope: createScope };
}

export function createLocalStoragePersistentTestStore(): PersistentTestStore {
  return createPersistentTestStore({
    writeRaw(key: string, raw: string) {
      localStorage.setItem(key, raw);
    },
    writeValue<T>(key: string, value: T) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    readEntry<T>(key: string): T | null {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;

      return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
    },
    remove(key: string) {
      localStorage.removeItem(key);
    },
    listKeys(prefix: string): string[] {
      const keys: string[] = [];

      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) {
          keys.push(key);
        }
      }

      return keys;
    },
    has(key: string) {
      return localStorage.getItem(key) !== null;
    },
    getRaw(key: string) {
      return localStorage.getItem(key);
    },
    getGlobalMaintenanceRaw() {
      return parseGlobalMaintenanceRaw(localStorage.getItem('tsdf._m.g'));
    },
    storageKind: 'localStorage',
  });
}
