import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { safeJsonParse } from '@ls-stack/utils/safeJson';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  getManagedLocalStorageManifestKeyForSingle,
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

type StorageSeedOptions = { timestamp?: number; version?: number };

type ListQuerySeedItemOptions = StorageSeedOptions & {
  loadedFields?: string[];
};

type ListQueryItemRef = string | { tableId: string; id: number | string };

type GlobalMaintenanceState = {
  lastCleanupAt: number | null;
  version?: unknown;
};

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

  return {
    lastCleanupAt: lca,
    version: 'v' in maintenance ? maintenance.v : undefined,
  };
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

export type PersistentTestStore = {
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
    return {
      data,
      timestamp: options.timestamp ?? Date.now(),
      version: options.version ?? 1,
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
          const entry = createCacheEntry<PersistedDocumentData<T>>(
            { data },
            options,
          );
          storage.writeValue(documentStorageKey, entry);
          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageSingleEntry({
              storageKey: documentStorageKey,
              lastAccessAt: entry.timestamp,
            });
          }

          return documentStorageKey;
        },
        readEntry<T>() {
          return readRequiredEntry<StorageCacheEntry<PersistedDocumentData<T>>>(
            storage,
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
          const entry = createCacheEntry<PersistedCollectionItemData<T>>(
            { data, payload },
            options,
          );
          storage.writeValue(key, entry);
          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageNamespaceEntry({
              storagePrefix: `tsdf.${sessionKey}.${storeName}.ci.`,
              entryKey: collectionItemKey(payload),
              lastAccessAt: entry.timestamp,
              meta: { p: payload },
            });
          }

          return key;
        },
        readItemEntry<T>(payload: string) {
          return readRequiredEntry<
            StorageCacheEntry<PersistedCollectionItemData<T>>
          >(storage, collectionItemStorageKey(payload));
        },
        readItemData<T>(payload: string) {
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
          const entry = createCacheEntry<PersistedListQueryItemData<T>>(
            { data, payload, loadedFields: options?.loadedFields },
            options,
          );

          storage.writeValue(storageKey, entry);
          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageNamespaceEntry({
              storagePrefix: `tsdf.${sessionKey}.${storeName}.li.`,
              entryKey: itemKey,
              lastAccessAt: entry.timestamp,
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
          const entry = createCacheEntry<PersistedListQueryData>(
            {
              payload: params,
              items: items.map(normalizeQueryItemRef),
              hasMore: options?.hasMore ?? false,
            },
            options,
          );
          storage.writeValue(key, entry);
          if (storage.storageKind === 'localStorage') {
            upsertManagedLocalStorageNamespaceEntry({
              storagePrefix: `tsdf.${sessionKey}.${storeName}.lq.`,
              entryKey: getCompositeKey(params),
              lastAccessAt: entry.timestamp,
              meta: { p: params, i: entry.data.items, h: entry.data.hasMore },
            });
          }

          return key;
        },
        readItemEntry<T>(tableId: string, id: number | string) {
          return readRequiredEntry<
            StorageCacheEntry<PersistedListQueryItemData<T>>
          >(storage, listQueryItemStorageKey(tableId, id));
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
            storage,
            listQueryStorageKey(params),
          );
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

export function createInMemoryPersistentTestStore(
  storageMap = new Map<string, string>(),
): PersistentTestStore {
  return createPersistentTestStore({
    writeRaw(key: string, raw: string) {
      storageMap.set(key, raw);
    },
    writeValue<T>(key: string, value: T) {
      storageMap.set(key, JSON.stringify(value));
    },
    readEntry<T>(key: string): T | null {
      const raw = storageMap.get(key);
      if (raw === undefined) return null;

      return __LEGIT_CAST__<T, unknown>(JSON.parse(raw));
    },
    remove(key: string) {
      storageMap.delete(key);
    },
    listKeys(prefix: string): string[] {
      return [...storageMap.keys()].filter((key) => key.startsWith(prefix));
    },
    has(key: string) {
      return storageMap.has(key);
    },
    getRaw(key: string) {
      return storageMap.get(key) ?? null;
    },
    getGlobalMaintenanceRaw() {
      return parseGlobalMaintenanceRaw(storageMap.get('tsdf._m.g') ?? null);
    },
    storageKind: 'memory',
  });
}
