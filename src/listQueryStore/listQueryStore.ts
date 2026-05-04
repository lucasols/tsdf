import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { notNullish } from '@ls-stack/utils/assertions';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter, type Emitter } from 'evtmitter';
import { klona } from 'klona/json';
import { useCallback } from 'react';
import { Result, type Result as ResultType } from 't-result';
import { Store } from 't-state';
import { createLruCacheRuntime } from '../cacheLimits/lruCacheRuntime';
import {
  CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS,
  createIdleThrottledScheduler,
} from '../cacheLimits/scheduleIdleThrottled';
import {
  wrapGetSessionKeyForTest,
  wrapOfflineOperationsForTimeline,
} from '../internal/offlineTestInstrumentation';
import type {
  TestOfflineTimelineEvent,
  TestSessionKeyChangedEvent,
} from '../internal/testTimelineTypes';
import { setupListQueryPersistence } from '../persistentStorage/listQueryStorePersistence';
import type { OfflineMutationResult } from '../persistentStorage/offline/mutationRuntime';
import { isOfflineResolutionRecordForStore } from '../persistentStorage/offline/offlineResolution.typeGuards';
import {
  captureOfflineOverlayEntries,
  rebindOfflineOverlayEntries,
} from '../persistentStorage/offline/overlayStoreLifecycle';
import {
  useOfflineStoreEntities,
  useOfflineStoreEntitiesWithPayload,
  useOfflineStoreResolutions,
  useOfflineStoreStatus,
} from '../persistentStorage/offline/sessionCoordinator';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  type OfflineStoreController,
} from '../persistentStorage/offline/storeController';
import {
  offlineItemEntityRefSchema,
  OfflineResolutionConflictParseError,
  type GlobalOfflineEntity,
  type OfflineMutationInput,
  type OfflineResolutionActionForOperation,
  type OfflineResolutionRecord,
  type ParsedOfflineResolutionConflictResultForStore,
} from '../persistentStorage/offline/types';
import type { OfflineMutationUploadsInput } from '../persistentStorage/offlineUploadTypes';
import {
  createProtectedStorageKey,
  isOfflineNetworkModeActiveSync,
} from '../persistentStorage/persistentStorageManager';
import type {
  ListQueryOfflineOperationsConfig,
  ListQueryPersistentStorageConfig,
  PersistentStoragePreloadResult,
  ResolvedListQueryPersistentStorageConfig,
} from '../persistentStorage/types';
import {
  FetchType,
  RequestSchedulerEventData,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
import {
  registerStoreWithManager,
  resolveStoreManagerOfflineSession,
  validateStoreManagerSessionConsistency,
  type StoreManager,
} from '../storeManager';
import {
  createBrowserTabsPriority,
  type BrowserTabsPriorityTimings,
  type BrowserTabsTabStatusMessage,
} from '../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinator,
  createBrowserTabsCoordinatorWithPriority,
  isBrowserTabsSyncVersionNewer,
  toBrowserTabsSyncVersion,
  type BrowserTabsMessageMeta,
  type BrowserTabsSyncVersion,
  type BrowserTabsTransportFactory,
  type SnapshotConsistency,
} from '../utils/browserTabsSync';
import { createStoreFocusLifecycle } from '../utils/storeFocusLifecycle';
import {
  DEFAULT_BATCH_KEY,
  resolveManagerFallback,
  StoreFetchError,
  StoreMutationError,
  type MaybeTSDFResult,
  type MutationSkipped,
  type StoreMutationErrorOptions,
  type UnwrapTSDFResult,
  type ValidPayload,
  type ValidStoreState,
} from '../utils/storeShared';
import { createFetchApi } from './createFetchApi';
import { createMutationApi } from './createMutationApi';
import {
  excludeLoadedFields,
  fallbackItemHasRequestedFields,
} from './itemFieldUtils';
import { createListQueryCacheLimits } from './listQueryCacheLimits';
import {
  type DerivedQueriesConfig,
  type FetchListFnReturn,
  type FieldsInput,
  type FieldsOption,
  type ListQueryOfflineOverlay,
  type ListQueryStoreInitialData,
  type ListQueryUseMultipleItemsQuery,
  type ListQueryUseMultipleListQueriesQuery,
  type OffsetPaginationConfig,
  type OnListQueryInvalidate,
  type OnListQueryItemInvalidate,
  type OptimisticListUpdate,
  type PartialResourcesConfig,
  type TSDFItemQuery,
  type TSFDListQuery,
  type TSFDListQueryState,
  type TSFDUseListItemReturn,
  type TSFDUseListQueryReturn,
  type TSFDUsePendingOfflineItemsReturn,
} from './types';
import { useFindItem as useFindItemHook } from './useFindItem';
import { useItem as useItemHook, UseItemOptions } from './useItem';
import {
  useListQuery as useListQueryHook,
  UseListQueryOptions,
} from './useListQuery';
import {
  useMultipleItems as useMultipleItemsHook,
  UseMultipleItemsOptions,
} from './useMultipleItems';
import {
  useMultipleListQueries as useMultipleListQueriesHook,
  UseMultipleListQueriesOptions,
} from './useMultipleListQueries';
import {
  usePendingOfflineItems as usePendingOfflineItemsHook,
  type UsePendingOfflineItemsOptions,
} from './usePendingOfflineItems';

/** Event payloads emitted by `ListQueryStore.events`. */
export type ListQueryStoreEvents = {
  /** Emitted whenever one or more list queries are invalidated. */
  invalidateQuery: {
    /** Fetch priority requested by the invalidation. */
    priority: FetchType;
    /** Store key for the invalidated query. */
    queryKey: string;
  };
  /** Emitted whenever one or more list-query items are invalidated. */
  invalidateItem: {
    /** Fetch priority requested by the invalidation. */
    priority: FetchType;
    /** Store key for the invalidated item. */
    itemKey: string;
    /** Partial-resource fields invalidated on this item, when applicable. */
    invalidateFields?: string[];
  };
};

type ListQueryStoreStoreEvents<ItemPayload extends ValidPayload> = {
  mutationStart: { mutationId: number; items: ItemPayload[] };
  mutationEnd: {
    mutationId: number;
    items: ItemPayload[];
    status: 'success' | 'error' | 'skipped';
  };
  tempEntityReconciled: { tempId: ItemPayload; finalPayload: ItemPayload };
};

type ResolvedListQueryOfflineOperations<TOfflineOperations> =
  TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;

type ListQueryHasPartialResources<TPartialResources extends boolean> = [
  TPartialResources,
] extends [true]
  ? true
  : false;

type ListQueryFetchFieldsOption<TPartialResources extends boolean> =
  ListQueryHasPartialResources<TPartialResources> extends true
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

type ListQueryScheduleFetchWithFieldsOption<TPartialResources extends boolean> =
  ScheduleFetchOptions & ListQueryFetchFieldsOption<TPartialResources>;

type ListQueryScheduleListQueryFetchApi<
  QueryPayload extends ValidPayload,
  TPartialResources extends boolean,
