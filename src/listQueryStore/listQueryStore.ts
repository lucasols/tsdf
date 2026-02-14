import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { Store } from 't-state';
import {
  FetchType,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
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
  TPartialResources extends PartialResourcesConfig<ItemState> | undefined =
    undefined,
> = ReturnType<
  typeof createListQueryStore<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  >
>;

const noFetchItemFnError = 'No fetchItemFn was provided';
const noPartialResourcesFieldsOptionError =
  'fields option is required when partialResources is enabled';

export type ListQueryStoreOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends PartialResourcesConfig<ItemState> | undefined =
    undefined,
> = {
  debugName?: string;
  fetchListFn: (
    payload: QueryPayload,
    size: number,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<FetchListFnReturn<ItemState, ItemPayload>>;
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
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
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
  getQueryKey?: (params: QueryPayload) => ValidPayload | unknown[];
  getItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  partialResources?: TPartialResources;
};

export function createListQueryStore<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TPartialResources extends PartialResourcesConfig<ItemState> | undefined =
    undefined,
>({
  debugName,
  fetchListFn,
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
  optimisticListUpdates,
  onInvalidateQuery,
  onInvalidateItem,
  onSchedulerEvent,
  onMutationError,
  getQueryKey: customGetQueryKey,
  getItemKey: customGetItemKey,
  partialResources,
}: ListQueryStoreOptions<
  ItemState,
  QueryPayload,
  ItemPayload,
  TPartialResources
>) {
  type HasPR = [TPartialResources] extends [undefined] ? false : true;
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

  type LoadMoreApi = HasPR extends true
    ? {
        (
          params: QueryPayload,
          size: number,
          options: FetchFieldsOption,
        ): ScheduleFetchResults;
        (
          params: QueryPayload,
          options: LoadMoreWithFieldsOptions,
        ): ScheduleFetchResults;
      }
    : {
        (
          params: QueryPayload,
          size?: number,
          options?: FetchFieldsOption,
        ): ScheduleFetchResults;
        (
          params: QueryPayload,
          options?: LoadMoreWithFieldsOptions,
        ): ScheduleFetchResults;
      };

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
    resetSchedulers,
  } = createFetchApi<ItemState, QueryPayload, ItemPayload, TPartialResources>({
    store,
    fetchListFn,
    fetchItemFn,
    batchFetchItemFn,
    getItemsBatchKey,
    errorNormalizer,
    partialResources,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs,
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
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    performMutation,
  } = createMutationApi<
    ItemState,
    QueryPayload,
    ItemPayload,
    TPartialResources
  >({
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
    emitInvalidateQuery: (event) => {
      events.emit('invalidateQuery', event);
    },
    emitInvalidateItem: (event) => {
      events.emit('invalidateItem', event);
    },
    blockWindowClose,
  });
  const useMultipleListQueries: {
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
  } = __LEGIT_CAST__(function useMultipleListQueries<
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
  });

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
    ): TSFDUseListQueryReturn<SelectedItem, QueryPayload>;
  } = function useListQuery<SelectedItem = ItemState>(
    payload: QueryPayload | false | null | undefined,
    options: UseListQueryOptions<ItemState, ItemPayload, SelectedItem> = {},
  ): TSFDUseListQueryReturn<SelectedItem, QueryPayload> {
    return useListQueryHook<ItemState, QueryPayload, ItemPayload, SelectedItem>(
      payload,
      options,
      store,
      getQueryKey,
      scheduleListQueryFetch,
      useMultipleListQueries,
    );
  };

  const useMultipleItems: {
    <
      Selected = ItemState | null,
      QueryMetadata extends undefined | Record<string, unknown> = undefined,
    >(
      items: (ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata> &
        FieldsOption<HasPR>)[],
      options?: UseMultipleItemsOptions<ItemState, Selected>,
    ): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[];
  } = function useMultipleItems<
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

  function reset() {
    resetSchedulers();

    store.setState({
      items: {},
      queries: {},
      itemQueries: {},
      itemLoadedFields: {},
      itemFieldInvalidationFields: {},
    });
  }

  const scheduleListQueryFetchApi: ScheduleListQueryFetchApi =
    scheduleListQueryFetch;
  const loadMoreApi: LoadMoreApi = loadMore;
  const scheduleItemFetchApi: ScheduleItemFetchApi = scheduleItemFetch;
  const awaitListQueryFetchApi: AwaitListQueryFetchApi = awaitListQueryFetch;
  const awaitItemFetchApi: AwaitItemFetchApi = awaitItemFetch;

  return {
    store,
    events,
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

function blockWindowClose() {
  return {
    unblock: () => {
      // FIX: Implement unblock
    },
  };
}
