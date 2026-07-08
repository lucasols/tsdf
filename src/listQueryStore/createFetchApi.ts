import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { Result, type Result as ResultType } from 't-result';
import { Store } from 't-state';
import type { OfflineAwareFetchController } from '../persistentStorage/offline/fetchRuntime';
import {
  BatchRequest,
  FetchContext,
  FetchType,
  RequestScheduler,
  RequestSchedulerEventData,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
import {
  AbortedStoreError,
  DEFAULT_BATCH_KEY,
  isStrictItemKeyPrefix,
  NotFoundStoreError,
  StoreError,
  StoreFetchError,
  TimeoutStoreError,
  type MaybeTSDFResult,
  type ValidPayload,
  type ValidStoreState,
} from '../utils/storeShared';
import { executeItemBatchFetch } from './executeItemBatchFetch';
import { executeQueryFetch } from './executeQueryFetch';
import {
  excludeLoadedFields,
  fallbackItemHasRequestedFields,
  getFallbackMissingRequestedFields,
  getStaleOrMissingRequestedFields,
  snapshotIsFullyLoaded,
} from './itemFieldUtils';
import {
  type FieldsInput,
  type ItemLoadedFields,
  type OffsetPaginationConfig,
  type PartialResourcesConfig,
  type QueryFetchPayload,
  type TSDFItemQuery,
  type TSFDListQuery,
  type TSFDListQueryState,
} from './types';

/** @internal */
export type FilterQueryFn<QueryPayload extends ValidPayload> = (
  params: QueryPayload,
  data: TSFDListQuery<QueryPayload>,
  queryKey: string,
) => boolean;

/** @internal */
export type FilterItemFn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (itemPayload: ItemPayload, itemState: ItemState) => boolean;

type ItemFetchData<ItemPayload extends ValidPayload> = {
  payload: ItemPayload;
  fields?: string[];
};

/** @internal */
export type NormalizedFetchListFn<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = (
  payload: QueryPayload,
  offset: number,
  limit: number,
  options: { signal: AbortSignal; fields?: string[] },
) => Promise<
  MaybeTSDFResult<{
    items: { itemPayload: ItemPayload; data: ItemState }[];
    hasMore: boolean;
  }>
>;

type CreateFetchApiOptions<
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
  ) => Promise<MaybeTSDFResult<ItemState>>;
  batchFetchItemFn?: (
    requests: { payload: ItemPayload; fields?: string[] }[],
    options: { signal: AbortSignal; batchKey: string },
  ) => Promise<
    MaybeTSDFResult<Map<ItemPayload, MaybeTSDFResult<ItemState> | Error>>
  >;
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  errorNormalizer: (exception: Error) => StoreError;
  partialResources?: PartialResourcesConfig<ItemState>;
  lowPriorityThrottleMs: number;
  getCoalescingWindowMs: () => number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  onSchedulerEvent?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  usesRealTimeUpdates: boolean;
  defaultQuerySize: number;
  maxItemBatchSize?: number;
  getQueryKey: (params: QueryPayload) => string;
  getItemKey: (params: ItemPayload) => string;
  normalizeFieldsOption: (
    fields: FieldsInput | undefined,
  ) => string[] | undefined;
  syncHydrationEnabled?: boolean;
  preloadQueries?: (queryKeys: string[]) => Promise<boolean[]>;
  preloadItems?: (itemKeys: string[]) => Promise<boolean[]>;
  persistence?: {
    getHydratedItemKeys(this: void): string[];
    getHydratedQueryKeys(this: void): string[];
    readHydratedItem(
      this: void,
      itemKey: string,
    ):
      | {
          item: ItemState;
          itemQuery: TSDFItemQuery<ItemPayload>;
          loadedFields: ItemLoadedFields | undefined;
        }
      | undefined;
    readHydratedQuery(
      this: void,
      queryKey: string,
    ): TSFDListQuery<QueryPayload> | undefined;
  } | null;
  testInitialLastFetchStartTime?: number;
  onQueryFetchStart?: (
    requests: BatchRequest<QueryFetchPayload<QueryPayload>>[],
    startedAt: number,
  ) => void;
  onQueryFetchSettled?: (params: {
    requests: BatchRequest<QueryFetchPayload<QueryPayload>>[];
    results: Map<string, boolean>;
    startedAt: number;
    duration: number;
  }) => void;
  onItemFetchStart?: (
    requests: BatchRequest<ItemFetchData<ItemPayload>>[],
    startedAt: number,
  ) => void;
  onItemFetchSettled?: (params: {
    requests: BatchRequest<ItemFetchData<ItemPayload>>[];
    results: Map<string, boolean>;
    startedAt: number;
    duration: number;
  }) => void;
  offlineController?: OfflineAwareFetchController | null;
};

