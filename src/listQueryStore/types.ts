import { FetchType } from '../requestScheduler';
import {
  StoreError,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';

/** Lifecycle status for a list query or list item query. */
export type QueryStatus = TSDFStatus | 'loadingMore';

/** Raw cached state for one list query. */
export type TSFDListQuery<QueryPayload extends ValidPayload> = {
  /** Last fetch error for this query, when the latest fetch failed. */
  error: StoreError | null;
  /** Current fetch lifecycle status for this query. */
  status: QueryStatus;
  /** Payload used to identify and fetch this query. */
  payload: QueryPayload;
  /** Whether another page is available. */
  hasMore: boolean;
  /** Whether this query has ever loaded successfully. */
  wasLoaded: boolean;
  /** Pending automatic refetch priority for stale data mounted by hooks. */
  refetchOnMount: false | FetchType;
  /** Ordered item keys included in the cached query page. */
  items: string[];
};

/** Raw cached state for one item query in a list-query store. */
export type TSDFItemQuery<ItemPayload extends ValidPayload> = {
  /** Last item fetch error, if any. */
  error: StoreError | null;
  /** Current fetch lifecycle status for this item. */
  status: Exclude<QueryStatus, 'loadingMore'>;
  /** Whether this item has ever loaded successfully. */
  wasLoaded: boolean;
  /** Pending automatic refetch priority for stale data mounted by hooks. */
  refetchOnMount: false | FetchType;
  /** Payload used to identify and fetch this item. */
  payload: ItemPayload;
};

/** Loaded partial-resource fields for one item, or `'*'` when fully loaded. */
export type ItemLoadedFields = string[] | '*';

/** Raw t-state shape used by a list-query store. */
export type TSFDListQueryState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  /** Item data records keyed by item store key. */
  items: Record<string, ItemState | null>;
  /** List query records keyed by query store key. */
  queries: Record<string, TSFDListQuery<QueryPayload>>;
  /** Item query records keyed by item store key. */
  itemQueries: Record<string, TSDFItemQuery<ItemPayload> | null>;
  /** Loaded partial-resource fields for each item key. */
  itemLoadedFields: Record<string, ItemLoadedFields>;
  /** Pending field invalidations for each item key. */
  itemFieldInvalidationFields: Record<string, string[]>;
};

export type ListQueryOfflineOverlay<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  item: ItemState | null;
  itemPayload?: ItemPayload;
  queryMemberships: Record<string, number>;
  /**
   * Temporary-id remaps can leave a child mutation in manual resolution while
   * it already targets the real server item. Keep that overlay visible until
   * the child resolution is cleared.
   */
  keepVisibleWhileResolutionRequired?: boolean;
};

/**
 * Partial-resource fields to request.
 *
 * Pass a field-name array to load only those fields, or `'*'` to load the
 * complete item.
 */
export type FieldsInput = string[] | '*';

/** Value returned by `ListQueryStore.useListQuery(...)` and `useMultipleListQueries(...)`. */
export type TSFDUseListQueryReturn<
  Selected,
  QueryPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
  HasPartialResources extends boolean = false,
> = {
  /** Selected items included in the current query result. */
  items: Selected[];
  /** Hook-visible query status, including `idle` before a query runs. */
  status: QueryStatus | 'idle';
  /** Query payload for this result, unless omitted or unavailable. */
  payload: QueryPayload | undefined;
  /** Requested partial-resource fields for this query result. */
  fields: HasPartialResources extends true
    ? FieldsInput
    : FieldsInput | undefined;
  /** Requested partial-resource fields that are still pending. */
  loadingFields?: string[];
  /** Last query fetch error, if any. */
  error: StoreError | null;
  /** Stable store key for the current query payload. */
  queryKey: string;
  /** Whether another page is available. */
  hasMore: boolean;
  /** Whether this result was derived from local items instead of fetched directly. */
  isDerived: boolean;
  /** Convenience flag for `loading` or `refetching` states. */
  isLoading: boolean;
  /** Whether a `loadMore(...)` request is currently active. */
  isLoadingMore: boolean;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
  /** Caller-provided metadata copied from the query descriptor. */
  queryMetadata: QueryMetadata;
};

/** Value returned by `ListQueryStore.useItem(...)` and `useMultipleItems(...)`. */
export type TSFDUseListItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  /** Selected item data. Defaults to the full item or `null`. */
  data: Selected;
  /** Hook-visible item status, including idle/deleted states for hook ergonomics. */
  status: QueryStatus | 'idle' | 'deleted';
  /** Item payload for this result, or `null` when unavailable. */
  payload: ItemPayload | null;
  /** Requested partial-resource fields that are still pending. */
  loadingFields?: string[];
  /** Last item fetch error, if any. */
  error: StoreError | null;
  /** Convenience flag for `loading` or `refetching` states. */
  isLoading: boolean;
  /** Stable store key for the current item payload. */
  itemStateKey: string;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
  /** Caller-provided metadata copied from the query descriptor. */
  queryMetadata: QueryMetadata;
};

