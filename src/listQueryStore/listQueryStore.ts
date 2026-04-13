import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { notNullish } from '@ls-stack/utils/assertions';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { useCallback } from 'react';
import { Result } from 't-result';
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
import {
  captureOfflineOverlayEntries,
  rebindOfflineOverlayEntries,
} from '../persistentStorage/offline/overlayStoreLifecycle';
import {
  useOfflineStoreStatus,
  useOfflineStoreEntities,
  useOfflineStoreEntitiesWithPayload,
  useOfflineStoreResolutions,
} from '../persistentStorage/offline/sessionCoordinator';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  type OfflineStoreController,
} from '../persistentStorage/offline/storeController';
import {
  offlineItemEntityRefSchema,
  OfflineResolutionConflictParseError,
  type OfflineMutationInput,
  type ParsedOfflineResolutionConflictResultForOperation,
  type OfflineResolutionRecordForOperation,
  type OfflineResolutionActionForOperation,
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
  type StoreManager,
  validateStoreManagerSessionConsistency,
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
import {
  createItemAliasRegistry,
  normalizeResolvedItemIdentity,
  type ResolveItemIdentity,
} from '../utils/itemIdentity';
import { type BlockWindowCloseHandler } from '../utils/performMutation';
import { createStoreFocusLifecycle } from '../utils/storeFocusLifecycle';
import {
  AbortedStoreError,
  DEFAULT_BATCH_KEY,
  NotFoundStoreError,
  StoreFetchError,
  TimeoutStoreError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { createFetchApi, type FilterItemFn } from './createFetchApi';
import { createMutationApi } from './createMutationApi';
import { excludeLoadedFields } from './itemFieldUtils';
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

export type ListQueryStoreEvents = {
  invalidateQuery: { priority: FetchType; queryKey: string };
  invalidateItem: {
    priority: FetchType;
    itemKey: string;
    invalidateFields?: string[];
  };
};

export type ListQueryStore<
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
> = ReturnType<
  typeof createListQueryStore<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources,
    TOffsetPagination,
    TOfflineOperations
  >
>;

export type ListQueryStateCleanup<
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  reason: 'cacheLimitEviction';
  itemKeys: string[];
  itemPayloads: ItemPayload[];
  queryKeys: string[];
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
) => Promise<FetchListFnReturn<ItemState, ItemPayload>>;

type FetchListFnOffsetMode<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = (
  payload: QueryPayload,
  pagination: { offset: number; limit: number },
  options: { signal: AbortSignal; fields?: string[] },
) => Promise<FetchListFnReturn<ItemState, ItemPayload>>;

type ListQuerySnapshotItemEntry<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  aliasPayloads?: ItemPayload[];
  itemKey: string;
  item: ItemState | null;
  itemQuery: TSDFItemQuery<ItemPayload> | null;
  loadedFields: string[];
};

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
      aliasPayloads?: ItemPayload[];
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
  debugName?: string;
  /** Stable id shared by the same logical list-query store across browser tabs. */
  id: string;
  /** Shared global store manager providing session scoping and error normalization. */
  storeManager: StoreManager;
  fetchItemFn?: (
    payload: ItemPayload,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<ItemState>;
  batchFetchItemFn?: (
    requests: { payload: ItemPayload; fields?: string[] }[],
    options: { signal: AbortSignal; batchKey: string },
  ) => Promise<Map<ItemPayload, ItemState | Error>>;
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  defaultQuerySize?: number;
  maxItemBatchSize?: number;
  /** Maximum number of cached items kept in memory. Defaults to 5,000. Item pressure may evict whole inactive queries to avoid leaving cached queries partially loaded. */
  maxItems?: number;
  /** Maximum number of cached queries kept in memory. Defaults to 1,000. Inactive queries are evicted in LRU order while mounted hook queries stay protected. */
  maxQueries?: number;
  /** Called when cache-limit eviction removes items or queries from in-memory state. */
  onStateCleanup?: (
    cleanup: ListQueryStateCleanup<QueryPayload, ItemPayload>,
  ) => void;
  usesRealTimeUpdates?: boolean;
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
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  /** Reconnect-specific cooldown. The first reconnect revalidates immediately;
   * additional reconnects within the cooldown are coalesced into one trailing
   * revalidation. Set to `0` to disable this cooldown. */
  transportReconnectCooldownMs?: number;
  optimisticListUpdates?: OptimisticListUpdate<
    ItemState,
    QueryPayload,
    ItemPayload
  >[];
  onInvalidateQuery?: OnListQueryInvalidate<QueryPayload>;
  onInvalidateItem?: OnListQueryItemInvalidate<ItemState, ItemPayload>;
  onSchedulerEvent?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  onMutationError?: (
    error: unknown,
    options: { silentErrors?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  /** Opt-in hook-level query derivation from locally materialized items. */
  derivedQueries?: DerivedQueriesConfig<ItemState, QueryPayload, ItemPayload>;
  getQueryKey?: (params: QueryPayload) => ValidPayload | unknown[];
  getItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  /** Resolves the canonical payload for a fetched item after the response is known. */
  resolveItemIdentity?: ResolveItemIdentity<ItemState, ItemPayload>;
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
        fetchListFn: FetchListFnOffsetMode<
          ItemState,
          QueryPayload,
          ItemPayload
        >;
        offsetPagination: OffsetPaginationConfig;
      }
    : {
        fetchListFn: FetchListFnSizeMode<ItemState, QueryPayload, ItemPayload>;
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
) {
  const {
    debugName,
    id,
    storeManager,
    fetchItemFn,
    batchFetchItemFn,
    getItemsBatchKey,
    defaultQuerySize = 50,
    maxItemBatchSize,
    maxItems = 5_000,
    maxQueries = 1_000,
    onStateCleanup,
    usesRealTimeUpdates = false,
    '~test': testOptions,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs = 2_000,
    optimisticListUpdates,
    onInvalidateQuery,
    onInvalidateItem,
    onSchedulerEvent,
    onMutationError,
    blockWindowClose,
    derivedQueries,
    getQueryKey: customGetQueryKey,
    getItemKey: customGetItemKey,
    resolveItemIdentity,
    partialResources,
    persistentStorage: persistentStorageConfig,
  } = storeOptions;

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

  type HasPR = [TPartialResources] extends [true] ? true : false;
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
  type FetchFieldsOption = HasPR extends true
    ? { fields: FieldsInput }
    : { fields?: FieldsInput };
  type ScheduleFetchWithFieldsOption = ScheduleFetchOptions & FetchFieldsOption;
  type AwaitListQueryFetchOptions = {
    size?: number;
    timeoutMs?: number;
  } & FetchFieldsOption;
  type AwaitItemFetchOptions = { timeoutMs?: number } & FetchFieldsOption;
  type LoadMoreWithFieldsOptions = { size?: number } & FetchFieldsOption;

  function normalizeFieldsOption(
    fields: FieldsInput | undefined,
  ): string[] | undefined {
    if (partialResources && fields === undefined) {
      throw new Error(noPartialResourcesFieldsOptionError);
    }

    if (fields === '*') return undefined;

    return fields;
  }

  type ScheduleListQueryFetchApi = {
    (
      fetchType: FetchType,
      payload: QueryPayload,
      ...args: HasPR extends true
        ? [size: number | undefined, options: ScheduleFetchWithFieldsOption]
        : [size?: number, options?: ScheduleFetchWithFieldsOption]
    ): ScheduleFetchResults;
    (
      fetchType: FetchType,
      payload: QueryPayload[],
      ...args: HasPR extends true
        ? [size: number | undefined, options: ScheduleFetchWithFieldsOption]
        : [size?: number, options?: ScheduleFetchWithFieldsOption]
    ): ScheduleFetchResults[];
  };

  type ScheduleItemFetchApi = {
    (
      fetchType: FetchType,
      itemPayload: ItemPayload,
      ...args: HasPR extends true
        ? [options: ScheduleFetchWithFieldsOption]
        : [options?: ScheduleFetchWithFieldsOption]
    ): ScheduleFetchResults;
    (
      fetchType: FetchType,
      itemPayload: ItemPayload[],
      ...args: HasPR extends true
        ? [options: ScheduleFetchWithFieldsOption]
        : [options?: ScheduleFetchWithFieldsOption]
    ): ScheduleFetchResults[];
  };

  type LoadMoreApi = (
    params: QueryPayload,
    ...args: HasPR extends true
      ?
          | [size: number, options: FetchFieldsOption]
          | [options: LoadMoreWithFieldsOptions]
      :
          | [size?: number, options?: FetchFieldsOption]
          | [options?: LoadMoreWithFieldsOptions]
  ) => ScheduleFetchResults;

  type AwaitListQueryFetchApi = (
    params: QueryPayload,
    ...args: HasPR extends true
      ? [options: AwaitListQueryFetchOptions]
      : [options?: AwaitListQueryFetchOptions]
  ) => Promise<
    | { items: []; error: StoreFetchError; hasMore: boolean }
    | {
        items: { data: ItemState; itemPayload: ItemPayload }[];
        error: null;
        hasMore: boolean;
      }
  >;

  type AwaitItemFetchApi = (
    itemPayload: ItemPayload,
    ...args: HasPR extends true
      ? [options: AwaitItemFetchOptions]
      : [options?: AwaitItemFetchOptions]
  ) => Promise<
    { data: null; error: StoreFetchError } | { data: ItemState; error: null }
  >;

  type UseMultipleListQueriesApi = {
    <
      SelectedItem = ItemState,
      QueryMetadata extends undefined | Record<string, unknown> = undefined,
    >(
      queries: (ListQueryUseMultipleListQueriesQuery<
        QueryPayload,
        QueryMetadata
      > &
        FieldsOption<HasPR>)[],
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

  type UseMultipleItemsApi = {
    <
      Selected = ItemState | null,
      QueryMetadata extends undefined | Record<string, unknown> = undefined,
    >(
      items: (ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata> &
        FieldsOption<HasPR>)[],
      options?: UseMultipleItemsOptions<ItemState, Selected>,
    ): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[];
    <S = ItemState | null>(
      items: ListQueryUseMultipleItemsQuery<ItemPayload, undefined>[],
      options: UseMultipleItemsOptions<ItemState, S>,
    ): readonly TSFDUseListItemReturn<S, ItemPayload, undefined>[];
  };

  type UsePendingOfflineItemsApi = {
    <SelectedItem = ItemState>(
      options?: UsePendingOfflineItemsOptions<
        ItemState,
        ItemPayload,
        SelectedItem
      >,
    ): TSFDUsePendingOfflineItemsReturn<SelectedItem, ItemPayload>;
  };

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
        offline: persistentStorageConfig.offline
          ? {
              ...persistentStorageConfig.offline,
              session: resolvedOfflineSessionForPersistentStorage,
            }
          : undefined,
        getSessionKey: getSessionKeyForRuntime,
        storeName: id,
      })
    : null;

  function getRawItemKey(params: ItemPayload): string {
    return getCompositeKey(
      customGetItemKey ? customGetItemKey(params) : params,
    );
  }

  const itemAliasRegistry = createItemAliasRegistry(getRawItemKey);

  // Persistent storage setup
  const persistence = resolvedPersistentStorageConfig
    ? setupListQueryPersistence(resolvedPersistentStorageConfig, {
        enableItemAliases: resolveItemIdentity !== undefined,
        getItemAliasPayloads: (itemKey) =>
          itemAliasRegistry.getAliasPayloads(itemKey),
        getItemKey: getRawItemKey,
        getItemDerivedGroup: derivedQueries?.getItemGroup,
        getQueryKey,
      })
    : null;

  function resolveKnownItemKey(itemKey: string): string {
    const persistedItemKey = persistence?.resolveItemKey(itemKey) ?? itemKey;
    return itemAliasRegistry.resolveItemKey(persistedItemKey);
  }

  function getLookupItemKey(params: ItemPayload): string {
    return resolveKnownItemKey(getRawItemKey(params));
  }
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
    debugName,
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
            const itemKey = getRawItemKey(payload);

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

  function readResolvedItemState(
    itemKey: string,
  ):
    | {
        item: ItemState | null | undefined;
        itemQuery: TSDFItemQuery<ItemPayload> | null | undefined;
        loadedFields: string[] | undefined;
      }
    | undefined {
    const resolvedItemKey = resolveKnownItemKey(itemKey);
    const hasItem = Object.hasOwn(store.state.items, resolvedItemKey);
    const hasItemQuery = Object.hasOwn(
      store.state.itemQueries,
      resolvedItemKey,
    );
    const hasLoadedFields = Object.hasOwn(
      store.state.itemLoadedFields,
      resolvedItemKey,
    );

    if (hasItem || hasItemQuery || hasLoadedFields) {
      return {
        item: hasItem ? store.state.items[resolvedItemKey] : undefined,
        itemQuery: hasItemQuery
          ? store.state.itemQueries[resolvedItemKey]
          : undefined,
        loadedFields: hasLoadedFields
          ? store.state.itemLoadedFields[resolvedItemKey]
          : undefined,
      };
    }

    const hydratedItem = persistence?.readHydratedItem(resolvedItemKey);
    if (!hydratedItem) return undefined;

    const storePersistence = persistence;
    if (storePersistence && !storePersistence.hasAsyncPreload) {
      void storePersistence.preloadItems([resolvedItemKey]);

      const hasSyncedItem = Object.hasOwn(store.state.items, resolvedItemKey);
      const hasSyncedItemQuery = Object.hasOwn(
        store.state.itemQueries,
        resolvedItemKey,
      );
      const hasSyncedLoadedFields = Object.hasOwn(
        store.state.itemLoadedFields,
        resolvedItemKey,
      );

      if (hasSyncedItem || hasSyncedItemQuery || hasSyncedLoadedFields) {
        return {
          item: hasSyncedItem ? store.state.items[resolvedItemKey] : undefined,
          itemQuery: hasSyncedItemQuery
            ? store.state.itemQueries[resolvedItemKey]
            : undefined,
          loadedFields: hasSyncedLoadedFields
            ? store.state.itemLoadedFields[resolvedItemKey]
            : undefined,
        };
      }
    }

    return {
      item: hydratedItem.item,
      itemQuery: hydratedItem.itemQuery,
      loadedFields: hydratedItem.loadedFields,
    };
  }

  function getResolvedItemPayload(itemPayload: ItemPayload): ItemPayload {
    const rawItemKey = getRawItemKey(itemPayload);
    const resolvedItemKey = resolveKnownItemKey(rawItemKey);

    if (resolvedItemKey === rawItemKey) return itemPayload;

    return (
      readResolvedItemState(resolvedItemKey)?.itemQuery?.payload ?? itemPayload
    );
  }

  function getKnownLocalItemSnapshotKeys(args: {
    aliasPayloads?: readonly ItemPayload[];
    itemKey: string;
  }): string[] {
    const candidateItemKeys = new Set<string>([args.itemKey]);

    for (const aliasPayload of args.aliasPayloads ?? []) {
      candidateItemKeys.add(getRawItemKey(aliasPayload));
    }

    return [...candidateItemKeys].filter((itemKey) => {
      return (
        Object.hasOwn(store.state.items, itemKey) ||
        Object.hasOwn(store.state.itemQueries, itemKey) ||
        Object.hasOwn(store.state.itemLoadedFields, itemKey)
      );
    });
  }

  function canonicalizeFetchedItems(args: {
    itemKeys: string[];
    requestedPayloadByItemKey?: Map<string, ItemPayload>;
    requestedFieldsByItemKey?: Map<string, string[] | undefined>;
    source: 'itemFetch' | 'listFetch';
    startedAt: number;
  }): {
    affectedQueryKeys: string[];
    canonicalItemKeys: string[];
    removedAliasKeys: string[];
  } {
    const affectedQueryKeys = new Set<string>();
    const canonicalItemKeys = new Set<string>();
    const removedAliasKeys = new Set<string>();
    const itemKeyRewriteMap = new Map<string, string>();
    const itemKeyRewrites: { previousItemKey: string; nextItemKey: string }[] =
      [];
    const fetchResourcesToDelete: { itemKey: string; payload: ItemPayload }[] =
      [];
    const aliasUpdates: {
      canonicalItemKey: string;
      aliasPayloads: ItemPayload[];
      canonicalPayload: ItemPayload;
    }[] = [];

    store.produceState(
      (draft) => {
        for (const itemKey of args.itemKeys) {
          const item = draft.items[itemKey];
          const itemQuery = draft.itemQueries[itemKey];
          if (item == null || itemQuery == null) continue;

          const requestedPayload =
            args.requestedPayloadByItemKey?.get(itemKey) ?? itemQuery.payload;
          const resolvedIdentity = normalizeResolvedItemIdentity({
            data: item,
            getItemKey: getRawItemKey,
            payload: requestedPayload,
            resolveItemIdentity,
            source: args.source,
          });
          const canonicalItemKey = resolvedIdentity.canonicalItemKey;
          const canonicalItem = draft.items[canonicalItemKey];
          const canonicalItemQuery = draft.itemQueries[canonicalItemKey];
          const aliasLoadedFields = draft.itemLoadedFields[itemKey] ?? [];
          const canonicalLoadedFields =
            draft.itemLoadedFields[canonicalItemKey] ?? [];
          const mergedItem = partialResources
            ? partialResources.mergeItems(canonicalItem ?? undefined, item)
            : item;

          draft.items[canonicalItemKey] = mergedItem;
          draft.itemQueries[canonicalItemKey] = {
            error: null,
            status: 'success',
            refetchOnMount: false,
            wasLoaded: true,
            payload: resolvedIdentity.canonicalPayload,
          };

          const nextInvalidationFields = Array.from(
            new Set([
              ...(draft.itemFieldInvalidationFields[canonicalItemKey] ?? []),
              ...(itemKey === canonicalItemKey
                ? []
                : (draft.itemFieldInvalidationFields[itemKey] ?? [])),
            ]),
          ).sort();
          if (nextInvalidationFields.length > 0) {
            draft.itemFieldInvalidationFields[canonicalItemKey] =
              nextInvalidationFields;
          } else {
            delete draft.itemFieldInvalidationFields[canonicalItemKey];
          }

          applyLoadedFieldsFromSnapshot(
            draft,
            canonicalItemKey,
            Array.from(
              new Set([
                ...canonicalLoadedFields,
                ...(itemKey === canonicalItemKey ? [] : aliasLoadedFields),
              ]),
            ).sort(),
          );

          canonicalItemKeys.add(canonicalItemKey);
          aliasUpdates.push({
            canonicalItemKey,
            aliasPayloads: [
              ...resolvedIdentity.aliasPayloads,
              ...(canonicalItemQuery &&
              getRawItemKey(canonicalItemQuery.payload) !== canonicalItemKey
                ? [canonicalItemQuery.payload]
                : []),
            ],
            canonicalPayload: resolvedIdentity.canonicalPayload,
          });

          if (itemKey === canonicalItemKey) continue;
          delete draft.items[itemKey];
          delete draft.itemQueries[itemKey];
          delete draft.itemLoadedFields[itemKey];
          delete draft.itemFieldInvalidationFields[itemKey];
          removedAliasKeys.add(itemKey);
          itemKeyRewriteMap.set(itemKey, canonicalItemKey);
          itemKeyRewrites.push({
            previousItemKey: itemKey,
            nextItemKey: canonicalItemKey,
          });
          fetchResourcesToDelete.push({ itemKey, payload: requestedPayload });
        }

        rewriteQueryMemberships(draft, itemKeyRewriteMap, affectedQueryKeys);
      },
      { action: 'canonicalize-item-identity' },
    );

    for (const {
      canonicalItemKey,
      aliasPayloads,
      canonicalPayload,
    } of aliasUpdates) {
      setCanonicalItemAliases(canonicalItemKey, aliasPayloads);
      getOrCreateItemScheduler(
        canonicalItemKey,
        canonicalPayload,
      ).setLastFetchStartTimeForRequest(canonicalItemKey, args.startedAt);
    }
    if (itemKeyRewrites.length > 0) {
      rebindOfflineOverlays(itemKeyRewrites);
    }
    if (fetchResourcesToDelete.length > 0) {
      deleteItemFetchResources(fetchResourcesToDelete);
    }

    return {
      affectedQueryKeys: [...affectedQueryKeys],
      canonicalItemKeys: [...canonicalItemKeys],
      removedAliasKeys: [...removedAliasKeys],
    };
  }

  function getItemState(
    itemPayload: ItemPayload[] | FilterItemFn<ItemState, ItemPayload>,
  ): { payload: ItemPayload; data: ItemState }[];
  function getItemState(itemPayload: ItemPayload): ItemState | null | undefined;
  function getItemState(
    itemPayload:
      | ItemPayload
      | ItemPayload[]
      | FilterItemFn<ItemState, ItemPayload>,
  ):
    | ItemState
    | null
    | undefined
    | { payload: ItemPayload; data: ItemState }[] {
    if (typeof itemPayload === 'function') {
      const itemKeys = new Set(
        [
          ...Object.keys(store.state.itemQueries),
          ...(persistence?.getHydratedItemKeys() ?? []),
        ].map((itemKey) => resolveKnownItemKey(itemKey)),
      );

      return filterAndMap([...itemKeys], (itemKey) => {
        const itemState = readResolvedItemState(itemKey);
        const item = itemState?.item;
        const payload = itemState?.itemQuery?.payload;

        if (item == null || payload === undefined) return false;

        return itemPayload(payload, item) ? { payload, data: item } : false;
      });
    }

    if (Array.isArray(itemPayload)) {
      return filterAndMap(itemPayload, (payload) => {
        const resolvedPayload = getResolvedItemPayload(payload);
        const item = readResolvedItemState(getLookupItemKey(payload))?.item;
        return item == null ? false : { payload: resolvedPayload, data: item };
      });
    }

    const itemState = readResolvedItemState(getLookupItemKey(itemPayload));
    if (itemState?.itemQuery === null) return null;
    return itemState?.item;
  }

  function getQueriesRelatedToItem(
    itemPayload: ItemPayload,
  ): { query: TSFDListQuery<QueryPayload>; key: string }[] {
    const itemKey = getLookupItemKey(itemPayload);

    return getRawQueriesState((_queryPayload, query) => {
      return query.items.includes(itemKey);
    });
  }

  function getQueryState(params: QueryPayload) {
    return getRawQueryState(params);
  }

  function getQueriesState(params: Parameters<typeof getRawQueriesState>[0]) {
    return getRawQueriesState(params);
  }

  function getQueryKey(params: QueryPayload): string {
    return getCompositeKey(
      customGetQueryKey ? customGetQueryKey(params) : params,
    );
  }

  function getItemKey(params: ItemPayload): string {
    return getRawItemKey(params);
  }

  type ResolvedOfflineOperations = TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;

  let offlineController: OfflineStoreController<ResolvedOfflineOperations> | null =
    null;
  const offlineFetchController = {
    prepareForFetch: () =>
      offlineController?.prepareForFetch() ?? Promise.resolve(),
    getSessionStatus: () => offlineController?.getSessionStatus() ?? null,
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

  const wrappedDynamicRealtimeThrottleMs = dynamicRealtimeThrottleMs
    ? (lastFetchDuration: number) =>
        dynamicRealtimeThrottleMs({
          lastFetchDuration,
          windowIsNotFocused: !getWindowIsFocused(),
        })
    : undefined;

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
      ...(resolveKnownItemKey(itemKey) === itemKey &&
      store.state.itemQueries[itemKey] !== null &&
      store.state.itemQueries[itemKey] !== undefined
        ? { aliasPayloads: itemAliasRegistry.getAliasPayloads(itemKey) }
        : {}),
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

    const aliasPayloads =
      resolveKnownItemKey(itemKey) === itemKey &&
      store.state.itemQueries[itemKey] !== null &&
      store.state.itemQueries[itemKey] !== undefined
        ? itemAliasRegistry.getAliasPayloads(itemKey)
        : [];
    const message = browserTabsSync?.publish({
      kind: 'list-item-snapshot',
      itemKey,
      ...(aliasPayloads.length > 0 ? { aliasPayloads } : {}),
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
      persistentStorageConfig?.onPersistentStorageError?.(
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
      persistentStorageConfig?.onPersistentStorageError?.(
        new Error('Persistent storage preload is not available'),
      );
      return payloads.map((itemPayload) => ({
        payload: itemPayload,
        preloaded: false,
      }));
    }

    const itemKeys = payloads.map((itemPayload) => getItemKey(itemPayload));
    const results = await persistence.preloadItems(itemKeys);
    const preloadedItemKeys = payloads.flatMap((itemPayload, index) =>
      results[index] ? [getLookupItemKey(itemPayload)] : [],
    );
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
    getQueryState: getRawQueryState,
    getQueriesKeyArray,
    getQueriesState: getRawQueriesState,
    getQueriesRelatedToItem: getRawQueriesRelatedToItem,
    getItemsKeyArray: getRawItemsKeyArray,
    scheduleListQueryFetch: scheduleRawListQueryFetch,
    loadMore: loadMoreRaw,
    awaitListQueryFetch: awaitRawListQueryFetch,
    getOrCreateQueryScheduler,
    getOrCreateItemScheduler,
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
    getItemKey: getLookupItemKey,
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
      const successfulQueryRequests = requests.filter(
        ({ requestId }) => results.get(requestId) === true,
      );
      const successfulQueryKeys = successfulQueryRequests.map(
        ({ requestId }) => requestId,
      );

      if (resolveItemIdentity === undefined) {
        pruneItemInvalidationTracking();

        if (successfulQueryKeys.length > 0) {
          touchQueries(successfulQueryKeys);
          touchItems(
            Array.from(
              new Set(
                successfulQueryKeys.flatMap(
                  (queryKey) => store.state.queries[queryKey]?.items ?? [],
                ),
              ),
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
        return;
      }

      const requestedFieldsByItemKey = new Map<string, string[] | undefined>();

      for (const { payload, requestId } of successfulQueryRequests) {
        for (const itemKey of store.state.queries[requestId]?.items ?? []) {
          const previousFields = requestedFieldsByItemKey.get(itemKey);
          if (previousFields === undefined || payload.fields === undefined) {
            requestedFieldsByItemKey.set(itemKey, payload.fields);
            continue;
          }

          requestedFieldsByItemKey.set(
            itemKey,
            Array.from(new Set([...previousFields, ...payload.fields])).sort(),
          );
        }
      }

      const canonicalization = canonicalizeFetchedItems({
        itemKeys: Array.from(
          new Set(
            successfulQueryRequests.flatMap(
              ({ requestId }) => store.state.queries[requestId]?.items ?? [],
            ),
          ),
        ),
        requestedFieldsByItemKey,
        source: 'listFetch',
        startedAt,
      });
      pruneItemInvalidationTracking();

      const touchedQueryKeys = Array.from(
        new Set([
          ...successfulQueryKeys,
          ...canonicalization.affectedQueryKeys,
        ]),
      );
      if (touchedQueryKeys.length > 0) {
        touchQueries(touchedQueryKeys);
        touchItems(
          Array.from(
            new Set(
              touchedQueryKeys.flatMap(
                (queryKey) => store.state.queries[queryKey]?.items ?? [],
              ),
            ),
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

        for (const queryKey of touchedQueryKeys) {
          publishQuerySnapshot(queryKey, 'confirmed');
        }
        for (const itemKey of canonicalization.removedAliasKeys) {
          publishItemSnapshot(itemKey, 'confirmed');
        }
      }
    },
    onItemFetchSettled: ({ requests, results, startedAt, duration }) => {
      const successfulRequests = requests.filter(
        ({ requestId }) => results.get(requestId) === true,
      );

      if (resolveItemIdentity === undefined) {
        const successfulItemKeys = successfulRequests.map(
          ({ requestId }) => requestId,
        );
        const affectedQueryKeys = Array.from(
          new Set(
            successfulRequests.flatMap(({ payload }) =>
              getRawQueriesRelatedToItem(payload.payload).map(({ key }) => key),
            ),
          ),
        );
        pruneItemInvalidationTracking();

        if (successfulItemKeys.length > 0) {
          touchItems(successfulItemKeys);
          touchQueries(affectedQueryKeys);
          if (shouldScheduleCacheLimitEnforcement()) {
            scheduleCacheLimitEnforcement();
          }
        }
        const firstSuccessfulItem = successfulRequests[0];
        if (firstSuccessfulItem) {
          const payload = requests[0]?.payload.payload;
          const batchKey = payload ? getItemBatchKey(payload) : false;
          const targetKey =
            batchKey === false
              ? getItemTargetKey(firstSuccessfulItem.requestId)
              : getItemBatchTargetKey(batchKey);

          browserTabsSync?.publish({
            kind: 'fetch-success',
            targetKey,
            requestIds: successfulItemKeys,
            startedAt,
            duration,
          });

          for (const itemKey of successfulItemKeys) {
            publishItemSnapshot(itemKey, 'confirmed');
          }
        }
        return;
      }

      const requestedPayloadByItemKey = new Map(
        successfulRequests.map((request) => [
          request.requestId,
          request.payload.payload,
        ]),
      );
      const requestedFieldsByItemKey = new Map(
        successfulRequests.map((request) => [
          request.requestId,
          request.payload.fields,
        ]),
      );
      const canonicalization = canonicalizeFetchedItems({
        itemKeys: successfulRequests.map((request) => request.requestId),
        requestedPayloadByItemKey,
        requestedFieldsByItemKey,
        source: 'itemFetch',
        startedAt,
      });
      pruneItemInvalidationTracking();

      if (canonicalization.canonicalItemKeys.length > 0) {
        touchItems(canonicalization.canonicalItemKeys);
        touchQueries(canonicalization.affectedQueryKeys);
        if (shouldScheduleCacheLimitEnforcement()) {
          scheduleCacheLimitEnforcement();
        }
      }
      const firstSuccessfulItem = successfulRequests[0];

      if (firstSuccessfulItem) {
        const payload = requests[0]?.payload.payload;
        const batchKey = payload ? getItemBatchKey(payload) : false;
        const targetKey =
          batchKey === false
            ? getItemTargetKey(firstSuccessfulItem.requestId)
            : getItemBatchTargetKey(batchKey);

        browserTabsSync?.publish({
          kind: 'fetch-success',
          targetKey,
          requestIds: successfulRequests.map(({ requestId }) => requestId),
          startedAt,
          duration,
        });

        for (const itemKey of canonicalization.canonicalItemKeys) {
          publishItemSnapshot(itemKey, 'confirmed');
        }
        for (const queryKey of canonicalization.affectedQueryKeys) {
          publishQuerySnapshot(queryKey, 'confirmed');
        }
        for (const itemKey of canonicalization.removedAliasKeys) {
          publishItemSnapshot(itemKey, 'confirmed');
        }
      }
    },
  });

  function getMutationItemEntries(
    itemPayload:
      | ItemPayload
      | ItemPayload[]
      | FilterItemFn<ItemState, ItemPayload>,
  ): { itemKey: string; payload: ItemPayload }[] {
    if (typeof itemPayload === 'function') {
      return getRawItemsKeyArray(itemPayload);
    }

    const payloads = Array.isArray(itemPayload) ? itemPayload : [itemPayload];
    return payloads.map((payload) => ({
      itemKey: getLookupItemKey(payload),
      payload,
    }));
  }

  const {
    storeEvents,
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    invalidateQueryAndItems: invalidateQueryAndItemsBase,
    invalidateItem: invalidateItemBase,
    startItemMutation: startItemMutationBase,
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
    onMutationError,
    errorNormalizer,
    getItemKey: getRawItemKey,
    getQueriesKeyArray,
    getQueriesRelatedToItem,
    getItemsKeyArray: getMutationItemEntries,
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

  const scheduleListQueryFetch = scheduleRawListQueryFetch;
  const loadMore = loadMoreRaw;
  const awaitListQueryFetch = awaitRawListQueryFetch;

  function invalidateQueryAndItems(
    args: Parameters<typeof invalidateQueryAndItemsBase>[0],
  ): void {
    invalidateQueryAndItemsBase(args);
  }

  function invalidateItem(
    itemPayload: Parameters<typeof invalidateItemBase>[0],
    priority?: Parameters<typeof invalidateItemBase>[1],
  ): void {
    invalidateItemBase(itemPayload, priority);
  }

  function startItemMutation(
    itemPayload: Parameters<typeof startItemMutationBase>[0],
  ): ReturnType<typeof startItemMutationBase> {
    return startItemMutationBase(itemPayload);
  }

  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload,
    options?: ScheduleFetchOptions & { fields?: FieldsInput },
  ): ScheduleFetchResults;
  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload[],
    options?: ScheduleFetchOptions & { fields?: FieldsInput },
  ): ScheduleFetchResults[];
  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload | ItemPayload[],
    options?: ScheduleFetchOptions & { fields?: FieldsInput },
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    if (!fetchItemFn) {
      throw new Error('No fetchItemFn was provided');
    }

    const fields = normalizeFieldsOption(options?.fields);
    const payloads = Array.isArray(itemPayload) ? itemPayload : [itemPayload];
    const results = payloads.map((payload) => {
      const requestItemKey = getItemKey(payload);
      const lookupItemKey = resolveKnownItemKey(requestItemKey);
      return getOrCreateItemScheduler(lookupItemKey, payload).scheduleFetch(
        requestItemKey,
        fetchType,
        { payload, fields },
        options,
      );
    });

    if (Array.isArray(itemPayload)) return results;

    const firstResult = results[0];
    if (!firstResult) {
      throw new Error('Unexpected empty results array');
    }
    return firstResult;
  }

  async function awaitItemFetch(
    itemPayload: ItemPayload,
    options: { timeoutMs?: number; fields?: FieldsInput } = {},
  ): Promise<
    { data: null; error: StoreFetchError } | { data: ItemState; error: null }
  > {
    if (!fetchItemFn) {
      throw new Error('No fetchItemFn was provided');
    }

    const requestItemKey = getItemKey(itemPayload);
    const lookupItemKey = resolveKnownItemKey(requestItemKey);
    const fields = normalizeFieldsOption(options.fields);

    if (
      persistence?.hasAsyncPreload &&
      readResolvedItemState(lookupItemKey) === undefined
    ) {
      await persistence.preloadItems([requestItemKey]);
    }

    const result = await getOrCreateItemScheduler(
      lookupItemKey,
      itemPayload,
    ).awaitFetch(
      requestItemKey,
      { payload: itemPayload, fields },
      { timeoutMs: options.timeoutMs },
    );

    if (result === 'timeout') {
      return { data: null, error: new TimeoutStoreError() };
    }

    if (result === true) {
      return { data: null, error: new AbortedStoreError() };
    }

    let itemState = readResolvedItemState(requestItemKey);

    if (itemState?.itemQuery?.error?.id === 'offline') {
      const hydratedItem = persistence?.readHydratedItem(requestItemKey);

      if (hydratedItem) {
        const resolvedItemKey = resolveKnownItemKey(requestItemKey);
        itemState = {
          item: hydratedItem.item,
          itemQuery: hydratedItem.itemQuery,
          loadedFields: hydratedItem.loadedFields,
        };
        store.produceState(
          (draft) => {
            draft.items[resolvedItemKey] = hydratedItem.item;
            draft.itemQueries[resolvedItemKey] = hydratedItem.itemQuery;
            draft.itemLoadedFields[resolvedItemKey] = hydratedItem.loadedFields;
          },
          { action: 'persistent-storage-hydrate' },
        );
      }
    }

    const item = itemState?.item;
    const itemQuery = itemState?.itemQuery;

    if (itemQuery?.error) {
      return {
        data: null,
        error: new StoreFetchError(itemQuery.error, 'fetch'),
      };
    }

    if (!itemQuery || !item) {
      return { data: null, error: new NotFoundStoreError() };
    }

    return { data: item, error: null };
  }

  if (resolvedPersistentStorageConfig && resolvedOfflineConfig) {
    offlineController = createOfflineStoreController<ResolvedOfflineOperations>(
      {
        storeName: id,
        storeType: 'listQuery',
        getSessionKey: getSessionKeyForRuntime,
        onPersistentStorageError:
          resolvedPersistentStorageConfig.onPersistentStorageError,
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
                entityKey: getLookupItemKey(
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
            const tempItemKey = getLookupItemKey(tempPayload);
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
            const finalItemKey = getLookupItemKey(finalPayload);
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
    if (
      resolveKnownItemKey(itemKey) === itemKey &&
      store.state.items[itemKey] === undefined &&
      store.state.itemQueries[itemKey] === undefined
    ) {
      itemAliasRegistry.clearCanonicalAliases(itemKey);
    }
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

  function getCanonicalAliasPayloads(
    canonicalItemKey: string,
    extraAliasPayloads: readonly ItemPayload[] = [],
  ): ItemPayload[] {
    const aliasPayloadsByKey = new Map<string, ItemPayload>();

    for (const aliasPayload of [
      ...itemAliasRegistry.getAliasPayloads(canonicalItemKey),
      ...extraAliasPayloads,
    ]) {
      const aliasItemKey = getRawItemKey(aliasPayload);
      if (aliasItemKey === canonicalItemKey) continue;
      if (!aliasPayloadsByKey.has(aliasItemKey)) {
        aliasPayloadsByKey.set(aliasItemKey, aliasPayload);
      }
    }

    return [...aliasPayloadsByKey.values()];
  }

  function setCanonicalItemAliases(
    canonicalItemKey: string,
    aliasPayloads: readonly ItemPayload[],
  ): ItemPayload[] {
    const nextAliasPayloads = getCanonicalAliasPayloads(
      canonicalItemKey,
      aliasPayloads,
    );
    itemAliasRegistry.setCanonicalAliases(canonicalItemKey, nextAliasPayloads);
    return nextAliasPayloads;
  }

  function rewriteQueryMemberships(
    draft: State,
    itemKeyRewrites: ReadonlyMap<string, string>,
    affectedQueryKeys: Set<string>,
  ): void {
    if (itemKeyRewrites.size === 0) return;

    for (const [queryKey, query] of Object.entries(draft.queries)) {
      let didChange = false;
      const dedupedItems: string[] = [];
      const seenItemKeys = new Set<string>();

      for (const itemKey of query.items) {
        const rewrittenItemKey = itemKeyRewrites.get(itemKey) ?? itemKey;
        if (rewrittenItemKey !== itemKey) {
          didChange = true;
        }
        if (seenItemKeys.has(rewrittenItemKey)) {
          didChange = true;
          continue;
        }
        seenItemKeys.add(rewrittenItemKey);
        dedupedItems.push(rewrittenItemKey);
      }

      if (!didChange) continue;

      query.items = dedupedItems;
      affectedQueryKeys.add(queryKey);
    }
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

  function applyRemoteItemSnapshot(
    message: Extract<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
      { kind: 'list-item-snapshot' }
    >,
  ): void {
    if (message.item !== null && message.itemQuery !== null) {
      setCanonicalItemAliases(message.itemKey, message.aliasPayloads ?? []);
    } else if (resolveKnownItemKey(message.itemKey) === message.itemKey) {
      itemAliasRegistry.clearCanonicalAliases(message.itemKey);
    }

    const payloadToCleanup = store.state.itemQueries[message.itemKey]?.payload;

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
    for (const item of message.items) {
      if (item.itemQuery === null) continue;
      setCanonicalItemAliases(item.itemKey, item.aliasPayloads ?? []);
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
      for (const localItemKey of getKnownLocalItemSnapshotKeys({
        itemKey: item.itemKey,
        aliasPayloads: item.aliasPayloads,
      })) {
        const localItemQuery = store.state.itemQueries[localItemKey];
        if (!localItemQuery) continue;

        if (
          getOrCreateItemScheduler(
            localItemKey,
            localItemQuery.payload,
          ).isMutationInProgress(localItemKey)
        ) {
          return true;
        }
      }
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

      const localItemKeys = getKnownLocalItemSnapshotKeys({
        itemKey: message.itemKey,
        aliasPayloads: message.aliasPayloads,
      });
      if (localItemKeys.length === 0) {
        lastItemSyncVersions.set(message.itemKey, candidateVersion);
        return;
      }

      if (message.consistency === 'confirmed') {
        const hasMutatingLocalItem = localItemKeys.some((localItemKey) => {
          const localItemQuery = store.state.itemQueries[localItemKey];
          if (!localItemQuery) return false;

          return getOrCreateItemScheduler(
            localItemKey,
            localItemQuery.payload,
          ).isMutationInProgress(localItemKey);
        });

        if (hasMutatingLocalItem) {
          lastItemSyncVersions.set(message.itemKey, candidateVersion);
          return;
        }
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
    if (!localQuery) {
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
      getWindowIsFocused,
      onWindowFocusChange: testOptions?.onWindowFocusChange,
      priorityTimings:
        testOptions?.browserTabsPriorityTimings ??
        testOptions?.browserTabsLeadershipTimings,
    }));

  const useMultipleListQueries: UseMultipleListQueriesApi =
    function useMultipleListQueries<
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
          state: Record<
            string,
            ListQueryOfflineOverlay<ItemState, ItemPayload>
          >,
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
                payloads.map((payload) =>
                  derivedQueries.getQueryGroup(payload),
                ),
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
      ...args: HasPR extends true
        ? [
            options: UseListQueryOptions<
              ItemState,
              ItemPayload,
              SelectedItem
            > & { fields: FieldsInput },
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

  const useMultipleItems: UseMultipleItemsApi = function useMultipleItems<
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
      getLookupItemKey,
      registerActiveStandaloneItems,
      touchItems,
      scheduleAutomaticItemFetch,
      persistence
        ? (payloads) =>
            persistence.maybeHydrateItems(
              payloads.map((payload) => getLookupItemKey(payload)),
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
      ...args: HasPR extends true
        ? [
            options: UseItemOptions<ItemState, Selected> & {
              fields: FieldsInput;
            },
          ]
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
  const usePendingOfflineItems: UsePendingOfflineItemsApi =
    function usePendingOfflineItems<SelectedItem = ItemState>(
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
          state: Record<
            string,
            ListQueryOfflineOverlay<ItemState, ItemPayload>
          >,
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
    revalidateOnWindowFocus,
    usesRealTimeUpdates,
    transportReconnectCooldownMs,
    getWindowIsFocused,
    onWindowFocus: testOptions?.onWindowFocus ?? onWindowFocusDefault,
    onWindowFocusRevalidate: () => {
      invalidateQueryAndItems({
        queryPayload: () => true,
        itemPayload: () => true,
        type: 'lowPriority',
      });
    },
    onTransportReconnectRevalidate: () => {
      invalidateQueryAndItems({
        queryPayload: () => true,
        itemPayload: () => true,
        type: 'realtimeUpdate',
      });
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
    itemAliasRegistry.clearAll();
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
    itemAliasRegistry.clearAll();
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
    ...args: HasPR extends true
      ? [size: number | undefined, options: ScheduleFetchWithFieldsOption]
      : [size?: number, options?: ScheduleFetchWithFieldsOption]
  ): ScheduleFetchResults;
  function scheduleListQueryFetchApiImpl(
    fetchType: FetchType,
    payload: QueryPayload[],
    ...args: HasPR extends true
      ? [size: number | undefined, options: ScheduleFetchWithFieldsOption]
      : [size?: number, options?: ScheduleFetchWithFieldsOption]
  ): ScheduleFetchResults[];
  function scheduleListQueryFetchApiImpl(
    fetchType: FetchType,
    payload: QueryPayload | QueryPayload[],
    ...args: [size?: number, options?: ScheduleFetchWithFieldsOption]
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const [size, options] = args;
    if (Array.isArray(payload)) {
      return scheduleListQueryFetch(fetchType, payload, size, options);
    }
    return scheduleListQueryFetch(fetchType, payload, size, options);
  }

  const scheduleListQueryFetchApi: ScheduleListQueryFetchApi =
    scheduleListQueryFetchApiImpl;

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
    ...args: HasPR extends true
      ?
          | [size: number, options: FetchFieldsOption]
          | [options: LoadMoreWithFieldsOptions]
      :
          | [size?: number, options?: FetchFieldsOption]
          | [options?: LoadMoreWithFieldsOptions]
  ): ScheduleFetchResults {
    if (typeof args[0] === 'number') {
      return loadMore(params, args[0], args[1]);
    }
    return loadMore(params, args[0]);
  }

  const loadMoreApi: LoadMoreApi = loadMoreApiImpl;

  function scheduleItemFetchApiImpl(
    fetchType: FetchType,
    itemPayload: ItemPayload,
    ...args: HasPR extends true
      ? [options: ScheduleFetchWithFieldsOption]
      : [options?: ScheduleFetchWithFieldsOption]
  ): ScheduleFetchResults;
  function scheduleItemFetchApiImpl(
    fetchType: FetchType,
    itemPayload: ItemPayload[],
    ...args: HasPR extends true
      ? [options: ScheduleFetchWithFieldsOption]
      : [options?: ScheduleFetchWithFieldsOption]
  ): ScheduleFetchResults[];
  function scheduleItemFetchApiImpl(
    fetchType: FetchType,
    itemPayload: ItemPayload | ItemPayload[],
    ...args: [options?: ScheduleFetchWithFieldsOption]
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const [options] = args;
    if (Array.isArray(itemPayload)) {
      return scheduleItemFetch(fetchType, itemPayload, options);
    }
    return scheduleItemFetch(fetchType, itemPayload, options);
  }

  const scheduleItemFetchApi: ScheduleItemFetchApi = scheduleItemFetchApiImpl;

  function scheduleAutomaticItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload,
    options?: { fields?: FieldsInput },
  ): ScheduleFetchResults {
    const requestItemKey = getItemKey(itemPayload);
    const lookupItemKey = resolveKnownItemKey(requestItemKey);
    const scheduler = getOrCreateItemScheduler(lookupItemKey, itemPayload);
    const fields = normalizeFieldsOption(options?.fields);

    return scheduler.scheduleFetch(requestItemKey, fetchType, {
      payload: itemPayload,
      fields,
    });
  }

  const awaitListQueryFetchApi: AwaitListQueryFetchApi = (params, ...args) => {
    const [options] = args;
    return awaitListQueryFetch(params, options);
  };

  const awaitItemFetchApi: AwaitItemFetchApi = (itemPayload, ...args) => {
    const [options] = args;
    return awaitItemFetch(itemPayload, options);
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
    const itemEntries = getMutationItemEntries(itemIds);
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
    addItemToStateBase(getResolvedItemPayload(itemPayload), data, options);
    touchUpdatedItemEntries([
      { itemKey: getLookupItemKey(itemPayload), payload: itemPayload },
    ]);
  }

  function deleteItemState(
    itemId: Parameters<typeof deleteItemStateBase>[0],
  ): void {
    const itemEntries = getMutationItemEntries(itemId);
    const relatedQueryKeys = getRelatedQueryKeysForItemEntries(itemEntries);

    deleteItemStateBase(itemId);

    for (const { itemKey } of itemEntries) {
      cleanupItemStateMetadata(itemKey);
    }
    touchQueries(relatedQueryKeys);
  }

  const performMutation: typeof performMutationBase = (payload, args) => {
    return performMutationBase(payload, args);
  };

  let isDisposed = false;
  const unregisterStoreFromManager = registerStoreWithManager(storeManager, {
    id,
    reset,
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
    preloadQueryFromStorage: preloadQueryFromPersistentStorage,
    loadMore: loadMoreApi,
    getItemKey,
    getItemState,
    usePendingOfflineItems,
    getOfflineEntities: () => offlineController?.getOfflineEntities() ?? [],
    useOfflineEntities: () => {
      return useOfflineStoreEntities({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      });
    },
    useOfflineResolutions: () => {
      return useOfflineStoreResolutions({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      });
    },
    getOfflineResolutions: () =>
      offlineController?.getOfflineResolutions() ?? [],
    parseOfflineResolutionConflict: <
      TName extends keyof ResolvedOfflineOperations & string,
    >(
      resolution: OfflineResolutionRecordForOperation<
        ResolvedOfflineOperations,
        TName
      >,
    ): ParsedOfflineResolutionConflictResultForOperation<
      ResolvedOfflineOperations,
      TName
    > =>
      offlineController?.parseOfflineResolutionConflict(resolution) ??
      Result.err(
        new OfflineResolutionConflictParseError({
          code: 'offline-not-configured',
          operation: resolution.operation,
        }),
      ),
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
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    performMutation,
    useMultipleListQueries,
    useListQuery,
    useMultipleItems,
    useItem,
    useFindItem,
    onTransportReconnect,
  };
}
