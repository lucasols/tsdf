import { type RcType } from 'runcheck';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  CollectionOfflineOperationsRegistry,
  DocumentOfflineOperationsRegistry,
  ListQueryOfflineOperationsRegistry,
  OfflineModeConfig,
} from './offline/types';

// --- Storage Adapter ---

/** Sync adapter used when storage can be read during store initialization. */
export type SyncStorageAdapter = {
  kind: 'sync';
  read<T>(key: string): T | null;
  write<T>(key: string, value: T): void;
  remove(key: string): void;
  removeByPrefix(prefix: string): void;
  listKeys(prefix: string): string[];
};

/** Async adapter used when storage access requires asynchronous I/O. */
export type AsyncStorageAdapter = {
  kind: 'async';
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  removeByPrefix(prefix: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
};

/** Injected persistent storage adapter. */
export type StorageAdapter = SyncStorageAdapter | AsyncStorageAdapter;

// --- Schema Types ---

/** Standard Schema v1 (zod, valibot, arktype, etc.) */
export type StandardSchemaLike<T> = {
  '~standard': {
    validate: (
      value: unknown,
    ) =>
      | { value: T; issues?: undefined }
      | { issues: readonly { message: string }[] }
      | Promise<
          | { value: T; issues?: undefined }
          | { issues: readonly { message: string }[] }
        >;
  };
};

/** Union of supported schema types for persistent storage validation. */
export type PersistentStorageSchema<T> = RcType<T> | StandardSchemaLike<T>;

/**
 * Converts between the in-memory store data shape and the persisted storage shape.
 * Use this when the cached representation should differ from the API store format.
 */
export type ConvertedPersistentStorageDataSchema<TFinal, TStorage> = {
  /** Schema for the final in-memory store data after hydration. */
  storeSchema: PersistentStorageSchema<TFinal>;
  /** Schema for the raw persisted storage representation. */
  storageSchema: PersistentStorageSchema<TStorage>;
  /** Converts in-memory store data into the persisted storage representation. */
  convertToStorage: (value: TFinal) => TStorage;
  /** Converts persisted storage data into the final in-memory store representation. */
  convertFromStorage: (value: TStorage) => TFinal;
};

/**
 * Schema configuration for persisted store data.
 * Accept either the final store schema directly or a converted storage format.
 */
export type PersistentStorageDataSchema<TFinal, TStorage = unknown> =
  | PersistentStorageSchema<TFinal>
  | ConvertedPersistentStorageDataSchema<TFinal, TStorage>;

// --- Cache Entry ---

export type StorageCacheEntry<T> = {
  data: T;
  timestamp: number;
  version: number;
};

/** Result entry returned by explicit persistent-storage preload APIs. */
export type PersistentStoragePreloadResult<
  Payload extends ValidPayload = ValidPayload,
> = { payload: Payload; preloaded: boolean };

// --- Config Types ---

/** Base config shared by all store types. */
export type PersistentStorageBaseConfig<TFinal, TStorage = unknown> = {
  /** Unique name for this store's persistent storage key. */
  storeName: string;
  /** Injected adapter used to save and restore persistent data. */
  adapter: StorageAdapter;
  /** Schema used to validate cached data on load and optionally convert persisted data. */
  schema: PersistentStorageDataSchema<TFinal, TStorage>;
  /** Version number for cache invalidation. Defaults to 1. */
  version?: number;
  /**
   * Throttles automatic background cleanup for the built-in localStorage adapter.
   * Direct cleanup caused by malformed or version-mismatched entries is not delayed.
   * Defaults to 24 hours. Use `0` to allow maintenance on every eligible init.
   */
  cleanupIntervalMs?: number;
  /**
   * Returns a session key scoping storage per org/tenant.
   * Return `false` to indicate the session is not ready — all storage
   * operations (load, save, clear) will be skipped until it returns a string.
   */
  getSessionKey: () => string | false;
  /**
   * Called when a storage write operation fails (e.g. quota exceeded, OPFS write error).
   * Use this to log or report persistence failures to your error tracking service.
   */
  onPersistentStorageError?: (error: unknown) => void;
};

/** Store-level persistent storage config. Session scoping comes from the parent store. */
type StorePersistentStorageBaseConfig<TFinal, TStorage = unknown> = Omit<
  PersistentStorageBaseConfig<TFinal, TStorage>,
  'getSessionKey'
>;

/** Persistent storage config for DocumentStore. */
export type DocumentPersistentStorageConfig<
  State extends ValidStoreState,
  StorageState = unknown,
  TOfflineOperations extends DocumentOfflineOperationsRegistry<State> =
    DocumentOfflineOperationsRegistry<State>,
> = StorePersistentStorageBaseConfig<State, StorageState> & {
  offlineMode?: OfflineModeConfig<TOfflineOperations>;
};

/** Persistent storage config for CollectionStore. */
export type CollectionPersistentStorageConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends CollectionOfflineOperationsRegistry<
    ItemState,
    ItemPayload
  > = CollectionOfflineOperationsRegistry<ItemState, ItemPayload>,
> = StorePersistentStorageBaseConfig<ItemState, StorageState> & {
  offlineMode?: OfflineModeConfig<TOfflineOperations>;
  /** Schema used to validate cached item payloads on load. */
  payloadSchema: PersistentStorageSchema<ItemPayload>;
  /** Maximum number of items to persist. Items are evicted via LRU. Defaults to 50. */
  maxItems?: number;
  /** Item payloads that should never be evicted from storage. */
  pinnedItems?: ItemPayload[];
  /**
   * Item payloads that should never be persisted or restored.
   * Accepts either an explicit payload list or a predicate function.
   * Takes precedence over `pinnedItems`.
   */
  ignoreItems?: ItemPayload[] | ((payload: ItemPayload) => boolean);
};

/** Persistent storage config for ListQueryStore. */
export type ListQueryPersistentStorageConfig<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload = ValidPayload,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends ListQueryOfflineOperationsRegistry<
    ItemState,
    QueryPayload,
    ItemPayload
  > = ListQueryOfflineOperationsRegistry<ItemState, QueryPayload, ItemPayload>,
> = StorePersistentStorageBaseConfig<ItemState, StorageState> & {
  offlineMode?: OfflineModeConfig<TOfflineOperations>;
  /** Schema used to validate cached item payloads on load. */
  itemPayloadSchema: PersistentStorageSchema<ItemPayload>;
  /** Schema used to validate cached query payloads on load. */
  queryPayloadSchema: PersistentStorageSchema<QueryPayload>;
  /** Maximum number of items to persist. Defaults to 500. */
  maxItems?: number;
  /** Maximum number of queries to persist. Defaults to 100. */
  maxQueries?: number;
  /** Maximum number of items per query to persist. Defaults to 100. */
  maxQuerySize?: number;
  /** Item payloads that should never be evicted from storage. */
  pinnedItems?: ItemPayload[];
  /** Query payloads that should never be evicted from storage. */
  pinnedQueries?: QueryPayload[];
  /**
   * Item payloads that should never be persisted or restored.
   * Accepts either an explicit payload list or a predicate function.
   * Takes precedence over `pinnedItems`.
   */
  ignoreItems?: ItemPayload[] | ((payload: ItemPayload) => boolean);
};

// --- Persisted Data Shapes ---

/** Shape of persisted data for DocumentStore. */
export type PersistedDocumentData<State> = { data: State };

/** Shape of a single persisted collection item entry. */
export type PersistedCollectionItemData<State> = {
  data: State;
  payload: unknown;
};

/** Shape of a single persisted list item entry. */
export type PersistedListQueryItemData<State> = {
  data: State;
  payload: unknown;
  loadedFields?: string[];
};

/** Shape of a single persisted list query entry. */
export type PersistedListQueryData = {
  payload: unknown;
  items: string[];
  hasMore: boolean;
};
