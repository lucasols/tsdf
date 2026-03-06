import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { evtmitter } from 'evtmitter';
import { Store } from 't-state';
import {
  FetchType,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
import {
  createBrowserTabsPriority,
  type BrowserTabsPriorityTimings,
  type BrowserTabsTabStatusMessage,
} from '../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinator,
  createBrowserTabsCoordinatorWithPriority,
  type BrowserTabsMessageMeta,
  type BrowserTabsSyncVersion,
  type BrowserTabsTransportFactory,
  isBrowserTabsSyncVersionNewer,
  type SnapshotConsistency,
  toBrowserTabsSyncVersion,
} from '../utils/browserTabsSync';
import { type BlockWindowCloseHandler } from '../utils/performMutation';
import { createStoreFocusLifecycle } from '../utils/storeFocusLifecycle';
import {
  StoreError,
  StoreFetchError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { setupListQueryPersistence } from '../persistentStorage/listQueryStorePersistence';
import type {
  ListQueryPersistentStorageConfig,
  StorageAdapter,
} from '../persistentStorage/types';
import { createFetchApi } from './createFetchApi';
import { createMutationApi } from './createMutationApi';
import {
  type FetchListFnReturn,
  type FieldsInput,
  type FieldsOption,
  type ListQueryStoreInitialData,
  type ListQueryUseMultipleItemsQuery,
  type ListQueryUseMultipleListQueriesQuery,
  type OffsetPaginationConfig,
  type OnListQueryInvalidate,
  type OnListQueryItemInvalidate,
  type OptimisticListUpdate,
  type PartialResourcesConfig,
  type TSFDListQueryState,
  type TSDFItemQuery,
  type TSFDListQuery,
  type TSFDUseListItemReturn,
  type TSFDUseListQueryReturn,
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
> = ReturnType<
  typeof createListQueryStore<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources,
    TOffsetPagination
  >
>;

const noFetchItemFnError = 'No fetchItemFn was provided';
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
> = {
  debugName?: string;
  /** Stable id shared by the same logical list-query store across browser tabs. */
  id: string;
  /**
   * Returns the current authenticated session / tenant key used to scope
   * browser-tabs sync. Return `false` to disable browser-tabs sync when no
   * account is loaded.
   */
  getSessionKey: () => string | false;
  fetchItemFn?: (
    payload: ItemPayload,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<ItemState>;
  batchFetchItemFn?: (
    requests: { payload: ItemPayload; fields?: string[] }[],
    options: { signal: AbortSignal; batchKey: string },
  ) => Promise<Map<ItemPayload, ItemState | Error>>;
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  errorNormalizer: (exception: Error) => StoreError;
  defaultQuerySize?: number;
  maxItemBatchSize?: number;
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
    storageAdapter?: StorageAdapter;
  };
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  optimisticListUpdates?: OptimisticListUpdate<
    ItemState,
    QueryPayload,
    ItemPayload
  >[];
  onInvalidateQuery?: OnListQueryInvalidate<QueryPayload>;
  onInvalidateItem?: OnListQueryItemInvalidate<ItemState, ItemPayload>;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { silentErrors?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  getQueryKey?: (params: QueryPayload) => ValidPayload | unknown[];
  getItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  /** Opt-in persistent storage configuration. When provided, cached items and queries
   * are loaded from storage on first read and saved back on successful fetches.
   * Session scoping always reuses this store's `getSessionKey`. */
  persistentStorage?: ListQueryPersistentStorageConfig<ItemState>;
} & ([TPartialResources] extends [true]
  ? { partialResources: PartialResourcesConfig<ItemState> }
  : { partialResources?: undefined });

export type ListQueryStoreOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean = false,
  TOffsetPagination extends boolean = false,
> = ListQueryStoreOptionsBase<
  ItemState,
  QueryPayload,
  ItemPayload,
  TPartialResources
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
>(
  storeOptions: ListQueryStoreOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources,
    TOffsetPagination
  >,
) {
  const {
    debugName,
    id,
    getSessionKey,
    fetchItemFn,
    batchFetchItemFn,
    getItemsBatchKey,
    errorNormalizer,
    defaultQuerySize = 50,
    maxItemBatchSize,
    usesRealTimeUpdates = false,
    '~test': testOptions,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    optimisticListUpdates,
    onInvalidateQuery,
    onInvalidateItem,
    onSchedulerEvent,
    onMutationError,
    blockWindowClose,
    getQueryKey: customGetQueryKey,
    getItemKey: customGetItemKey,
    partialResources,
    persistentStorage: persistentStorageConfig,
  } = storeOptions;

  let remoteApplyDepth = 0;
  let currentBroadcastConsistency: SnapshotConsistency = 'confirmed';
  const lastQuerySyncVersions = new Map<string, BrowserTabsSyncVersion>();
  const lastItemSyncVersions = new Map<string, BrowserTabsSyncVersion>();

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
  type AwaitItemFetchOptions = {
    timeoutMs?: number;
  } & FetchFieldsOption;
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

  const globalDisableRefetchOnMount = usesRealTimeUpdates;

  // Persistent storage setup
  const persistence = persistentStorageConfig
    ? setupListQueryPersistence<ItemState, QueryPayload, ItemPayload>(
        {
          ...persistentStorageConfig,
          getSessionKey,
        },
        { adapter: testOptions?.storageAdapter },
      )
    : null;

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
    if (!getItemsBatchKey) return '__default__';
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

  async function preloadQueryFromPersistentStorage(
    payload: QueryPayload | QueryPayload[],
  ): Promise<void> {
    if (!persistence?.hasAsyncPreload) {
      persistentStorageConfig?.onPersistentStorageError?.(
        new Error('Async preload is not available'),
      );
      return;
    }

    const payloads = Array.isArray(payload) ? payload : [payload];
    await persistence.preloadQueries(
      payloads.map((queryPayload) => getQueryKey(queryPayload)),
    );
  }

  async function preloadItemFromPersistentStorage(
    payload: ItemPayload | ItemPayload[],
  ): Promise<void> {
    if (!persistence?.hasAsyncPreload) {
      persistentStorageConfig?.onPersistentStorageError?.(
        new Error('Async preload is not available'),
      );
      return;
    }

    const payloads = Array.isArray(payload) ? payload : [payload];
    await persistence.preloadItems(
      payloads.map((itemPayload) => getItemKey(itemPayload)),
    );
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
    scheduleItemFetch,
    awaitItemFetch,
    getOrCreateQueryScheduler,
    getOrCreateItemScheduler,
    syncRemoteFetchStart,
    syncRemoteFetchSuccess,
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
    preloadQueries: persistence?.hasAsyncPreload
      ? (queryKeys) => persistence.preloadQueries(queryKeys)
      : undefined,
    preloadItems: persistence?.hasAsyncPreload
      ? (itemKeys) => persistence.preloadItems(itemKeys)
      : undefined,
    testInitialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
    noFetchItemFnError,
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
        .map((request) => ({
          itemKey: request.requestId,
        }));
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
    updateItemState,
    addItemToState,
    deleteItemState,
    resetInvalidationTracking,
    performMutation: performMutationBase,
  } = createMutationApi<ItemState, QueryPayload, ItemPayload>({
    store,
    fetchItemFn,
    partialResources,
    optimisticListUpdates,
    onInvalidateQuery,
    onInvalidateItem,
    onMutationError,
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
    runWithBroadcastConsistency,
    publishQuerySnapshot,
    publishItemSnapshot,
  });

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

    const remainingFields = invalidationFields.filter(
      (field) => !loadedFields.includes(field),
    );

    if (remainingFields.length > 0) {
      draft.itemFieldInvalidationFields[itemKey] = remainingFields;
    } else {
      delete draft.itemFieldInvalidationFields[itemKey];
    }
  }

  function pruneItemInvalidationTracking(): void {
    for (const [itemKey, pendingFields] of itemPendingInvalidationFields) {
      const loadedFields = store.state.itemLoadedFields[itemKey] ?? [];
      const remainingFields = pendingFields.filter(
        (field) => !loadedFields.includes(field),
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
      itemFieldInvalidationPriorities.delete(message.itemKey);
      itemPendingInvalidationFields.delete(message.itemKey);
    }
    pruneItemInvalidationTracking();
    if (message.item === null && message.itemQuery === null) {
      if (payloadToCleanup) {
        deleteItemFetchResources([
          { itemKey: message.itemKey, payload: payloadToCleanup },
        ]);
      }
    }
  }

  function applyRemoteQuerySnapshot(
    message: Extract<
      ListQueryBrowserTabsMessage<ItemState, QueryPayload, ItemPayload>,
      { kind: 'list-query-snapshot' }
    >,
  ): void {
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

      if (
        getOrCreateItemScheduler(
          item.itemKey,
          localItemQuery.payload,
        ).isMutationInProgress(item.itemKey)
      ) {
        return true;
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

      const localItemQuery = store.state.itemQueries[message.itemKey];
      if (localItemQuery === undefined) {
        lastItemSyncVersions.set(message.itemKey, candidateVersion);
        return;
      }

      if (
        message.consistency === 'confirmed' &&
        localItemQuery !== null &&
        getOrCreateItemScheduler(
          message.itemKey,
          localItemQuery.payload,
        ).isMutationInProgress(message.itemKey)
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
      getSessionKey,
      onMessage: handleRemoteBrowserTabsMessage,
      onSessionChange() {
        lastQuerySyncVersions.clear();
        lastItemSyncVersions.clear();
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
        getQueryState,
        persistence?.hasAsyncPreload
          ? (payloads) =>
              persistence.preloadQueries(
                payloads.map((payload) => getQueryKey(payload)),
              )
          : undefined,
        scheduleAutomaticListQueryFetch,
        queryInvalidationWasTriggered,
        itemFieldInvalidationPriorities,
        itemPendingInvalidationFields,
        globalDisableRefetchOnMount,
        partialResources,
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
            > & {
              fields: FieldsInput;
            },
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
      scheduleAutomaticItemFetch,
      persistence?.hasAsyncPreload
        ? (payloads) =>
            persistence.preloadItems(
              payloads.map((payload) => getItemKey(payload)),
            )
        : undefined,
      itemInvalidationWasTriggered,
      itemFieldInvalidationPriorities,
      itemPendingInvalidationFields,
      globalDisableRefetchOnMount,
      fetchItemFn,
      partialResources,
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
    );
  }

  const focusLifecycle = createStoreFocusLifecycle({
    revalidateOnWindowFocus,
    usesRealTimeUpdates,
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
  persistence?.attach(store);

  /**
   * Signals that the real-time transport (e.g. WebSocket) has reconnected after
   * a disconnection. Events may have been missed during the outage, so all
   * queries and items need to be revalidated.
   *
   * - No-op when `usesRealTimeUpdates` is `false`.
   * - If the window is focused, invalidates all queries and items immediately
   *   with `realtimeUpdate` priority.
   * - If the window is **not** focused, defers invalidation until the next
   *   window focus event. Multiple calls while unfocused are coalesced (only
   *   one invalidation fires on focus).
   */
  function onTransportReconnect(): void {
    focusLifecycle.onTransportReconnect();
  }

  function reset() {
    resetSchedulers();
    resetInvalidationTracking();
    lastQuerySyncVersions.clear();
    lastItemSyncVersions.clear();
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
    const itemKey = getItemKey(itemPayload);
    const scheduler = getOrCreateItemScheduler(itemKey, itemPayload);
    const fields = normalizeFieldsOption(options?.fields);

    return scheduler.scheduleFetch(itemKey, fetchType, {
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
    scheduleListQueryFetch: scheduleListQueryFetchApi,
    getQueryState,
    getQueryKey,
    getQueriesState,
    getQueriesRelatedToItem,
    awaitListQueryFetch: awaitListQueryFetchApi,
    preloadQueryFromPersistentStorage,
    loadMore: loadMoreApi,
    getItemKey,
    getItemState,
    preloadItemFromPersistentStorage,
    scheduleItemFetch: scheduleItemFetchApi,
    awaitItemFetch: awaitItemFetchApi,
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