/** @internal */
export function createFetchApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  store: CreateFetchApiOptions<ItemState, QueryPayload, ItemPayload>['store'],
  normalizedFetchListFn: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['normalizedFetchListFn'],
  offsetPagination: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['offsetPagination'],
  fetchItemFn: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['fetchItemFn'],
  batchFetchItemFn: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['batchFetchItemFn'],
  getItemsBatchKey: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['getItemsBatchKey'],
  errorNormalizer: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['errorNormalizer'],
  partialResources: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['partialResources'],
  lowPriorityThrottleMs: number,
  getCoalescingWindowMs: () => number,
  mediumPriorityDelayMs: number | undefined,
  dynamicRealtimeThrottleMs:
    | ((lastFetchDuration: number) => number)
    | undefined,
  onSchedulerEvent:
    | ((
        event: RequestSchedulerEvents,
        data?: RequestSchedulerEventData,
      ) => void)
    | undefined,
  usesRealTimeUpdates: boolean,
  defaultQuerySize: number,
  maxItemBatchSize: number | undefined,
  getQueryKey: (params: QueryPayload) => string,
  getItemKey: (params: ItemPayload) => string,
  normalizeFieldsOption: (
    fields: FieldsInput | undefined,
  ) => string[] | undefined,
  syncHydrationEnabled: boolean,
  preloadQueries_: ((queryKeys: string[]) => Promise<boolean[]>) | undefined,
  preloadItems_: ((itemKeys: string[]) => Promise<boolean[]>) | undefined,
  persistence: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['persistence'],
  testInitialLastFetchStartTime: number | undefined,
  onQueryFetchStart: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['onQueryFetchStart'],
  onQueryFetchSettled: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['onQueryFetchSettled'],
  onItemFetchStart: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['onItemFetchStart'],
  onItemFetchSettled: CreateFetchApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload
  >['onItemFetchSettled'],
  offlineController: OfflineAwareFetchController | null | undefined,
  itemPendingInvalidationFields: Map<string, string[]>,
  itemsPendingFullInvalidation: Set<string>,
) {
  type Query = TSFDListQuery<QueryPayload>;

  const noFetchItemFnError = 'No fetchItemFn was provided';

  const querySchedulers = new Map<
    string,
    RequestScheduler<QueryFetchPayload<QueryPayload>>
  >();
  const queryInitialFetchStartTime = new Map<string, number>();
  const itemInitialFetchStartTime = new Map<string, number>();

  if (import.meta.env.TEST && testInitialLastFetchStartTime !== undefined) {
    for (const queryKey of Object.keys(store.state.queries)) {
      queryInitialFetchStartTime.set(queryKey, testInitialLastFetchStartTime);
    }
  }

  const itemKeyToPayload = new Map<string, ItemPayload>();

  function seedQuerySchedulerKnownRequest(
    scheduler: RequestScheduler<QueryFetchPayload<QueryPayload>>,
    queryKey: string,
    initialStartTime: number | undefined,
  ): void {
    if (
      initialStartTime === undefined &&
      store.state.queries[queryKey] === undefined
    ) {
      return;
    }

    scheduler.setLastFetchStartTimeForRequest(queryKey, initialStartTime ?? 0);
  }

  function seedItemSchedulerKnownRequest(
    scheduler: RequestScheduler<ItemFetchData<ItemPayload>>,
    itemKey: string,
    initialStartTime = itemInitialFetchStartTime.get(itemKey),
  ): void {
    if (initialStartTime !== undefined) {
      itemInitialFetchStartTime.delete(itemKey);
    }

    if (
      initialStartTime === undefined &&
      store.state.itemQueries[itemKey] === undefined
    ) {
      return;
    }

    scheduler.setLastFetchStartTimeForRequest(itemKey, initialStartTime ?? 0);
  }

  function seedBatchSchedulerKnownRequests(
    scheduler: RequestScheduler<ItemFetchData<ItemPayload>>,
    batchKey: string,
  ): void {
    for (const [itemKey, itemQuery] of Object.entries(
      store.state.itemQueries,
    )) {
      const payload = itemQuery?.payload;
      const currentBatchKey =
        payload && getItemsBatchKey
          ? getItemsBatchKey(payload)
          : DEFAULT_BATCH_KEY;

      if (currentBatchKey !== batchKey) continue;

      seedItemSchedulerKnownRequest(scheduler, itemKey);
    }
  }

  function updateItemSchedulerTiming(itemKey: string, startTime: number) {
    if (!fetchItemFn) return;

    if (useBatchSchedulers) {
      const payload =
        itemKeyToPayload.get(itemKey) ??
        store.state.itemQueries[itemKey]?.payload;
      const batchKey =
        payload && getItemsBatchKey
          ? getItemsBatchKey(payload)
          : DEFAULT_BATCH_KEY;

      if (batchKey !== false) {
        const scheduler = batchKeySchedulers.get(batchKey);
        if (scheduler) {
          scheduler.setLastFetchStartTimeForRequest(itemKey, startTime);
        } else {
          const existingStartTime = itemInitialFetchStartTime.get(itemKey);
          itemInitialFetchStartTime.set(
            itemKey,
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
      existingScheduler.setLastFetchStartTimeForRequest(itemKey, startTime);
    } else {
      const existingStartTime = itemInitialFetchStartTime.get(itemKey);
      itemInitialFetchStartTime.set(
        itemKey,
        existingStartTime === undefined
          ? startTime
          : Math.max(existingStartTime, startTime),
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
          onQueryFetchStart?.(requests, fetchCtx.getStartTime());
          const results = await executeQueryFetch(
            requests,
            fetchCtx,
            store,
            normalizedFetchListFn,
            errorNormalizer,
            getItemKey,
            updateItemSchedulerTiming,
            partialResources,
            offsetPagination,
            offlineController,
          );
          onQueryFetchSettled?.({
            requests,
            results,
            startedAt: fetchCtx.getStartTime(),
            duration: Date.now() - fetchCtx.getStartTime(),
          });
          return results;
        },
        lowPriorityThrottleMs,
        getCoalescingWindowMs,
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
      seedQuerySchedulerKnownRequest(
        scheduler,
        queryKey,
        initialLastFetchStartTime,
      );
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

  function getOrCreateBatchKeyScheduler(
    batchKey: string,
  ): RequestScheduler<ItemFetchData<ItemPayload>> {
    let scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) {
      if (!fetchItemFn) {
        throw new Error(noFetchItemFnError);
      }

      scheduler = new RequestScheduler<ItemFetchData<ItemPayload>>({
        fetchFn: async (
          requests: BatchRequest<ItemFetchData<ItemPayload>>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          onItemFetchStart?.(requests, fetchCtx.getStartTime());
          const results = await executeItemBatchFetch(
            requests,
            fetchCtx,
            store,
            itemKeyToPayload,
            fetchItemFn,
            batchFetchItemFn,
            errorNormalizer,
            partialResources,
            batchKey,
            offlineController,
          );
          onItemFetchSettled?.({
            requests,
            results,
            startedAt: fetchCtx.getStartTime(),
            duration: Date.now() - fetchCtx.getStartTime(),
          });
          return results;
        },
        lowPriorityThrottleMs,
        getCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        maxBatchSize: maxItemBatchSize,
        on: onSchedulerEvent,
        coalescePayload: coalesceItemFetchPayload,
        usesRealTimeUpdates,
      });
      seedBatchSchedulerKnownRequests(scheduler, batchKey);
      batchKeySchedulers.set(batchKey, scheduler);
    }
    return scheduler;
  }

  const perItemSchedulers = new Map<
    string,
    RequestScheduler<ItemFetchData<ItemPayload>>
  >();

  if (import.meta.env.TEST && testInitialLastFetchStartTime !== undefined) {
    for (const [itemKey, itemQuery] of Object.entries(
      store.state.itemQueries,
    )) {
      if (!itemQuery) continue;
      itemInitialFetchStartTime.set(itemKey, testInitialLastFetchStartTime);
    }
  }

  function getOrCreateItemScheduler(
    itemKey: string,
    payload: ItemPayload,
  ): RequestScheduler<ItemFetchData<ItemPayload>> {
    itemKeyToPayload.set(itemKey, payload);

    if (useBatchSchedulers) {
      if (getItemsBatchKey) {
        const batchKey = getItemsBatchKey(payload);
        if (batchKey !== false) {
          return getOrCreateBatchKeyScheduler(batchKey);
        }
        // batchKey === false → fall through to per-item scheduler
      } else {
        return getOrCreateBatchKeyScheduler(DEFAULT_BATCH_KEY);
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
          onItemFetchStart?.(requests, fetchCtx.getStartTime());
          const results = await executeItemBatchFetch(
            requests,
            fetchCtx,
            store,
            itemKeyToPayload,
            fetchItemFn,
            undefined,
            errorNormalizer,
            partialResources,
            undefined,
            offlineController,
          );
          onItemFetchSettled?.({
            requests,
            results,
            startedAt: fetchCtx.getStartTime(),
            duration: Date.now() - fetchCtx.getStartTime(),
          });
          return results;
        },
        lowPriorityThrottleMs,
        getCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime,
        coalescePayload: coalesceItemFetchPayload,
        usesRealTimeUpdates,
      });
      seedItemSchedulerKnownRequest(
        scheduler,
        itemKey,
        initialLastFetchStartTime,
      );
      perItemSchedulers.set(itemKey, scheduler);
    }
    return scheduler;
  }

  function getBatchKeyForPayload(payload: ItemPayload): string | false {
    if (!useBatchSchedulers) return false;
    if (!getItemsBatchKey) return DEFAULT_BATCH_KEY;
    return getItemsBatchKey(payload);
  }

  function getKnownQueryScheduler(
    queryKey: string,
  ): RequestScheduler<QueryFetchPayload<QueryPayload>> | null {
    const existingScheduler = querySchedulers.get(queryKey);
    if (existingScheduler) return existingScheduler;
    if (store.state.queries[queryKey] === undefined) return null;

    return getOrCreateQueryScheduler(queryKey);
  }

  function getKnownBatchKeyScheduler(
    batchKey: string,
  ): RequestScheduler<ItemFetchData<ItemPayload>> | null {
    const existingScheduler = batchKeySchedulers.get(batchKey);
    if (existingScheduler) return existingScheduler;

    const hasKnownItems = Object.values(store.state.itemQueries).some(
      (itemQuery) => {
        if (!itemQuery) return false;
        return getBatchKeyForPayload(itemQuery.payload) === batchKey;
      },
    );
    if (!hasKnownItems) return null;

    return getOrCreateBatchKeyScheduler(batchKey);
  }

  function getKnownItemRequestIds(requestIds: string[]): string[] {
    return requestIds.filter((requestId) => {
      return store.state.itemQueries[requestId] !== undefined;
    });
  }

  function getKnownItemScheduler(
    itemKey: string,
  ): RequestScheduler<ItemFetchData<ItemPayload>> | null {
    const existingScheduler = perItemSchedulers.get(itemKey);
    if (existingScheduler) return existingScheduler;
    if (!fetchItemFn) return null;

    const payload =
      itemKeyToPayload.get(itemKey) ??
      store.state.itemQueries[itemKey]?.payload;
    if (payload === undefined) return null;

    return getOrCreateItemScheduler(itemKey, payload);
  }

  function maybeDisposeBatchScheduler(payload: ItemPayload): void {
    const batchKey = getBatchKeyForPayload(payload);
    if (batchKey === false) return;

    const scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) return;

    const hasRelatedItems = Object.values(store.state.itemQueries).some(
      (itemQuery) => {
        if (!itemQuery) return false;
        return getBatchKeyForPayload(itemQuery.payload) === batchKey;
      },
    );

    if (!hasRelatedItems) {
      scheduler.reset();
      batchKeySchedulers.delete(batchKey);
    }
  }

  function deleteItemFetchResources(
    items: { itemKey: string; payload: ItemPayload }[],
  ): void {
    for (const { itemKey, payload } of items) {
      itemKeyToPayload.delete(itemKey);
      itemInitialFetchStartTime.delete(itemKey);

      const itemScheduler = perItemSchedulers.get(itemKey);
      if (itemScheduler) {
        itemScheduler.reset();
        perItemSchedulers.delete(itemKey);
      }

      maybeDisposeBatchScheduler(payload);
    }
  }

  function deleteQueryFetchResources(queryKeys: string[]): void {
    for (const queryKey of queryKeys) {
      queryInitialFetchStartTime.delete(queryKey);

      const queryScheduler = querySchedulers.get(queryKey);
      if (!queryScheduler) continue;

      queryScheduler.reset();
      querySchedulers.delete(queryKey);
    }
  }

  function getQueryStateByKey(queryKey: string): Query | undefined {
    const query = store.state.queries[queryKey];
    if (query !== undefined) return query;

    const hydratedQuery = persistence?.readHydratedQuery(queryKey);
    if (!hydratedQuery) return undefined;

    if (syncHydrationEnabled && preloadQueries_) {
      void preloadQueries_([queryKey]);
      return store.state.queries[queryKey] ?? hydratedQuery;
    }

    return hydratedQuery;
  }

  function getQueryState(params: QueryPayload): Query | undefined {
    return getQueryStateByKey(getQueryKey(params));
  }

  function readMaterializedItemState(
    itemKey: string,
  ):
    | {
        item: ItemState | null | undefined;
        itemQuery: TSDFItemQuery<ItemPayload> | null | undefined;
        loadedFields: ItemLoadedFields | undefined;
      }
    | undefined {
    const hasItem = Object.hasOwn(store.state.items, itemKey);
    const hasItemQuery = Object.hasOwn(store.state.itemQueries, itemKey);
    const hasLoadedFields = Object.hasOwn(
      store.state.itemLoadedFields,
      itemKey,
    );
    if (!hasItem && !hasItemQuery && !hasLoadedFields) return undefined;

    return {
      item: hasItem ? store.state.items[itemKey] : undefined,
      itemQuery: hasItemQuery ? store.state.itemQueries[itemKey] : undefined,
      loadedFields: hasLoadedFields
        ? store.state.itemLoadedFields[itemKey]
        : undefined,
    };
  }

  function readItemState(
    itemKey: string,
  ):
    | {
        item: ItemState | null | undefined;
        itemQuery: TSDFItemQuery<ItemPayload> | null | undefined;
        loadedFields: ItemLoadedFields | undefined;
      }
    | undefined {
    const materializedItemState = readMaterializedItemState(itemKey);
    if (materializedItemState) return materializedItemState;

    const hydratedItem = persistence?.readHydratedItem(itemKey);
    if (!hydratedItem) return undefined;

    if (syncHydrationEnabled && preloadItems_) {
      void preloadItems_([itemKey]);
      return readMaterializedItemState(itemKey) ?? hydratedItem;
    }

    return hydratedItem;
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
      const queryKeys = new Set([
        ...Object.keys(store.state.queries),
        ...(persistence?.getHydratedQueryKeys() ?? []),
      ]);

      return filterAndMap([...queryKeys], (queryKey) => {
        const query = getQueryStateByKey(queryKey);
        return query && payloads(query.payload, query, queryKey)
          ? { key: queryKey, payload: query.payload }
          : false;
      });
    }

    return [{ key: getQueryKey(payloads), payload: payloads }];
  }

  function getQueriesState(
    params: QueryPayload[] | FilterQueryFn<QueryPayload>,
  ): { query: Query; key: string }[] {
    if (typeof params === 'function') {
      const queryKeys = new Set([
        ...Object.keys(store.state.queries),
        ...(persistence?.getHydratedQueryKeys() ?? []),
      ]);

      return filterAndMap([...queryKeys], (queryKey) => {
        const query = getQueryStateByKey(queryKey);
        return query && params(query.payload, query, queryKey)
          ? { query, key: queryKey }
          : false;
      });
    }

    const queryKeys = getQueriesKeyArray(params);

    return filterAndMap(queryKeys, ({ key }) => {
      const query = getQueryStateByKey(key);
      return query ? { query, key } : false;
    });
  }

  function getQueriesRelatedToItem(
    itemPayload: ItemPayload,
  ): { query: Query; key: string }[] {
    const itemKey = getItemKey(itemPayload);

    return getQueriesState((_queryPayload, query) => {
      return query.items.includes(itemKey);
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
      const itemKeys = new Set([
        ...Object.keys(store.state.items),
        ...(persistence?.getHydratedItemKeys() ?? []),
      ]);

      return filterAndMap([...itemKeys], (itemKey) => {
        const itemState = readItemState(itemKey);
        const item = itemState?.item;
        const payload = itemState?.itemQuery?.payload;

        if (item == null || payload === undefined) return false;

        return itemsPayload(payload, item) ? { itemKey, payload } : false;
      });
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
    if (typeof itemPayload === 'function') {
      const itemKeys = new Set([
        ...Object.keys(store.state.items),
        ...(persistence?.getHydratedItemKeys() ?? []),
      ]);

      return filterAndMap([...itemKeys], (itemKey) => {
        const itemState = readItemState(itemKey);
        const item = itemState?.item;
        const payload = itemState?.itemQuery?.payload;

        if (item == null || payload === undefined) return false;

        return itemPayload(payload, item) ? { payload, data: item } : false;
      });
    }

    if (Array.isArray(itemPayload)) {
      const itemsId = getItemsKeyArray(itemPayload);

      return filterAndMap(itemsId, ({ itemKey, payload }) => {
        const item = readItemState(itemKey)?.item;
        return item == null ? false : { payload, data: item };
      });
    }

    const itemKey = getItemKey(itemPayload);
    const itemState = readItemState(itemKey);
    if (itemState?.itemQuery === null) return null;
    return itemState?.item;
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
        { type: 'load', payload: param, offset: 0, limit: querySize, fields },
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

    const queryKey = getQueryKey(params);
    const loadSize =
      typeof sizeOrOptions === 'number'
        ? sizeOrOptions
        : (sizeOrOptions?.size ?? defaultQuerySize);

    const queryState = getQueryStateByKey(queryKey);

    if (!queryState) return 'skipped';
    if (queryState.status !== 'success') return 'skipped';
    if (!queryState.hasMore) return 'skipped';
    if (offlineController?.shouldTreatFetchAsOffline?.()) {
      return loadMoreFromHydratedQuery(
        queryKey,
        queryState,
        loadSize,
        fieldsToFetch,
      );
    }

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

  function loadMoreFromHydratedQuery(
    queryKey: string,
    queryState: Query,
    loadSize: number,
    fields: string[] | undefined,
  ): ScheduleFetchResults {
    if (!persistence) return 'skipped';

    const hydratedQuery = persistence.readHydratedQuery(queryKey);
    if (!hydratedQuery) return 'skipped';
    if (!isStrictItemKeyPrefix(queryState.items, hydratedQuery.items)) {
      return 'skipped';
    }

    const start = queryState.items.length;
    const end = Math.min(start + loadSize, hydratedQuery.items.length);
    if (start === end) return 'skipped';

    const appendedItemKeys: string[] = [];
    const appendedHydratedItems: {
      itemKey: string;
      state: NonNullable<ReturnType<typeof persistence.readHydratedItem>>;
    }[] = [];
    for (let i = start; i < end; i++) {
      const itemKey = hydratedQuery.items[i];
      if (itemKey === undefined) return 'skipped';
      const materializedState = readMaterializedItemState(itemKey);
      const hydratedState = persistence.readHydratedItem(itemKey);
      const state = materializedState ?? hydratedState;
      if (
        !state ||
        state.item == null ||
        state.itemQuery == null ||
        (partialResources &&
          fields &&
          fields.length > 0 &&
          !fallbackItemHasRequestedFields(
            state,
            fields,
            partialResources.inferFields,
          ))
      ) {
        return 'skipped';
      }
      appendedItemKeys.push(itemKey);
      if (!materializedState && hydratedState) {
        appendedHydratedItems.push({ itemKey, state: hydratedState });
      }
    }

    const nextItems = [...queryState.items, ...appendedItemKeys];
    const nextHasMore =
      end < hydratedQuery.items.length || hydratedQuery.hasMore;

    store.produceState(
      (draft) => {
        const currentQuery = draft.queries[queryKey];
        if (!currentQuery) return;

        currentQuery.error = null;
        currentQuery.status = 'success';
        currentQuery.refetchOnMount = false;
        currentQuery.items = nextItems;
        currentQuery.hasMore = nextHasMore;

        for (const { itemKey, state } of appendedHydratedItems) {
          draft.items[itemKey] = state.item;
          draft.itemQueries[itemKey] = state.itemQuery;
          if (state.loadedFields !== undefined) {
            draft.itemLoadedFields[itemKey] = state.loadedFields;
          }
        }
      },
      { action: 'persistent-storage-load-more' },
    );

    return 'triggered';
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

  /**
   * Fields of an item still awaiting an invalidation re-fetch. Reads the
   * state-level record first; when a fetch already consumed it (the record is
   * deleted before the response lands), falls back to the in-memory pending
   * list minus the fields that were re-loaded since the invalidation.
   */
  function getUnresolvedPendingInvalidationFields(itemKey: string): string[] {
    const stateInvalidationFields =
      store.state.itemFieldInvalidationFields[itemKey];
    if (stateInvalidationFields && stateInvalidationFields.length > 0) {
      return stateInvalidationFields;
    }

    return excludeLoadedFields(
      store.state.itemLoadedFields[itemKey],
      itemPendingInvalidationFields.get(itemKey),
    );
  }

  /**
   * Whether an item snapshot is fresh enough for a require-fresh
   * (`ignoreStaleState: true`) full ('*') read: no unresolved full ('*')
   * invalidation and no fields still awaiting an invalidation re-fetch.
   */
  function itemSnapshotIsFresh(itemKey: string): boolean {
    if (
      store.state.itemLoadedFields[itemKey] !== '*' &&
      itemsPendingFullInvalidation.has(itemKey)
    ) {
      return false;
    }

    return getUnresolvedPendingInvalidationFields(itemKey).length === 0;
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

    if (
      !syncHydrationEnabled &&
      preloadQueries_ &&
      store.state.queries[queryKey] === undefined
    ) {
      await preloadQueries_([queryKey]);
    }

    const result = await getOrCreateQueryScheduler(queryKey).awaitFetch(
      queryKey,
      { type: 'load', payload: params, offset: 0, limit: size, fields },
      { timeoutMs: options.timeoutMs },
    );

    if (result === 'timeout') {
      return { items: [], error: new TimeoutStoreError(), hasMore: false };
    }

    if (result === true) {
      return { items: [], error: new AbortedStoreError(), hasMore: false };
    }

    let query = getQueryStateByKey(queryKey);

    if (query?.error?.id === 'offline') {
      const hydratedQuery = persistence?.readHydratedQuery(queryKey);

      if (hydratedQuery) {
        query = hydratedQuery;
        store.produceState(
          (draft) => {
            draft.queries[queryKey] = hydratedQuery;

            for (const itemKey of hydratedQuery.items) {
              const hydratedItem = persistence?.readHydratedItem(itemKey);
              if (!hydratedItem) continue;

              draft.items[itemKey] = hydratedItem.item;
              draft.itemQueries[itemKey] = hydratedItem.itemQuery;
              if (hydratedItem.loadedFields !== undefined) {
                draft.itemLoadedFields[itemKey] = hydratedItem.loadedFields;
              }
            }
          },
          { action: 'persistent-storage-hydrate' },
        );
      }
    }

    if (query?.error) {
      return {
        items: [],
        error: new StoreFetchError(query.error, 'fetch'),
        hasMore: query.hasMore,
      };
    }

    if (!query) {
      return { items: [], error: new NotFoundStoreError(), hasMore: false };
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

  async function getQueryFromStateOrFetch(
    params: QueryPayload,
    options: {
      ignoreStaleState?: boolean;
      size?: number;
      timeoutMs?: number;
      fields?: FieldsInput;
    } = {},
  ): Promise<
    ResultType<
      {
        items: { data: ItemState; itemPayload: ItemPayload }[];
        hasMore: boolean;
      },
      StoreFetchError
    >
  > {
    const queryKey = getQueryKey(params);
    const fields = normalizeFieldsOption(options.fields);
    const fullFieldsRequested = options.fields === '*';
    const query = getQueryStateByKey(queryKey);
    const includeStale = !!options.ignoreStaleState;
    const cachedQueryCanBeUsed =
      !!query?.wasLoaded &&
      (!includeStale ||
        (query.status === 'success' && !query.error && !query.refetchOnMount));

    if (query && cachedQueryCanBeUsed) {
      const needsFieldCheck =
        partialResources &&
        ((Array.isArray(fields) && fields.length > 0) || fullFieldsRequested);

      if (!needsFieldCheck) {
        return Result.ok({
          items: getQueryItems(query, (data, itemPayload) => ({
            data,
            itemPayload,
          })),
          hasMore: query.hasMore,
        });
      }

      const queryNeedsFieldFetch = query.items.some((itemKey) => {
        const itemState = readItemState(itemKey);

        if (fullFieldsRequested) {
          return (
            !snapshotIsFullyLoaded(
              itemState?.loadedFields,
              itemState?.item,
              partialResources.inferFields,
            ) ||
            (includeStale && !itemSnapshotIsFresh(itemKey))
          );
        }

        const requestedFields = Array.isArray(fields) ? fields : [];

        if (includeStale) {
          // Require-fresh reads must also refetch requested fields that are
          // still awaiting an invalidation re-fetch (per-field or full), even
          // when the stale data is present and vouchable in state.
          return (
            getStaleOrMissingRequestedFields(
              itemKey,
              itemState?.loadedFields,
              itemState?.item,
              requestedFields,
              partialResources.inferFields,
              itemsPendingFullInvalidation,
              getUnresolvedPendingInvalidationFields(itemKey),
            ).length > 0
          );
        }

        return (
          getFallbackMissingRequestedFields(
            itemState,
            requestedFields,
            partialResources.inferFields,
          ).length > 0
        );
      });

      if (!queryNeedsFieldFetch) {
        return Result.ok({
          items: getQueryItems(query, (data, itemPayload) => ({
            data,
            itemPayload,
          })),
          hasMore: query.hasMore,
        });
      }

      // Query refetches can return a different item set than the cached query.
      // Fetch the full requested field set so newly returned items are complete.
    }

    const result = await awaitListQueryFetch(params, {
      size: options.size,
      timeoutMs: options.timeoutMs,
      fields: options.fields,
    });

    if (result.error) {
      return Result.err(result.error);
    }

    return Result.ok({ items: result.items, hasMore: result.hasMore });
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

    if (
      !syncHydrationEnabled &&
      preloadItems_ &&
      readMaterializedItemState(itemKey) === undefined
    ) {
      await preloadItems_([itemKey]);
    }

    const result = await getOrCreateItemScheduler(
      itemKey,
      itemPayload,
    ).awaitFetch(
      itemKey,
      { payload: itemPayload, fields },
      { timeoutMs: options.timeoutMs },
    );

    if (result === 'timeout') {
      return { data: null, error: new TimeoutStoreError() };
    }

    if (result === true) {
      return { data: null, error: new AbortedStoreError() };
    }

    let itemState = readItemState(itemKey);

    if (itemState?.itemQuery?.error?.id === 'offline') {
      const hydratedItem = persistence?.readHydratedItem(itemKey);

      if (hydratedItem) {
        itemState = hydratedItem;
        store.produceState(
          (draft) => {
            draft.items[itemKey] = hydratedItem.item;
            draft.itemQueries[itemKey] = hydratedItem.itemQuery;
            if (hydratedItem.loadedFields !== undefined) {
              draft.itemLoadedFields[itemKey] = hydratedItem.loadedFields;
            }
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

  async function getItemFromStateOrFetch(
    itemPayload: ItemPayload,
    options: {
      ignoreStaleState?: boolean;
      timeoutMs?: number;
      fields?: FieldsInput;
    } = {},
  ): Promise<ResultType<ItemState, StoreFetchError>> {
    const itemKey = getItemKey(itemPayload);
    const fields = normalizeFieldsOption(options.fields);
    const fullFieldsRequested = options.fields === '*';
    const itemState = readItemState(itemKey);
    const item = itemState?.item;
    const itemQuery = itemState?.itemQuery;
    const includeStale = !!options.ignoreStaleState;
    const needsFieldCheck =
      partialResources &&
      ((Array.isArray(fields) && fields.length > 0) || fullFieldsRequested);
    const itemHasAllFields =
      !needsFieldCheck ||
      (fullFieldsRequested
        ? snapshotIsFullyLoaded(
            itemState?.loadedFields,
            itemState?.item,
            partialResources.inferFields,
          )
        : fallbackItemHasRequestedFields(
            itemState,
            Array.isArray(fields) ? fields : [],
            partialResources.inferFields,
          ));
    const itemQueryFresh =
      itemQuery?.status === 'success' &&
      !itemQuery.error &&
      !itemQuery.refetchOnMount;
    // For require-fresh reads of specific fields, the requested fields that
    // are stale (awaiting an invalidation re-fetch) or missing without a vouch.
    const staleOrMissingRequestedFields =
      needsFieldCheck && !fullFieldsRequested && includeStale
        ? getStaleOrMissingRequestedFields(
            itemKey,
            itemState?.loadedFields,
            item,
            Array.isArray(fields) ? fields : [],
            partialResources.inferFields,
            itemsPendingFullInvalidation,
            getUnresolvedPendingInvalidationFields(itemKey),
          )
        : undefined;
    const cachedItemCanBeUsed =
      item != null &&
      itemHasAllFields &&
      (!includeStale ||
        (itemQueryFresh &&
          (!needsFieldCheck ||
            (fullFieldsRequested
              ? itemSnapshotIsFresh(itemKey)
              : staleOrMissingRequestedFields?.length === 0))));

    if (cachedItemCanBeUsed) {
      return Result.ok(item);
    }

    if (!fetchItemFn) {
      throw new Error(noFetchItemFnError);
    }

    let fieldsToFetch: FieldsInput | undefined = options.fields;

    if (
      needsFieldCheck &&
      !fullFieldsRequested &&
      item != null &&
      itemQueryFresh
    ) {
      // Fetch only the fields that are actually stale or missing — for
      // require-fresh reads that is `staleOrMissingRequestedFields`; default
      // reads tolerate staleness and only fetch missing unvouched fields.
      fieldsToFetch =
        staleOrMissingRequestedFields ??
        getFallbackMissingRequestedFields(
          itemState,
          Array.isArray(fields) ? fields : [],
          partialResources.inferFields,
        );
    }

    const result = await awaitItemFetch(itemPayload, {
      timeoutMs: options.timeoutMs,
      fields: fieldsToFetch,
    });

    if (result.error) {
      return Result.err(result.error);
    }

    return Result.ok(result.data);
  }

  function resetSchedulers() {
    for (const scheduler of querySchedulers.values()) {
      scheduler.reset();
    }
    querySchedulers.clear();
    queryInitialFetchStartTime.clear();

    for (const scheduler of batchKeySchedulers.values()) {
      scheduler.reset();
    }
    batchKeySchedulers.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();
    itemInitialFetchStartTime.clear();
    itemKeyToPayload.clear();
  }

  function reevaluateDelayedRTUs() {
    for (const scheduler of querySchedulers.values()) {
      scheduler.reevaluateDelayedRTU();
    }
    for (const scheduler of batchKeySchedulers.values()) {
      scheduler.reevaluateDelayedRTU();
    }
    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reevaluateDelayedRTU();
    }
  }

  function syncRemoteFetchStart(
    targetKey: string,
    requestIds: string[],
    startedAt: number,
  ): void {
    if (targetKey.startsWith('query:')) {
      const queryKey = targetKey.slice('query:'.length);
      const scheduler = getKnownQueryScheduler(queryKey);
      if (!scheduler) return;
      scheduler.syncExternalFetchStart(requestIds, startedAt);
      scheduler.cancelCoalescingRequests(requestIds);
      return;
    }

    if (targetKey.startsWith('item-batch:')) {
      const batchKey = targetKey.slice('item-batch:'.length);
      const scheduler = getKnownBatchKeyScheduler(batchKey);
      if (!scheduler) return;
      const knownRequestIds = getKnownItemRequestIds(requestIds);
      if (knownRequestIds.length === 0) return;

      scheduler.syncExternalFetchStart(knownRequestIds, startedAt);
      scheduler.cancelCoalescingRequests(knownRequestIds);
      return;
    }

    const itemKey = targetKey.slice('item:'.length);
    const scheduler = getKnownItemScheduler(itemKey);
    if (!scheduler) return;

    scheduler.syncExternalFetchStart(requestIds, startedAt);
    scheduler.cancelCoalescingRequests(requestIds);
  }

  function syncRemoteFetchSuccess(
    targetKey: string,
    requestIds: string[],
    startedAt: number,
    duration: number,
  ): void {
    if (targetKey.startsWith('query:')) {
      const queryKey = targetKey.slice('query:'.length);
      const scheduler = getKnownQueryScheduler(queryKey);
      if (!scheduler) return;

      scheduler.syncExternalFetchSuccess(requestIds, startedAt, duration);
      return;
    }

    if (targetKey.startsWith('item-batch:')) {
      const batchKey = targetKey.slice('item-batch:'.length);
      const scheduler = getKnownBatchKeyScheduler(batchKey);
      if (!scheduler) return;
      const knownRequestIds = getKnownItemRequestIds(requestIds);
      if (knownRequestIds.length === 0) return;

      scheduler.syncExternalFetchSuccess(knownRequestIds, startedAt, duration);
      return;
    }

    const itemKey = targetKey.slice('item:'.length);
    const scheduler = getKnownItemScheduler(itemKey);
    if (!scheduler) return;

    scheduler.syncExternalFetchSuccess(requestIds, startedAt, duration);
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
    reevaluateDelayedRTUs,
  };
}
