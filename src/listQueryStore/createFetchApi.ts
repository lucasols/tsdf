import { filterAndMap } from '@ls-stack/utils/arrayUtils';
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
  StoreError,
  StoreFetchError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { executeItemBatchFetch } from './executeItemBatchFetch';
import { executeQueryFetch } from './executeQueryFetch';
import {
  type FieldsInput,
  type OffsetPaginationConfig,
  type PartialResourcesConfig,
  type QueryFetchPayload,
  type TSFDListQuery,
  type TSFDListQueryState,
} from './types';

export type FilterQueryFn<QueryPayload extends ValidPayload> = (
  params: QueryPayload,
  data: TSFDListQuery<QueryPayload>,
  queryKey: string,
) => boolean;

export type FilterItemFn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (itemPayload: ItemPayload, itemState: ItemState) => boolean;

type ItemFetchData<ItemPayload extends ValidPayload> = {
  payload: ItemPayload;
  fields?: string[];
};

export type NormalizedFetchListFn<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = (
  payload: QueryPayload,
  offset: number,
  limit: number,
  options: { signal: AbortSignal; fields?: string[] },
) => Promise<{
  items: { itemPayload: ItemPayload; data: ItemState }[];
  hasMore: boolean;
}>;

export type CreateFetchApiOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>;
  normalizedFetchListFn: NormalizedFetchListFn<
    ItemState,
    QueryPayload,
    ItemPayload
  >;
  offsetPagination: OffsetPaginationConfig | undefined;
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
  partialResources?: PartialResourcesConfig<ItemState>;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  usesRealTimeUpdates: boolean;
  defaultQuerySize: number;
  maxItemBatchSize?: number;
  getQueryKey: (params: QueryPayload) => string;
  getItemKey: (params: ItemPayload) => string;
  normalizeFieldsOption: (
    fields: FieldsInput | undefined,
  ) => string[] | undefined;
  testInitialLastFetchStartTime?: number;
  noFetchItemFnError: string;
};

