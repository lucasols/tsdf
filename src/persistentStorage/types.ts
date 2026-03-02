import type { ValidStoreState } from '../utils/storeShared';

// --- Storage Adapter ---

/** Uniform async interface for reading/writing persistent data. */
export type StorageAdapter = {
  read<T>(key: string): Promise<T | null>;
  write<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  removeByPrefix(prefix: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
};

export type StorageBackend = 'localStorage' | 'opfs';

// --- Schema Types ---

/** Runcheck-compatible schema (has .parse() method) */
export type RcLikeSchema<T> = {
  parse: (input: unknown) => { ok: true; value: T } | { ok: false };
};

/** Standard Schema v1 (zod, valibot, arktype, etc.) */
export type StandardSchemaLike<T> = {
  '~standard': {
    validate: (
      value: unknown,
    ) =>
      | { value: T; issues?: undefined }
      | { issues: readonly { message: string }[] };
  };
};

/** Union of supported schema types for persistent storage validation. */
export type PersistentStorageSchema<T> =
  | RcLikeSchema<T>
  | StandardSchemaLike<T>;

// --- Cache Entry ---

export type StorageCacheEntry<T> = {
  data: T;
  timestamp: number;
  version: number;
};

// --- Config Types ---

/** Base config shared by all store types. */
export type PersistentStorageBaseConfig<T> = {
  /** Unique name for this store's persistent storage key. */
  storeName: string;
  /** Storage backend to use. Defaults to `'opfs'`. */
  backend?: StorageBackend;
  /** Schema used to validate cached data on load. */
  schema: PersistentStorageSchema<T>;
  /** Version number for cache invalidation. Defaults to 1. */
  version?: number;
  /**
   * Returns a session key scoping storage per org/tenant.
   * Return `false` to indicate the session is not ready — all storage
   * operations (load, save, clear) will be skipped until it returns a string.
   */
  getSessionKey: () => string | false;
};

/** Persistent storage config for DocumentStore. */
export type DocumentPersistentStorageConfig<State extends ValidStoreState> =
  PersistentStorageBaseConfig<State>;

/** Persistent storage config for CollectionStore. */
export type CollectionPersistentStorageConfig<
  ItemState extends ValidStoreState,
> = PersistentStorageBaseConfig<ItemState> & {
  /** Maximum number of items to persist. Items are evicted via LRU. Defaults to 50. */
  maxItems?: number;
  /** Item keys that should never be evicted from storage. */
  pinnedItems?: string[];
};

/** Persistent storage config for ListQueryStore. */
export type ListQueryPersistentStorageConfig<
  ItemState extends ValidStoreState,
> = PersistentStorageBaseConfig<ItemState> & {
  /** Maximum number of items to persist. Defaults to 100. */
  maxItems?: number;
  /** Maximum number of queries to persist. Defaults to 20. */
  maxQueries?: number;
  /** Item keys that should never be evicted from storage. */
  pinnedItems?: string[];
  /** Query keys that should never be evicted from storage. */
  pinnedQueries?: string[];
};

// --- Persisted Data Shapes ---

/** Shape of persisted data for DocumentStore. */
export type PersistedDocumentData<State> = {
  data: State;
};

/** Shape of a single persisted collection item. */
export type PersistedCollectionItem<State> = {
  data: State;
  payload: unknown;
  lastAccessedAt: number;
};

/** Shape of persisted data for CollectionStore. */
export type PersistedCollectionData<State> = {
  items: Record<string, PersistedCollectionItem<State>>;
};

/** Shape of a single persisted query. */
export type PersistedQuery = {
  payload: unknown;
  items: string[];
  hasMore: boolean;
};

/** Shape of persisted data for ListQueryStore. */
export type PersistedListQueryData<State> = {
  items: Record<string, State>;
  queries: Record<string, PersistedQuery>;
  itemPayloads: Record<string, unknown>;
};