/** Value returned by `ListQueryStore.usePendingOfflineItems(...)`. */
export type TSFDUsePendingOfflineItemsReturn<
  Selected,
  ItemPayload extends ValidPayload,
> = {
  /** Locally created or updated offline items selected by the hook. */
  items: Selected[];
  /** Payloads for locally deleted offline items. */
  deletedItems: ItemPayload[];
};

/** One item returned from a list query fetch function. */
export type FetchListFnReturnItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = {
  /** Item payload used to key and refetch the returned item. */
  itemPayload: ItemPayload;
  /** Item data returned by the server. */
  data: ItemState;
};

/** Return shape for list query fetch functions. */
export type FetchListFnReturn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  /** Items included in the fetched page. */
  items: FetchListFnReturnItem<ItemPayload, ItemState>[];
  /** Whether the query has another page available. */
  hasMore: boolean;
};

/** @internal */
export type ListQueryStoreInitialData<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  items: { payload: ItemPayload; data: ItemState }[];
  queries: { payload: QueryPayload; items: string[]; hasMore: boolean }[];
};

/** Item descriptor accepted by `ListQueryStore.useMultipleItems(...)`. */
export type ListQueryUseMultipleItemsQuery<
  ItemPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  /** Item payload to subscribe to and fetch when needed. */
  payload: ItemPayload;
  /**
   * Partial-resource fields to request for this item.
   *
   * Pass `'*'` to fetch the complete item. This option is required when
   * `partialResources` is enabled and optional otherwise.
   */
  fields?: FieldsInput;
  /** Metadata returned with this item result for caller-side bookkeeping. */
  queryMetadata?: QueryMetadata;
  /**
   * Only fetches when the item is missing from state, skipping stale-state and
   * invalidation refetches.
   */
  disableRefetches?: boolean;
  /** Prevents the automatic mount refetch for stale loaded data. */
  disableRefetchOnMount?: boolean;
  /** Returns `idle` instead of `loading` while the item has not been fetched. */
  returnIdleStatus?: boolean;
  /** Returns `refetching` instead of keeping `loaded` status during refetches. */
  returnRefetchingStatus?: boolean;
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
  /** Marks this subscription as off-screen, lowering automatic fetch priority. */
  isOffScreen?: boolean;
};

/** Query descriptor accepted by `ListQueryStore.useMultipleListQueries(...)`. */
export type ListQueryUseMultipleListQueriesQuery<
  QueryPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  /** Query payload to subscribe to and fetch when needed. */
  payload: QueryPayload;
  /**
   * Partial-resource fields to request for each item in this query.
   *
   * Pass `'*'` to fetch complete items. This option is required when
   * `partialResources` is enabled and optional otherwise.
   */
  fields?: FieldsInput;
  /** Metadata returned with this query result for caller-side bookkeeping. */
  queryMetadata?: QueryMetadata;
  /** Omits `payload` from this query result. */
  omitPayload?: boolean;
  /**
   * Only fetches when the query is missing from state, skipping stale-state and
   * invalidation refetches.
   */
  disableRefetches?: boolean;
  /** Prevents the automatic mount refetch for stale loaded data. */
  disableRefetchOnMount?: boolean;
  /** Returns `idle` instead of `loading` while the query has not been fetched. */
  returnIdleStatus?: boolean;
  /** Returns `refetching` instead of keeping `loaded` status during refetches. */
  returnRefetchingStatus?: boolean;
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
  /** Marks this subscription as off-screen, lowering automatic fetch priority. */
  isOffScreen?: boolean;
  /** Number of items to request when fetching this query page. */
  loadSize?: number;
};

/** Callback invoked when an already-loaded list query is invalidated. */
export type OnListQueryInvalidate<QueryPayload extends ValidPayload> = (
  query: QueryPayload,
  priority: FetchType,
) => void;

/** Callback invoked when an already-loaded list-query item is invalidated. */
export type OnListQueryItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  /** Current cached item state at invalidation time. */
  itemState: ItemState;
  /** Payload of the invalidated item. */
  payload: ItemPayload;
  /** Fetch priority requested for the invalidation. */
  priority: FetchType;
}) => void;

/** Rule for keeping cached list query membership in sync after item updates. */
export type OptimisticListUpdate<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  /** Query payloads, or a predicate over query payloads, affected by this rule. */
  queries: QueryPayload | ((query: QueryPayload) => boolean) | QueryPayload[];
  /** Restricts this rule to items that should belong in the affected query set. */
  filterItem?: (item: ItemState) => boolean | null;
  /** Where newly matching items should be inserted in affected query pages. */
  appendNewTo?: 'start' | 'end';
  /**
   * Schedules a background refetch of queries this rule mutated. Leave off
   * unless the optimistic update can't represent the final server state —
   * e.g. server-assigned sort fields (`updatedAt`, computed scores), server-
   * only membership data (permissions), or cursor pagination shifts.
   */
  invalidateQueries?: boolean;
  /** Sort order to maintain inside affected query pages. */
  sort?: {
    /** Selects sortable values from an item. */
    sortBy: (
      item: ItemState,
      itemPayload: ItemPayload,
    ) => string | number | (string | number)[];
    /** Sort direction for each `sortBy` value. */
    order?: 'asc' | 'desc' | ('asc' | 'desc')[];
  };
};

