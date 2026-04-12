import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type RcType } from 'runcheck';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  AnyOfflineOperationDefinition,
  CollectionOfflineEntityRef,
  ListQueryOfflineEntityRef,
  OfflineSession,
} from './offline/types';

export type AsyncStorageNamespaceKind =
  | 'document'
  | 'collection.item'
  | 'listQuery.item'
  | 'listQuery.query'
  | 'offline.queue'
  | 'offline.conflict'
  | 'offline.entity'
  | '__internal.protected';

export function parseAsyncStorageNamespaceKind(
  value: string,
): AsyncStorageNamespaceKind | null {
  switch (value) {
    case 'document':
    case 'collection.item':
    case 'listQuery.item':
    case 'listQuery.query':
    case 'offline.queue':
    case 'offline.conflict':
    case 'offline.entity':
    case '__internal.protected':
      return value;
    default:
      return null;
  }
}

export type AsyncStorageNamespaceScope = {
  sessionKey: string;
  storeName: string;
  kind: AsyncStorageNamespaceKind;
};

export type AsyncStorageProtectedEntryRef = AsyncStorageNamespaceScope & {
  key: string;
};

export type AsyncStorageTouchMode = 'never' | 'coarse' | 'force';

export type AsyncStorageReadOptions = { touch?: AsyncStorageTouchMode };

export type AsyncStorageMetadataOrder = 'key' | 'lru-asc' | 'lru-desc';

export type AsyncStorageEntryMetadataBase = {
  key: string;
  payloadRef: string;
  writtenAt: number;
  lastAccessAt: number;
  sizeBytes?: number;
  version: number;
};

export type AsyncStorageEntryMetadata<
  TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
> = AsyncStorageEntryMetadataBase & { customMetadata: TCustomMetadata };

export type AsyncStorageNamespaceGetResult<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
> = { value: TValue; metadata: AsyncStorageEntryMetadata<TCustomMetadata> };

export type AsyncStorageNamespaceCommitUpsert<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
> = { key: string; value: TValue; version: number; metadata?: TCustomMetadata };

export type AsyncStorageNamespaceCommitTouch = {
  key: string;
  lastAccessAt?: number;
};

export type AsyncStorageNamespaceStaticPolicy = {
  maxEntries?: number;
  pinnedKeys?: string[];
};

export type AsyncStorageNamespaceCommitArgs<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  upserts?: AsyncStorageNamespaceCommitUpsert<TValue, TCustomMetadata>[];
  removes?: string[];
  staticPolicy?: AsyncStorageNamespaceStaticPolicy | null;
  touches?: AsyncStorageNamespaceCommitTouch[];
};

export type AsyncStorageMaintenanceState = {
  lastSuccessfulCleanupAt: number | null;
};

export type AsyncStorageDriverSetEntry = { key: string; value: unknown };

export type AsyncStorageDiscoveredScope = {
  /** Known raw record keys for this scope. `null` if keys were not enumerated during discovery. */
  knownRecordKeys: string[] | null;
  scope: AsyncStorageNamespaceScope;
};

/** Low-level async backend contract implemented by custom storage drivers. */
export type AsyncStorageDriver = {
  /** Read a single raw record from a logical namespace. */
  get(scope: AsyncStorageNamespaceScope, key: string): Promise<unknown>;
  /** Write a single raw record to a logical namespace. */
  set(
    scope: AsyncStorageNamespaceScope,
    key: string,
    value: unknown,
  ): Promise<void>;
  /** Remove a single raw record from a logical namespace. */
  remove(scope: AsyncStorageNamespaceScope, key: string): Promise<void>;
  /** List raw record keys within a logical namespace. */
  listKeys(scope: AsyncStorageNamespaceScope): Promise<string[]>;
  /** Remove every record from a logical namespace. */
  clear(scope: AsyncStorageNamespaceScope): Promise<void>;
  /** Namespace discovery used for cold cleanup, protected-key restore, and session clearing. */
  listScopes(sessionKey?: string): Promise<AsyncStorageNamespaceScope[]>;
  /** Returns discovered scopes together with known raw record keys. Used for cleanup. */
  listScopesWithKnownRecordKeys(
    sessionKey?: string,
  ): Promise<AsyncStorageDiscoveredScope[]>;
  /** Bulk read for multiple keys in a single call. */
  getMany(
    scope: AsyncStorageNamespaceScope,
    keys: string[],
  ): Promise<unknown[]>;
  /** Bulk write for multiple entries in a single call. */
  setMany(
    scope: AsyncStorageNamespaceScope,
    entries: AsyncStorageDriverSetEntry[],
  ): Promise<void>;
  /** Bulk remove for multiple keys in a single call. */
  removeMany(scope: AsyncStorageNamespaceScope, keys: string[]): Promise<void>;
  /** @internal Test-only reset hook used by TSDF internals. */
  __resetForTests?(): void;
};

