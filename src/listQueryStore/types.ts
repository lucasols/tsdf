import { FetchType } from '../requestScheduler';
import {
  StoreError,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';

export type QueryStatus = TSDFStatus | 'loadingMore';

export type TSFDListQuery<QueryPayload extends ValidPayload> = {
  error: StoreError | null;
  status: QueryStatus;
  payload: QueryPayload;
  hasMore: boolean;
  wasLoaded: boolean;
  refetchOnMount: false | FetchType;
  items: string[];
};

export type TSDFItemQuery<ItemPayload extends ValidPayload> = {
  error: StoreError | null;
  status: Exclude<QueryStatus, 'loadingMore'>;
  wasLoaded: boolean;
  refetchOnMount: false | FetchType;
  payload: ItemPayload;
};

export type TSFDListQueryState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  items: Record<string, ItemState | null>;
  queries: Record<string, TSFDListQuery<QueryPayload>>;
  itemQueries: Record<string, TSDFItemQuery<ItemPayload> | null>;
  itemLoadedFields: Record<string, string[]>;
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

export type TSFDUseListQueryReturn<
  Selected,
  QueryPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
  HasPartialResources extends boolean = false,
> = {
  items: Selected[];
  status: QueryStatus | 'idle';
  payload: QueryPayload | undefined;
  fields: HasPartialResources extends true
    ? FieldsInput
    : FieldsInput | undefined;
  /** Requested partial-resource fields that are still pending. */
  loadingFields?: string[];
  error: StoreError | null;
  queryKey: string;
  hasMore: boolean;
  isDerived: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
  queryMetadata: QueryMetadata;
};

export type TSFDUseListItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  data: Selected;
  status: QueryStatus | 'idle' | 'deleted';
  payload: ItemPayload | null;
  /** Requested partial-resource fields that are still pending. */
  loadingFields?: string[];
  error: StoreError | null;
  isLoading: boolean;
  itemStateKey: string;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
  queryMetadata: QueryMetadata;
};

export type TSFDUsePendingOfflineItemsReturn<
  Selected,
  ItemPayload extends ValidPayload,
> = { items: Selected[]; deletedItems: ItemPayload[] };

export type FetchListFnReturnItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = { itemPayload: ItemPayload; data: ItemState };

export type FetchListFnReturn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  items: FetchListFnReturnItem<ItemPayload, ItemState>[];
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

export type OnListQueryInvalidate<QueryPayload extends ValidPayload> = (
  query: QueryPayload,
  priority: FetchType,
) => void;

export type OnListQueryItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  itemState: ItemState;
  payload: ItemPayload;
  priority: FetchType;
}) => void;

export type OptimisticListUpdate<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  queries: QueryPayload | ((query: QueryPayload) => boolean) | QueryPayload[];
  filterItem?: (item: ItemState) => boolean | null;
  appendNewTo?: 'start' | 'end';
  invalidateQueries?: boolean;
  sort?: {
    sortBy: (
      item: ItemState,
      itemPayload: ItemPayload,
    ) => string | number | (string | number)[];
    order?: 'asc' | 'desc' | ('asc' | 'desc')[];
  };
};

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

export type OffsetPaginationConfig = {
  maxInvalidationLimit: number;
  /** Max parallel chunk requests during chunked invalidation (default: 3) */
  maxParallel?: number;
};

export type PartialResourcesConfig<ItemState extends ValidStoreState> = {
  mergeItems: (prev: ItemState | undefined, fetched: ItemState) => ItemState;
  selectFields: (fields: string[], item: ItemState) => ItemState;
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