/** Payload passed to list fetch functions. */
export type QueryFetchPayload<QueryPayload extends ValidPayload> = {
  /** Whether this request loads the first page or a later page. */
  type: 'load' | 'loadMore';
  /** Query payload being fetched. */
  payload: QueryPayload;
  /** Offset used for offset-paginated fetches. */
  offset: number;
  /** Maximum number of items requested. */
  limit: number;
  /** Partial-resource fields requested for each item in the fetched query. */
  fields?: string[];
};

/** Options for offset-based list pagination. */
export type OffsetPaginationConfig = {
  /** Largest item count requested when refetching invalidated offset queries. */
  maxInvalidationLimit: number;
  /** Max parallel chunk requests during chunked invalidation (default: 3) */
  maxParallel?: number;
};

/** Partial-resource helpers used to merge and select field subsets. */
export type PartialResourcesConfig<ItemState extends ValidStoreState> = {
  /** Merges a partial fetch result into an existing item snapshot. */
  mergeItems: (prev: ItemState | undefined, fetched: ItemState) => ItemState;
  /** Returns an item containing only the requested fields. */
  selectFields: (fields: string[], item: ItemState) => ItemState;
  /**
   * Reports which logical fields are genuinely present in an item snapshot,
   * or `'*'` when the snapshot is complete.
   *
   * It is the only availability signal for snapshots without loaded-field
   * metadata (manually inserted items, persisted fallback snapshots, offline
   * optimistic rows), but it is also consulted for metadata-tracked items:
   * metadata only records what fetches delivered, so `inferFields` can vouch
   * for fields present beyond the tracked list (e.g. written by a mutation)
   * and avoid refetching data that is already there.
   *
   * Because it can vouch for any snapshot, it must only report fields whose
   * data is genuinely usable — never return `'*'` unconditionally unless
   * every snapshot the store can hold is complete. Staleness is handled by
   * TSDF: fields awaiting an invalidation refetch are excluded before
   * `inferFields` is consulted.
   */
  inferFields: (item: ItemState) => ItemLoadedFields;
};

export type DerivedQuerySummary<QueryPayload extends ValidPayload> = {
  payload: QueryPayload;
  hasMore: boolean;
  itemCount: number;
};

export type DerivedQueryItem<ItemState extends ValidStoreState> = {
  key: string;
  data: ItemState;
};

/** Why a derived query is currently being resolved. */
export type DerivedQuerySource = 'online' | 'offline' | 'sticky-offline';

/** Runtime context passed to `derivedQueries.deriveQuery(...)`. */
export type DerivedQueryContext = {
  /** The requested hook fields for this query, when partial resources are enabled. */
  fields: FieldsInput | undefined;
  /** Whether the store is currently in offline mode. */
  isOfflineMode: boolean;
  /**
   * What caused derivation to run.
   * `sticky-offline` means a query that was derived offline is still sticking
   * to the local derived view after reconnect, until explicit invalidation.
   */
  deriveSource: DerivedQuerySource;
};

/** Configuration for deriving query membership from locally materialized items. */
export type DerivedQueriesConfig<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  /** Extracts the domain/group key for a query payload. */
  getQueryGroup: (queryPayload: QueryPayload) => string;
  /** Extracts the domain/group key for a materialized item. */
  getItemGroup: (item: ItemState, itemPayload: ItemPayload) => string;
  /**
   * Returns whether the local data for the query group is complete enough to
   * derive from while online.
   */
  isComplete: (
    queryPayload: QueryPayload,
    context: { queries: DerivedQuerySummary<QueryPayload>[] },
  ) => boolean;
  /**
   * Computes a derived ordered list of item keys for a query, or `false` to
   * fall back to the regular fetch/cache path. `context.fields` lets the
   * callback decide whether partial-resource queries should still derive.
   */
  deriveQuery: (
    queryPayload: QueryPayload,
    items: DerivedQueryItem<ItemState>[],
    context: DerivedQueryContext,
  ) => string[] | false;
};

/** Field option shape used by APIs that are conditional on `partialResources`. */
export type FieldsOption<HasPartialResources extends boolean> =
  HasPartialResources extends true
    ? {
        /**
         * Partial-resource fields to request.
         *
         * Pass `'*'` to fetch complete items. This option is required when
         * `partialResources` is enabled.
         */
        fields: FieldsInput;
      }
    : {
        /**
         * Partial-resource fields to request.
         *
         * Pass `'*'` to fetch complete items. This option is optional when
         * `partialResources` is not enabled.
         */
        fields?: FieldsInput;
      };