export type AsyncStorageNamespaceHandle<
  TValue,
  TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
> = {
  get(
    key: string,
    options?: AsyncStorageReadOptions,
  ): Promise<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>;
  getMany(
    keys: string[],
    options?: AsyncStorageReadOptions,
  ): Promise<
    Array<AsyncStorageNamespaceGetResult<TValue, TCustomMetadata> | null>
  >;
  listKeys(): Promise<string[]>;
  commit(
    args: AsyncStorageNamespaceCommitArgs<TValue, TCustomMetadata>,
  ): Promise<void>;
  listMetadata(args?: {
    order?: AsyncStorageMetadataOrder;
  }): Promise<AsyncStorageEntryMetadata<TCustomMetadata>[]>;
  clear(): Promise<void>;
};

/** Managed async adapter consumed by TSDF persistence internals. */
export type AsyncStorageAdapter = {
  /** Adapter mode marker used by persistence internals to pick async behavior. */
  kind: 'async';
  /** Open a logical namespace with managed batching and touch guarantees. */
  openNamespace<
    TValue,
    TCustomMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    scope: AsyncStorageNamespaceScope,
  ): AsyncStorageNamespaceHandle<TValue, TCustomMetadata>;
  /** Reconstruct offline-protected entry refs for a session from persisted metadata. */
  readProtectedStorageKeys(sessionKey: string): Promise<Set<string>>;
  /** Eagerly sync offline protection changes into persisted metadata for already-cached entries. */
  syncSessionProtectedKeys(
    sessionKey: string,
    protectedKeys: Iterable<string>,
    previousProtectedKeys?: Iterable<string>,
  ): Promise<void>;
  /** Remove all namespaces for a session key. */
  clearSession(sessionKey: string): Promise<void>;
  /** Test-only reset hook used by TSDF internals. */
  resetForTests?(): void;
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

// --- Config Types ---

