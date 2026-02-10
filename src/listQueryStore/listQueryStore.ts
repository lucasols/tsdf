import { filterAndMap, sortBy } from '@ls-stack/utils/arrayUtils';
import { awaitDebounce } from '@ls-stack/utils/awaitDebounce';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { Result, unknownToError } from 't-result';
import { Store } from 't-state';
import {
  BatchRequest,
  FetchContext,
  FetchType,
  RequestScheduler,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
import {
  fetchTypePriority,
  StoreError,
  StoreFetchError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { executeItemBatchFetch } from './executeItemBatchFetch';
import { executeQueryFetch } from './executeQueryFetch';
import {
  type FetchListFnReturn,
  type FieldsOption,
  type ListQueryStoreInitialData,
  type ListQueryUseMultipleItemsQuery,
  type ListQueryUseMultipleListQueriesQuery,
  type OnListQueryInvalidate,
  type OnListQueryItemInvalidate,
  type OptimisticListUpdate,
  type PartialResourcesConfig,
  type QueryFetchPayload,
  type TSFDListQuery,
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
  invalidateItem: { priority: FetchType; itemKey: string };
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
    options: { signal: AbortSignal },
  ) => Promise<Map<ItemPayload, ItemState | Error>>;
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
  type Query = TSFDListQuery<QueryPayload>;

  const globalDisableRefetchOnMount = usesRealTimeUpdates;

  const store = new Store<State>({
    debugName,
    state: () => {
      const initialState: State = {
        items: {},
        queries: {},
        itemQueries: {},
        itemLoadedFields: {},
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

  const querySchedulers = new Map<
    string,
    RequestScheduler<QueryFetchPayload<QueryPayload>>
  >();
  const queryInitialFetchStartTime = new Map<string, number>();
  const lastQueryFields = new Map<string, string[] | undefined>();

  if (
    import.meta.env.TEST
    && testOptions?.initialLastFetchStartTime !== undefined
  ) {
    for (const queryKey of Object.keys(store.state.queries)) {
      queryInitialFetchStartTime.set(
        queryKey,
        testOptions.initialLastFetchStartTime,
      );
    }
  }

  function getOrCreateQueryScheduler(
    queryKey: string,
  ): RequestScheduler<QueryFetchPayload<QueryPayload>> {
    let scheduler = querySchedulers.get(queryKey);
    if (!scheduler) {
      const initialLastFetchStartTime =
        queryInitialFetchStartTime.get(queryKey);
      if (initialLastFetchStartTime !== undefined) {
        queryInitialFetchStartTime.delete(queryKey);
      }

      scheduler = new RequestScheduler<QueryFetchPayload<QueryPayload>>({
        fetchFn: async (
          requests: BatchRequest<QueryFetchPayload<QueryPayload>>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          return executeQueryFetch(
            requests,
            fetchCtx,
            store,
            fetchListFn,
            errorNormalizer,
            getItemKey,
            updateItemSchedulerTiming,
            partialResources,
          );
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime,
        coalescePayload: (existing, incoming) => ({
          ...incoming,
          type:
            existing.type === 'loadMore' || incoming.type === 'loadMore' ?
              'loadMore'
            : 'load',
          size: Math.max(existing.size, incoming.size),
        }),
        usesRealTimeUpdates,
      });
      querySchedulers.set(queryKey, scheduler);
    }
    return scheduler;
  }

  const itemKeyToPayload = new Map<string, ItemPayload>();

  type ItemFetchData = { payload: ItemPayload; fields?: string[] };

  function coalesceItemFetchPayload(
    existing: ItemFetchData,
    incoming: ItemFetchData,
  ) {
    // If either request asks for all fields, keep "all fields".
    if (!existing.fields || !incoming.fields) {
      return { payload: incoming.payload, fields: undefined };
    }

    return {
      payload: incoming.payload,
      fields: Array.from(
        new Set([...existing.fields, ...incoming.fields]),
      ).sort(),
    };
  }

  const useSingleItemScheduler = !!batchFetchItemFn;

  const singleItemScheduler =
    useSingleItemScheduler && fetchItemFn ?
      new RequestScheduler<ItemFetchData>({
        fetchFn: async (
          requests: BatchRequest<ItemFetchData>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          return executeItemBatchFetch(
            requests,
            fetchCtx,
            store,
            itemKeyToPayload,
            fetchItemFn,
            batchFetchItemFn,
            errorNormalizer,
            partialResources,
          );
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        maxBatchSize: maxItemBatchSize,
        on: onSchedulerEvent,
        coalescePayload: coalesceItemFetchPayload,
        usesRealTimeUpdates,
      })
    : null;

  const perItemSchedulers = new Map<string, RequestScheduler<ItemFetchData>>();
  const itemInitialFetchStartTime = new Map<string, number>();

  if (
    import.meta.env.TEST
    && testOptions?.initialLastFetchStartTime !== undefined
  ) {
    for (const itemKey of Object.keys(store.state.itemQueries)) {
      itemInitialFetchStartTime.set(
        itemKey,
        testOptions.initialLastFetchStartTime,
      );
    }
  }

  function getOrCreateItemScheduler(
    itemKey: string,
  ): RequestScheduler<ItemFetchData> {
    if (singleItemScheduler) return singleItemScheduler;

    let scheduler = perItemSchedulers.get(itemKey);
    if (!scheduler) {
      if (!fetchItemFn) {
        throw new Error(noFetchItemFnError);
      }

      const initialLastFetchStartTime = itemInitialFetchStartTime.get(itemKey);
      if (initialLastFetchStartTime !== undefined) {
        itemInitialFetchStartTime.delete(itemKey);
      }

      scheduler = new RequestScheduler<ItemFetchData>({
        fetchFn: async (
          requests: BatchRequest<ItemFetchData>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          return executeItemBatchFetch(
            requests,
            fetchCtx,
            store,
            itemKeyToPayload,
            fetchItemFn,
            undefined,
            errorNormalizer,
            partialResources,
          );
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime,
        coalescePayload: coalesceItemFetchPayload,
        usesRealTimeUpdates,
      });
      perItemSchedulers.set(itemKey, scheduler);
    }
    return scheduler;
  }

  function updateItemSchedulerTiming(itemKey: string, startTime: number) {
    if (!fetchItemFn) return;

    if (singleItemScheduler) {
      singleItemScheduler.setLastFetchStartTime(startTime);
      return;
    }

    const existingScheduler = perItemSchedulers.get(itemKey);
    if (existingScheduler) {
      existingScheduler.setLastFetchStartTime(startTime);
    } else {
      itemInitialFetchStartTime.set(itemKey, startTime);
    }
  }

  function getQueryState(params: QueryPayload): Query | undefined {
    return store.state.queries[getQueryKey(params)];
  }

  type FilterQueryFn = (
    params: QueryPayload,
    data: Query,
    queryKey: string,
  ) => boolean;

  function getQueriesKeyArray(
    payloads: QueryPayload | QueryPayload[] | FilterQueryFn,
  ): { key: string; payload: QueryPayload }[] {
    if (Array.isArray(payloads)) {
      return payloads.map((payload) => ({
        key: getQueryKey(payload),
        payload,
      }));
    } else if (typeof payloads === 'function') {
      return filterAndMap(
        Object.entries(store.state.queries),
        ([queryKey, query]) => {
          return payloads(query.payload, query, queryKey) ?
              { key: queryKey, payload: query.payload }
            : false;
        },
      );
    } else {
      return [{ key: getQueryKey(payloads), payload: payloads }];
    }
  }

  function getQueriesState(
    params: QueryPayload[] | FilterQueryFn,
  ): { query: Query; key: string }[] {
    const queryKeys = getQueriesKeyArray(params);

    return filterAndMap(queryKeys, ({ key }) => {
      const query = store.state.queries[key];
      return query ? { query, key } : false;
    });
  }

  function getQueriesRelatedToItem(
    itemPayload: ItemPayload,
  ): { query: Query; key: string }[] {
    const itemKey = getItemKey(itemPayload);

    return getQueriesState((queryPayload) => {
      const queryState = store.state.queries[getQueryKey(queryPayload)];
      return !!queryState?.items.includes(itemKey);
    });
  }

  type FilterItemFn = (
    itemPayload: ItemPayload,
    itemState: ItemState,
  ) => boolean;
  type MutationPayload =
    | ItemPayload
    | ItemPayload[]
    | FilterItemFn
    | undefined
    | null;
  type MutationPayloadToUse = ItemPayload | ItemPayload[] | FilterItemFn;

  function getItemsKeyArray(
    itemsPayload: ItemPayload | ItemPayload[] | FilterItemFn,
  ): { itemKey: string; payload: ItemPayload }[] {
    if (Array.isArray(itemsPayload)) {
      return itemsPayload.map((payload) => ({
        itemKey: getItemKey(payload),
        payload,
      }));
    }

    if (typeof itemsPayload === 'function') {
      return filterAndMap(
        Object.entries(store.state.items),
        ([itemKey, item]) => {
          const payload = store.state.itemQueries[itemKey]?.payload;

          if (item === null || !payload) return false;

          return itemsPayload(payload, item) ? { itemKey, payload } : false;
        },
      );
    }

    return [{ payload: itemsPayload, itemKey: getItemKey(itemsPayload) }];
  }

  function getItemState(
    itemPayload: ItemPayload[] | FilterItemFn,
  ): { payload: ItemPayload; data: ItemState }[];
  function getItemState(itemPayload: ItemPayload): ItemState | null | undefined;
  function getItemState(
    itemPayload: ItemPayload | ItemPayload[] | FilterItemFn,
  ):
    | ItemState
    | null
    | undefined
    | { payload: ItemPayload; data: ItemState }[] {
    if (typeof itemPayload === 'function' || Array.isArray(itemPayload)) {
      const itemsId = getItemsKeyArray(itemPayload);

      return filterAndMap(itemsId, ({ itemKey }) => {
        const item = store.state.items[itemKey];
        const payload = store.state.itemQueries[itemKey]?.payload;

        return !item || !payload ? false : { payload, data: item };
      });
    }

    return store.state.items[getItemKey(itemPayload)];
  }

  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload,
    size?: number,
    options?: ScheduleFetchOptions & { fields?: string[] },
  ): ScheduleFetchResults;
  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload[],
    size?: number,
    options?: ScheduleFetchOptions & { fields?: string[] },
  ): ScheduleFetchResults[];
  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload | QueryPayload[],
    size?: number,
    options?: ScheduleFetchOptions & { fields?: string[] },
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const multiplePayloads = Array.isArray(payload);
    const payloads = multiplePayloads ? payload : [payload];

    const results = payloads.map((param) => {
      const queryKey = getQueryKey(param);
      const queryState = store.state.queries[queryKey];
      const currentQuerySize = queryState?.items.length ?? 0;
      const querySize = Math.max(currentQuerySize, size ?? defaultQuerySize);

      lastQueryFields.set(queryKey, options?.fields);

      return getOrCreateQueryScheduler(queryKey).scheduleFetch(
        queryKey,
        fetchType,
        {
          type: 'load',
          payload: param,
          size: querySize,
          fields: options?.fields,
        },
        options,
      );
    });

    if (multiplePayloads) return results;

    const firstResult = results[0];
    if (!firstResult) {
      throw new Error('Unexpected empty results array');
    }
    return firstResult;
  }

  function loadMore(params: QueryPayload, size?: number): ScheduleFetchResults {
    const queryState = getQueryState(params);

    if (!queryState || !queryState.hasMore) return 'skipped';
    if (queryState.status !== 'success') return 'skipped';

    const queryKey = getQueryKey(params);
    const loadSize = size ?? defaultQuerySize;
    const newSize = queryState.items.length + loadSize;
    const fields = lastQueryFields.get(queryKey);

    return getOrCreateQueryScheduler(queryKey).scheduleFetch(
      queryKey,
      'highPriority',
      {
        type: 'loadMore',
        payload: params,
        size: newSize,
        fields,
      },
    );
  }

  function getQueryItems<T>(
    query: Query,
    itemDataSelector: (
      data: ItemState,
      itemPayload: ItemPayload,
      itemKey: string,
    ) => T,
  ): T[] {
    return filterAndMap(query.items, (itemKey) => {
      const item = store.state.items[itemKey];
      const itemPayload = store.state.itemQueries[itemKey]?.payload;
      return item && itemPayload ?
          itemDataSelector(item, itemPayload, itemKey)
        : false;
    });
  }

  async function awaitListQueryFetch(
    params: QueryPayload,
    options: { size?: number; timeoutMs?: number } = {},
  ): Promise<
    | { items: []; error: StoreFetchError; hasMore: boolean }
    | {
        items: { data: ItemState; itemPayload: ItemPayload }[];
        error: null;
        hasMore: boolean;
      }
  > {
    const queryKey = getQueryKey(params);
    const size = options.size ?? defaultQuerySize;

    const result = await getOrCreateQueryScheduler(queryKey).awaitFetch(
      queryKey,
      { type: 'load', payload: params, size },
      { timeoutMs: options.timeoutMs },
    );

    if (result === 'timeout') {
      return {
        items: [],
        error: new StoreFetchError(
          { code: 408, id: 'timeout', message: 'Timeout' },
          'timeout',
        ),
        hasMore: false,
      };
    }

    if (result === true) {
      return {
        items: [],
        error: new StoreFetchError(
          { code: 408, id: 'aborted', message: 'Aborted' },
          'aborted',
        ),
        hasMore: false,
      };
    }

    const query = store.state.queries[queryKey];

    if (query?.error) {
      return {
        items: [],
        error: new StoreFetchError(query.error, 'fetch'),
        hasMore: query.hasMore,
      };
    }

    if (!query) {
      return {
        items: [],
        error: new StoreFetchError(
          { code: 404, id: 'not-found', message: 'Not found' },
          'fetch',
        ),
        hasMore: false,
      };
    }

    return {
      items: getQueryItems(query, (data, itemPayload) => ({
        data,
        itemPayload,
      })),
      error: null,
      hasMore: query.hasMore,
    };
  }

  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload,
    options?: ScheduleFetchOptions & { fields?: string[] },
  ): ScheduleFetchResults;
  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload[],
    options?: ScheduleFetchOptions & { fields?: string[] },
  ): ScheduleFetchResults[];
  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload | ItemPayload[],
    options?: ScheduleFetchOptions & { fields?: string[] },
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    if (!fetchItemFn) {
      throw new Error(noFetchItemFnError);
    }

    const fetchMultiple = Array.isArray(itemPayload);
    const itemsId = fetchMultiple ? itemPayload : [itemPayload];

    const results = itemsId.map((payload) => {
      const itemKey = getItemKey(payload);
      return getOrCreateItemScheduler(itemKey).scheduleFetch(
        itemKey,
        fetchType,
        { payload, fields: options?.fields },
        options,
      );
    });

    if (fetchMultiple) return results;

    const firstResult = results[0];
    if (!firstResult) {
      throw new Error('Unexpected empty results array');
    }
    return firstResult;
  }

  async function awaitItemFetch(
    itemPayload: ItemPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<
    { data: null; error: StoreFetchError } | { data: ItemState; error: null }
  > {
    if (!fetchItemFn) {
      throw new Error(noFetchItemFnError);
    }

    const itemKey = getItemKey(itemPayload);

    const result = await getOrCreateItemScheduler(itemKey).awaitFetch(
      itemKey,
      { payload: itemPayload },
      options,
    );

    if (result === 'timeout') {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 408, id: 'timeout', message: 'Timeout' },
          'timeout',
        ),
      };
    }

    if (result === true) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 408, id: 'aborted', message: 'Aborted' },
          'aborted',
        ),
      };
    }

    const item = store.state.items[itemKey];
    const itemQuery = store.state.itemQueries[itemKey];

    if (itemQuery?.error) {
      return {
        data: null,
        error: new StoreFetchError(itemQuery.error, 'fetch'),
      };
    }

    if (!itemQuery || !item) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 404, id: 'not-found', message: 'Not found' },
          'fetch',
        ),
      };
    }

    return { data: item, error: null };
  }

  const queryInvalidationWasTriggered = new Set<string>();
  const itemInvalidationWasTriggered = new Set<string>();

  function invalidateQueryAndItems({
    itemPayload,
    queryPayload,
    type: priority = 'highPriority',
    fields: invalidateFields,
  }: {
    itemPayload: ItemPayload | ItemPayload[] | FilterItemFn | false;
    queryPayload: QueryPayload | QueryPayload[] | FilterQueryFn | false;
    type?: FetchType;
    fields?: string[];
  }) {
    const queriesKey = queryPayload ? getQueriesKeyArray(queryPayload) : [];

    for (const { key, payload } of queriesKey) {
      const queryState = store.state.queries[key];

      if (!queryState) continue;

      const currentInvalidationPriority =
        queryState.refetchOnMount ?
          fetchTypePriority[queryState.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const query = draft.queries[key];
          if (!query) return;

          query.refetchOnMount = priority;
        },
        { action: 'invalidate-query' },
      );

      queryInvalidationWasTriggered.delete(key);
      events.emit('invalidateQuery', { priority, queryKey: key });

      onInvalidateQuery?.(payload, priority);
    }

    if (itemPayload) {
      if (partialResources && invalidateFields) {
        // Per-field invalidation: remove specified fields from itemLoadedFields
        const itemsKey = getItemsKeyArray(itemPayload);

        store.produceState(
          (draft) => {
            for (const { itemKey } of itemsKey) {
              const loadedFields = draft.itemLoadedFields[itemKey];
              if (!loadedFields) continue;

              draft.itemLoadedFields[itemKey] = loadedFields.filter(
                (f) => !invalidateFields.includes(f),
              );
            }
          },
          { action: 'invalidate-item-fields' },
        );

        // Emit invalidation events so hooks can detect missing fields and refetch
        for (const { itemKey } of itemsKey) {
          events.emit('invalidateItem', { priority, itemKey });
        }
      } else {
        invalidateItem(itemPayload, priority);
      }
    }
  }

  function invalidateItem(
    itemId: ItemPayload | ItemPayload[] | FilterItemFn,
    priority: FetchType = 'highPriority',
  ) {
    if (!fetchItemFn) return;

    const itemsKey = getItemsKeyArray(itemId);

    for (const { itemKey, payload } of itemsKey) {
      const item = store.state.itemQueries[itemKey];

      if (!item) continue;

      const currentInvalidationPriority =
        item.refetchOnMount ? fetchTypePriority[item.refetchOnMount] : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const query = draft.itemQueries[itemKey];
          if (!query) return;

          query.refetchOnMount = priority;

          // Clear loaded fields so all hooks refetch their fields
          if (partialResources) {
            draft.itemLoadedFields[itemKey] = [];
          }
        },
        { action: 'invalidate-item' },
      );

      itemInvalidationWasTriggered.delete(itemKey);
      events.emit('invalidateItem', { priority, itemKey });

      if (onInvalidateItem) {
        const itemState = store.state.items[itemKey];

        if (itemState) {
          onInvalidateItem({ priority, itemState, payload });
        }
      }
    }
  }

  function startItemMutation(
    itemId: ItemPayload | ItemPayload[] | FilterItemFn,
  ): () => void {
    const itemsKey = getItemsKeyArray(itemId);

    const endMutations: (() => boolean)[] = [];

    for (const { itemKey } of itemsKey) {
      if (fetchItemFn) {
        const itemScheduler = getOrCreateItemScheduler(itemKey);
        endMutations.push(itemScheduler.startMutation(itemKey));
      }

      for (const [queryKey, query] of Object.entries(store.state.queries)) {
        if (query.items.includes(itemKey)) {
          endMutations.push(
            getOrCreateQueryScheduler(queryKey).startMutation(queryKey),
          );
        }
      }
    }

    return () => {
      for (const endMutation of endMutations) {
        endMutation();
      }
    };
  }

  function applyOptimisticListUpdates(itemKeys: string[]) {
    if (!optimisticListUpdates) return;

    const queriesToInvalidate: QueryPayload[] = [];

    store.produceState((draftState) => {
      for (const itemKey of itemKeys) {
        const item = draftState.items[itemKey];

        if (!item) continue;

        for (const {
          queries,
          filterItem,
          appendNewTo = 'end',
          invalidateQueries,
          sort,
        } of optimisticListUpdates) {
          const relatedFilterQueries = getQueriesKeyArray(queries);

          for (const { key: queryKey, payload } of relatedFilterQueries) {
            const queryState = draftState.queries[queryKey];

            if (filterItem) {
              const itemShouldBeIncluded = filterItem(item);

              if (itemShouldBeIncluded === null) continue;

              if (itemShouldBeIncluded) {
                if (!queryState) {
                  draftState.queries[queryKey] = {
                    status: 'success',
                    items: [itemKey],
                    error: null,
                    hasMore: false,
                    payload,
                    refetchOnMount: 'lowPriority',
                    wasLoaded: true,
                  };

                  continue;
                }

                if (queryState.items.includes(itemKey)) continue;

                if (invalidateQueries) queriesToInvalidate.push(payload);

                if (appendNewTo === 'end') {
                  queryState.items.push(itemKey);
                } else {
                  queryState.items.unshift(itemKey);
                }
              } else {
                if (!queryState) continue;

                const itemIndex = queryState.items.indexOf(itemKey);

                if (itemIndex !== -1) {
                  if (invalidateQueries)
                    queriesToInvalidate.push(queryState.payload);

                  queryState.items.splice(itemIndex, 1);
                }
              }
            }

            if (sort) {
              if (!queryState) continue;

              const queryHasItem = queryState.items.includes(itemKey);

              if (!queryHasItem) continue;

              queryState.items = sortBy(
                queryState.items,
                (itemId) => {
                  const itemState = store.state.items[itemId];
                  const itemPayloadFromState =
                    store.state.itemQueries[itemId]?.payload;

                  if (!itemState || !itemPayloadFromState) return Infinity;

                  return sort.sortBy(itemState, itemPayloadFromState);
                },
                { order: sort.order },
              );
            }
          }
        }
      }
    });

    if (queriesToInvalidate.length)
      invalidateQueryAndItems({
        queryPayload: queriesToInvalidate,
        itemPayload: false,
      });
  }

  function updateItemState(
    itemIds: ItemPayload | ItemPayload[] | FilterItemFn,
    produceNewData: (
      draftData: ItemState,
      itemPayload: ItemPayload,
    ) => void | ItemState,
    options: { ifNothingWasUpdated?: () => void } = {},
  ): boolean {
    const itemKeys = getItemsKeyArray(itemIds);

    let someItemWasUpdated = false;

    store.batch(
      () => {
        store.produceState((draftState) => {
          for (const { itemKey, payload } of itemKeys) {
            const item = draftState.items[itemKey];

            if (!item) continue;

            someItemWasUpdated = true;
            const newData = produceNewData(item, payload);

            if (newData) {
              draftState.items[itemKey] = newData;
            }
          }
        });

        if (someItemWasUpdated) {
          applyOptimisticListUpdates(itemKeys.map((i) => i.itemKey));
        }

        if (options.ifNothingWasUpdated && !someItemWasUpdated) {
          options.ifNothingWasUpdated();
        }
      },
      { type: 'update-item-state' },
    );

    return someItemWasUpdated;
  }

  function addItemToState(
    itemPayload: ItemPayload,
    data: ItemState,
    options: {
      addItemToQueries?: {
        queries: QueryPayload[] | FilterQueryFn | QueryPayload;
        appendTo: 'start' | 'end' | ((itemsPayload: ItemPayload[]) => number);
      };
    } = {},
  ) {
    const itemKey = getItemKey(itemPayload);

    store.batch(() => {
      store.produceState(
        (draftState) => {
          draftState.items[itemKey] = data;
          draftState.itemQueries[itemKey] = {
            status: 'success',
            wasLoaded: true,
            refetchOnMount: false,
            error: null,
            payload: klona(itemPayload),
          };

          if (options.addItemToQueries) {
            const queries = getQueriesKeyArray(
              options.addItemToQueries.queries,
            );

            for (const { key } of queries) {
              const queryState = draftState.queries[key];
              if (!queryState) continue;

              if (queryState.items.includes(itemKey)) continue;

              if (options.addItemToQueries.appendTo === 'start') {
                queryState.items.unshift(itemKey);
              } else if (options.addItemToQueries.appendTo === 'end') {
                queryState.items.push(itemKey);
              } else {
                const index = options.addItemToQueries.appendTo(
                  filterAndMap(queryState.items, (itemKey2) => {
                    const payload = draftState.itemQueries[itemKey2]?.payload;
                    return payload ?? false;
                  }),
                );

                queryState.items.splice(index, 0, itemKey);
              }
            }
          }
        },
        { action: 'create-item-state' },
      );

      applyOptimisticListUpdates([itemKey]);
    });
  }

  function deleteItemState(itemId: ItemPayload | ItemPayload[] | FilterItemFn) {
    const itemsId = getItemsKeyArray(itemId);

    store.produceState(
      (draftState) => {
        for (const { itemKey } of itemsId) {
          draftState.items[itemKey] = null;
          draftState.itemQueries[itemKey] = null;
          delete draftState.itemLoadedFields[itemKey];

          for (const query of Object.values(draftState.queries)) {
            if (query.items.includes(itemKey)) {
              query.items = query.items.filter((i) => i !== itemKey);
            }
          }
        }
      },
      { action: 'delete-item-state' },
    );
  }

  async function performMutation<T>(
    payload: MutationPayload,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      dontRevalidateOnError,
      getRelatedQueries = () => true,
      getRevalidateOnSuccessQueries = getRelatedQueries,
      onSuccess,
      onError,
      debounce,
    }: {
      optimisticUpdate?: (payload: MutationPayloadToUse) => void | boolean;
      mutation: (payload: MutationPayloadToUse) => Promise<T>;
      revalidateOnSuccess?: boolean | 'queries';
      dontRevalidateOnError?: boolean;
      getRelatedQueries?: FilterQueryFn;
      getRevalidateOnSuccessQueries?: FilterQueryFn;
      onSuccess?: (response: Awaited<T>, payload: MutationPayloadToUse) => void;
      onError?: (error: StoreError | true) => void;
      silentErrors?: boolean;
      debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
    },
  ): Promise<Result<Awaited<T>, StoreError | true>> {
    const matchAllItems: FilterItemFn = () => true;
    const payloadToUse: MutationPayloadToUse = payload ?? matchAllItems;

    const endMutation = startItemMutation(payloadToUse);

    if (optimisticUpdate) {
      if (optimisticUpdate(payloadToUse) === false) {
        endMutation();
        return Result.err(true);
      }
    }

    let unblockWindowClose: VoidFunction | null = null;

    try {
      if (debounce) {
        unblockWindowClose = blockWindowClose().unblock;

        const debounceResult = await awaitDebounce({
          callId: [debounce.context, debounce.payload],
          debounce: debounce.ms,
        });

        if (debounceResult === 'skip') {
          endMutation();
          return Result.err(true);
        }
      }

      const result = await mutation(payloadToUse);

      endMutation();

      if (revalidateOnSuccess) {
        invalidateQueryAndItems({
          itemPayload: revalidateOnSuccess === 'queries' ? false : payloadToUse,
          queryPayload: getRevalidateOnSuccessQueries,
        });
      }

      if (onSuccess) {
        onSuccess(result, payloadToUse);
      }

      return Result.ok(result);
    } catch (exception) {
      endMutation();

      const error = errorNormalizer(unknownToError(exception));

      if (!silentErrors && onMutationError) {
        onMutationError(exception, { silentErrors });
      }

      if (!dontRevalidateOnError) {
        invalidateQueryAndItems({
          itemPayload: payloadToUse,
          queryPayload: getRelatedQueries,
        });
      }

      if (onError) {
        onError(error);
      }

      return Result.err(error);
    } finally {
      unblockWindowClose?.();
    }
  }

  const useMultipleListQueries: {
    <
      SelectedItem = ItemState,
      QueryMetadata extends undefined | Record<string, unknown> = undefined,
    >(
      queries: (ListQueryUseMultipleListQueriesQuery<
        QueryPayload,
        QueryMetadata
      >
        & FieldsOption<HasPR>)[],
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
      ...args: HasPR extends true ?
        [
          options: UseListQueryOptions<ItemState, ItemPayload, SelectedItem> & {
            fields: string[];
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
      items: (ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata>
        & FieldsOption<HasPR>)[],
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
      ...args: HasPR extends true ?
        [options: UseItemOptions<ItemState, Selected> & { fields: string[] }]
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
    for (const scheduler of querySchedulers.values()) {
      scheduler.reset();
    }
    querySchedulers.clear();

    if (singleItemScheduler) {
      singleItemScheduler.reset();
    } else {
      for (const scheduler of perItemSchedulers.values()) {
        scheduler.reset();
      }
      perItemSchedulers.clear();
    }

    store.setState({
      items: {},
      queries: {},
      itemQueries: {},
      itemLoadedFields: {},
    });
  }

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
    scheduleListQueryFetch,
    getQueryState,
    getQueryKey,
    getQueriesState,
    getQueriesRelatedToItem,
    awaitListQueryFetch,
    loadMore,
    getItemKey,
    getItemState,
    scheduleItemFetch,
    awaitItemFetch,
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
