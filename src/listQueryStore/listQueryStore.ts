import { isWindowFocused, onWindowFocus } from '@ls-stack/browser-utils/window';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { evtmitter } from 'evtmitter';
import { Store } from 't-state';
import {
  FetchType,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
import { type BlockWindowCloseHandler } from '../utils/performMutation';
import {
  StoreError,
  StoreFetchError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
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

type ListQueryStoreOptionsBase<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends boolean = false,
> = {
  debugName?: string;
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
  };
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  backgroundCoalescingWindowMultiplier: number;
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
    backgroundCoalescingWindowMultiplier,
    optimisticListUpdates,
    onInvalidateQuery,
    onInvalidateItem,
    onSchedulerEvent,
    onMutationError,
    blockWindowClose,
    getQueryKey: customGetQueryKey,
    getItemKey: customGetItemKey,
    partialResources,
  } = storeOptions;

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

      return initialState;
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

  const events = evtmitter<ListQueryStoreEvents>();

  const wrappedDynamicRealtimeThrottleMs = dynamicRealtimeThrottleMs
    ? (lastFetchDuration: number) =>
        dynamicRealtimeThrottleMs({
          lastFetchDuration,
          windowIsNotFocused: !isWindowFocused(),
        })
    : undefined;

  const getCoalescingWindowMultiplier = (): number =>
    !isWindowFocused() ? backgroundCoalescingWindowMultiplier : 1;

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
    baseCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
    getCoalescingWindowMultiplier,
    onSchedulerEvent,
    usesRealTimeUpdates,
    defaultQuerySize,
    maxItemBatchSize,
    getQueryKey,
    getItemKey,
    normalizeFieldsOption,
    testInitialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
    noFetchItemFnError,
  });

  const {
    storeEvents,
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    resetInvalidationTracking,
    performMutation,
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
  });
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
        scheduleListQueryFetch,
        queryInvalidationWasTriggered,
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
      scheduleItemFetch,
      itemInvalidationWasTriggered,
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

  // Set up window focus listener for non-realtime stores
  let cleanupFocusListener: (() => void) | null = null;

  function setupFocusListener() {
    cleanupFocusListener?.();
    cleanupFocusListener = null;

    if (!revalidateOnWindowFocus || usesRealTimeUpdates) return;

    cleanupFocusListener = onWindowFocus(() => {
      const enabled =
        typeof revalidateOnWindowFocus === 'function'
          ? revalidateOnWindowFocus()
          : revalidateOnWindowFocus;

      if (enabled) {
        invalidateQueryAndItems({
          queryPayload: () => true,
          itemPayload: () => true,
          type: 'lowPriority',
        });
      }
    });
  }

  setupFocusListener();

  function reset() {
    resetSchedulers();
    resetInvalidationTracking();

    store.setState({
      items: {},
      queries: {},
      itemQueries: {},
      itemLoadedFields: {},
      itemFieldInvalidationFields: {},
    });
    setupFocusListener();
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
    loadMore: loadMoreApi,
    getItemKey,
    getItemState,
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
  };
}