export function createFetchApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>({
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
  dynamicRealtimeThrottleMs,
  onSchedulerEvent,
  usesRealTimeUpdates,
  defaultQuerySize,
  maxItemBatchSize,
  getQueryKey,
  getItemKey,
  normalizeFieldsOption,
  testInitialLastFetchStartTime,
  noFetchItemFnError,
}: CreateFetchApiOptions<ItemState, QueryPayload, ItemPayload>) {
  type Query = TSFDListQuery<QueryPayload>;

  const querySchedulers = new Map<
    string,
    RequestScheduler<QueryFetchPayload<QueryPayload>>
  >();
  const queryInitialFetchStartTime = new Map<string, number>();

  if (import.meta.env.TEST && testInitialLastFetchStartTime !== undefined) {
    for (const queryKey of Object.keys(store.state.queries)) {
      queryInitialFetchStartTime.set(queryKey, testInitialLastFetchStartTime);
    }
  }

  const itemKeyToPayload = new Map<string, ItemPayload>();

  function updateItemSchedulerTiming(itemKey: string, startTime: number) {
    if (!fetchItemFn) return;

    if (useBatchSchedulers) {
      const payload =
        itemKeyToPayload.get(itemKey) ??
        store.state.itemQueries[itemKey]?.payload;
      const batchKey =
        payload && getItemsBatchKey ? getItemsBatchKey(payload) : '__default__';

      if (batchKey !== false) {
        const scheduler = batchKeySchedulers.get(batchKey);
        if (scheduler) {
          scheduler.setLastFetchStartTime(startTime);
        } else {
          const existingStartTime = batchInitialFetchStartTime.get(batchKey);
          batchInitialFetchStartTime.set(
            batchKey,
            existingStartTime === undefined
              ? startTime
              : Math.max(existingStartTime, startTime),
          );
        }
        return;
      }
    }

    const existingScheduler = perItemSchedulers.get(itemKey);
    if (existingScheduler) {
      existingScheduler.setLastFetchStartTime(startTime);
    } else {
      itemInitialFetchStartTime.set(itemKey, startTime);
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
            normalizedFetchListFn,
            errorNormalizer,
            getItemKey,
            updateItemSchedulerTiming,
            partialResources,
            offsetPagination,
          );
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime,
        coalescePayload: (existing, incoming) => {
          const minOffset = Math.min(existing.offset, incoming.offset);
          const maxEnd = Math.max(
            existing.offset + existing.limit,
            incoming.offset + incoming.limit,
          );

          // 'loadMore' wins: in size mode both are full re-fetches so loadMore has bigger size;
          // in offset mode the combined range already covers the full extent.
          const coalescedType =
            existing.type === 'loadMore' || incoming.type === 'loadMore'
              ? 'loadMore'
              : 'load';

          return {
            ...incoming,
            type: coalescedType,
            offset: minOffset,
            limit: maxEnd - minOffset,
            // Preserve fields requested by all coalesced hooks.
            fields:
              !existing.fields || !incoming.fields
                ? undefined
                : Array.from(
                    new Set([...existing.fields, ...incoming.fields]),
                  ).sort(),
          };
        },
        usesRealTimeUpdates,
      });
      querySchedulers.set(queryKey, scheduler);
    }
    return scheduler;
  }

  function coalesceItemFetchPayload(
    existing: ItemFetchData<ItemPayload>,
    incoming: ItemFetchData<ItemPayload>,
  ): ItemFetchData<ItemPayload> {
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

  const useBatchSchedulers = !!batchFetchItemFn && !!fetchItemFn;

  const batchKeySchedulers = new Map<
    string,
    RequestScheduler<ItemFetchData<ItemPayload>>
  >();
  const batchInitialFetchStartTime = new Map<string, number>();

  function getOrCreateBatchKeyScheduler(
    batchKey: string,
  ): RequestScheduler<ItemFetchData<ItemPayload>> {
    let scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) {
      if (!fetchItemFn) {
        throw new Error(noFetchItemFnError);
      }

      const initialLastFetchStartTime =
        batchInitialFetchStartTime.get(batchKey);
      if (initialLastFetchStartTime !== undefined) {
        batchInitialFetchStartTime.delete(batchKey);
      }

      scheduler = new RequestScheduler<ItemFetchData<ItemPayload>>({
        fetchFn: async (
          requests: BatchRequest<ItemFetchData<ItemPayload>>[],
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
            batchKey,
          );
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        maxBatchSize: maxItemBatchSize,
        on: onSchedulerEvent,
        initialLastFetchStartTime,
        coalescePayload: coalesceItemFetchPayload,
        usesRealTimeUpdates,
      });
      batchKeySchedulers.set(batchKey, scheduler);
    }
    return scheduler;
  }

  const perItemSchedulers = new Map<
    string,
    RequestScheduler<ItemFetchData<ItemPayload>>
  >();
  const itemInitialFetchStartTime = new Map<string, number>();

  if (import.meta.env.TEST && testInitialLastFetchStartTime !== undefined) {
    for (const [itemKey, itemQuery] of Object.entries(
      store.state.itemQueries,
    )) {
      const initialLastFetchStartTime = testInitialLastFetchStartTime;

      if (useBatchSchedulers) {
        const payload = itemQuery?.payload;
        const batchKey =
          payload && getItemsBatchKey
            ? getItemsBatchKey(payload)
            : '__default__';

        if (batchKey !== false) {
          const existingStartTime = batchInitialFetchStartTime.get(batchKey);
          batchInitialFetchStartTime.set(
            batchKey,
            existingStartTime === undefined
              ? initialLastFetchStartTime
              : Math.max(existingStartTime, initialLastFetchStartTime),
          );
          continue;
        }
      }

      itemInitialFetchStartTime.set(itemKey, initialLastFetchStartTime);
    }
  }

  function getOrCreateItemScheduler(
    itemKey: string,
    payload: ItemPayload,
  ): RequestScheduler<ItemFetchData<ItemPayload>> {
    if (useBatchSchedulers) {
      if (getItemsBatchKey) {
        const batchKey = getItemsBatchKey(payload);
        if (batchKey !== false) {
          return getOrCreateBatchKeyScheduler(batchKey);
        }
        // batchKey === false → fall through to per-item scheduler
      } else {
        return getOrCreateBatchKeyScheduler('__default__');
      }
    }

    let scheduler = perItemSchedulers.get(itemKey);
    if (!scheduler) {
      if (!fetchItemFn) {
        throw new Error(noFetchItemFnError);
      }

      const initialLastFetchStartTime = itemInitialFetchStartTime.get(itemKey);
      if (initialLastFetchStartTime !== undefined) {
        itemInitialFetchStartTime.delete(itemKey);
      }

      scheduler = new RequestScheduler<ItemFetchData<ItemPayload>>({
        fetchFn: async (
          requests: BatchRequest<ItemFetchData<ItemPayload>>[],
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

  function getQueryState(params: QueryPayload): Query | undefined {
    return store.state.queries[getQueryKey(params)];
  }

  function getQueriesKeyArray(
    payloads: QueryPayload | QueryPayload[] | FilterQueryFn<QueryPayload>,
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
          return payloads(query.payload, query, queryKey)
            ? { key: queryKey, payload: query.payload }
            : false;
        },
      );
    } else {
      return [{ key: getQueryKey(payloads), payload: payloads }];
    }
  }

  function getQueriesState(
    params: QueryPayload[] | FilterQueryFn<QueryPayload>,
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

  function getItemsKeyArray(
    itemsPayload:
      | ItemPayload
      | ItemPayload[]
      | FilterItemFn<ItemState, ItemPayload>,
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
    options?: ScheduleFetchOptions & { fields?: FieldsInput },
  ): ScheduleFetchResults;
  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload[],
    size?: number,
    options?: ScheduleFetchOptions & { fields?: FieldsInput },
  ): ScheduleFetchResults[];
  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload | QueryPayload[],
    size?: number,
    options?: ScheduleFetchOptions & { fields?: FieldsInput },
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const fields = normalizeFieldsOption(options?.fields);
    const multiplePayloads = Array.isArray(payload);
    const payloads = multiplePayloads ? payload : [payload];

    const results = payloads.map((param) => {
      const queryKey = getQueryKey(param);
      const queryState = store.state.queries[queryKey];
      const currentQuerySize = queryState?.items.length ?? 0;
      const querySize = Math.max(currentQuerySize, size ?? defaultQuerySize);

      return getOrCreateQueryScheduler(queryKey).scheduleFetch(
        queryKey,
        fetchType,
        {
          type: 'load',
          payload: param,
          offset: 0,
          limit: querySize,
          fields,
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

  function loadMore(
    params: QueryPayload,
    size?: number,
    options?: { fields?: FieldsInput },
  ): ScheduleFetchResults;
  function loadMore(
    params: QueryPayload,
    options?: { size?: number; fields?: FieldsInput },
  ): ScheduleFetchResults;
  function loadMore(
    params: QueryPayload,
    sizeOrOptions?: number | { size?: number; fields?: FieldsInput },
    options?: { fields?: FieldsInput },
  ): ScheduleFetchResults {
    const fields = (
      typeof sizeOrOptions === 'number' ? options : (sizeOrOptions ?? options)
    )?.fields;
    const fieldsToFetch = normalizeFieldsOption(fields);

    const queryState = getQueryState(params);

    if (!queryState || !queryState.hasMore) return 'skipped';
    if (queryState.status !== 'success') return 'skipped';

    const queryKey = getQueryKey(params);
    const loadSize =
      typeof sizeOrOptions === 'number'
        ? sizeOrOptions
        : (sizeOrOptions?.size ?? defaultQuerySize);

    const fetchPayload: QueryFetchPayload<QueryPayload> = offsetPagination
      ? {
          type: 'loadMore',
          payload: params,
          offset: queryState.items.length,
          limit: loadSize,
          fields: fieldsToFetch,
        }
      : {
          type: 'loadMore',
          payload: params,
          offset: 0,
          limit: queryState.items.length + loadSize,
          fields: fieldsToFetch,
        };

    return getOrCreateQueryScheduler(queryKey).scheduleFetch(
      queryKey,
      'highPriority',
      fetchPayload,
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
      return item && itemPayload
        ? itemDataSelector(item, itemPayload, itemKey)
        : false;
    });
  }

  async function awaitListQueryFetch(
    params: QueryPayload,
    options: { size?: number; timeoutMs?: number; fields?: FieldsInput } = {},
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
    const fields = normalizeFieldsOption(options.fields);

    const result = await getOrCreateQueryScheduler(queryKey).awaitFetch(
      queryKey,
      { type: 'load', payload: params, offset: 0, limit: size, fields },
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
      throw new Error(noFetchItemFnError);
    }

    const fields = normalizeFieldsOption(options?.fields);
    const fetchMultiple = Array.isArray(itemPayload);
    const itemsId = fetchMultiple ? itemPayload : [itemPayload];

    const results = itemsId.map((payload) => {
      const itemKey = getItemKey(payload);
      return getOrCreateItemScheduler(itemKey, payload).scheduleFetch(
        itemKey,
        fetchType,
        { payload, fields },
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
    options: { timeoutMs?: number; fields?: FieldsInput } = {},
  ): Promise<
    { data: null; error: StoreFetchError } | { data: ItemState; error: null }
  > {
    if (!fetchItemFn) {
      throw new Error(noFetchItemFnError);
    }

    const itemKey = getItemKey(itemPayload);
    const fields = normalizeFieldsOption(options.fields);

    const result = await getOrCreateItemScheduler(
      itemKey,
      itemPayload,
    ).awaitFetch(
      itemKey,
      { payload: itemPayload, fields },
      { timeoutMs: options.timeoutMs },
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

  function resetSchedulers() {
    for (const scheduler of querySchedulers.values()) {
      scheduler.reset();
    }
    querySchedulers.clear();

    for (const scheduler of batchKeySchedulers.values()) {
      scheduler.reset();
    }
    batchKeySchedulers.clear();
    batchInitialFetchStartTime.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();
  }

  return {
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
  };
}
