import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import { type RcType } from 'runcheck';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  AnyOfflineOperationDefinition,
  CollectionOfflineEntityRef,
  ListQueryOfflineEntityRef,
  OfflineModeConfig,
} from './offline/types';

/** Async adapter used when storage access requires asynchronous I/O. */
export type AsyncStorageAdapter = {
  /** Adapter mode marker used by persistence internals to pick async behavior. */
  kind: 'async';
  /** Read an entry using async storage APIs. */
  read<T>(key: string): Promise<T | null>;
  /** Persist an entry using async storage APIs. */
  write<T>(key: string, value: T): Promise<void>;
  /** Remove a single key using async storage APIs. */
  remove(key: string): Promise<void>;
  /** Remove all keys that start with a prefix using async storage APIs. */
  removeByPrefix(prefix: string): Promise<void>;
  /** Return all matching keys in async storage. */
  listKeys(prefix: string): Promise<string[]>;
};

/** Injected persistent storage adapter. */
export type StorageAdapter = 'local-sync' | AsyncStorageAdapter;

// --- Schema Types ---

/** Standard Schema v1 (zod, valibot, arktype, etc.). */
export type StandardSchemaLike<T> = StandardSchemaV1<unknown, T>;

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
  /** Cached payload persisted for this key. */
  data: T;
  /** Epoch timestamp used for age-based maintenance. */
  timestamp: number;
  /** Optional user-configured cache version used for migration-safe hydration. */
  version?: number;
};

/** Result entry returned by explicit persistent-storage preload APIs. */
export type PersistentStoragePreloadResult<
  Payload extends ValidPayload = ValidPayload,
> = {
  /** Payload loaded from storage or fresh store initialization result. */
  payload: Payload;
  /** `true` when payload came from storage cache, `false` when loaded from source. */
  preloaded: boolean;
};

/** Context passed to versioned cache-entry migrations. */
export type PersistentStorageMigrationContext = {
  /** Raw persisted payload read from storage for this cache entry. */
  persistedData: unknown;
  /** Stored cache-entry version, or `undefined` when the entry had no version. */
  fromVersion: number | undefined;
  /** Current configured cache-entry version that the store expects. */
  toVersion: number;
};

/** Allowed return values from a cache-entry migration callback. */
export type PersistentStorageMigrationResult =
  | object
  | string
  | number
  | boolean
  | bigint
  | symbol
  | undefined
  | null;

/** Optional callback used to upgrade mismatched persisted cache-entry payloads. */
export type PersistentStorageMigration = (
  ctx: PersistentStorageMigrationContext,
) => PersistentStorageMigrationResult;

// --- Config Types ---

/** Base config shared by all store types. */
export type PersistentStorageBaseConfig<TFinal, TStorage = unknown> = {
  /** Unique name for this store's persistent storage key. Must not contain `.`. */
  storeName: string;
  /** Injected adapter used to save and restore persistent data. Use `'local-sync'` for built-in localStorage or provide a custom async adapter. */
  adapter: StorageAdapter;
  /** Schema used to validate cached data on load and optionally convert persisted data. */
  schema: PersistentStorageDataSchema<TFinal, TStorage>;
  /** Optional version number for cache invalidation. When omitted, no version is persisted or checked. */
  version?: number;
  /**
   * Optional version-aware migration used when `version` is configured and a
   * stored cache entry has a different version or no version.
   *
   * `persistedData` is the raw stored payload from the cache entry.
   * Return the payload in the current configured persisted-data shape, or
   * return `null` to discard the cached entry.
   */
  migrate?: PersistentStorageMigration;
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

type InternalDocumentOfflineOperations<State extends ValidStoreState> = Record<
  string,
  AnyOfflineOperationDefinition
> &
  ([State] extends [never] ? never : unknown);

type DocumentOfflineOperationsConfig<State extends ValidStoreState> =
  InternalDocumentOfflineOperations<State> | null;

/** Persistent storage config for DocumentStore. */
export type DocumentPersistentStorageConfig<
  State extends ValidStoreState,
  StorageState = unknown,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
> = StorePersistentStorageBaseConfig<State, StorageState> & {
  /** Optional offline sync/replay configuration for mutations. */
  offlineMode?: TOfflineOperations extends null
    ? never
    : OfflineModeConfig<Exclude<TOfflineOperations, null>>;
};

type InternalCollectionOfflineOperations<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  AnyOfflineOperationDefinition & {
    getEntityRefs: (ctx: {
      input: __LEGIT_ANY__;
    }) => CollectionOfflineEntityRef<ItemPayload>[];
  }
> &
  ([ItemState | ItemPayload] extends [never] ? never : unknown);

type CollectionOfflineOperationsConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = InternalCollectionOfflineOperations<ItemState, ItemPayload> | null;

/** Persistent storage config for CollectionStore. */
export type CollectionPersistentStorageConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
> = StorePersistentStorageBaseConfig<ItemState, StorageState> & {
  /** Optional offline sync/replay configuration for mutations. */
  offlineMode?: TOfflineOperations extends null
    ? never
    : OfflineModeConfig<Exclude<TOfflineOperations, null>>;
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

type InternalListQueryOfflineOperations<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  AnyOfflineOperationDefinition & {
    getEntityRefs: (ctx: {
      input: __LEGIT_ANY__;
    }) => ListQueryOfflineEntityRef<ItemPayload>[];
  }
> &
  ([ItemState | QueryPayload | ItemPayload] extends [never] ? never : unknown);

type ListQueryOfflineOperationsConfig<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = InternalListQueryOfflineOperations<
  ItemState,
  QueryPayload,
  ItemPayload
> | null;

/** Persistent storage config for ListQueryStore. */
export type ListQueryPersistentStorageConfig<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload = ValidPayload,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
> = StorePersistentStorageBaseConfig<ItemState, StorageState> & {
  /** Optional offline sync/replay configuration for mutations. */
  offlineMode?: TOfflineOperations extends null
    ? never
    : OfflineModeConfig<Exclude<TOfflineOperations, null>>;
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
export type PersistedDocumentData<State> = {
  /** Persisted document state snapshot. */
  data: State;
};

/** Shape of a single persisted collection item entry. */
export type PersistedCollectionItemData<State> = {
  /** Persisted collection item state snapshot. */
  data: State;
  /** Payload stored alongside the item for validation and retrieval. */
  payload: unknown;
};

/** Shape of a single persisted list item entry. */
export type PersistedListQueryItemData<State> = {
  /** Persisted list item state snapshot. */
  data: State;
  /** Payload stored to validate and rehydrate item queries. */
  payload: unknown;
  /** Optional list of selected fields that were loaded from the query result. */
  loadedFields?: string[];
};

/** Shape of a single persisted list query entry. */
export type PersistedListQueryData = {
  /** Persisted query payload. */
  payload: unknown;
  /** Ordered list of item IDs included in the cached query page. */
  items: string[];
  /** Whether the query has additional pages available. */
  hasMore: boolean;
};
