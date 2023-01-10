import mitt from 'mitt';
import { useCallback, useEffect, useMemo } from 'react';
import { deepEqual, Store, useSubscribeToStore } from 't-state';
import { createCollectionFetchOrquestrator } from './collectionFetchOrquestrator';
import {
  FetchType,
  ScheduleFetchResults,
  FetchContext as FetchCtx,
} from './fetchOrquestrator';
import { Status, ValidPayload, ValidStoreState } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { filterAndMap } from './utils/filterAndMap';
import { getCacheId } from './utils/getCacheId';
import { useConst, useDeepMemo, useOnMittEvent } from './utils/hooks';

type QueryStatus = Status | 'loadingMore';

type TSFDListQuery<NError, QueryPayload extends ValidPayload> = {
  error: NError | null;
  status: QueryStatus;
  payload: QueryPayload;
  hasMore: boolean;
  wasLoaded: boolean;
  refetchOnMount: boolean;
  items: string[];
};

type TSDFItemQuery<NError> = {
  error: NError | null;
  status: Exclude<QueryStatus, 'loadingMore'>;
  wasLoaded: boolean;
  refetchOnMount: boolean;
};

export type TSFDListQueryState<
  ItemState extends ValidStoreState,
  NError,
  QueryPayload extends ValidPayload,
> = {
  items: Record<string, ItemState | null>;
  queries: Record<string, TSFDListQuery<NError, QueryPayload>>;
  itemQueries: Record<string, TSDFItemQuery<NError> | null>;
};

export type TSFDUseListQueryReturn<Selected, ItemPayload, NError> = {
  items: Selected[];
  status: QueryStatus | 'idle';
  payload: ItemPayload | undefined;
  error: NError | null;
  queryKey: string;
  hasMore: boolean;
  isLoading: boolean;
};

export type TSFDUseItemReturn<Selected, NError> = {
  data: Selected;
  status: QueryStatus | 'idle' | 'deleted';
  itemId: string;
  error: NError | null;
  isLoading: boolean;
};

type FetchListFnReturn<ItemState extends ValidStoreState> = {
  items: { id: string | number; data: ItemState }[];
  hasMore: boolean;
};

const noFetchFnError = 'No fetchItemFn was provided';

export function newTSDFListQueryStore<
  ItemState extends ValidStoreState,
  NError,
  QueryPayload extends ValidPayload,