/** Base config shared by all store types. */
export type PersistentStorageBaseConfig<TFinal, TStorage = unknown> = {
  /** Unique storage namespace used internally for this store's persisted entries. Must not contain `.`. */
  storeName: string;
  /** Injected adapter used to save and restore persistent data. Use `'local-sync'` for built-in localStorage or provide a custom async adapter. */
  adapter: StorageAdapter;
  /** Schema used to validate cached data on load and optionally convert persisted data. */
  schema: PersistentStorageDataSchema<TFinal, TStorage>;
  /** Optional version number for cache invalidation. When omitted, no version is persisted or checked. */
  version?: number;
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
  'getSessionKey' | 'storeName'
>;

type InternalDocumentOfflineOperations<State extends ValidStoreState> = Record<
  string,
  AnyOfflineOperationDefinition<__LEGIT_ANY__>
> &
  ([State] extends [never] ? never : unknown);

type DocumentOfflineOperationsConfig<State extends ValidStoreState> =
  InternalDocumentOfflineOperations<State> | null;

type PublicStoreOfflineConfig<
  TOperations extends Record<
    string,
    AnyOfflineOperationDefinition<__LEGIT_ANY__>
  > = Record<never, never>,
> = {
  /** Store-local offline operation definitions. Optional when only session-level offline controls are used. */
  operations?: TOperations;
};

type PublicStoreOfflineConfigField<
  TOfflineOperations extends Record<
    string,
    AnyOfflineOperationDefinition<__LEGIT_ANY__>
  > | null,
> = {
  /** Optional offline sync/replay configuration for mutations. */
  offline?: TOfflineOperations extends null
    ? PublicStoreOfflineConfig
    : PublicStoreOfflineConfig<Exclude<TOfflineOperations, null>>;
};

type ResolvedStoreOfflineConfig<
  TOperations extends Record<string, AnyOfflineOperationDefinition> = Record<
    never,
    never
  >,
> = PublicStoreOfflineConfig<TOperations> & {
  /** Shared session-level offline policy and runtime controls. */
  session: OfflineSession;
};

type ResolvedStoreOfflineConfigField<
  TOfflineOperations extends Record<
    string,
    AnyOfflineOperationDefinition
  > | null,
> = {
  /** Internal resolved offline config with the manager-owned session attached. */
  offline?: TOfflineOperations extends null
    ? ResolvedStoreOfflineConfig
    : ResolvedStoreOfflineConfig<Exclude<TOfflineOperations, null>>;
};

/** Persistent storage config for DocumentStore. */
export type DocumentPersistentStorageConfig<
  State extends ValidStoreState,
  StorageState = unknown,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
> = StorePersistentStorageBaseConfig<State, StorageState> &
  PublicStoreOfflineConfigField<TOfflineOperations>;

type ResolvedStorePersistentStorageBaseConfig<
  TFinal,
  TStorage = unknown,
> = StorePersistentStorageBaseConfig<TFinal, TStorage> & {
  /** Internal resolved namespace reused from the parent store id. */
  storeName: string;
  /** Internal resolved session scoping reused from the parent store. */
  getSessionKey: () => string | false;
};

export type ResolvedDocumentPersistentStorageConfig<
  State extends ValidStoreState,
  StorageState = unknown,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
> = ResolvedStorePersistentStorageBaseConfig<State, StorageState> &
  ResolvedStoreOfflineConfigField<TOfflineOperations>;

type InternalCollectionOfflineOperations<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  AnyOfflineOperationDefinition<__LEGIT_ANY__> & {
    getEntityRefs: (ctx: {
      input: __LEGIT_ANY__;
    }) => CollectionOfflineEntityRef<ItemPayload>[];
    dependsOn?: (ctx: {
      input: __LEGIT_ANY__;
    }) => CollectionOfflineEntityRef<ItemPayload>[];
  }
> &
  ([ItemState | ItemPayload] extends [never] ? never : unknown);

type CollectionOfflineOperationsConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = InternalCollectionOfflineOperations<ItemState, ItemPayload> | null;

type CollectionPersistentStorageFields<ItemPayload extends ValidPayload> = {
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

/** Persistent storage config for CollectionStore. */
export type CollectionPersistentStorageConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
> = StorePersistentStorageBaseConfig<ItemState, StorageState> &
  PublicStoreOfflineConfigField<TOfflineOperations> &
  CollectionPersistentStorageFields<ItemPayload>;

export type ResolvedCollectionPersistentStorageConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
> = ResolvedStorePersistentStorageBaseConfig<ItemState, StorageState> &
  ResolvedStoreOfflineConfigField<TOfflineOperations> &
  CollectionPersistentStorageFields<ItemPayload>;

export type InternalListQueryOfflineOperations<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  AnyOfflineOperationDefinition<__LEGIT_ANY__> & {
    getEntityRefs: (ctx: {
      input: __LEGIT_ANY__;
    }) => ListQueryOfflineEntityRef<ItemPayload>[];
    dependsOn?: (ctx: {
      input: __LEGIT_ANY__;
    }) => ListQueryOfflineEntityRef<ItemPayload>[];
  }
> &
  ([ItemState | QueryPayload | ItemPayload] extends [never] ? never : unknown);

export type ListQueryOfflineOperationsConfig<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = InternalListQueryOfflineOperations<
  ItemState,
  QueryPayload,
  ItemPayload
> | null;

type ListQueryPersistentStorageFields<
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
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
> = StorePersistentStorageBaseConfig<ItemState, StorageState> &
  PublicStoreOfflineConfigField<TOfflineOperations> &
  ListQueryPersistentStorageFields<QueryPayload, ItemPayload>;

export type ResolvedListQueryPersistentStorageConfig<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload = ValidPayload,
  ItemPayload extends ValidPayload = ValidPayload,
  StorageState = unknown,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
> = ResolvedStorePersistentStorageBaseConfig<ItemState, StorageState> &
  ResolvedStoreOfflineConfigField<TOfflineOperations> &
  ListQueryPersistentStorageFields<QueryPayload, ItemPayload>;

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