> = {
  (
    fetchType: FetchType,
    payload: QueryPayload,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [
          /** Number of items to request. Defaults to the store's `defaultQuerySize`. */
          size: number | undefined,
          options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
      : [
          /** Number of items to request. Defaults to the store's `defaultQuerySize`. */
          size?: number,
          options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
  ): ScheduleFetchResults;
  (
    fetchType: FetchType,
    payload: QueryPayload[],
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [
          /** Number of items to request. Defaults to the store's `defaultQuerySize`. */
          size: number | undefined,
          options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
      : [
          /** Number of items to request. Defaults to the store's `defaultQuerySize`. */
          size?: number,
          options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
  ): ScheduleFetchResults[];
};

type ListQueryScheduleItemFetchApi<
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = {
  (
    fetchType: FetchType,
    itemPayload: ItemPayload,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
      : [options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
  ): ScheduleFetchResults;
  (
    fetchType: FetchType,
    itemPayload: ItemPayload[],
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
      : [options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
  ): ScheduleFetchResults[];
};

type ListQueryLoadMoreWithFieldsOptions<TPartialResources extends boolean> = {
  /** Number of additional items to request. Defaults to the store's `defaultQuerySize`. */
  size?: number;
} & ListQueryFetchFieldsOption<TPartialResources>;

type ListQueryLoadMoreApi<
  QueryPayload extends ValidPayload,
  TPartialResources extends boolean,
> = (
  params: QueryPayload,
  ...args: ListQueryHasPartialResources<TPartialResources> extends true
    ?
        | [size: number, options: ListQueryFetchFieldsOption<TPartialResources>]
        | [options: ListQueryLoadMoreWithFieldsOptions<TPartialResources>]
    :
        | [
            /** Number of additional items to request. Defaults to the store's `defaultQuerySize`. */
            size?: number,
            options?: ListQueryFetchFieldsOption<TPartialResources>,
          ]
        | [options?: ListQueryLoadMoreWithFieldsOptions<TPartialResources>]
) => ScheduleFetchResults;

type ListQueryAwaitListQueryFetchOptions<TPartialResources extends boolean> = {
  /** Number of items to request. Defaults to the store's `defaultQuerySize`. */
  size?: number;
  timeoutMs?: number;
} & ListQueryFetchFieldsOption<TPartialResources>;

type ListQueryAwaitListQueryFetchApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = (
  params: QueryPayload,
  ...args: ListQueryHasPartialResources<TPartialResources> extends true
    ? [options: ListQueryAwaitListQueryFetchOptions<TPartialResources>]
    : [options?: ListQueryAwaitListQueryFetchOptions<TPartialResources>]
) => Promise<
  | { items: []; error: StoreFetchError; hasMore: boolean }
  | {
      items: { data: ItemState; itemPayload: ItemPayload }[];
      error: null;
      hasMore: boolean;
    }
>;

type ListQueryGetQueryFromStateOrFetchOptions<
  TPartialResources extends boolean,
> = {
  /** When `true`, stale cached queries are ignored and refetched before returning. Defaults to `false`. */
  ignoreStaleState?: boolean;
  /** Number of items to request when a fetch is needed. Defaults to the store's `defaultQuerySize`. */
  size?: number;
  timeoutMs?: number;
} & ListQueryFetchFieldsOption<TPartialResources>;

type ListQueryGetQueryFromStateOrFetchApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = (
  params: QueryPayload,
  ...args: ListQueryHasPartialResources<TPartialResources> extends true
    ? [options: ListQueryGetQueryFromStateOrFetchOptions<TPartialResources>]
    : [options?: ListQueryGetQueryFromStateOrFetchOptions<TPartialResources>]
) => Promise<
  ResultType<
    {
      items: { data: ItemState; itemPayload: ItemPayload }[];
      hasMore: boolean;
    },
    StoreFetchError
  >
>;

type ListQueryAwaitItemFetchOptions<TPartialResources extends boolean> = {
  timeoutMs?: number;
} & ListQueryFetchFieldsOption<TPartialResources>;

type ListQueryAwaitItemFetchApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = (
  itemPayload: ItemPayload,
  ...args: ListQueryHasPartialResources<TPartialResources> extends true
    ? [options: ListQueryAwaitItemFetchOptions<TPartialResources>]
    : [options?: ListQueryAwaitItemFetchOptions<TPartialResources>]
) => Promise<
  { data: null; error: StoreFetchError } | { data: ItemState; error: null }
>;

type ListQueryGetItemFromStateOrFetchOptions<
  TPartialResources extends boolean,
> = {
  /** When `true`, stale cached items are ignored and refetched before returning. Defaults to `false`. */
  ignoreStaleState?: boolean;
  timeoutMs?: number;
} & ListQueryFetchFieldsOption<TPartialResources>;

type ListQueryGetItemFromStateOrFetchApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = (
  itemPayload: ItemPayload,
  ...args: ListQueryHasPartialResources<TPartialResources> extends true
    ? [options: ListQueryGetItemFromStateOrFetchOptions<TPartialResources>]
    : [options?: ListQueryGetItemFromStateOrFetchOptions<TPartialResources>]
) => Promise<ResultType<ItemState, StoreFetchError>>;

type ListQueryUseMultipleListQueriesApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = {
  <
    SelectedItem = ItemState,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    queries: (ListQueryUseMultipleListQueriesQuery<
      QueryPayload,
      QueryMetadata
    > &
      FieldsOption<ListQueryHasPartialResources<TPartialResources>>)[],
    options?: UseMultipleListQueriesOptions<
      ItemState,
      ItemPayload,
      SelectedItem
    >,
  ): readonly TSFDUseListQueryReturn<
    SelectedItem,
    QueryPayload,
    QueryMetadata
  >[];
  <S = ItemState>(
    queries: ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[],
    options: UseMultipleListQueriesOptions<ItemState, ItemPayload, S>,
  ): readonly TSFDUseListQueryReturn<S, QueryPayload, undefined>[];
};

type ListQueryUseListQueryApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = {
  <SelectedItem = ItemState>(
    payload: QueryPayload | false | null | undefined,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [
          options: UseListQueryOptions<ItemState, ItemPayload, SelectedItem> &
            FieldsOption<true>,
        ]
      : [options?: UseListQueryOptions<ItemState, ItemPayload, SelectedItem>]
  ): TSFDUseListQueryReturn<SelectedItem, QueryPayload, undefined>;
};

type ListQueryUseMultipleItemsApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = {
  <
    Selected = ItemState | null,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    items: (ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata> &
      FieldsOption<ListQueryHasPartialResources<TPartialResources>>)[],
    options?: UseMultipleItemsOptions<ItemState, Selected>,
  ): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[];
  <S = ItemState | null>(
    items: ListQueryUseMultipleItemsQuery<ItemPayload, undefined>[],
    options: UseMultipleItemsOptions<ItemState, S>,
  ): readonly TSFDUseListItemReturn<S, ItemPayload, undefined>[];
};

type ListQueryUseItemApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean,
> = {
  <Selected = ItemState | null>(
    itemPayload: ItemPayload | false | null | undefined,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [options: UseItemOptions<ItemState, Selected> & FieldsOption<true>]
      : [options?: UseItemOptions<ItemState, Selected>]
  ): TSFDUseListItemReturn<Selected, ItemPayload>;
};

type ListQueryUsePendingOfflineItemsApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  <SelectedItem = ItemState>(
    options?: UsePendingOfflineItemsOptions<
      ItemState,
      ItemPayload,
      SelectedItem
    >,
  ): TSFDUsePendingOfflineItemsReturn<SelectedItem, ItemPayload>;
};

type ListQueryFilterQuery<QueryPayload extends ValidPayload> = (
  params: QueryPayload,
  data: TSFDListQuery<QueryPayload>,
  queryKey: string,
) => boolean;

type ListQueryRevalidateOnSuccessOption<QueryPayload extends ValidPayload> =
  | boolean
  | 'queries'
  | ListQueryFilterQuery<QueryPayload>
  | { queries: ListQueryFilterQuery<QueryPayload>; items?: boolean };

type ListQueryFilterItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (itemPayload: ItemPayload, itemState: ItemState) => boolean;

type ListQueryMutationPayload<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> =
  | ItemPayload
  | ItemPayload[]
  | ListQueryFilterItem<ItemState, ItemPayload>
  | null;

type ListQueryMutationPayloadToUse<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = ItemPayload | ItemPayload[] | ListQueryFilterItem<ItemState, ItemPayload>;

type ListQueryMutationArgsBase<
  T,
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  /**
   * Applies optimistic updates for the affected item payloads before the
   * mutation runs. Return `false` to cancel the mutation before the async
   * mutation function is called.
   */
  optimisticUpdate?: (
    payload: ListQueryMutationPayloadToUse<ItemState, ItemPayload>,
  ) => void | boolean;
  /** Performs the server mutation for the affected item payloads. */
  mutation: (
    payload: ListQueryMutationPayloadToUse<ItemState, ItemPayload>,
  ) => Promise<T>;
  /**
   * Controls query and item invalidation after a successful online mutation.
   *
   * Use `true` to invalidate affected items and all queries, `'queries'` to
   * invalidate only queries, a query filter to invalidate affected items and
   * matching queries, or `{ queries, items }` to choose both explicitly.
   */
  revalidateOnSuccess?: ListQueryRevalidateOnSuccessOption<QueryPayload>;
  /** Called after a successful online mutation. */
  onSuccess?: (
    response: UnwrapTSDFResult<Awaited<T>>,
    payload: ListQueryMutationPayloadToUse<ItemState, ItemPayload>,
  ) => void;
  /** Called after a failed or skipped mutation. */
  onError?: (error: StoreMutationError | MutationSkipped) => void;
  /**
   * Passes `{ silentErrors: true }` to `onMutationError`.
   *
   * The handler is still called so centralized logging and recovery can run,
   * but UI handlers can suppress user-facing notifications.
   */
  silentErrors?: boolean;
  /** Debounces mutations with the same context and payload. Superseded calls are skipped. */
  debounce?: { context: string; payload: unknown; ms: number };
};

type ListQueryOnlineMutationArgs<
  T,
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = ListQueryMutationArgsBase<T, ItemState, QueryPayload, ItemPayload> & {
  offline?: undefined;
  upload?: undefined;
};

type ListQueryOfflineMutationArgs<
  T,
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  >,
> = ListQueryMutationArgsBase<T, ItemState, QueryPayload, ItemPayload> & {
  /**
   * Queues this mutation through the store's registered offline operation when
   * the session is offline or the direct request fails with an offline outage.
   */
  offline: TOfflineOperations extends null
    ? never
    : OfflineMutationInput<Exclude<TOfflineOperations, null>>;
  /** Files to attach if this mutation is queued for offline replay. */
  upload?: OfflineMutationUploadsInput;
};

type ListQueryPerformMutationApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  >,
> = {
  /**
   * Runs a list-query mutation for existing item payloads or an item filter.
   *
   * Returns the direct server result when offline replay is not configured for
   * this call.
   */
  <T>(
    payload: ListQueryMutationPayloadToUse<ItemState, ItemPayload>,
    args: ListQueryOnlineMutationArgs<T, ItemState, QueryPayload, ItemPayload>,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a list-query mutation for existing item payloads or an item filter,
   * with durable offline queueing as a fallback.
   *
   * When the mutation is queued, the result is `{ kind: 'queued' }` instead of
   * the server payload.
   */
  <T>(
    payload: ListQueryMutationPayloadToUse<ItemState, ItemPayload>,
    args: ListQueryOfflineMutationArgs<
      T,
      ItemState,
      QueryPayload,
      ItemPayload,
      TOfflineOperations
    >,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a list-query mutation with no current item target.
   *
   * Use this for create mutations that do not have a pre-generated item payload
   * yet. Optimistic updates are not available without a target payload.
   */
  <T>(
    payload: null,
    args: Omit<
      ListQueryOnlineMutationArgs<T, ItemState, QueryPayload, ItemPayload>,
      'optimisticUpdate'
    >,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs an offline-capable list-query mutation with no current item target.
   *
   * Use this for create mutations that do not have a pre-generated item payload
   * yet. When the mutation is queued, the result is `{ kind: 'queued' }`.
   */
  <T>(
    payload: null,
    args: Omit<
      ListQueryOfflineMutationArgs<
        T,
        ItemState,
        QueryPayload,
        ItemPayload,
        TOfflineOperations
      >,
      'optimisticUpdate'
    >,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  <T>(
    payload: ListQueryMutationPayload<ItemState, ItemPayload>,
    args:
      | ListQueryOnlineMutationArgs<T, ItemState, QueryPayload, ItemPayload>
      | ListQueryOfflineMutationArgs<
          T,
          ItemState,
          QueryPayload,
          ItemPayload,
          TOfflineOperations
        >,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
};

type ListQueryUpdateItemStateApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (
  itemIds:
    | ItemPayload
    | ItemPayload[]
    | ListQueryFilterItem<ItemState, ItemPayload>,
  produceNewData: (
    draftData: ItemState,
    itemPayload: ItemPayload,
  ) => void | ItemState,
  options?: { ifNothingWasUpdated?: () => void },
) => boolean;

type ListQueryAddItemToStateApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = (
  itemPayload: ItemPayload,
  data: ItemState,
  options?: {
    addItemToQueries?: {
      queries:
        | QueryPayload[]
        | ListQueryFilterQuery<QueryPayload>
        | QueryPayload;
      appendTo: 'start' | 'end' | ((itemsPayload: ItemPayload[]) => number);
    };
  },
) => void;

type ListQueryDeleteItemStateApi<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (
  itemId:
    | ItemPayload
    | ItemPayload[]
    | ListQueryFilterItem<ItemState, ItemPayload>,
) => void;

type ListQueryInvalidateQueryAndItemsArgs<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> =
  | {
      /** Invalidate every cached query and every cached item. */
      all: true;
      /** Fetch priority used for refetches triggered by this invalidation. Defaults to `highPriority`. */
      type?: FetchType;
      /**
       * Partial-resource fields to invalidate on matching items.
       *
       * Omit to invalidate the full item data.
       */
      fields?: string[];
      /** Not allowed when invalidating every query and item. */
      itemPayload?: undefined;
      /** Not allowed when invalidating every query and item. */
      queryPayload?: undefined;
    }
  | {
      /** Leave unset when invalidating selected queries or items. */
      all?: undefined;
      /**
       * Items to invalidate.
       *
       * Pass one payload, many payloads, a predicate over cached items, or
       * `false` to skip item invalidation.
       */
      itemPayload:
        | ItemPayload
        | ItemPayload[]
        | ListQueryFilterItem<ItemState, ItemPayload>
        | false;
      /**
       * Queries to invalidate.
       *
       * Pass one payload, many payloads, a predicate over cached queries, or
       * `false` to skip query invalidation.
       */
      queryPayload:
        | QueryPayload
        | QueryPayload[]
        | ListQueryFilterQuery<QueryPayload>
        | false;
      /** Fetch priority used for refetches triggered by this invalidation. Defaults to `highPriority`. */
      type?: FetchType;
      /**
       * Partial-resource fields to invalidate on matching items.
       *
       * Omit to invalidate the full item data.
       */
      fields?: string[];
    };

/** Public API returned by `createListQueryStore(...)`. */
export type ListQueryStore<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean = false,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
> = {
  /** Underlying t-state store containing raw cached queries and items. */
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>;
  /** Invalidation event emitter used by hooks and integrations. */
  events: Emitter<ListQueryStoreEvents>;
  /** Mutation lifecycle event emitter for observers and tests. */
  storeEvents: Emitter<ListQueryStoreStoreEvents<ItemPayload>>;
  /** Query keys that have been explicitly invalidated and are awaiting refresh. */
  readonly queryInvalidationWasTriggered: Set<string>;
  /** Item keys that have been explicitly invalidated and are awaiting refresh. */
  readonly itemInvalidationWasTriggered: Set<string>;
  /** Clears in-memory state and cancels store-local runtime state. */
  reset: () => void;
  /** Unregisters listeners and releases resources owned by this store. */
  dispose: () => void;
  /** Schedules a list-query fetch with the requested priority. */
  scheduleListQueryFetch: ListQueryScheduleListQueryFetchApi<
    QueryPayload,
    TPartialResources
  >;
  /** Reads one cached query directly from store state. */
  getQueryState: (
    params: QueryPayload,
  ) => TSFDListQuery<QueryPayload> | undefined;
  /** Returns the stable cache key for a query payload. */
  getQueryKey: (params: QueryPayload) => string;
  /** Reads many cached queries directly from store state. */
  getQueriesState: (
    params: QueryPayload[] | ListQueryFilterQuery<QueryPayload>,
  ) => { query: TSFDListQuery<QueryPayload>; key: string }[];
  /** Finds cached queries that currently include the item payload. */
  getQueriesRelatedToItem: (
    itemPayload: ItemPayload,
  ) => { query: TSFDListQuery<QueryPayload>; key: string }[];
  /** Waits for a list-query fetch to settle and returns query data or a fetch error. */
  awaitListQueryFetch: ListQueryAwaitListQueryFetchApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  >;
  /** Returns a cached query when usable, otherwise fetches it first. */
  getQueryFromStateOrFetch: ListQueryGetQueryFromStateOrFetchApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  >;
  /** Loads query payloads from persistent storage into memory when available. */
  preloadQueryFromStorage: (
    params: QueryPayload | QueryPayload[],
  ) => Promise<PersistentStoragePreloadResult<QueryPayload>[]>;
  /** Fetches and appends the next page for a list query. */
  loadMore: ListQueryLoadMoreApi<QueryPayload, TPartialResources>;
  /** Returns the stable cache key for an item payload. */
  getItemKey: (params: ItemPayload) => string;
  /** Reads one or many cached items directly from store state. */
  getItemState: {
    (itemPayload: ItemPayload): ItemState | null | undefined;
    (
      itemPayload: ItemPayload[] | ListQueryFilterItem<ItemState, ItemPayload>,
    ): { payload: ItemPayload; data: ItemState }[];
  };
  /** React hook for locally pending offline items in this store. */
  usePendingOfflineItems: ListQueryUsePendingOfflineItemsApi<
    ItemState,
    ItemPayload
  >;
  /** Returns offline sync metadata for this store's tracked entities. */
  getOfflineEntities: () => GlobalOfflineEntity[];
  /** React hook subscribing to this store's offline entity metadata. */
  useOfflineEntities: () => readonly GlobalOfflineEntity[];
  /** React hook subscribing to manual offline resolutions for this store. */
  useOfflineResolutions: () => readonly OfflineResolutionRecord[];
  /** Returns manual offline resolutions for this store. */
  getOfflineResolutions: () => OfflineResolutionRecord[];
  /** Parses a stored offline conflict into the operation-specific conflict shape. */
  parseOfflineResolutionConflict: (
    resolution: OfflineResolutionRecord,
  ) => ParsedOfflineResolutionConflictResultForStore<
    ResolvedListQueryOfflineOperations<TOfflineOperations>
  >;
  /** Applies a retry/discard/requeue/commit action to a pending offline resolution. */
  resolveOfflineResolution: <
    TName extends keyof ResolvedListQueryOfflineOperations<TOfflineOperations> &
      string,
  >(
    resolutionId: string,
    operationName: TName,
    resolution: OfflineResolutionActionForOperation<
      ResolvedListQueryOfflineOperations<TOfflineOperations>,
      TName
    >,
  ) => Promise<void> | void;
  /** Loads item payloads from persistent storage into memory when available. */
  preloadItemFromStorage: (
    params: ItemPayload | ItemPayload[],
  ) => Promise<PersistentStoragePreloadResult<ItemPayload>[]>;
  /** Schedules an item fetch with the requested priority. */
  scheduleItemFetch: ListQueryScheduleItemFetchApi<
    ItemPayload,
    TPartialResources
  >;
  /** Waits for an item fetch to settle and returns data or a fetch error. */
  awaitItemFetch: ListQueryAwaitItemFetchApi<
    ItemState,
    ItemPayload,
    TPartialResources
  >;
  /** Returns cached item data when usable, otherwise fetches it first. */
  getItemFromStateOrFetch: ListQueryGetItemFromStateOrFetchApi<
    ItemState,
    ItemPayload,
    TPartialResources
  >;
  /** Invalidates selected queries and items together. Defaults to `highPriority`. */
  invalidateQueryAndItems: (
    args: ListQueryInvalidateQueryAndItemsArgs<
      ItemState,
      QueryPayload,
      ItemPayload
    >,
  ) => void;
  /** Marks cached items stale and schedules refetches for active subscriptions. Defaults to `highPriority`. */
  invalidateItem: (
    itemId:
      | ItemPayload
      | ItemPayload[]
      | ListQueryFilterItem<ItemState, ItemPayload>,
    /** Fetch priority used for refetches triggered by this invalidation. Defaults to `highPriority`. */
    priority?: FetchType,
  ) => void;
  /** Marks one or more items as mutating and returns a function that ends the mutation. */
  startItemMutation: (
    itemId:
      | ItemPayload
      | ItemPayload[]
      | ListQueryFilterItem<ItemState, ItemPayload>,
  ) => () => void;
  /** Applies an immutable update to one or more cached list-query items. */
  updateItemState: ListQueryUpdateItemStateApi<ItemState, ItemPayload>;
  /** Adds or replaces one cached item directly in state. */
  addItemToState: ListQueryAddItemToStateApi<
    ItemState,
    QueryPayload,
    ItemPayload
  >;
  /** Deletes one cached item directly from state and query membership. */
  deleteItemState: ListQueryDeleteItemStateApi<ItemState, ItemPayload>;
  /**
   * Runs the full mutation lifecycle: optional optimistic update, async
   * mutation, rollback/error handling, revalidation, and offline queue fallback.
   */
  performMutation: ListQueryPerformMutationApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >;
  /** React hook for subscribing to many list queries at once. */
  useMultipleListQueries: ListQueryUseMultipleListQueriesApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  >;
  /** React hook for subscribing to one list query. */
  useListQuery: ListQueryUseListQueryApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  >;
  /** React hook for subscribing to many list-query items at once. */
  useMultipleItems: ListQueryUseMultipleItemsApi<
    ItemState,
    ItemPayload,
    TPartialResources
  >;
  /** React hook for subscribing to one list-query item. */
  useItem: ListQueryUseItemApi<ItemState, ItemPayload, TPartialResources>;
  /** React hook for selecting the first cached item matching a predicate. */
  useFindItem: <SelectedItem = ItemState | null>(
    findItemFn: (item: ItemState, itemPayload: ItemPayload) => boolean,
    options?: {
      /** Maps the matched item before it is returned from the hook. */
      selector?: (data: ItemState, id: ItemPayload) => SelectedItem;
    },
  ) => SelectedItem | null;
  /** Notifies the store that a shared transport reconnected and should revalidate active data. */
  onTransportReconnect: () => void;
};

/** Details passed when list-query cache-limit cleanup evicts cached items or queries. */
export type ListQueryStateCleanup<
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  /** Cleanup trigger that removed these records. */
  reason: 'cacheLimitEviction';
  /** Item store keys removed from state. */
  itemKeys: string[];
  /** Original item payloads removed from state. */
  itemPayloads: ItemPayload[];
  /** Query store keys removed from state. */
  queryKeys: string[];
  /** Original query payloads removed from state. */
  queryPayloads: QueryPayload[];
};

const EMPTY_LIST_QUERY_OFFLINE_OPERATIONS = {};

const noPartialResourcesFieldsOptionError =
  'fields option is required when partialResources is enabled';

type FetchListFnSizeMode<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = (
  payload: QueryPayload,
  size: number,
  options: { signal: AbortSignal; fields?: string[] },
) => Promise<MaybeTSDFResult<FetchListFnReturn<ItemState, ItemPayload>>>;

type FetchListFnOffsetMode<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = (
  payload: QueryPayload,
  pagination: { offset: number; limit: number },
  options: { signal: AbortSignal; fields?: string[] },
) => Promise<MaybeTSDFResult<FetchListFnReturn<ItemState, ItemPayload>>>;

type ListQuerySnapshotItemEntry<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  itemKey: string;
  item: ItemState | null;
  itemQuery: TSDFItemQuery<ItemPayload> | null;
  loadedFields: string[];
};

/** @internal */
export type ListQueryBrowserTabsMessage<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> =
  | (BrowserTabsMessageMeta & BrowserTabsTabStatusMessage)
  | (BrowserTabsMessageMeta & {
      kind: 'list-query-snapshot';
      queryKey: string;
      consistency: SnapshotConsistency;
      query: TSFDListQuery<QueryPayload>;
      items: ListQuerySnapshotItemEntry<ItemState, ItemPayload>[];
    })
  | (BrowserTabsMessageMeta & {
      kind: 'list-item-snapshot';
      itemKey: string;
      consistency: SnapshotConsistency;
      item: ItemState | null;
      itemQuery: TSDFItemQuery<ItemPayload> | null;
      loadedFields: string[];
    })
  | (BrowserTabsMessageMeta & {
      kind: 'fetch-start';
      targetKey: string;
      requestIds: string[];
      startedAt: number;
    })
  | (BrowserTabsMessageMeta & {
      kind: 'fetch-success';
      targetKey: string;
      requestIds: string[];
      startedAt: number;
      duration: number;
    });

type ListQueryStoreOptionsBase<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean = false,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
  StorageState = unknown,
> = {
  /**
   * Stable id for this logical list-query store. Used for debug labels,
   * persistence namespaces, and browser tab sync.
   */
  id: string;
  /** Shared global store manager providing session scoping and error normalization. */
  storeManager: StoreManager;
  /** Fetches one item by payload. Required when items can be loaded outside list pages. */
  fetchItemFn?: (
    payload: ItemPayload,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<MaybeTSDFResult<ItemState>>;
  /** Optional batch fetch function for fetching multiple items at once. */
  batchFetchItemFn?: (
    requests: { payload: ItemPayload; fields?: string[] }[],
    options: { signal: AbortSignal; batchKey: string },
  ) => Promise<
    MaybeTSDFResult<Map<ItemPayload, MaybeTSDFResult<ItemState> | Error>>
  >;
  /** Optional function to group item batch fetches by key. When omitted, all batched items share one default batch key. Return false to fetch individually. */
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  /** Default number of items requested by list-query fetches. Defaults to 50. */
  defaultQuerySize?: number;
  /** Max items per item batch. Defaults to 50. Triggers an immediate fetch when reached. */
  maxItemBatchSize?: number;
  /** Maximum number of cached items kept in memory. Defaults to 5,000. Item pressure may evict whole inactive queries to avoid leaving cached queries partially loaded. */
  maxItems?: number;
  /** Maximum number of cached queries kept in memory. Defaults to 1,000. Inactive queries are evicted in LRU order while mounted hook queries stay protected. */
  maxQueries?: number;
  /** Called when cache-limit eviction removes items or queries from in-memory state. */
  onStateCleanup?: (
    cleanup: ListQueryStateCleanup<QueryPayload, ItemPayload>,
  ) => void;
  /** Treats refetches as real-time driven, disabling stale mount refetches by default. Defaults to `false`. */
  usesRealTimeUpdates?: boolean;
  /** @internal */
  '~test'?: {
    initialData?: ListQueryStoreInitialData<
      ItemState,
      QueryPayload,
      ItemPayload
    >;
    initialRefetchOnMount?: FetchType | false;
    initialLastFetchStartTime?: number;
    getWindowIsFocused?: () => boolean;
    onWindowFocus?: (handler: () => void) => () => void;
    onWindowFocusChange?: (handler: () => void) => () => void;
    browserTabsTransportFactory?: BrowserTabsTransportFactory;
    browserTabsPriorityTimings?: BrowserTabsPriorityTimings;
    browserTabsLeadershipTimings?: BrowserTabsPriorityTimings;
    onReceiveRemoteMsg?: (
      message: ListQueryBrowserTabsMessage<
        ItemState,
        QueryPayload,
        ItemPayload
      >,
    ) => void;
    onSessionKeyChanged?: (event: TestSessionKeyChangedEvent) => void;
    onOfflineTimelineEvent?: (event: TestOfflineTimelineEvent) => void;
  };
  /** Overrides the manager's default minimum interval between low-priority fetches for this store. */
  lowPriorityThrottleMs?: number;
  /** Overrides the manager's default coalescing window for this store. */
  baseCoalescingWindowMs?: number;
  /** Delay applied to medium-priority requests before they enter the scheduler. */
  mediumPriorityDelayMs?: number;
  /** Computes a per-fetch throttle for real-time updates using recent fetch cost and focus state. */
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  /** Store-level focus revalidation policy. Overrides the manager default. */
  revalidateOnWindowFocus?: boolean | (() => boolean);
  /** Reconnect-specific cooldown. Defaults to 2,000ms. The first reconnect revalidates immediately;
   * additional reconnects within the cooldown are coalesced into one trailing
   * revalidation. Set to `0` to disable this cooldown. */
  transportReconnectCooldownMs?: number;
  /** Rules that keep cached query membership in sync after item updates. */
  optimisticListUpdates?: OptimisticListUpdate<
    ItemState,
    QueryPayload,
    ItemPayload
  >[];
  /** Called when an already-loaded query is invalidated. */
  onInvalidateQuery?: OnListQueryInvalidate<QueryPayload>;
  /** Called when an already-loaded item is invalidated. */
  onInvalidateItem?: OnListQueryItemInvalidate<ItemState, ItemPayload>;
  /** Observes request scheduler lifecycle events for this store. */
  onSchedulerEvent?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  /**
   * Store-specific mutation error handler.
   *
   * Overrides the manager fallback. Use `null` to disable inherited mutation
   * error handling for this store.
   */
  onMutationError?:
    | ((error: unknown, options: StoreMutationErrorOptions) => void)
    | null;
  /** Opt-in hook-level query derivation from locally materialized items. */
  derivedQueries?: DerivedQueriesConfig<ItemState, QueryPayload, ItemPayload>;
  /** Converts a query payload to the stable cache key used by this store. */
  getQueryKey?: (params: QueryPayload) => ValidPayload | unknown[];
  /** Converts an item payload to the stable cache key used by this store. */
  getItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  /** Opt-in persistent storage configuration. When provided, cached items and queries
   * are loaded from storage on first read and saved back on successful fetches.
   * Session scoping always reuses this store manager's `getSessionKey`, and the
   * persisted namespace always reuses this store's `id`. */
  persistentStorage?: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload,
    StorageState,
    TOfflineOperations
  >;
} & ([TPartialResources] extends [true]
  ? { partialResources: PartialResourcesConfig<ItemState> }
  : { partialResources?: undefined });

/** Options used to create a list-query store. */
export type ListQueryStoreOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean = false,
  TOffsetPagination extends boolean = false,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
  StorageState = unknown,
> = ListQueryStoreOptionsBase<
  ItemState,
  QueryPayload,
  ItemPayload,
  TPartialResources,
  TOfflineOperations,
  StorageState
> &
  ([TOffsetPagination] extends [true]
    ? {
        /** Fetches one offset-paginated list query page. */
        fetchListFn: FetchListFnOffsetMode<
          ItemState,
          QueryPayload,
          ItemPayload
        >;
        /** Enables offset-pagination behavior and invalidation sizing. */
        offsetPagination: OffsetPaginationConfig;
      }
    : {
        /** Fetches one size-based list query page. */
        fetchListFn: FetchListFnSizeMode<ItemState, QueryPayload, ItemPayload>;
        /** Not allowed unless offset pagination is enabled. */
        offsetPagination?: undefined;
      });

export function createListQueryStore<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean = false,
  TOffsetPagination extends boolean = false,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
  StorageState = unknown,
>(
  storeOptions: ListQueryStoreOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources,
    TOffsetPagination,
    TOfflineOperations,
    StorageState
  >,
): ListQueryStore<
  ItemState,
  QueryPayload,
  ItemPayload,
  TPartialResources,
  TOfflineOperations
> {
  const {
    id,
    storeManager,
    fetchItemFn,
    batchFetchItemFn,
    getItemsBatchKey,
    defaultQuerySize = 50,
    maxItemBatchSize = 50,
    maxItems = 5_000,
    maxQueries = 1_000,
    onStateCleanup,
    usesRealTimeUpdates = false,
    '~test': testOptions,
    lowPriorityThrottleMs: storeLowPriorityThrottleMs,
    baseCoalescingWindowMs: storeBaseCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs = 2_000,
    optimisticListUpdates,
    onInvalidateQuery,
    onInvalidateItem,
    onSchedulerEvent,
    onMutationError,
    derivedQueries,
    getQueryKey: customGetQueryKey,
    getItemKey: customGetItemKey,
    partialResources,
    persistentStorage: persistentStorageConfig,
  } = storeOptions;

  const lowPriorityThrottleMs =
    storeLowPriorityThrottleMs ??
    storeManager.storeDefaults.lowPriorityThrottleMs;
  const baseCoalescingWindowMs =
    storeBaseCoalescingWindowMs ??
    storeManager.storeDefaults.baseCoalescingWindowMs;
  const resolvedDynamicRealtimeThrottleMs =
    dynamicRealtimeThrottleMs ??
    storeManager.storeDefaults.dynamicRealtimeThrottleMs;
  const blockWindowClose = storeManager.storeDefaults.blockWindowClose;
  const resolvedRevalidateOnWindowFocus =
    revalidateOnWindowFocus ??
    storeManager.storeDefaults.revalidateOnWindowFocus;
  const resolvedOnMutationError = resolveManagerFallback(
    onMutationError,
    storeManager.onMutationError,
  );

  let remoteApplyDepth = 0;
  let currentBroadcastConsistency: SnapshotConsistency = 'confirmed';
  const lastQuerySyncVersions = new Map<string, BrowserTabsSyncVersion>();
  const lastItemSyncVersions = new Map<string, BrowserTabsSyncVersion>();
  const offlineOverlayStore = new Store<
    Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>
  >({ debugName: `${id}:list-query-offline-overlays`, state: () => ({}) });
  offlineOverlayStore.initializeStore();
  let offlineOverlaySessionKey: string | null = null;
  const itemCacheRuntime = createLruCacheRuntime();
  const queryCacheRuntime = createLruCacheRuntime();

  const offsetPagination: OffsetPaginationConfig | undefined =
    storeOptions.offsetPagination;

  const normalizedFetchListFn = storeOptions.offsetPagination
    ? (
        payload: QueryPayload,
        offset: number,
        limit: number,
        fetchOptions: { signal: AbortSignal; fields?: string[] },
      ) => storeOptions.fetchListFn(payload, { offset, limit }, fetchOptions)
    : (
        payload: QueryPayload,
        _offset: number,
        limit: number,
        fetchOptions: { signal: AbortSignal; fields?: string[] },
      ) => storeOptions.fetchListFn(payload, limit, fetchOptions);
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  function normalizeFieldsOption(
    fields: FieldsInput | undefined,
  ): string[] | undefined {
    if (partialResources && fields === undefined) {
      throw new Error(noPartialResourcesFieldsOptionError);
    }

    if (fields === '*') return undefined;

    return fields;
  }

  const resolvedOfflineSession = resolveStoreManagerOfflineSession({
    storeManager,
    storeName: id,
    usesOfflineStorage: persistentStorageConfig?.offline !== undefined,
  });
  const getSessionKeyBase =
    import.meta.env.TEST && testOptions
      ? wrapGetSessionKeyForTest(
          storeManager.getSessionKey,
          testOptions.onSessionKeyChanged,
        )
      : storeManager.getSessionKey;
  const getSessionKeyForRuntime =
    resolvedOfflineSession === null
      ? getSessionKeyBase
      : () =>
          validateStoreManagerSessionConsistency({
            storeManager,
            storeName: id,
            offlineSession: resolvedOfflineSession,
            getSessionKey: getSessionKeyBase,
          });
  const errorNormalizer = storeManager.errorNormalizer;
  const resolvedOfflineSessionForPersistentStorage =
    persistentStorageConfig?.offline === undefined
      ? undefined
      : (() => {
          if (resolvedOfflineSession === null) {
            throw new Error(
              `[tsdf] Store "${id}" requires an offline session but none was configured on the store manager`,
            );
          }

          return resolvedOfflineSession;
        })();

  const globalDisableRefetchOnMount = usesRealTimeUpdates;
  // WORKAROUND: The public persistent-storage config intentionally omits the
  // manager-owned offline session, so stores reattach that resolved session at
  // runtime before passing the config to persistence internals.
  const resolvedPersistentStorageConfig: ResolvedListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload,
    StorageState,
    TOfflineOperations
  > | null = persistentStorageConfig
    ? __LEGIT_CAST__<
        ResolvedListQueryPersistentStorageConfig<
          ItemState,
          QueryPayload,
          ItemPayload,
          StorageState,
          TOfflineOperations
        >,
        unknown
      >({
        ...persistentStorageConfig,
        onPersistentStorageError: resolveManagerFallback(
          persistentStorageConfig.onPersistentStorageError,
          storeManager.onPersistentStorageError,
        ),
        offline: persistentStorageConfig.offline
          ? {
              ...persistentStorageConfig.offline,
              session: resolvedOfflineSessionForPersistentStorage,
            }
          : undefined,
        ...(import.meta.env.DEV
          ? { debugLogger: storeManager.debugLogger }
          : undefined),
        getSessionKey: getSessionKeyForRuntime,
        storeName: id,
      })
    : null;

  // Persistent storage setup
  const persistence = resolvedPersistentStorageConfig
    ? setupListQueryPersistence(resolvedPersistentStorageConfig, {
        getItemKey,
        getItemDerivedGroup: derivedQueries?.getItemGroup,
        getQueryKey,
      })
    : null;
  const persistentStorageErrorReporter = resolvedPersistentStorageConfig
    ? resolvedPersistentStorageConfig.onPersistentStorageError
    : storeManager.onPersistentStorageError;
  const resolvedOfflineConfig = resolvedPersistentStorageConfig?.offline;
  // WORKAROUND: Session-only offline config omits operations, so list-query stores normalize that case to an empty registry before passing it through the generic offline controller surface.
  const resolvedOfflineOperations = __LEGIT_CAST__<
    ResolvedOfflineOperations,
    Record<string, unknown>
  >(resolvedOfflineConfig?.operations ?? EMPTY_LIST_QUERY_OFFLINE_OPERATIONS);
  const offlineOperationsForRuntime =
    import.meta.env.TEST &&
    testOptions?.onOfflineTimelineEvent &&
    resolvedOfflineConfig
      ? wrapOfflineOperationsForTimeline(
          resolvedOfflineOperations,
          testOptions.onOfflineTimelineEvent,
        )
      : resolvedOfflineOperations;

  const store = new Store<State>({
    debugName: id,
    state: () => {
      const initialState: State = {
        items: {},
        queries: {},
        itemQueries: {},
        itemLoadedFields: {},
        itemFieldInvalidationFields: {},
      };

      if (import.meta.env.TEST && testOptions) {
        const initialData = testOptions.initialData;
        const initialRefetchOnMount =
          testOptions.initialRefetchOnMount ?? false;

        if (initialData) {
          for (const { payload, data } of initialData.items) {
            const itemKey = getItemKey(payload);

            initialState.items[itemKey] = data;
            initialState.itemQueries[itemKey] = {
              error: null,
              status: 'success',
              refetchOnMount: initialRefetchOnMount,
              wasLoaded: true,
              payload,
            };
          }

          for (const { payload, items, hasMore } of initialData.queries) {
            const queryKey = getQueryKey(payload);

            initialState.queries[queryKey] = {
              error: null,
              status: 'success',
              refetchOnMount: initialRefetchOnMount,
              wasLoaded: true,
              payload,
              items,
              hasMore,
            };
          }
        }
      }

      return persistence?.createInitialState(initialState) ?? initialState;
    },
  });

  function getQueryKey(params: QueryPayload): string {
    return getCompositeKey(
      customGetQueryKey ? customGetQueryKey(params) : params,
    );
  }

  function getItemKey(params: ItemPayload): string {
    return getCompositeKey(
      customGetItemKey ? customGetItemKey(params) : params,
    );
  }

  type ResolvedOfflineOperations = TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;

  let offlineController: OfflineStoreController<ResolvedOfflineOperations> | null =
    null;
  function isOfflineFetchModeActive(): boolean {
    return (
      (offlineController?.shouldTreatFetchAsOffline() ?? false) ||
      resolvedOfflineConfig?.session.getOfflineStatus().isOfflineMode ===
        true ||
      isOfflineNetworkModeActiveSync(
        resolvedOfflineConfig?.session.getConfig().network,
      )
    );
  }

  const offlineFetchController = {
    prepareForFetch: () =>
      offlineController?.prepareForFetch() ?? Promise.resolve(),
    getSessionStatus: () => offlineController?.getSessionStatus() ?? null,
    shouldTreatFetchAsOffline: isOfflineFetchModeActive,
    handleFetchSuccess: () =>
      offlineController?.handleFetchSuccess() ?? Promise.resolve(),
    evaluateOfflineFetchError: (error: unknown, operationName?: string) =>
      offlineController
        ? offlineController.evaluateOfflineFetchError(error, operationName)
        : Promise.resolve(),
  };
  const offlineMutationController = {
    canQueueMutation: () => offlineController?.canQueueMutation() ?? false,
    prepareForMutation: <
      TName extends keyof Exclude<TOfflineOperations, null> & string,
    >(args: {
      offline: OfflineMutationInput<Exclude<TOfflineOperations, null>, TName>;
      upload?: OfflineMutationUploadsInput;
    }) =>
      offlineController
        ? // WORKAROUND: The shared controller also supports session-only offline configs with no operation map, so list-query mutation calls re-narrow it only when typed offline mutation input is present.
          __LEGIT_CAST__<
            OfflineStoreController<Exclude<TOfflineOperations, null>>,
            unknown
          >(offlineController).prepareForMutation(args)
        : Promise.reject(new Error('Offline mutation controller unavailable')),
    queueMutation: <
      TName extends keyof Exclude<TOfflineOperations, null> & string,
    >(args: {
      offline: OfflineMutationInput<Exclude<TOfflineOperations, null>, TName>;
      upload?: OfflineMutationUploadsInput;
    }) =>
      offlineController
        ? // WORKAROUND: The shared controller also supports session-only offline configs with no operation map, so list-query mutation calls re-narrow it only when typed offline mutation input is present.
          __LEGIT_CAST__<
            OfflineStoreController<Exclude<TOfflineOperations, null>>,
            unknown
          >(offlineController).queueMutation(args)
        : Promise.resolve(),
  };

  function touchQueries(queryKeys: string[]): void {
    queryCacheRuntime.touch(queryKeys, (queryKey) => {
      return store.state.queries[queryKey] !== undefined;
    });
  }

  function touchItems(itemKeys: string[]): void {
    itemCacheRuntime.touch(itemKeys, (itemKey) => {
      return store.state.itemQueries[itemKey] !== undefined;
    });
  }

  function registerActiveQueryRefs(queryKeys: string[]): () => void {
    if (queryKeys.length === 0) return () => {};

    const unregister = queryCacheRuntime.registerActive(queryKeys);

    return () => {
      unregister();
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
    };
  }

  function registerActiveStandaloneItems(itemKeys: string[]): () => void {
    if (itemKeys.length === 0) return () => {};

    const unregister = itemCacheRuntime.registerActive(itemKeys);

    return () => {
      unregister();
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
    };
  }

  function shouldScheduleCacheLimitEnforcement(): boolean {
    if (Object.keys(store.state.queries).length > maxQueries) {
      return true;
    }

    let itemCount = 0;
    for (const itemQuery of Object.values(store.state.itemQueries)) {
      if (itemQuery !== null) {
        itemCount++;
        if (itemCount > maxItems) return true;
      }
    }

    return false;
  }

  const getWindowIsFocused = testOptions?.getWindowIsFocused ?? isWindowFocused;

  function runWithoutBroadcast<T>(callback: () => T): T {
    remoteApplyDepth++;
    try {
      return callback();
    } finally {
      remoteApplyDepth--;
    }
  }

  function runWithBroadcastConsistency<T>(
    consistency: SnapshotConsistency,
    callback: () => T,
  ): T {
    const previousConsistency = currentBroadcastConsistency;
    currentBroadcastConsistency = consistency;

    try {
      return callback();
    } finally {
      currentBroadcastConsistency = previousConsistency;
    }
  }

  const events = evtmitter<ListQueryStoreEvents>();

  const wrappedDynamicRealtimeThrottleMs = (lastFetchDuration: number) =>
    resolvedDynamicRealtimeThrottleMs({
      lastFetchDuration,
      windowIsNotFocused: !getWindowIsFocused(),
    });

  function getCoalescingWindowMs(): number {
    return (
      browserTabsPriority?.getCoalescingWindowMs(baseCoalescingWindowMs) ??
      baseCoalescingWindowMs
    );
  }
  type BrowserTabsSyncCoordinator = ReturnType<
    typeof createBrowserTabsCoordinator<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>
    >
  >;
  let browserTabsSync: BrowserTabsSyncCoordinator | null = null;
  let browserTabsPriority: ReturnType<typeof createBrowserTabsPriority> | null =
    null;

  function getQueryTargetKey(queryKey: string): string {
    return `query:${queryKey}`;
  }

  function getItemTargetKey(itemKey: string): string {
    return `item:${itemKey}`;
  }

  function getItemBatchTargetKey(batchKey: string): string {
    return `item-batch:${batchKey}`;
  }

  function getItemBatchKey(payload: ItemPayload): string | false {
    if (!fetchItemFn || !batchFetchItemFn) return false;
    if (!getItemsBatchKey) return DEFAULT_BATCH_KEY;
    return getItemsBatchKey(payload);
  }

  function recordQuerySyncVersion(
    queryKey: string,
    meta: Pick<BrowserTabsMessageMeta, 'tabId' | 'seq' | 'sentAt'>,
    consistency: SnapshotConsistency,
  ): void {
    lastQuerySyncVersions.set(
      queryKey,
      toBrowserTabsSyncVersion(meta, consistency),
    );
  }

  function recordItemSyncVersion(
    itemKey: string,
    meta: Pick<BrowserTabsMessageMeta, 'tabId' | 'seq' | 'sentAt'>,
    consistency: SnapshotConsistency,
  ): void {
    lastItemSyncVersions.set(
      itemKey,
      toBrowserTabsSyncVersion(meta, consistency),
    );
  }

  function getQuerySnapshotItems(
    query: TSFDListQuery<QueryPayload>,
  ): ListQuerySnapshotItemEntry<ItemState, ItemPayload>[] {
    return query.items.map((itemKey) => ({
      itemKey,
      item: store.state.items[itemKey] ?? null,
      itemQuery: store.state.itemQueries[itemKey] ?? null,
      loadedFields: store.state.itemLoadedFields[itemKey] ?? [],
    }));
  }

  function publishQuerySnapshot(
    queryKey: string,
    consistency: SnapshotConsistency = currentBroadcastConsistency,
  ): void {
    if (remoteApplyDepth > 0) return;

    const query = store.state.queries[queryKey];
    if (!query) return;
    const items = getQuerySnapshotItems(query);

    const message = browserTabsSync?.publish({
      kind: 'list-query-snapshot',
      queryKey,
      consistency,
      query,
      items,
    });
    if (!message) return;

    recordQuerySyncVersion(queryKey, message, consistency);
    for (const item of items) {
      recordItemSyncVersion(item.itemKey, message, consistency);
    }
  }

  function publishItemSnapshot(
    itemKey: string,
    consistency: SnapshotConsistency = currentBroadcastConsistency,
  ): void {
    if (remoteApplyDepth > 0) return;

    const message = browserTabsSync?.publish({
      kind: 'list-item-snapshot',
      itemKey,
      consistency,
      item: store.state.items[itemKey] ?? null,
      itemQuery: store.state.itemQueries[itemKey] ?? null,
      loadedFields: store.state.itemLoadedFields[itemKey] ?? [],
    });
    if (!message) return;

    recordItemSyncVersion(itemKey, message, consistency);
  }

  /**
   * Attempts to hydrate cached queries from persistent storage before the first
   * hook read. Returns one result per requested query.
   */
  async function preloadQueryFromPersistentStorage(
    payload: QueryPayload | QueryPayload[],
  ): Promise<PersistentStoragePreloadResult<QueryPayload>[]> {
    const payloads = Array.isArray(payload) ? payload : [payload];

    if (!persistence) {
      persistentStorageErrorReporter?.(
        new Error('Persistent storage preload is not available'),
      );
      return payloads.map((queryPayload) => ({
        payload: queryPayload,
        preloaded: false,
      }));
    }

    const queryKeys = payloads.map((queryPayload) => getQueryKey(queryPayload));
    const results = await persistence.preloadQueries(queryKeys);
    const preloadedQueryKeys = queryKeys.filter(
      (_key, index) => results[index],
    );
    if (preloadedQueryKeys.length > 0) {
      touchQueries(preloadedQueryKeys);
      touchItems(
        preloadedQueryKeys.flatMap(
          (queryKey) => store.state.queries[queryKey]?.items ?? [],
        ),
      );
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
    }
    return payloads.map((queryPayload, index) => ({
      payload: queryPayload,
      preloaded: results[index] ?? false,
    }));
  }

  /**
   * Attempts to hydrate cached items from persistent storage before the first
   * hook read. Returns one result per requested item.
   */
  async function preloadItemFromPersistentStorage(
    payload: ItemPayload | ItemPayload[],
  ): Promise<PersistentStoragePreloadResult<ItemPayload>[]> {
    const payloads = Array.isArray(payload) ? payload : [payload];

    if (!persistence) {
      persistentStorageErrorReporter?.(
        new Error('Persistent storage preload is not available'),
      );
      return payloads.map((itemPayload) => ({
        payload: itemPayload,
        preloaded: false,
      }));
    }

    const itemKeys = payloads.map((itemPayload) => getItemKey(itemPayload));
    const results = await persistence.preloadItems(itemKeys);
    const preloadedItemKeys = itemKeys.filter((_key, index) => results[index]);
    if (preloadedItemKeys.length > 0) {
      touchItems(preloadedItemKeys);
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
    }
    return payloads.map((itemPayload, index) => ({
      payload: itemPayload,
      preloaded: results[index] ?? false,
    }));
  }

  const {
    getQueryState,
    getQueriesKeyArray,
    getQueriesState,
    getQueriesRelatedToItem,
    getItemsKeyArray,
    getItemState,
    scheduleListQueryFetch,
    loadMore,
    awaitListQueryFetch,
    getQueryFromStateOrFetch,
    scheduleItemFetch,
    awaitItemFetch,
    getItemFromStateOrFetch,
    getOrCreateQueryScheduler,
    getOrCreateItemScheduler,
    getKnownQueryScheduler,
    getKnownItemScheduler,
    syncRemoteFetchStart,
    syncRemoteFetchSuccess,
    deleteQueryFetchResources,
    deleteItemFetchResources,
    resetSchedulers,
  } = createFetchApi<ItemState, QueryPayload, ItemPayload>({
    store,
    normalizedFetchListFn,
    offsetPagination,
    fetchItemFn,
    batchFetchItemFn,
    getItemsBatchKey,
    errorNormalizer,
    partialResources,
    lowPriorityThrottleMs,
    getCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
    onSchedulerEvent,
    usesRealTimeUpdates,
    defaultQuerySize,
    maxItemBatchSize,
    getQueryKey,
    getItemKey,
    normalizeFieldsOption,
    syncHydrationEnabled: !!persistence && !persistence.hasAsyncPreload,
    preloadQueries: persistence
      ? (queryKeys) => persistence.preloadQueries(queryKeys)
      : undefined,
    preloadItems: persistence
      ? (itemKeys) => persistence.preloadItems(itemKeys)
      : undefined,
    persistence,
    testInitialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
    offlineController: offlineFetchController,
    onQueryFetchStart: (requests, startedAt) => {
      const queryKey = requests[0]?.requestId;
      if (!queryKey) return;

      browserTabsSync?.publish({
        kind: 'fetch-start',
        targetKey: getQueryTargetKey(queryKey),
        requestIds: requests.map(({ requestId }) => requestId),
        startedAt,
      });
    },
    onItemFetchStart: (requests, startedAt) => {
      const firstRequest = requests[0];
      if (!firstRequest) return;

      const payload = firstRequest.payload.payload;
      const batchKey = getItemBatchKey(payload);
      const targetKey =
        batchKey === false
          ? getItemTargetKey(firstRequest.requestId)
          : getItemBatchTargetKey(batchKey);

      browserTabsSync?.publish({
        kind: 'fetch-start',
        targetKey,
        requestIds: requests.map(({ requestId }) => requestId),
        startedAt,
      });
    },
    onQueryFetchSettled: ({ requests, results, startedAt, duration }) => {
      pruneItemInvalidationTracking();
      const successfulQueryKeys = requests
        .filter(({ requestId }) => results.get(requestId) === true)
        .map(({ requestId }) => requestId);
      if (successfulQueryKeys.length > 0) {
        touchQueries(successfulQueryKeys);
        touchItems(
          successfulQueryKeys.flatMap(
            (queryKey) => store.state.queries[queryKey]?.items ?? [],
          ),
        );
        if (shouldScheduleCacheLimitEnforcement()) {
          scheduleCacheLimitEnforcement();
        }
      }
      const firstQueryKey = successfulQueryKeys[0];

      if (firstQueryKey) {
        browserTabsSync?.publish({
          kind: 'fetch-success',
          targetKey: getQueryTargetKey(firstQueryKey),
          requestIds: successfulQueryKeys,
          startedAt,
          duration,
        });

        for (const queryKey of successfulQueryKeys) {
          publishQuerySnapshot(queryKey, 'confirmed');
        }
      }
    },
    onItemFetchSettled: ({ requests, results, startedAt, duration }) => {
      pruneItemInvalidationTracking();
      const successfulItems = requests
        .filter(({ requestId }) => results.get(requestId) === true)
        .map((request) => ({ itemKey: request.requestId }));
      if (successfulItems.length > 0) {
        touchItems(successfulItems.map(({ itemKey }) => itemKey));
        if (shouldScheduleCacheLimitEnforcement()) {
          scheduleCacheLimitEnforcement();
        }
      }
      const firstSuccessfulItem = successfulItems[0];

      if (firstSuccessfulItem) {
        const payload = requests[0]?.payload.payload;
        const batchKey = payload ? getItemBatchKey(payload) : false;
        const targetKey =
          batchKey === false
            ? getItemTargetKey(firstSuccessfulItem.itemKey)
            : getItemBatchTargetKey(batchKey);

        browserTabsSync?.publish({
          kind: 'fetch-success',
          targetKey,
          requestIds: successfulItems.map(({ itemKey }) => itemKey),
          startedAt,
          duration,
        });

        for (const { itemKey } of successfulItems) {
          publishItemSnapshot(itemKey, 'confirmed');
        }
      }
    },
  });

  const {
    storeEvents,
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState: updateItemStateBase,
    addItemToState: addItemToStateBase,
    deleteItemState: deleteItemStateBase,
    resetInvalidationTracking,
    performMutation: performMutationBase,
  } = createMutationApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >({
    store,
    fetchItemFn,
    partialResources,
    optimisticListUpdates,
    onInvalidateQuery,
    onInvalidateItem,
    onMutationError: resolvedOnMutationError,
    errorNormalizer,
    getItemKey,
    getQueriesKeyArray,
    getQueriesRelatedToItem,
    getItemsKeyArray,
    getOrCreateItemScheduler,
    getOrCreateQueryScheduler,
    deleteItemFetchResources,
    emitInvalidateQuery: (event) => {
      events.emit('invalidateQuery', event);
    },
    emitInvalidateItem: (event) => {
      events.emit('invalidateItem', event);
    },
    blockWindowClose,
    offlineController: resolvedOfflineConfig ? offlineMutationController : null,
    runWithBroadcastConsistency,
    publishQuerySnapshot,
    publishItemSnapshot,
    onOfflineTimelineEvent:
      import.meta.env.TEST && testOptions
        ? testOptions.onOfflineTimelineEvent
        : undefined,
  });

  if (resolvedPersistentStorageConfig && resolvedOfflineConfig) {
    offlineController = createOfflineStoreController<ResolvedOfflineOperations>(
      {
        storeName: id,
        storeType: 'listQuery',
        getSessionKey: getSessionKeyForRuntime,
        onPersistentStorageError:
          resolvedPersistentStorageConfig.onPersistentStorageError,
        ...(import.meta.env.DEV
          ? { debugLogger: storeManager.debugLogger }
          : undefined),
        adapter: resolvedPersistentStorageConfig.adapter,
        offlineSession: resolvedOfflineConfig.session,
        // WORKAROUND: The list-query persistent config keeps operations behind a
        // widened generic boundary, so the controller input has to re-narrow
        // them back to the caller's concrete offline operation map here.
        operations: __LEGIT_CAST__<
          ResolvedOfflineOperations,
          Record<string, unknown>
        >(offlineOperationsForRuntime),
        storeAdapter: {
          normalizeEntityRefs: (entityRefs) =>
            entityRefs.map((ref) => {
              // Temp entities are queued internally as normalized refs.
              const normalizedRef = offlineItemEntityRefSchema
                .parse(ref)
                .unwrapOrNull();
              if (normalizedRef !== null) return normalizedRef;

              return {
                entityKey: getItemKey(
                  // WORKAROUND: normalizeEntityRefs accepts either normalized refs or raw payloads, and after the ref schema fails the remaining value is treated as the caller's ItemPayload.
                  __LEGIT_CAST__<ItemPayload, unknown>(ref),
                ),
                entityKind: 'item' as const,
              };
            }),
          getProtectedCacheKeys: (entityRefs) => {
            const sessionKey = getSessionKeyForRuntime();
            if (sessionKey === false) return [];
            return entityRefs.map((ref) =>
              createProtectedStorageKey({
                backend:
                  resolvedPersistentStorageConfig.adapter !== 'local-sync'
                    ? 'async'
                    : 'localStorage',
                sessionKey,
                storeName: id,
                kind: 'listQuery.item',
                key: ref.entityKey,
              }),
            );
          },
          applyPendingEntity: ({ tempId, pendingEntity }) => {
            if (!pendingEntity || typeof pendingEntity !== 'object') return;
            addItemToState(
              // WORKAROUND: Offline temp ids are stored as generic ValidPayload values, so this list-query adapter has to narrow them back to ItemPayload when applying queued entities.
              __LEGIT_CAST__<ItemPayload, ValidPayload>(tempId),
              // WORKAROUND: Pending entity snapshots cross the offline queue as unknown and are rehydrated back to ItemState at this store-specific boundary.
              __LEGIT_CAST__<ItemState, unknown>(pendingEntity),
            );
          },
          rollbackPendingEntity: ({ tempId }) => {
            deleteItemState(
              // WORKAROUND: Offline temp ids are stored as generic ValidPayload values, so this list-query adapter has to narrow them back to ItemPayload when removing queued temp entities.
              __LEGIT_CAST__<ItemPayload, ValidPayload>(tempId),
            );
          },
          reconcileTempEntity: ({ tempId, reconciliation }) => {
            const tempPayload =
              // WORKAROUND: Offline temp ids are stored as generic ValidPayload values, so this list-query adapter has to narrow them back to ItemPayload when reconciling queued temp entities.
              __LEGIT_CAST__<ItemPayload, ValidPayload>(tempId);
            const tempItemKey = getItemKey(tempPayload);
            const currentItem = getItemState(tempPayload);
            const finalData =
              reconciliation.finalData !== undefined
                ? // WORKAROUND: Reconciliation data is stored as unknown by the shared offline queue and is rehydrated to ItemState by the list-query store.
                  __LEGIT_CAST__<ItemState, unknown>(reconciliation.finalData)
                : (currentItem ?? undefined);
            if (finalData === undefined) return;

            const finalPayload =
              // WORKAROUND: Reconciliation payloads flow through the shared offline controller as ValidPayload and are narrowed back to the list-query store's ItemPayload here.
              __LEGIT_CAST__<ItemPayload, ValidPayload>(
                reconciliation.finalPayload,
              );
            const finalItemKey = getItemKey(finalPayload);
            const queryMemberships = Object.entries(store.state.queries)
              .map(([queryKey, query]) => ({
                queryKey,
                index: query.items.indexOf(tempItemKey),
              }))
              .filter(({ index }) => index !== -1);

            deleteItemState(tempPayload);
            addItemToState(finalPayload, finalData);

            storeEvents.emit('tempEntityReconciled', {
              tempId: tempPayload,
              finalPayload,
            });

            if (queryMemberships.length === 0) return;

            store.produceState(
              (draft) => {
                for (const { queryKey, index } of queryMemberships) {
                  const query = notNullish(draft.queries[queryKey]);
                  const existingIndex = query.items.indexOf(finalItemKey);
                  if (existingIndex !== -1) {
                    query.items.splice(existingIndex, 1);
                  }

                  query.items.splice(
                    Math.min(index, query.items.length),
                    0,
                    finalItemKey,
                  );
                }
              },
              { action: 'offline-reconcile-temp-item' },
            );

            touchQueries(queryMemberships.map(({ queryKey }) => queryKey));
            for (const { queryKey } of queryMemberships) {
              publishQuerySnapshot(queryKey);
            }
          },
          captureQueuedMutationOverlays: ({ entityRefs, sessionKey }) => {
            if (offlineOverlaySessionKey !== sessionKey)
              clearOfflineOverlays(sessionKey);
            captureOfflineOverlays(
              entityRefs.flatMap((ref) => {
                return ref.entityKind === 'item' ? [ref.entityKey] : [];
              }),
            );
          },
          rebindQueuedMutationOverlays: ({ itemKeyRewrites, sessionKey }) => {
            if (offlineOverlaySessionKey !== sessionKey)
              clearOfflineOverlays(sessionKey);

            rebindOfflineOverlays(itemKeyRewrites);
          },
          syncEntityOverlays: ({ entities, sessionKey }) => {
            if (offlineOverlaySessionKey !== sessionKey)
              clearOfflineOverlays(sessionKey);
            const activeItemKeys = new Set(
              entities
                .filter((entity) => entity.entityKind === 'item')
                .map((entity) => entity.entityKey),
            );

            offlineOverlayStore.produceState((draft) => {
              for (const itemKey of Object.keys(draft)) {
                if (!activeItemKeys.has(itemKey)) {
                  delete draft[itemKey];
                }
              }
            });
          },
        },
      },
    );
  }

  function applyLoadedFieldsFromSnapshot(
    draft: State,
    itemKey: string,
    loadedFields: string[],
  ): void {
    if (loadedFields.length > 0) {
      const existingLoadedFields = draft.itemLoadedFields[itemKey] ?? [];
      draft.itemLoadedFields[itemKey] = Array.from(
        new Set([...existingLoadedFields, ...loadedFields]),
      ).sort();
    } else {
      delete draft.itemLoadedFields[itemKey];
    }

    const invalidationFields = draft.itemFieldInvalidationFields[itemKey];
    if (!invalidationFields) return;

    const remainingFields = excludeLoadedFields(
      loadedFields,
      invalidationFields,
    );

    if (remainingFields.length > 0) {
      draft.itemFieldInvalidationFields[itemKey] = remainingFields;
    } else {
      delete draft.itemFieldInvalidationFields[itemKey];
    }
  }

  function pruneItemInvalidationTracking(): void {
    for (const [itemKey, pendingFields] of itemPendingInvalidationFields) {
      const remainingFields = excludeLoadedFields(
        store.state.itemLoadedFields[itemKey],
        pendingFields,
      );

      if (remainingFields.length > 0) {
        itemPendingInvalidationFields.set(itemKey, remainingFields);
      } else {
        itemPendingInvalidationFields.delete(itemKey);
      }
    }

    for (const itemKey of itemFieldInvalidationPriorities.keys()) {
      const hasPendingStateInvalidation =
        !!store.state.itemFieldInvalidationFields[itemKey];
      const hasPendingTrackedInvalidation =
        (itemPendingInvalidationFields.get(itemKey)?.length ?? 0) > 0;

      if (!hasPendingStateInvalidation && !hasPendingTrackedInvalidation) {
        itemFieldInvalidationPriorities.delete(itemKey);
      }
    }
  }

  function cleanupItemStateMetadata(itemKey: string): void {
    itemFieldInvalidationPriorities.delete(itemKey);
    itemPendingInvalidationFields.delete(itemKey);
    itemInvalidationWasTriggered.delete(itemKey);
    itemCacheRuntime.clear(itemKey);
  }

  function cleanupQueryStateMetadata(queryKey: string): void {
    queryInvalidationWasTriggered.delete(queryKey);
    queryCacheRuntime.clear(queryKey);
  }

  function clearOfflineOverlays(nextSessionKey: string | null = null): void {
    offlineOverlaySessionKey = nextSessionKey;
    offlineOverlayStore.setState({});
  }

  function rebindOfflineOverlays(
    itemKeyRewrites: readonly {
      previousItemKey: string;
      nextItemKey: string;
    }[],
  ): void {
    rebindOfflineOverlayEntries({
      itemKeyRewrites,
      overlayStore: offlineOverlayStore,
      createReboundOverlay: ({ existingOverlay, nextItemKey }) => ({
        item: existingOverlay.item ?? null,
        itemPayload:
          store.state.itemQueries[nextItemKey]?.payload ??
          existingOverlay.itemPayload,
        queryMemberships: existingOverlay.queryMemberships,
        keepVisibleWhileResolutionRequired: true,
      }),
    });
  }

  function captureOfflineOverlays(itemKeys: readonly string[]): void {
    const targetItemKeySet = new Set(itemKeys);
    if (targetItemKeySet.size === 0) return;
    const queryMembershipsByItemKey = new Map<string, Record<string, number>>();

    for (const itemKey of targetItemKeySet) {
      queryMembershipsByItemKey.set(itemKey, {});
    }

    for (const [queryKey, query] of Object.entries(store.state.queries)) {
      for (const [index, itemKey] of query.items.entries()) {
        if (!targetItemKeySet.has(itemKey)) continue;

        const queryMemberships = queryMembershipsByItemKey.get(itemKey);
        if (!queryMemberships) continue;

        queryMemberships[queryKey] = index;
      }
    }

    captureOfflineOverlayEntries({
      itemKeys: [...targetItemKeySet],
      overlayStore: offlineOverlayStore,
      createOverlay: (itemKey) => {
        const item = store.state.items[itemKey];
        const itemPayload = store.state.itemQueries[itemKey]?.payload;

        return {
          item: item == null ? null : klona(item),
          itemPayload:
            itemPayload === undefined ? undefined : klona(itemPayload),
          queryMemberships: queryMembershipsByItemKey.get(itemKey) ?? {},
        };
      },
    });
  }

  function isQueryProtectedFromEviction(
    queryKey: string,
    query: TSFDListQuery<QueryPayload>,
  ): boolean {
    if (queryCacheRuntime.isActive(queryKey)) return true;
    const scheduler = getOrCreateQueryScheduler(queryKey);
    if (
      query.status === 'loading' ||
      query.status === 'refetching' ||
      query.status === 'loadingMore' ||
      scheduler.getFetchIsInProgress()
    ) {
      return true;
    }

    return scheduler.isMutationInProgress(queryKey);
  }

  function isStandaloneItemProtectedFromEviction(
    itemKey: string,
    itemQuery: TSDFItemQuery<ItemPayload>,
  ): boolean {
    if (itemCacheRuntime.isActive(itemKey)) return true;
    const scheduler = getOrCreateItemScheduler(itemKey, itemQuery.payload);
    if (
      itemQuery.status === 'loading' ||
      itemQuery.status === 'refetching' ||
      scheduler.getFetchIsInProgress()
    ) {
      return true;
    }

    return scheduler.isMutationInProgress(itemKey);
  }

  function mergeIncomingItemSnapshot(
    currentItem: ItemState | null | undefined,
    incomingItem: ItemState | null,
  ): ItemState | null {
    if (!partialResources || incomingItem === null) {
      return incomingItem;
    }

    return partialResources.mergeItems(currentItem ?? undefined, incomingItem);
  }

  function itemSnapshotSatisfiesRequestedFields(
    item: ItemState | null,
    loadedFields: string[],
    requestedFields: readonly string[] | undefined,
  ): boolean {
    if (!partialResources || !requestedFields || requestedFields.length === 0) {
      return true;
    }

    if (item === null) return true;

    return fallbackItemHasRequestedFields(
      { item, loadedFields },
      requestedFields,
    );
  }

  function querySnapshotSatisfiesPendingQueryFetch(
    message: Extract<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
      { kind: 'list-query-snapshot' }
    >,
    snapshotItemsByKey: ReadonlyMap<string, (typeof message.items)[number]>,
    request: { payload: { offset: number; limit: number; fields?: string[] } },
  ): boolean {
    const requestedEnd = request.payload.offset + request.payload.limit;
    if (message.query.items.length < requestedEnd && message.query.hasMore) {
      return false;
    }

    const requestedFields = request.payload.fields;
    if (!partialResources || !requestedFields || requestedFields.length === 0) {
      return true;
    }

    const coveredItemKeys = message.query.items.slice(
      request.payload.offset,
      requestedEnd,
    );

    return coveredItemKeys.every((itemKey) => {
      const item = snapshotItemsByKey.get(itemKey);
      return (
        !!item &&
        itemSnapshotSatisfiesRequestedFields(
          item.item,
          item.loadedFields,
          requestedFields,
        )
      );
    });
  }

  function applyRemoteItemSnapshot(
    message: Extract<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
      { kind: 'list-item-snapshot' }
    >,
  ): void {
    const currentItemQuery = store.state.itemQueries[message.itemKey];
    const payloadToCleanup = currentItemQuery?.payload;
    const itemScheduler = getKnownItemScheduler(message.itemKey);

    runWithoutBroadcast(() => {
      store.produceState(
        (draft) => {
          draft.items[message.itemKey] = mergeIncomingItemSnapshot(
            draft.items[message.itemKey],
            message.item,
          );
          draft.itemQueries[message.itemKey] =
            message.itemQuery === null
              ? null
              : {
                  ...message.itemQuery,
                  status: 'success',
                  error: null,
                  refetchOnMount: false,
                };

          applyLoadedFieldsFromSnapshot(
            draft,
            message.itemKey,
            message.loadedFields,
          );

          if (!message.itemQuery && message.item === null) {
            delete draft.itemFieldInvalidationFields[message.itemKey];

            for (const query of Object.values(draft.queries)) {
              query.items = query.items.filter(
                (itemId) => itemId !== message.itemKey,
              );
            }
          }
        },
        { action: 'browser-tabs-list-item-snapshot' },
      );
    });

    if (message.consistency === 'confirmed') {
      itemScheduler?.cancelPendingRequests([message.itemKey], ({ payload }) =>
        itemSnapshotSatisfiesRequestedFields(
          message.item,
          message.loadedFields,
          payload.fields,
        ),
      );
    }

    itemInvalidationWasTriggered.delete(message.itemKey);
    if (message.item === null && message.itemQuery === null) {
      cleanupItemStateMetadata(message.itemKey);
    }
    pruneItemInvalidationTracking();
    if (message.item === null && message.itemQuery === null) {
      if (payloadToCleanup) {
        deleteItemFetchResources([
          { itemKey: message.itemKey, payload: payloadToCleanup },
        ]);
      }
    } else if (message.item !== null && message.itemQuery !== null) {
      touchItems([message.itemKey]);
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
    }
  }

  function applyRemoteQuerySnapshot(
    message: Extract<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
      { kind: 'list-query-snapshot' }
    >,
  ): void {
    if (message.consistency === 'confirmed') {
      const snapshotItemsByKey = new Map(
        message.items.map((item) => [item.itemKey, item]),
      );

      getOrCreateQueryScheduler(message.queryKey).cancelPendingRequests(
        [message.queryKey],
        (request) =>
          querySnapshotSatisfiesPendingQueryFetch(
            message,
            snapshotItemsByKey,
            request,
          ),
      );

      for (const item of message.items) {
        const itemScheduler = getKnownItemScheduler(item.itemKey);

        itemScheduler?.cancelPendingRequests([item.itemKey], ({ payload }) =>
          itemSnapshotSatisfiesRequestedFields(
            item.item,
            item.loadedFields,
            payload.fields,
          ),
        );
      }
    }

    runWithoutBroadcast(() => {
      store.produceState(
        (draft) => {
          draft.queries[message.queryKey] = {
            ...message.query,
            status: 'success',
            error: null,
            refetchOnMount: false,
          };

          for (const item of message.items) {
            draft.items[item.itemKey] = mergeIncomingItemSnapshot(
              draft.items[item.itemKey],
              item.item,
            );
            draft.itemQueries[item.itemKey] =
              item.itemQuery === null
                ? null
                : {
                    ...item.itemQuery,
                    status: 'success',
                    error: null,
                    refetchOnMount: false,
                  };

            applyLoadedFieldsFromSnapshot(
              draft,
              item.itemKey,
              item.loadedFields,
            );
          }
        },
        { action: 'browser-tabs-list-query-snapshot' },
      );
    });

    queryInvalidationWasTriggered.delete(message.queryKey);
    pruneItemInvalidationTracking();
    lastQuerySyncVersions.set(
      message.queryKey,
      toBrowserTabsSyncVersion(message, message.consistency),
    );
    for (const item of message.items) {
      itemInvalidationWasTriggered.delete(item.itemKey);
      lastItemSyncVersions.set(
        item.itemKey,
        toBrowserTabsSyncVersion(message, message.consistency),
      );
    }
    touchQueries([message.queryKey]);
    touchItems(message.items.map(({ itemKey }) => itemKey));
    if (shouldScheduleCacheLimitEnforcement()) {
      scheduleCacheLimitEnforcement();
    }
  }

  function querySnapshotHasLocallyMutatingItem(
    message: Extract<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
      { kind: 'list-query-snapshot' }
    >,
  ): boolean {
    for (const item of message.items) {
      const localItemQuery = store.state.itemQueries[item.itemKey];
      if (!localItemQuery) continue;

      const itemScheduler = getKnownItemScheduler(item.itemKey);
      if (itemScheduler?.isMutationInProgress(item.itemKey)) return true;
    }

    return false;
  }

  function handleRemoteBrowserTabsMessage(
    message: ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
  ): void {
    if (message.kind === 'tab-status') {
      browserTabsPriority?.onTabStatusMessage(message.tabId, message);
      return;
    }

    if (message.kind === 'fetch-start') {
      syncRemoteFetchStart(
        message.targetKey,
        message.requestIds,
        message.startedAt,
      );
      return;
    }

    if (message.kind === 'fetch-success') {
      syncRemoteFetchSuccess(
        message.targetKey,
        message.requestIds,
        message.startedAt,
        message.duration,
      );
      return;
    }

    if (message.kind === 'list-item-snapshot') {
      const candidateVersion = toBrowserTabsSyncVersion(
        message,
        message.consistency,
      );
      const currentVersion = lastItemSyncVersions.get(message.itemKey);
      if (!isBrowserTabsSyncVersionNewer(candidateVersion, currentVersion)) {
        return;
      }

      const localItemQuery = store.state.itemQueries[message.itemKey];
      const itemScheduler =
        localItemQuery === null ? null : getKnownItemScheduler(message.itemKey);
      if (localItemQuery === undefined && !itemScheduler?.hasPendingFetch) {
        lastItemSyncVersions.set(message.itemKey, candidateVersion);
        return;
      }

      if (
        message.consistency === 'confirmed' &&
        itemScheduler?.isMutationInProgress(message.itemKey)
      ) {
        lastItemSyncVersions.set(message.itemKey, candidateVersion);
        return;
      }

      if (import.meta.env.TEST) {
        testOptions?.onReceiveRemoteMsg?.(message);
      }

      applyRemoteItemSnapshot(message);
      lastItemSyncVersions.set(message.itemKey, candidateVersion);
      return;
    }

    const candidateVersion = toBrowserTabsSyncVersion(
      message,
      message.consistency,
    );
    const currentVersion = lastQuerySyncVersions.get(message.queryKey);
    if (!isBrowserTabsSyncVersionNewer(candidateVersion, currentVersion)) {
      return;
    }

    const localQuery = store.state.queries[message.queryKey];
    const queryScheduler = getKnownQueryScheduler(message.queryKey);
    if (!localQuery && !queryScheduler?.hasPendingFetch) {
      lastQuerySyncVersions.set(message.queryKey, candidateVersion);
      for (const item of message.items) {
        lastItemSyncVersions.set(item.itemKey, candidateVersion);
      }
      return;
    }

    if (
      message.consistency === 'confirmed' &&
      querySnapshotHasLocallyMutatingItem(message)
    ) {
      lastQuerySyncVersions.set(message.queryKey, candidateVersion);
      for (const item of message.items) {
        lastItemSyncVersions.set(item.itemKey, candidateVersion);
      }
      return;
    }

    if (import.meta.env.TEST) {
      testOptions?.onReceiveRemoteMsg?.(message);
    }

    applyRemoteQuerySnapshot(message);
  }

  ({ coordinator: browserTabsSync, priority: browserTabsPriority } =
    createBrowserTabsCoordinatorWithPriority<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>
    >({
      storeType: 'listQuery',
      storeKey: id,
      getSessionKey: getSessionKeyForRuntime,
      onMessage: handleRemoteBrowserTabsMessage,
      onSessionChange() {
        lastQuerySyncVersions.clear();
        lastItemSyncVersions.clear();
        clearOfflineOverlays();
      },
      transportFactory: testOptions?.browserTabsTransportFactory,
      ...(import.meta.env.DEV
        ? { debugLogger: storeManager.debugLogger }
        : undefined),
      getWindowIsFocused,
      onWindowFocusChange: testOptions?.onWindowFocusChange,
      priorityTimings:
        testOptions?.browserTabsPriorityTimings ??
        testOptions?.browserTabsLeadershipTimings,
    }));

  const useMultipleListQueries: ListQueryUseMultipleListQueriesApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  > = function useMultipleListQueries<
    SelectedItem = ItemState,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    queries: ListQueryUseMultipleListQueriesQuery<
      QueryPayload,
      QueryMetadata
    >[],
    options: UseMultipleListQueriesOptions<
      ItemState,
      ItemPayload,
      SelectedItem
    > = {},
  ): readonly TSFDUseListQueryReturn<
    SelectedItem,
    QueryPayload,
    QueryMetadata
  >[] {
    const offlineEntities = useOfflineStoreEntities({
      sessionKey: getSessionKeyForRuntime(),
      inactiveScope: id,
      storeName: resolvedPersistentStorageConfig ? id : undefined,
    });
    const offlineStatus = useOfflineStoreStatus({
      sessionKey: getSessionKeyForRuntime(),
      inactiveScope: id,
    });
    const isStoreOfflineMode =
      offlineStatus.isOfflineMode ||
      isOfflineNetworkModeActiveSync(
        resolvedOfflineConfig?.session.getConfig().network,
      );
    const offlineOverlaysSelector = useCallback(
      (
        state: Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>,
      ) => {
        return state;
      },
      [],
    );
    const offlineOverlays = offlineOverlayStore.useSelectorRC(
      offlineOverlaysSelector,
    );

    return useMultipleListQueriesHook<
      ItemState,
      QueryPayload,
      ItemPayload,
      SelectedItem,
      QueryMetadata
    >(
      queries,
      options,
      store,
      events,
      getQueryKey,
      registerActiveQueryRefs,
      touchQueries,
      getQueryState,
      persistence?.readHydratedQuery,
      persistence
        ? (payloads) =>
            persistence.maybeHydrateQueries(
              payloads.map((payload) => getQueryKey(payload)),
            )
        : undefined,
      !!persistence && !persistence.hasAsyncPreload,
      persistence && derivedQueries
        ? (payloads) =>
            persistence.preloadItemsByDerivedQueryGroup(
              payloads.map((payload) => derivedQueries.getQueryGroup(payload)),
            )
        : undefined,
      persistence?.readHydratedItem,
      scheduleAutomaticListQueryFetch,
      queryInvalidationWasTriggered,
      itemFieldInvalidationPriorities,
      itemPendingInvalidationFields,
      globalDisableRefetchOnMount,
      partialResources,
      derivedQueries,
      isStoreOfflineMode,
      offlineEntities,
      offlineOverlays,
    );
  };

  const useListQuery: {
    <SelectedItem = ItemState>(
      payload: QueryPayload | false | null | undefined,
      ...args: ListQueryHasPartialResources<TPartialResources> extends true
        ? [
            options: UseListQueryOptions<ItemState, ItemPayload, SelectedItem> &
              FieldsOption<true>,
          ]
        : [options?: UseListQueryOptions<ItemState, ItemPayload, SelectedItem>]
    ): TSFDUseListQueryReturn<SelectedItem, QueryPayload, undefined>;
  } = function useListQuery<SelectedItem = ItemState>(
    payload: QueryPayload | false | null | undefined,
    options: UseListQueryOptions<ItemState, ItemPayload, SelectedItem> = {},
  ): TSFDUseListQueryReturn<SelectedItem, QueryPayload, undefined> {
    return useListQueryHook<ItemState, QueryPayload, ItemPayload, SelectedItem>(
      payload,
      options,
      store,
      getQueryKey,
      scheduleListQueryFetch,
      useMultipleListQueries,
    );
  };

  const useMultipleItems: ListQueryUseMultipleItemsApi<
    ItemState,
    ItemPayload,
    TPartialResources
  > = function useMultipleItems<
    Selected = ItemState | null,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    items: ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
    options: UseMultipleItemsOptions<ItemState, Selected> = {},
  ): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[] {
    const offlineEntities = useOfflineStoreEntities({
      sessionKey: getSessionKeyForRuntime(),
      inactiveScope: id,
      storeName: resolvedPersistentStorageConfig ? id : undefined,
    });
    const offlineOverlaysSelector = useCallback(
      (
        state: Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>,
      ) => {
        return state;
      },
      [],
    );
    const offlineOverlays = offlineOverlayStore.useSelectorRC(
      offlineOverlaysSelector,
    );

    return useMultipleItemsHook<
      ItemState,
      QueryPayload,
      ItemPayload,
      Selected,
      QueryMetadata
    >(
      items,
      options,
      store,
      events,
      getItemKey,
      registerActiveStandaloneItems,
      touchItems,
      scheduleAutomaticItemFetch,
      persistence
        ? (payloads) =>
            persistence.maybeHydrateItems(
              payloads.map((payload) => getItemKey(payload)),
            )
        : undefined,
      !!persistence && !persistence.hasAsyncPreload,
      persistence?.readHydratedItem,
      itemInvalidationWasTriggered,
      itemFieldInvalidationPriorities,
      itemPendingInvalidationFields,
      globalDisableRefetchOnMount,
      fetchItemFn,
      partialResources,
      offlineEntities,
      offlineOverlays,
    );
  };

  const useItem: {
    <Selected = ItemState | null>(
      itemPayload: ItemPayload | false | null | undefined,
      ...args: ListQueryHasPartialResources<TPartialResources> extends true
        ? [options: UseItemOptions<ItemState, Selected> & FieldsOption<true>]
        : [options?: UseItemOptions<ItemState, Selected>]
    ): TSFDUseListItemReturn<Selected, ItemPayload>;
  } = function useItem<Selected = ItemState | null>(
    itemPayload: ItemPayload | false | null | undefined,
    options: UseItemOptions<ItemState, Selected> = {},
  ): TSFDUseListItemReturn<Selected, ItemPayload> {
    return useItemHook<ItemState, QueryPayload, ItemPayload, Selected>(
      itemPayload,
      options,
      store,
      scheduleItemFetch,
      useMultipleItems,
    );
  };

  /**
   * Returns the current offline-tracked list items for this store without
   * performing any fetches. Visible queued creates/updates are exposed through
   * `items`, while pending deletes are exposed separately through
   * `deletedItems`.
   */
  const usePendingOfflineItems: ListQueryUsePendingOfflineItemsApi<
    ItemState,
    ItemPayload
  > = function usePendingOfflineItems<SelectedItem = ItemState>(
    options: UsePendingOfflineItemsOptions<
      ItemState,
      ItemPayload,
      SelectedItem
    > = {},
  ): TSFDUsePendingOfflineItemsReturn<SelectedItem, ItemPayload> {
    const offlineEntities = useOfflineStoreEntitiesWithPayload({
      sessionKey: getSessionKeyForRuntime(),
      inactiveScope: id,
      storeName: resolvedPersistentStorageConfig ? id : undefined,
    });
    const offlineOverlaysSelector = useCallback(
      (
        state: Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>,
      ) => {
        return state;
      },
      [],
    );
    const offlineOverlays = offlineOverlayStore.useSelectorRC(
      offlineOverlaysSelector,
    );

    return usePendingOfflineItemsHook<
      ItemState,
      QueryPayload,
      ItemPayload,
      SelectedItem
    >(
      options,
      store,
      registerActiveStandaloneItems,
      touchItems,
      persistence?.preloadItems
        ? (itemKeys) => persistence.preloadItems(itemKeys)
        : undefined,
      !!persistence && !persistence.hasAsyncPreload,
      persistence?.readHydratedItem,
      offlineEntities,
      offlineOverlays,
    );
  };

  function useFindItem<SelectedItem = ItemState | null>(
    findItemFn: (item: ItemState, itemPayload: ItemPayload) => boolean,
    options: {
      /** Maps the matched item before it is returned from the hook. */
      selector?: (data: ItemState, id: ItemPayload) => SelectedItem;
    } = {},
  ): SelectedItem | null {
    return useFindItemHook<ItemState, QueryPayload, ItemPayload, SelectedItem>(
      findItemFn,
      options,
      store,
      registerActiveStandaloneItems,
      touchItems,
    );
  }

  const focusLifecycle = createStoreFocusLifecycle({
    revalidateOnWindowFocus: resolvedRevalidateOnWindowFocus,
    usesRealTimeUpdates,
    transportReconnectCooldownMs,
    getWindowIsFocused,
    onWindowFocus: testOptions?.onWindowFocus ?? onWindowFocusDefault,
    onWindowFocusRevalidate: () => {
      invalidateQueryAndItems({ all: true, type: 'lowPriority' });
    },
    onTransportReconnectRevalidate: () => {
      invalidateQueryAndItems({ all: true, type: 'realtimeUpdate' });
    },
  });

  // Attach persistent storage after store creation
  const { enforceCacheLimits } = createListQueryCacheLimits({
    store,
    maxItems,
    maxQueries,
    itemCacheRuntime,
    queryCacheRuntime,
    isQueryProtectedFromEviction,
    isStandaloneItemProtectedFromEviction,
    cleanupItemStateMetadata,
    cleanupQueryStateMetadata,
    deleteQueryFetchResources,
    deleteItemFetchResources,
    onStateCleanup,
  });

  const cacheLimitEnforcementScheduler = createIdleThrottledScheduler({
    throttleMs: CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS,
    run: enforceCacheLimits,
  });

  function scheduleCacheLimitEnforcement(): void {
    cacheLimitEnforcementScheduler.schedule();
  }

  persistence?.attach(store);
  initializeOfflineStoreController(offlineController);
  if (store.isInitialized) {
    touchQueries(Object.keys(store.state.queries));
    touchItems(
      Object.keys(store.state.itemQueries).filter((itemKey) => {
        return store.state.itemQueries[itemKey] !== undefined;
      }),
    );
    if (shouldScheduleCacheLimitEnforcement()) {
      scheduleCacheLimitEnforcement();
    }
  }

  /**
   * Signals that the real-time transport (e.g. WebSocket) has reconnected after
   * a disconnection. Events may have been missed during the outage, so all
   * queries and items need to be revalidated.
   *
   * - No-op when `usesRealTimeUpdates` is `false`.
   * - If the window is focused, the first reconnect invalidates all queries
   *   and items immediately with `realtimeUpdate` priority.
   * - Additional reconnects within `transportReconnectCooldownMs` are
   *   coalesced into one trailing invalidation.
   * - If the window is **not** focused, reconnect invalidation waits until the
   *   next window focus event.
   */
  function onTransportReconnect(): void {
    if (isDisposed) return;
    focusLifecycle.onTransportReconnect();
  }

  function reset() {
    if (isDisposed) return;
    resetSchedulers();
    resetInvalidationTracking();
    lastQuerySyncVersions.clear();
    lastItemSyncVersions.clear();
    clearOfflineOverlays();
    queryCacheRuntime.clearAll();
    itemCacheRuntime.clearAll();
    cacheLimitEnforcementScheduler.cancel();
    browserTabsPriority?.reset();

    persistence?.dispose();
    void persistence?.clear();

    store.setState(
      persistence?.createInitialState({
        items: {},
        queries: {},
        itemQueries: {},
        itemLoadedFields: {},
        itemFieldInvalidationFields: {},
      }) ?? {
        items: {},
        queries: {},
        itemQueries: {},
        itemLoadedFields: {},
        itemFieldInvalidationFields: {},
      },
    );
    focusLifecycle.reset();
    persistence?.attach(store);
  }

  /** Releases store resources and unregisters the store from its manager. */
  function dispose(): void {
    if (isDisposed) return;

    isDisposed = true;
    unregisterStoreFromManager();
    resetSchedulers();
    resetInvalidationTracking();
    lastQuerySyncVersions.clear();
    lastItemSyncVersions.clear();
    clearOfflineOverlays();
    queryCacheRuntime.clearAll();
    itemCacheRuntime.clearAll();
    cacheLimitEnforcementScheduler.cancel();
    browserTabsSync?.close();
    browserTabsPriority?.close();
    focusLifecycle.dispose();
    persistence?.dispose();
    offlineController?.dispose();
  }

  function scheduleListQueryFetchApiImpl(
    fetchType: FetchType,
    payload: QueryPayload,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [
          size: number | undefined,
          options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
      : [
          size?: number,
          options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
  ): ScheduleFetchResults;
  function scheduleListQueryFetchApiImpl(
    fetchType: FetchType,
    payload: QueryPayload[],
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [
          size: number | undefined,
          options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
      : [
          size?: number,
          options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
        ]
  ): ScheduleFetchResults[];
  function scheduleListQueryFetchApiImpl(
    fetchType: FetchType,
    payload: QueryPayload | QueryPayload[],
    ...args: [
      size?: number,
      options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
    ]
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const [size, options] = args;
    if (Array.isArray(payload)) {
      return scheduleListQueryFetch(fetchType, payload, size, options);
    }
    return scheduleListQueryFetch(fetchType, payload, size, options);
  }

  const scheduleListQueryFetchApi: ListQueryScheduleListQueryFetchApi<
    QueryPayload,
    TPartialResources
  > = scheduleListQueryFetchApiImpl;

  function scheduleAutomaticListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload,
    size?: number,
    options?: { fields?: FieldsInput },
  ): ScheduleFetchResults {
    const queryKey = getQueryKey(payload);
    const scheduler = getOrCreateQueryScheduler(queryKey);
    const fields = normalizeFieldsOption(options?.fields);
    const currentQuerySize = store.state.queries[queryKey]?.items.length ?? 0;
    const querySize = Math.max(currentQuerySize, size ?? defaultQuerySize);

    return scheduler.scheduleFetch(queryKey, fetchType, {
      type: 'load',
      payload,
      offset: 0,
      limit: querySize,
      fields,
    });
  }

  function loadMoreApiImpl(
    params: QueryPayload,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ?
          | [
              size: number,
              options: ListQueryFetchFieldsOption<TPartialResources>,
            ]
          | [options: ListQueryLoadMoreWithFieldsOptions<TPartialResources>]
      :
          | [
              size?: number,
              options?: ListQueryFetchFieldsOption<TPartialResources>,
            ]
          | [options?: ListQueryLoadMoreWithFieldsOptions<TPartialResources>]
  ): ScheduleFetchResults {
    if (typeof args[0] === 'number') {
      return loadMore(params, args[0], args[1]);
    }
    return loadMore(params, args[0]);
  }

  const loadMoreApi: ListQueryLoadMoreApi<QueryPayload, TPartialResources> =
    loadMoreApiImpl;

  function scheduleItemFetchApiImpl(
    fetchType: FetchType,
    itemPayload: ItemPayload,
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
      : [options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
  ): ScheduleFetchResults;
  function scheduleItemFetchApiImpl(
    fetchType: FetchType,
    itemPayload: ItemPayload[],
    ...args: ListQueryHasPartialResources<TPartialResources> extends true
      ? [options: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
      : [options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>]
  ): ScheduleFetchResults[];
  function scheduleItemFetchApiImpl(
    fetchType: FetchType,
    itemPayload: ItemPayload | ItemPayload[],
    ...args: [
      options?: ListQueryScheduleFetchWithFieldsOption<TPartialResources>,
    ]
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const [options] = args;
    if (Array.isArray(itemPayload)) {
      return scheduleItemFetch(fetchType, itemPayload, options);
    }
    return scheduleItemFetch(fetchType, itemPayload, options);
  }

  const scheduleItemFetchApi: ListQueryScheduleItemFetchApi<
    ItemPayload,
    TPartialResources
  > = scheduleItemFetchApiImpl;

  function scheduleAutomaticItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload,
    options?: { fields?: FieldsInput },
  ): ScheduleFetchResults {
    const itemKey = getItemKey(itemPayload);
    const scheduler = getOrCreateItemScheduler(itemKey, itemPayload);
    const fields = normalizeFieldsOption(options?.fields);

    return scheduler.scheduleFetch(itemKey, fetchType, {
      payload: itemPayload,
      fields,
    });
  }

  const awaitListQueryFetchApi: ListQueryAwaitListQueryFetchApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  > = (params, ...args) => {
    const [options] = args;
    return awaitListQueryFetch(params, options);
  };

  const getQueryFromStateOrFetchApi: ListQueryGetQueryFromStateOrFetchApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  > = (params, ...args) => {
    const [options] = args;
    return getQueryFromStateOrFetch(params, options);
  };

  const awaitItemFetchApi: ListQueryAwaitItemFetchApi<
    ItemState,
    ItemPayload,
    TPartialResources
  > = (itemPayload, ...args) => {
    const [options] = args;
    return awaitItemFetch(itemPayload, options);
  };

  const getItemFromStateOrFetchApi: ListQueryGetItemFromStateOrFetchApi<
    ItemState,
    ItemPayload,
    TPartialResources
  > = (itemPayload, ...args) => {
    const [options] = args;
    return getItemFromStateOrFetch(itemPayload, options);
  };

  function getRelatedQueryKeysForItemEntries(
    itemEntries: { payload: ItemPayload }[],
  ): string[] {
    return Array.from(
      new Set(
        itemEntries.flatMap(({ payload }) =>
          getQueriesRelatedToItem(payload).map(({ key }) => key),
        ),
      ),
    );
  }

  function touchUpdatedItemEntries(
    itemEntries: { itemKey: string; payload: ItemPayload }[],
  ): void {
    touchItems(itemEntries.map(({ itemKey }) => itemKey));
    touchQueries(getRelatedQueryKeysForItemEntries(itemEntries));
    if (shouldScheduleCacheLimitEnforcement()) {
      scheduleCacheLimitEnforcement();
    }
  }

  function updateItemState(
    itemIds: Parameters<typeof updateItemStateBase>[0],
    produceNewData: Parameters<typeof updateItemStateBase>[1],
    options?: Parameters<typeof updateItemStateBase>[2],
  ): ReturnType<typeof updateItemStateBase> {
    const itemEntries = getItemsKeyArray(itemIds);
    const wasUpdated = updateItemStateBase(itemIds, produceNewData, options);

    if (!wasUpdated) return wasUpdated;

    touchUpdatedItemEntries(itemEntries);

    return wasUpdated;
  }

  function addItemToState(
    itemPayload: Parameters<typeof addItemToStateBase>[0],
    data: Parameters<typeof addItemToStateBase>[1],
    options?: Parameters<typeof addItemToStateBase>[2],
  ): void {
    addItemToStateBase(itemPayload, data, options);
    touchUpdatedItemEntries([
      { itemKey: getItemKey(itemPayload), payload: itemPayload },
    ]);
  }

  function deleteItemState(
    itemId: Parameters<typeof deleteItemStateBase>[0],
  ): void {
    const itemEntries = getItemsKeyArray(itemId);
    const relatedQueryKeys = getRelatedQueryKeysForItemEntries(itemEntries);

    deleteItemStateBase(itemId);

    for (const { itemKey } of itemEntries) {
      cleanupItemStateMetadata(itemKey);
    }
    touchQueries(relatedQueryKeys);
  }

  let isDisposed = false;
  const unregisterStoreFromManager = registerStoreWithManager(storeManager, {
    id,
    reset,
    onTransportReconnect,
  });

  return {
    store,
    events,
    storeEvents,
    get queryInvalidationWasTriggered() {
      return queryInvalidationWasTriggered;
    },
    get itemInvalidationWasTriggered() {
      return itemInvalidationWasTriggered;
    },
    reset,
    dispose,
    scheduleListQueryFetch: scheduleListQueryFetchApi,
    getQueryState,
    getQueryKey,
    getQueriesState,
    getQueriesRelatedToItem,
    awaitListQueryFetch: awaitListQueryFetchApi,
    getQueryFromStateOrFetch: getQueryFromStateOrFetchApi,
    preloadQueryFromStorage: preloadQueryFromPersistentStorage,
    loadMore: loadMoreApi,
    getItemKey,
    getItemState,
    usePendingOfflineItems,
    getOfflineEntities: () => offlineController?.getOfflineEntities() ?? [],
    useOfflineEntities: () =>
      useOfflineStoreEntities({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      }),
    useOfflineResolutions: () =>
      useOfflineStoreResolutions({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      }),
    getOfflineResolutions: () =>
      offlineController?.getOfflineResolutions() ?? [],
    parseOfflineResolutionConflict: (resolution) => {
      if (!offlineController) {
        return Result.err(
          new OfflineResolutionConflictParseError({
            code: 'offline-not-configured',
            operation: resolution.operation,
          }),
        );
      }

      if (
        !isOfflineResolutionRecordForStore(
          resolution,
          resolvedOfflineOperations,
        )
      ) {
        return Result.err(
          new OfflineResolutionConflictParseError({
            code: 'operation-not-found',
            operation: resolution.operation,
          }),
        );
      }

      return offlineController.parseOfflineResolutionConflict(resolution);
    },
    resolveOfflineResolution: <
      TName extends keyof ResolvedOfflineOperations & string,
    >(
      resolutionId: string,
      operationName: TName,
      resolution: OfflineResolutionActionForOperation<
        ResolvedOfflineOperations,
        TName
      >,
    ) =>
      offlineController?.resolveOfflineResolution(
        resolutionId,
        operationName,
        resolution,
      ),
    preloadItemFromStorage: preloadItemFromPersistentStorage,
    scheduleItemFetch: scheduleItemFetchApi,
    awaitItemFetch: awaitItemFetchApi,
    getItemFromStateOrFetch: getItemFromStateOrFetchApi,
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    performMutation: performMutationBase,
    useMultipleListQueries,
    useListQuery,
    useMultipleItems,
    useItem,
    useFindItem,
    onTransportReconnect,
  };
}