>({
  debugName,
  fetchListFn,
  fetchItemFn,
  errorNormalizer,
  defaultQuerySize = 50,
  disableRefetchOnWindowFocus,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  lowPriorityThrottleMs,
  mediumPriorityThrottleMs,
  getDynamicRealtimeThrottleMs,
  syncMutationsAndInvalidations,
}: {
  debugName?: string;
  fetchListFn: (
    payload: QueryPayload,
    size: number,
  ) => Promise<FetchListFnReturn<ItemState>>;
  fetchItemFn?: (itemId: string) => Promise<ItemState>;
  errorNormalizer: (exception: unknown) => NError;
  defaultQuerySize?: number;
  disableRefetchOnWindowFocus?: boolean;
  syncMutationsAndInvalidations?: {
    syncQueries: (query1: QueryPayload, query2: QueryPayload) => boolean;
    syncItemAndQuery: (itemId: string, query: QueryPayload) => boolean;
  };
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
  type State = TSFDListQueryState<ItemState, NError, QueryPayload>;
  type Query = TSFDListQuery<NError, QueryPayload>;

  const store = new Store<State>({
    debugName,
    state: { items: {}, queries: {}, itemQueries: {} },
  });

  function getQueryKey(params: QueryPayload): string {
    return getCacheId(params);
  }

  async function fetchQuery(
    fetchCtx: FetchCtx,
    [fetchType, params, size = defaultQuerySize]: [
      'load' | 'loadMore',
      QueryPayload,
      number | undefined,
    ],
  ): Promise<boolean> {
    const queryKey = getQueryKey(params);

    const queryState = store.state.queries[queryKey];

    const isLoading = !queryState?.wasLoaded;

    store.produceState(
      (draft) => {
        const query = draft.queries[queryKey];

        if (!query) {
          draft.queries[queryKey] = {
            error: null,
            status: 'loading',
            wasLoaded: false,
            payload: params,
            refetchOnMount: false,
            hasMore: false,
            items: [],
          };

          return;
        }

        query.status = query.wasLoaded
          ? fetchType === 'loadMore'
            ? 'loadingMore'
            : 'refetching'
          : 'loading';
        query.error = null;
        query.refetchOnMount = false;
      },
      {
        equalityCheck: deepEqual,
        action: {
          type: isLoading
            ? 'fetch-query-start-loading'
            : fetchType === 'loadMore'
            ? 'fetch-query-loading-more'
            : 'refetching-query-start',
          params,
        },
      },
    );

    const currentQuerySize = queryState?.items.length ?? 0;

    const querySize = ((): number => {
      if (fetchType === 'loadMore') {
        return currentQuerySize + size;
      }

      if (isLoading) return size;

      return Math.max(currentQuerySize, size);
    })();

    try {
      const { items, hasMore } = await fetchListFn(params, querySize);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const query = draft.queries[queryKey];

          if (!query) return;

          query.status = 'success';
          query.wasLoaded = true;
          query.hasMore = hasMore;

          query.items = [];

          for (const { data, id } of items) {
            draft.items[id] = data;
            query.items.push(String(id));

            const itemQuery = draft.itemQueries[id];

            if (
              !itemQuery ||
              (itemQuery.status !== 'loading' &&
                itemQuery.status !== 'refetching')
            ) {
              draft.itemQueries[id] = {
                error: null,
                refetchOnMount: false,
                status: 'success',
                wasLoaded: true,
              };
            }
          }
        },
        {
          action: { type: 'fetch-query-success', params },
        },
      );

      for (const { id } of items) {
        const itemFetchOrquestrator = fetchItemOrquestrator?.get(String(id));

        if (itemFetchOrquestrator) {
          itemFetchOrquestrator.setLastFetchStartTime(fetchCtx.getStartTime());
        }
      }

      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      const error = errorNormalizer(exception);

      store.produceState(
        (draft) => {
          const query = draft.queries[queryKey];

          if (!query) return;

          query.status = 'error';
          query.error = error;
        },
        {
          action: { type: 'fetch-query-error', params, error },
        },
      );

      return false;
    }
  }

  function getQueryState(params: QueryPayload): Query | undefined {
    return store.state.queries[getQueryKey(params)];
  }

  function getItemState(
    id: string[] | FilterItemFn,
  ): { id: string; data: ItemState }[];
  function getItemState(id: string): ItemState | null | undefined;
  function getItemState(
    id: string | string[] | FilterItemFn,
  ): ItemState | null | undefined | { id: string; data: ItemState }[] {
    if (typeof id === 'string') {
      return store.state.items[id];
    }

    const itemsId = getItemsIdArray(id);

    return filterAndMap(itemsId, (itemId, ignore) => {
      const item = store.state.items[itemId];
      return !item ? ignore : { id: itemId, data: item };
    });
  }

  const fetchQueryOrquestrator = createCollectionFetchOrquestrator({
    fetchFn: fetchQuery,
    lowPriorityThrottleMs,
    getDynamicRealtimeThrottleMs,
    mediumPriorityThrottleMs,
  });

  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload,
    size?: number,
  ): ScheduleFetchResults;
  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload[],
    size?: number,
  ): ScheduleFetchResults[];
  function scheduleListQueryFetch(
    fetchType: FetchType,
    payload: QueryPayload | QueryPayload[],
    size?: number,
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const multiplePayloads = Array.isArray(payload);

    const payloads = multiplePayloads ? payload : [payload];

    const results = payloads.map((param) => {
      return fetchQueryOrquestrator
        .get(getQueryKey(param))
        .scheduleFetch(fetchType, ['load', param, size]);
    });

    return multiplePayloads ? results : results[0]!;
  }

  function loadMore(params: QueryPayload, size: number): ScheduleFetchResults {
    const queryState = getQueryState(params);

    if (!queryState || !queryState.hasMore) return 'skipped';

    return fetchQueryOrquestrator
      .get(getQueryKey(params))
      .scheduleFetch('highPriority', ['loadMore', params, size]);
  }

  function getQueryItems<T>(
    query: Query,
    itemDataSelector: (data: ItemState, id: string) => T,
  ): T[] {
    return filterAndMap(query.items, (itemId, ignore) => {
      const data = store.state.items[itemId];
      return data ? itemDataSelector(data, itemId) : ignore;
    });
  }

  async function awaitListFetch(
    params: QueryPayload,
    size = defaultQuerySize,
  ): Promise<
    | { items: []; error: NError; hasMore: boolean }
    | {
        items: { data: ItemState; id: string }[];
        error: null;
        hasMore: boolean;
      }
  > {
    const queryKey = getQueryKey(params);

    const wasAborted = await fetchQueryOrquestrator
      .get(queryKey)
      .awaitFetch(['load', params, size]);

    if (wasAborted) {
      return {
        items: [],
        error: errorNormalizer(new Error('Aborted')),
        hasMore: false,
      };
    }

    const query = store.state.queries[queryKey];

    if (!query) {
      return {
        items: [],
        error: errorNormalizer(new Error('Not found')),
        hasMore: false,
      };
    }

    return query.error
      ? { items: [], error: query.error, hasMore: query.hasMore }
      : {
          items: getQueryItems(query, (data, id) => ({ data, id })),
          error: null,
          hasMore: query.hasMore,
        };
  }

  // FIX: add tests
  async function awaitItemFetch(itemId: string): Promise<
    | { data: null; error: NError }
    | {
        data: ItemState;
        error: null;
      }
  > {
    if (!fetchItemOrquestrator) throw new Error(noFetchFnError);

    const wasAborted = await fetchItemOrquestrator
      .get(itemId)
      .awaitFetch(itemId);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    const itemData = store.state.items[itemId];
    const itemQuery = store.state.itemQueries[itemId];

    if (!itemQuery || !itemData) {
      return { data: null, error: errorNormalizer(new Error('Not found')) };
    }

    return itemQuery.error
      ? { data: null, error: itemQuery.error }
      : { data: itemData, error: null };
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
        ([queryKey, query], ignore) => {
          return payloads(query.payload, query, queryKey)
            ? {
                key: queryKey,
                payload: query.payload,
              }
            : ignore;
        },
      );
    } else {
      return [{ key: getQueryKey(payloads), payload: payloads }];
    }
  }

  const storeEvents = mitt<{
    invalidateQuery: { priority: FetchType; queryKey: string };
    invalidateItem: { priority: FetchType; itemId: string };
  }>();

  const queryInvalidationWasTriggered = new Set<string>();

  function invalidateQuery(
    queryPayload: QueryPayload | QueryPayload[] | FilterQueryFn,
    priority: 'highPriority' | 'lowPriority' = 'highPriority',
    ignoreInvalidationSync = false,
  ) {
    const queriesKey = getQueriesKeyArray(queryPayload);

    for (const { key } of queriesKey) {
      store.produceState(
        (draft) => {
          const query = draft.queries[key];

          if (!query) return;

          query.refetchOnMount = true;
        },
        { action: { type: 'invalidate-data', key } },
      );

      queryInvalidationWasTriggered.delete(key);
      storeEvents.emit('invalidateQuery', { priority, queryKey: key });
    }

    if (syncMutationsAndInvalidations && !ignoreInvalidationSync) {
      invalidateItem(
        (_, itemId) =>
          queriesKey.some(({ payload }) => {
            return syncMutationsAndInvalidations.syncItemAndQuery(
              itemId,
              payload,
            );
          }),
        'highPriority',
        true,
      );

      invalidateQuery(
        (queryToInvalidatePayload, _, queryToInvalidateKey) =>
          queriesKey.some((alreadyInvalidatedQueryPayload) => {
            return (
              queryToInvalidateKey !== alreadyInvalidatedQueryPayload.key &&
              syncMutationsAndInvalidations.syncQueries(
                alreadyInvalidatedQueryPayload.payload,
                queryToInvalidatePayload,
              )
            );
          }),
        'highPriority',
        true,
      );
    }
  }

  function defaultItemSelector<T>(data: ItemState, id: string): T {
    return { id, data } as T;
  }

  function useMultipleListQueries<
    SelectedItem = { id: string; data: ItemState },
  >(
    queries: readonly QueryPayload[],
    {
      itemSelector = defaultItemSelector,
      omitPayload,
      returnIdleStatus,
      returnRefetchingStatus,
      // FIXLATER: add tests
      loadSize,
      disableRefetchOnMount = globalDisableRefetchOnMount,
    }: {
      itemSelector?: (data: ItemState, id: string) => SelectedItem;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      loadSize?: number;
    } = {},
  ) {
    type QueryWithId = {
      key: string;
      payload: QueryPayload;
    };

    const queriesWithId = useDeepMemo(() => {
      return queries.map((payload): QueryWithId => {
        return {
          key: getQueryKey(payload),
          payload,
        };
      });
    }, [queries]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const dataSelector = useCallback(itemSelector, []);

    const resultSelector = useCallback(
      (state: State) => {
        return queriesWithId.map(
          ({
            key: queryKey,
            payload,
          }): TSFDUseListQueryReturn<SelectedItem, QueryPayload, NError> => {
            const query = state.queries[queryKey];

            if (!query) {
              return {
                queryKey,
                status: returnIdleStatus ? 'idle' : 'loading',
                items: [],
                error: null,
                hasMore: false,
                payload: omitPayload ? undefined : payload,
                isLoading: returnIdleStatus ? false : true,
              };
            }

            let status = query.status;

            if (!returnRefetchingStatus && query.status === 'refetching') {
              status = 'success';
            }

            return {
              queryKey,
              status,
              items: getQueryItems(query, dataSelector),
              error: query.error,
              hasMore: query.hasMore,
              isLoading: status === 'loading',
              payload: omitPayload ? undefined : query.payload,
            };
          },
        );
      },
      [
        dataSelector,
        omitPayload,
        queriesWithId,
        returnIdleStatus,
        returnRefetchingStatus,
      ],
    );

    const storeState = store.useSelector(resultSelector, {
      equalityFn: deepEqual,
      useExternalDeps: true,
    });

    useOnMittEvent(storeEvents, 'invalidateQuery', (event) => {
      for (const { key, payload } of queriesWithId) {
        if (key !== event.queryKey) continue;

        if (!queryInvalidationWasTriggered.has(key)) {
          scheduleListQueryFetch(event.priority, payload);
          queryInvalidationWasTriggered.add(key);
        }
      }
    });

    const loadSizeConst = useConst(() => loadSize);

    useEffect(() => {
      for (const { key: itemId, payload: fetchParams } of queriesWithId) {
        if (itemId) {
          if (disableRefetchOnMount) {
            const itemState = getQueryState(fetchParams);

            const shouldFetch =
              !itemState || !itemState.wasLoaded || itemState.refetchOnMount;

            if (!shouldFetch) return;
          }

          scheduleListQueryFetch('lowPriority', fetchParams, loadSizeConst);
        }
      }
    }, [disableRefetchOnMount, loadSizeConst, queriesWithId]);

    return storeState;
  }

  function useListQuery<SelectedItem = { id: string; data: ItemState }>(
    payload: QueryPayload | false | null | undefined,
    options: {
      itemSelector?: (data: ItemState, id: string) => SelectedItem;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      ensureIsLoaded?: boolean;
      loadSize?: number;
    } = {},
  ) {
    const { ensureIsLoaded } = options;

    const query = useMemo(
      () =>
        payload === false || payload === null || payload === undefined
          ? []
          : [payload],
      [payload],
    );

    const queryResult = useMultipleListQueries(query, options);

    const result = useMemo(
      (): TSFDUseListQueryReturn<SelectedItem, QueryPayload, NError> =>
        queryResult[0] ?? {
          payload: undefined,
          error: null,
          hasMore: false,
          isLoading: false,
          status: 'idle',
          queryKey: '',
          items: [],
        },
      [queryResult],
    );

    const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
      ensureIsLoaded,
      !!payload,
      () => {
        if (payload) {
          scheduleListQueryFetch('highPriority', payload);
        }
      },
    );

    useSubscribeToStore(store, ({ observe }) => {
      if (!ensureIsLoaded) return;

      observe
        .ifSelector((state) => state.queries[result.queryKey]?.status)
        .change.then(({ current }) => {
          if (current === 'success' || current === 'error') {
            emitIsLoadedEvt('isLoaded', true);
          }
        });
    });

    return useModifyResult(result);
  }

  async function fetchItem(
    fetchCtx: FetchCtx,
    itemId: string,
  ): Promise<boolean> {
    if (!fetchItemOrquestrator) {
      throw new Error(noFetchFnError);
    }

    const isLoaded = !store.state.itemQueries[itemId]?.wasLoaded;

    store.produceState(
      (draft) => {
        const itemQuery = draft.itemQueries[itemId];

        if (!itemQuery) {
          draft.itemQueries[itemId] = {
            status: 'loading',
            error: null,
            wasLoaded: false,
            refetchOnMount: false,
          };

          return;
        }

        itemQuery.status = itemQuery.wasLoaded ? 'refetching' : 'loading';
        itemQuery.error = null;
        itemQuery.refetchOnMount = false;
      },
      {
        action: {
          type: isLoaded ? 'fetch-item-start' : 'fetch-item-refetch-start',
          itemId,
        },
      },
    );

    try {
      const item = await fetchItemFn(itemId);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const itemQuery = draft.itemQueries[itemId];

          if (!itemQuery) return;

          itemQuery.status = 'success';
          itemQuery.wasLoaded = true;

          draft.items[itemId] = item;
        },
        {
          action: { type: 'fetch-item-success', itemId },
        },
      );
      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      const error = errorNormalizer(exception);

      store.produceState(
        (draft) => {
          const itemQuery = draft.itemQueries[itemId];

          if (!itemQuery) return;

          itemQuery.status = 'error';
          itemQuery.error = error;
        },
        {
          action: { type: 'fetch-item-error', itemId },
        },
      );

      return false;
    }
  }

  const fetchItemOrquestrator =
    fetchItemFn &&
    createCollectionFetchOrquestrator({
      fetchFn: fetchItem,
      lowPriorityThrottleMs,
      getDynamicRealtimeThrottleMs,
      mediumPriorityThrottleMs,
    });

  function scheduleItemFetch(
    fetchType: FetchType,
    itemId: string,
  ): ScheduleFetchResults;
  function scheduleItemFetch(
    fetchType: FetchType,
    itemId: string[],
  ): ScheduleFetchResults[];
  function scheduleItemFetch(
    fetchType: FetchType,
    itemId: string | string[],
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    if (!fetchItemOrquestrator) {
      throw new Error(noFetchFnError);
    }

    const fetchMultiple = Array.isArray(itemId);

    const itemsId = fetchMultiple ? itemId : [itemId];

    const results = itemsId.map((id) => {
      return fetchItemOrquestrator.get(id).scheduleFetch(fetchType, id);
    });

    return fetchMultiple ? results : results[0]!;
  }

  type FilterItemFn = (item: ItemState, itemId: string) => boolean;

  function getItemsIdArray(itemId: string | string[] | FilterItemFn): string[] {
    if (Array.isArray(itemId)) {
      return itemId;
    }

    if (typeof itemId === 'function') {
      return filterAndMap(
        Object.entries(store.state.items),
        ([id, item], ignore) => {
          if (item === null) return ignore;

          return itemId(item, id) ? id : ignore;
        },
      );
    }

    return [itemId];
  }

  const itemInvalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemId: string | string[] | FilterItemFn,
    priority: 'highPriority' | 'lowPriority' = 'highPriority',
    ignoreInvalidationSync = false,
  ) {
    if (!fetchItemOrquestrator) {
      throw new Error(noFetchFnError);
    }

    const itemsId = getItemsIdArray(itemId);

    for (const id of itemsId) {
      store.produceState(
        (draft) => {
          const query = draft.itemQueries[id];

          if (!query) return;

          query.refetchOnMount = true;
        },
        { action: { type: 'invalidate-item', queryKey: id } },
      );

      itemInvalidationWasTriggered.delete(id);
      storeEvents.emit('invalidateItem', { priority, itemId: id });
    }

    if (syncMutationsAndInvalidations && !ignoreInvalidationSync) {
      invalidateQuery(
        (query) =>
          itemsId.some((id) =>
            syncMutationsAndInvalidations.syncItemAndQuery(id, query),
          ),
        'highPriority',
        true,
      );
    }
  }

  function startItemMutation(itemId: string | string[] | FilterItemFn) {
    if (!fetchItemOrquestrator) throw new Error(noFetchFnError);

    const itemsId = getItemsIdArray(itemId);

    const endMutations: (() => void)[] = [];

    for (const id of itemsId) {
      endMutations.push(fetchItemOrquestrator.get(id).startMutation());

      if (syncMutationsAndInvalidations) {
        for (const [queryKey, query] of Object.entries(store.state.queries)) {
          if (
            syncMutationsAndInvalidations.syncItemAndQuery(id, query.payload)
          ) {
            endMutations.push(
              fetchQueryOrquestrator.get(queryKey).startMutation(),
            );
          }
        }
      }
    }

    return () => {
      for (const endMutation of endMutations) {
        endMutation();
      }
    };
  }

  function defaultItemDataSelector<T>(data: ItemState | null): T {
    return data as unknown as T;
  }

  function useMultipleItems<SelectedItem = ItemState>(
    itemIds: string[],
    {
      selector = defaultItemDataSelector,
      returnIdleStatus,
      returnRefetchingStatus,
      disableRefetchOnMount,
    }: {
      selector?: (data: ItemState | null, id: string) => SelectedItem;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
    } = {},
  ) {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const dataSelector = useCallback(selector, []);

    const memoizedItemIds = useDeepMemo(() => itemIds, [itemIds]);

    const resultSelector = useCallback(
      (state: State) => {
        return memoizedItemIds.map(
          (itemId): TSFDUseItemReturn<SelectedItem, NError> => {
            const itemQuery = state.itemQueries[itemId];
            const itemState = state.items[itemId];

            if (itemQuery === null) {
              return {
                status: 'deleted',
                error: null,
                isLoading: false,
                itemId,
                data: dataSelector(null, itemId),
              };
            }

            if (!itemQuery) {
              return {
                status: returnIdleStatus ? 'idle' : 'loading',
                error: null,
                isLoading: returnIdleStatus ? false : true,
                itemId,
                data: dataSelector(null, itemId),
              };
            }

            let status = itemQuery.status;

            if (!returnRefetchingStatus && itemQuery.status === 'refetching') {
              status = 'success';
            }

            return {
              status,
              error: itemQuery.error,
              isLoading: status === 'loading',
              data: dataSelector(itemState ?? null, itemId),
              itemId,
            };
          },
        );
      },
      [dataSelector, memoizedItemIds, returnIdleStatus, returnRefetchingStatus],
    );

    const storeState = store.useSelector(resultSelector, {
      equalityFn: deepEqual,
      useExternalDeps: true,
    });

    useOnMittEvent(storeEvents, 'invalidateItem', (event) => {
      for (const itemId of memoizedItemIds) {
        if (itemId !== event.itemId) continue;

        if (!itemInvalidationWasTriggered.has(itemId)) {
          scheduleItemFetch(event.priority, itemId);
          itemInvalidationWasTriggered.add(itemId);
        }
      }
    });

    useEffect(() => {
      for (const itemId of memoizedItemIds) {
        if (itemId) {
          if (disableRefetchOnMount) {
            const itemState = store.state.itemQueries[itemId];

            const shouldFetch =
              !itemState || !itemState.wasLoaded || itemState.refetchOnMount;

            if (!shouldFetch) return;
          }

          scheduleItemFetch('lowPriority', itemId);
        }
      }
    }, [disableRefetchOnMount, memoizedItemIds]);

    return storeState;
  }

  function useItem<SelectedItem = ItemState>(
    itemId: string | false | null | undefined,
    options: {
      selector?: (data: ItemState | null, id: string) => SelectedItem;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      ensureIsLoaded?: boolean;
    } = {},
  ) {
    const { ensureIsLoaded } = options;

    const query = useMemo(
      () =>
        itemId === false || itemId === null || itemId === undefined
          ? []
          : [itemId],
      [itemId],
    );

    const queryResult = useMultipleItems<SelectedItem>(query, options);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const memoizedSelector = useCallback(
      options.selector ?? defaultItemDataSelector,
      [],
    );

    const result = useMemo(
      (): TSFDUseItemReturn<SelectedItem, NError> =>
        queryResult[0] ?? {
          error: null,
          isLoading: false,
          status: 'idle',
          data: memoizedSelector(null, itemId || ''),
          itemId: itemId || '',
        },
      [itemId, memoizedSelector, queryResult],
    );

    const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
      ensureIsLoaded,
      !!itemId,
      () => {
        if (itemId) {
          scheduleItemFetch('highPriority', itemId);
        }
      },
    );

    useSubscribeToStore(store, ({ observe }) => {
      if (!ensureIsLoaded || !itemId) return;

      observe
        .ifSelector((state) => state.itemQueries[itemId]?.status)
        .change.then(({ current }) => {
          if (current === 'success' || current === 'error') {
            emitIsLoadedEvt('isLoaded', true);
          }
        });
    });

    return useModifyResult(result);
  }

  function updateItemState(
    itemIds: string | string[] | FilterItemFn,
    produceNewData: (draftData: ItemState, itemId: string) => void | ItemState,
    ifNothingWasUpdated?: () => void,
  ): boolean {
    const itemKeys = getItemsIdArray(itemIds);

    let someItemWasUpdated = false as boolean;

    store.batch(
      () => {
        store.produceState((draftState) => {
          for (const itemId of itemKeys) {
            const item = draftState.items[itemId];

            if (!item) continue;

            someItemWasUpdated = true;
            const newData = produceNewData(item, itemId);

            if (newData) {
              draftState.items[itemId] = newData;
            }
          }
        });

        if (ifNothingWasUpdated && !someItemWasUpdated) {
          ifNothingWasUpdated();
        }
      },
      { type: 'update-item-state', item: itemKeys },
    );

    return someItemWasUpdated;
  }

  function addItemToState(itemId: string, data: ItemState) {
    store.produceState(
      (draftState) => {
        draftState.items[itemId] = data;
        draftState.itemQueries[itemId] = {
          status: 'success',
          wasLoaded: true,
          refetchOnMount: false,
          error: null,
        };
      },
      { action: { type: 'create-item-state', itemId } },
    );
  }

  function deleteItemState(itemId: string | string[] | FilterItemFn) {
    const itemsId = getItemsIdArray(itemId);

    store.produceState(
      (draftState) => {
        for (const itemKey of itemsId) {
          draftState.items[itemKey] = null;
          draftState.itemQueries[itemKey] = null;

          for (const query of Object.values(draftState.queries)) {
            if (query.items.includes(itemKey)) {
              query.items = query.items.filter((i) => i !== itemKey);
            }
          }
        }
      },
      { action: { type: 'delete-item-state', itemId } },
    );
  }

  if (!disableRefetchOnWindowFocus) {
    function handleFocus() {
      invalidateQuery(() => true, 'lowPriority');
      invalidateItem(() => true, 'lowPriority');
    }

    window.addEventListener('focus', handleFocus);
    window.addEventListener('visibilitychange', handleFocus);
  }

  return {
    store,
    scheduleListQueryFetch,
    getQueryState,
    getQueryKey,
    deleteItemState,
    getItemState,
    loadMore,
    awaitItemFetch,
    invalidateQuery,
    invalidateItem,
    scheduleItemFetch,
    awaitListFetch,
    useMultipleListQueries,
    useListQuery,
    useItem,
    useMultipleItems,
    addItemToState,
    updateItemState,
    startItemMutation,
  };
}
