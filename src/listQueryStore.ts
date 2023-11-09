import { evtmitter } from 'evtmitter';
import { useOnEvtmitterEvent } from 'evtmitter/react';
import { klona } from 'klona/json';
import { useCallback, useEffect, useMemo } from 'react';
import { Store, deepEqual, useSubscribeToStore } from 't-state';
import { createCollectionFetchOrquestrator } from './collectionFetchOrquestrator';
import {
  FetchContext as FetchCtx,
  FetchType,
  ScheduleFetchResults,
} from './fetchOrquestrator';
import {
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
  fetchTypePriority,
} from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { filterAndMap } from './utils/filterAndMap';
import { findAndMap } from './utils/findAndMap';
import { getCacheId } from './utils/getCacheId';
import { useConst, useDeepMemo } from './utils/hooks';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import { sortBy } from './utils/sortBy';
import { NonPartial } from './utils/types';

type QueryStatus = TSDFStatus | 'loadingMore';

export type TSFDListQuery<NError, QueryPayload extends ValidPayload> = {
  error: NError | null;
  status: QueryStatus;
  payload: QueryPayload;
  hasMore: boolean;
  wasLoaded: boolean;
  refetchOnMount: false | FetchType;
  items: string[];
};

export type TSDFItemQuery<NError, ItemPayload> = {
  error: NError | null;
  status: Exclude<QueryStatus, 'loadingMore'>;
  wasLoaded: boolean;
  refetchOnMount: false | FetchType;
  payload: ItemPayload;
};

export type TSFDListQueryState<
  ItemState extends ValidStoreState,
  NError,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  items: Record<string, ItemState | null>;
  queries: Record<string, TSFDListQuery<NError, QueryPayload>>;
  itemQueries: Record<string, TSDFItemQuery<NError, ItemPayload> | null>;
};

export type TSFDUseListQueryReturn<
  Selected,
  ItemPayload,
  NError,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  items: Selected[];
  status: QueryStatus | 'idle';
  payload: ItemPayload | undefined;
  error: NError | null;
  queryKey: string;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  queryMetadata: QueryMetadata;
};

export type TSFDUseListItemReturn<
  Selected,
  NError,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  data: Selected;
  status: QueryStatus | 'idle' | 'deleted';
  payload: ItemPayload | null;
  error: NError | null;
  isLoading: boolean;
  queryMetadata: QueryMetadata;
};

export type FetchListFnReturnItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = {
  itemPayload: ItemPayload;
  data: ItemState;
};

export type FetchListFnReturn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  items: FetchListFnReturnItem<ItemPayload, ItemState>[];
  hasMore: boolean;
};

export type ListQueryStoreInitialData<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  items: { payload: ItemPayload; data: ItemState }[];
  queries: {
    payload: QueryPayload;
    items: string[];
    hasMore: boolean;
  }[];
};

const noFetchFnError = 'No fetchItemFn was provided';

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

export type ListQueryUseMultipleItemsQuery<
  ItemPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown>,
> = {
  payload: ItemPayload;
  queryMetadata?: QueryMetadata;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
};

export type ListQueryUseMultipleListQueriesQuery<
  QueryPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown>,
> = {
  payload: QueryPayload;
  queryMetadata?: QueryMetadata;
  omitPayload?: boolean;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
  loadSize?: number;
};

export function newTSDFListQueryStore<
  ItemState extends ValidStoreState,
  NError,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>({
  debugName,
  fetchListFn,
  fetchItemFn,
  errorNormalizer,
  defaultQuerySize = 50,
  getInitialData,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  lowPriorityThrottleMs,
  disableInitialDataInvalidation,
  mediumPriorityThrottleMs,
  dynamicRealtimeThrottleMs,
  syncMutationsAndInvalidations,
  optimisticListUpdates,
  onInvalidateItem,
  onInvalidateQuery,
}: {
  debugName?: string;
  fetchListFn: (
    payload: QueryPayload,
    size: number,
  ) => Promise<FetchListFnReturn<ItemState, ItemPayload>>;
  fetchItemFn?: (itemId: ItemPayload) => Promise<ItemState>;
  errorNormalizer: (exception: unknown) => NError;
  defaultQuerySize?: number;
  getInitialData?: () =>
    | ListQueryStoreInitialData<ItemState, QueryPayload, ItemPayload>
    | undefined;
  disableInitialDataInvalidation?: boolean;
  syncMutationsAndInvalidations?: {
    syncQueries: (query1: QueryPayload, query2: QueryPayload) => boolean;
    syncItemAndQuery: (
      itemPayload: ItemPayload,
      query: QueryPayload,
    ) => boolean;
  };
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  optimisticListUpdates?: {
    queries: QueryPayload | ((query: QueryPayload) => boolean) | QueryPayload[];
    filterItem?: (item: ItemState) => boolean | null;
    /** @default 'end' */
    appendNewTo?: 'start' | 'end';
    invalidateQueries?: boolean;
    sort?: {
      sortBy: (
        item: ItemState,
        itemPayload: ItemPayload,
      ) => string | number | (string | number)[];
      /** @default 'asc' */
      order?: 'asc' | 'desc' | ('asc' | 'desc')[];
    };
  }[];
  onInvalidateQuery?: OnListQueryInvalidate<QueryPayload>;
  onInvalidateItem?: OnListQueryItemInvalidate<ItemState, ItemPayload>;
}) {
  type State = TSFDListQueryState<ItemState, NError, QueryPayload, ItemPayload>;
  type Query = TSFDListQuery<NError, QueryPayload>;

  const store = new Store<State>({
    debugName,
    state: () => {
      const initialState: State = { items: {}, queries: {}, itemQueries: {} };

      const initialData = getInitialData?.();

      if (initialData) {
        for (const { payload, data } of initialData.items) {
          const itemKey = getItemKey(payload);

          initialState.items[itemKey] = data;
          initialState.itemQueries[itemKey] = {
            error: null,
            status: 'success',
            refetchOnMount: disableInitialDataInvalidation
              ? false
              : 'lowPriority',
            wasLoaded: true,
            payload,
          };
        }

        for (const { payload, items, hasMore } of initialData.queries) {
          const queryKey = getQueryKey(payload);

          initialState.queries[queryKey] = {
            error: null,
            status: 'success',
            refetchOnMount: disableInitialDataInvalidation
              ? false
              : 'lowPriority',
            wasLoaded: true,
            payload,
            items,
            hasMore,
          };
        }
      }

      return initialState;
    },
  });

  function getQueryKey(params: QueryPayload): string {
    return getCacheId(params);
  }

  function getItemKey(params: ItemPayload): string {
    return getCacheId(params);
  }

  async function fetchQuery(
    fetchCtx: FetchCtx,
    [fetchType, queryPayload, size = defaultQuerySize]: [
      'load' | 'loadMore',
      QueryPayload,
      number | undefined,
    ],
  ): Promise<boolean> {
    const payload = klona(queryPayload);
    const queryKey = getQueryKey(payload);

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
            payload,
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
          payload,
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
      const { items, hasMore } = await fetchListFn(payload, querySize);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const query = draft.queries[queryKey];

          if (!query) return;

          query.status = 'success';
          query.wasLoaded = true;
          query.hasMore = hasMore;

          query.items = [];

          for (const { data, itemPayload } of items) {
            const itemKey = getItemKey(itemPayload);

            draft.items[itemKey] = reusePrevIfEqual<ItemState>({
              current: data,
              prev: draft.items[itemKey] ?? undefined,
            });
            query.items.push(String(itemKey));

            const itemQuery = draft.itemQueries[itemKey];

            if (
              !itemQuery ||
              (itemQuery.status !== 'loading' &&
                itemQuery.status !== 'refetching')
            ) {
              draft.itemQueries[itemKey] = {
                error: null,
                refetchOnMount: false,
                status: 'success',
                wasLoaded: true,
                payload: itemPayload,
              };
            }
          }
        },
        {
          action: { type: 'fetch-query-success', payload },
        },
      );

      for (const { itemPayload: id } of items) {
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
          action: { type: 'fetch-query-error', payload, error },
        },
      );

      return false;
    }
  }

  function getQueryState(params: QueryPayload): Query | undefined {
    return store.state.queries[getQueryKey(params)];
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

      return filterAndMap(itemsId, ({ itemKey }, ignore) => {
        const item = store.state.items[itemKey];

        const payload = store.state.itemQueries[itemKey]?.payload;

        return !item || !payload ? ignore : { payload, data: item };
      });
    }

    return store.state.items[getItemKey(itemPayload)];
  }

  const fetchQueryOrquestrator = createCollectionFetchOrquestrator({
    fetchFn: fetchQuery,
    lowPriorityThrottleMs,
    dynamicRealtimeThrottleMs,
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

  function loadMore(params: QueryPayload, size?: number): ScheduleFetchResults {
    const queryState = getQueryState(params);

    if (!queryState || !queryState.hasMore) return 'skipped';

    if (queryState.status !== 'success') return 'skipped';

    return fetchQueryOrquestrator
      .get(getQueryKey(params))
      .scheduleFetch('highPriority', ['loadMore', params, size]);
  }

  function getQueryItems<T>(
    query: Query,
    itemDataSelector: (
      data: ItemState,
      itemPayload: ItemPayload,
      itemKey: string,
    ) => T,
  ): T[] {
    return filterAndMap(query.items, (itemKey, ignore) => {
      const item = store.state.items[itemKey];
      const itemPayload = store.state.itemQueries[itemKey]?.payload;
      return item && itemPayload
        ? itemDataSelector(item, itemPayload, itemKey)
        : ignore;
    });
  }

  async function awaitListQueryFetch(
    params: QueryPayload,
    size = defaultQuerySize,
  ): Promise<
    | { items: []; error: NError; hasMore: boolean }
    | {
        items: { data: ItemState; itemPayload: ItemPayload }[];
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

    if (query?.error) {
      return {
        items: [],
        error: query.error,
        hasMore: query.hasMore,
      };
    }

    if (!query) {
      return {
        items: [],
        error: errorNormalizer(new Error('Not found')),
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

  async function awaitItemFetch(
    itemPayload: ItemPayload,
  ): Promise<{ data: null; error: NError } | { data: ItemState; error: null }> {
    if (!fetchItemOrquestrator) throw new Error(noFetchFnError);

    const itemKey = getItemKey(itemPayload);

    const wasAborted = await fetchItemOrquestrator
      .get(itemKey)
      .awaitFetch(itemPayload);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    const item = store.state.items[itemKey];
    const itemQuery = store.state.itemQueries[itemKey];

    if (itemQuery?.error) {
      return { data: null, error: itemQuery.error };
    }

    if (!itemQuery || !item) {
      return { data: null, error: errorNormalizer(new Error('Not found')) };
    }

    return { data: item, error: null };
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

  const storeEvents = evtmitter<{
    invalidateQuery: { priority: FetchType; queryKey: string };
    invalidateItem: { priority: FetchType; itemKey: string };
  }>();

  const queryInvalidationWasTriggered = new Set<string>();

  function invalidateQuery(
    queryPayload: QueryPayload | QueryPayload[] | FilterQueryFn,
    priority: FetchType = 'highPriority',
    ignoreInvalidationSync = false,
  ) {
    const queriesKey = getQueriesKeyArray(queryPayload);

    for (const { key, payload } of queriesKey) {
      const queryState = store.state.queries[key];

      if (!queryState) continue;

      const currentInvalidationPriority = queryState.refetchOnMount
        ? fetchTypePriority[queryState.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const query = draft.queries[key];

          if (!query) return;

          query.refetchOnMount = priority;
        },
        { action: { type: 'invalidate-data', key } },
      );

      queryInvalidationWasTriggered.delete(key);
      storeEvents.emit('invalidateQuery', { priority, queryKey: key });

      onInvalidateQuery?.(payload, priority);
    }

    if (syncMutationsAndInvalidations && !ignoreInvalidationSync) {
      invalidateItem(
        (itemPayload) =>
          queriesKey.some(({ payload }) => {
            return syncMutationsAndInvalidations.syncItemAndQuery(
              itemPayload,
              payload,
            );
          }),
        priority,
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
        priority,
        true,
      );
    }
  }

  function defaultItemSelector<T>(data: ItemState): T {
    return data as unknown as T;
  }

  type DefaultSelectedItem = ItemState;

  function useMultipleListQueries<
    SelectedItem = DefaultSelectedItem,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    queries: ListQueryUseMultipleListQueriesQuery<
      QueryPayload,
      QueryMetadata
    >[],
    {
      itemSelector = defaultItemSelector,
      selectorUsesExternalDeps,
    }: {
      itemSelector?: (
        data: ItemState,
        id: ItemPayload,
        itemKey: string,
      ) => SelectedItem;
      selectorUsesExternalDeps?: boolean;
    } = {},
  ) {
    type QueryWithId = {
      key: string;
    } & NonPartial<
      ListQueryUseMultipleListQueriesQuery<QueryPayload, QueryMetadata>
    >;

    const queriesWithId = useDeepMemo(() => {
      return queries.map((item): QueryWithId => {
        return {
          key: getQueryKey(item.payload),
          payload: item.payload,
          disableRefetchOnMount:
            item.disableRefetchOnMount ?? globalDisableRefetchOnMount,
          returnIdleStatus: item.returnIdleStatus,
          returnRefetchingStatus: item.returnRefetchingStatus,
          queryMetadata: item.queryMetadata,
          isOffScreen: item.isOffScreen,
          omitPayload: item.omitPayload,
          loadSize: item.loadSize,
        };
      });
    }, [queries]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const dataSelector = useCallback(itemSelector, [
      selectorUsesExternalDeps ? itemSelector : 0,
    ]);

    const resultSelector = useCallback(
      (state: State) => {
        return queriesWithId.map(
          ({
            key: queryKey,
            payload,
            returnIdleStatus,
            returnRefetchingStatus,
            omitPayload,
            queryMetadata,
          }): TSFDUseListQueryReturn<
            SelectedItem,
            QueryPayload,
            NError,
            QueryMetadata
          > => {
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
                isLoadingMore: false,
                queryMetadata: queryMetadata as QueryMetadata,
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
              isLoadingMore: status === 'loadingMore',
              queryMetadata: queryMetadata as QueryMetadata,
            };
          },
        );
      },
      [dataSelector, queriesWithId],
    );

    const storeState = store.useSelector(resultSelector, {
      equalityFn: deepEqual,
      useExternalDeps: true,
    });

    useOnEvtmitterEvent(storeEvents, 'invalidateQuery', (event) => {
      for (const { key, payload, isOffScreen } of queriesWithId) {
        if (isOffScreen) continue;

        if (key !== event.queryKey) continue;

        if (!queryInvalidationWasTriggered.has(key)) {
          store.produceState((draft) => {
            const query = draft.queries[key];

            if (!query?.refetchOnMount) return;

            query.refetchOnMount = false;
          });

          scheduleListQueryFetch(event.priority, payload);
          queryInvalidationWasTriggered.add(key);
        }
      }
    });

    const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

    useEffect(() => {
      const removedItems = new Set(ignoreItemsInRefetchOnMount);

      for (const {
        key: itemId,
        payload: fetchParams,
        isOffScreen,
        loadSize,
        disableRefetchOnMount,
      } of queriesWithId) {
        removedItems.delete(itemId);

        if (isOffScreen) continue;

        if (itemId) {
          const itemState = getQueryState(fetchParams);
          const fetchType = itemState?.refetchOnMount || 'lowPriority';

          const shouldFetch =
            !itemState || !itemState.wasLoaded || itemState.refetchOnMount;

          if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemId)) {
            continue;
          }

          ignoreItemsInRefetchOnMount.add(itemId);

          if (disableRefetchOnMount) {
            if (shouldFetch) {
              scheduleListQueryFetch(fetchType, fetchParams, loadSize);
              continue;
            }
          } else {
            scheduleListQueryFetch(fetchType, fetchParams, loadSize);
          }
        }
      }

      for (const itemKey of removedItems) {
        ignoreItemsInRefetchOnMount.delete(itemKey);
      }
    }, [ignoreItemsInRefetchOnMount, queriesWithId]);

    return storeState;
  }

  function useListQuery<SelectedItem = DefaultSelectedItem>(
    payload: QueryPayload | false | null | undefined,
    {
      isOffScreen,
      itemSelector,
      disableRefetchOnMount,
      returnIdleStatus,
      returnRefetchingStatus,
      loadSize,
      omitPayload,
      ensureIsLoaded,
      selectorUsesExternalDeps,
    }: {
      itemSelector?: (
        data: ItemState,
        id: ItemPayload,
        itemKey: string,
      ) => SelectedItem;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      ensureIsLoaded?: boolean;
      loadSize?: number;
      isOffScreen?: boolean;
      selectorUsesExternalDeps?: boolean;
    } = {},
  ) {
    const query = useMemo(
      (): ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[] =>
        payload === false || payload === null || payload === undefined
          ? []
          : [
              {
                payload,
                disableRefetchOnMount,
                returnIdleStatus,
                returnRefetchingStatus,
                omitPayload,
                isOffScreen,
                loadSize,
              },
            ],
      [
        disableRefetchOnMount,
        isOffScreen,
        loadSize,
        omitPayload,
        payload,
        returnIdleStatus,
        returnRefetchingStatus,
      ],
    );

    const queryResult = useMultipleListQueries(query, {
      itemSelector,
      selectorUsesExternalDeps,
    });

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
          isLoadingMore: false,
          queryMetadata: undefined,
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
    itemPayload: ItemPayload,
  ): Promise<boolean> {
    if (!fetchItemOrquestrator) {
      throw new Error(noFetchFnError);
    }

    const itemKey = getCacheId(itemPayload);

    const isLoaded = !store.state.itemQueries[itemKey]?.wasLoaded;

    store.produceState(
      (draft) => {
        const itemQuery = draft.itemQueries[itemKey];

        if (!itemQuery) {
          draft.itemQueries[itemKey] = {
            status: 'loading',
            error: null,
            wasLoaded: false,
            refetchOnMount: false,
            payload: klona(itemPayload),
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
          itemPayload,
        },
      },
    );

    try {
      const item = await fetchItemFn(itemPayload);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const itemQuery = draft.itemQueries[itemKey];

          if (!itemQuery) return;

          itemQuery.status = 'success';
          itemQuery.wasLoaded = true;

          draft.items[itemKey] = reusePrevIfEqual<ItemState>({
            current: item,
            prev: draft.items[itemKey] ?? undefined,
          });
        },
        {
          action: { type: 'fetch-item-success', itemPayload },
        },
      );
      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      const error = errorNormalizer(exception);

      store.produceState(
        (draft) => {
          const itemQuery = draft.itemQueries[itemKey];

          if (!itemQuery) return;

          itemQuery.status = 'error';
          itemQuery.error = error;
        },
        {
          action: { type: 'fetch-item-error', itemPayload },
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
      dynamicRealtimeThrottleMs,
      mediumPriorityThrottleMs,
    });

  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload,
  ): ScheduleFetchResults;
  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload[],
  ): ScheduleFetchResults[];
  function scheduleItemFetch(
    fetchType: FetchType,
    itemPayload: ItemPayload | ItemPayload[],
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    if (!fetchItemOrquestrator) {
      throw new Error(noFetchFnError);
    }

    const fetchMultiple = Array.isArray(itemPayload);

    const itemsId = fetchMultiple ? itemPayload : [itemPayload];

    const results = itemsId.map((payload) => {
      const itemKey = getCacheId(payload);

      return fetchItemOrquestrator
        .get(itemKey)
        .scheduleFetch(fetchType, payload);
    });

    return fetchMultiple ? results : results[0]!;
  }

  type FilterItemFn = (
    ItemPayload: ItemPayload,
    itemState: ItemState,
  ) => boolean;

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
        ([itemKey, item], ignore) => {
          const payload = store.state.itemQueries[itemKey]?.payload;

          if (item === null || !payload) return ignore;

          return itemsPayload(payload, item) ? { itemKey, payload } : ignore;
        },
      );
    }

    return [{ payload: itemsPayload, itemKey: getItemKey(itemsPayload) }];
  }

  const itemInvalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemId: ItemPayload | ItemPayload[] | FilterItemFn,
    priority: FetchType = 'highPriority',
    ignoreInvalidationSync = false,
  ) {
    if (!fetchItemOrquestrator) {
      throw new Error(noFetchFnError);
    }

    const itemsKey = getItemsKeyArray(itemId);

    for (const { itemKey, payload } of itemsKey) {
      const item = store.state.itemQueries[itemKey];

      if (!item) continue;

      const currentInvalidationPriority = item.refetchOnMount
        ? fetchTypePriority[item.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const query = draft.itemQueries[itemKey];

          if (!query) return;

          query.refetchOnMount = priority;
        },
        { action: { type: 'invalidate-item', queryKey: itemKey } },
      );

      itemInvalidationWasTriggered.delete(itemKey);
      storeEvents.emit('invalidateItem', { priority, itemKey });

      if (onInvalidateItem) {
        const itemState = store.state.items[itemKey];

        if (itemState) {
          onInvalidateItem({
            priority,
            itemState,
            payload,
          });
        }
      }
    }

    if (syncMutationsAndInvalidations && !ignoreInvalidationSync) {
      invalidateQuery(
        (query) =>
          itemsKey.some(({ payload }) =>
            syncMutationsAndInvalidations.syncItemAndQuery(payload, query),
          ),
        priority,
        true,
      );
    }
  }

  function startItemMutation(
    itemId: ItemPayload | ItemPayload[] | FilterItemFn,
  ) {
    const itemsKey = getItemsKeyArray(itemId);

    const endMutations: (() => void)[] = [];

    for (const { itemKey, payload } of itemsKey) {
      endMutations.push(
        fetchItemOrquestrator?.get(itemKey).startMutation() || (() => {}),
      );

      if (syncMutationsAndInvalidations) {
        for (const [queryKey, query] of Object.entries(store.state.queries)) {
          if (
            syncMutationsAndInvalidations.syncItemAndQuery(
              payload,
              query.payload,
            )
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

  function useMultipleItems<
    SelectedItem = ItemState | null,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    items: ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
    {
      selector = defaultItemDataSelector,
      loadFromStateOnly,
      selectorUsesExternalDeps,
    }: {
      loadFromStateOnly?: boolean;
      selector?: (
        data: ItemState | null,
        id: ItemPayload | null,
      ) => SelectedItem;
      selectorUsesExternalDeps?: boolean;
    } = {},
  ) {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const dataSelector = useCallback(selector, [
      selectorUsesExternalDeps ? selector : 0,
    ]);

    type PayloadWithKey = {
      payload: ItemPayload;
      itemKey: string;
      disableRefetchOnMount: boolean | undefined;
      returnIdleStatus: boolean | undefined;
      returnRefetchingStatus: boolean | undefined;
      isOffScreen: boolean | undefined;
      queryMetadata: QueryMetadata | undefined;
    };

    const memoizedItemKeys = useDeepMemo(
      () =>
        items.map(
          (itemPayload): PayloadWithKey => ({
            itemKey: getItemKey(itemPayload.payload),
            payload: itemPayload.payload,
            disableRefetchOnMount: itemPayload.disableRefetchOnMount,
            returnIdleStatus: itemPayload.returnIdleStatus,
            returnRefetchingStatus: itemPayload.returnRefetchingStatus,
            isOffScreen: itemPayload.isOffScreen,
            queryMetadata: itemPayload.queryMetadata,
          }),
        ),
      [items],
    );

    const resultSelector = useCallback(
      (state: State) => {
        return memoizedItemKeys.map(
          ({
            itemKey,
            payload,
            queryMetadata,
            returnRefetchingStatus,
            returnIdleStatus,
          }): TSFDUseListItemReturn<
            SelectedItem,
            NError,
            ItemPayload,
            QueryMetadata
          > => {
            const itemQuery = state.itemQueries[itemKey];
            const itemState = state.items[itemKey];

            if (itemQuery === null) {
              return {
                status: 'deleted',
                error: null,
                isLoading: false,
                payload,
                data: dataSelector(null, null),
                queryMetadata: queryMetadata as QueryMetadata,
              };
            }

            if (!itemQuery) {
              return {
                status: returnIdleStatus ? 'idle' : 'loading',
                error: null,
                isLoading: returnIdleStatus ? false : true,
                payload,
                data: dataSelector(null, null),
                queryMetadata: queryMetadata as QueryMetadata,
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
              data: dataSelector(itemState ?? null, itemQuery.payload),
              payload,
              queryMetadata: queryMetadata as QueryMetadata,
            };
          },
        );
      },
      [dataSelector, memoizedItemKeys],
    );

    const storeState = store.useSelector(resultSelector, {
      equalityFn: deepEqual,
      useExternalDeps: true,
    });

    useOnEvtmitterEvent(storeEvents, 'invalidateItem', (event) => {
      if (loadFromStateOnly) return;

      for (const { payload, itemKey, isOffScreen } of memoizedItemKeys) {
        if (isOffScreen) continue;

        if (itemKey !== event.itemKey) continue;

        if (!itemInvalidationWasTriggered.has(itemKey)) {
          store.produceState((draft) => {
            const query = draft.itemQueries[itemKey];

            if (!query?.refetchOnMount) return;

            query.refetchOnMount = false;
          });

          scheduleItemFetch(event.priority, payload);
          itemInvalidationWasTriggered.add(itemKey);
        }
      }
    });

    const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

    useEffect(() => {
      if (loadFromStateOnly) return;

      const removedItems = new Set(ignoreItemsInRefetchOnMount);

      for (const {
        payload,
        itemKey,
        isOffScreen,
        disableRefetchOnMount,
      } of memoizedItemKeys) {
        removedItems.delete(itemKey);

        if (isOffScreen) continue;

        if (itemKey) {
          const itemState = store.state.itemQueries[itemKey];
          const fetchType = itemState?.refetchOnMount || 'lowPriority';

          const shouldFetch =
            !itemState || !itemState.wasLoaded || itemState.refetchOnMount;

          if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemKey)) {
            continue;
          }

          ignoreItemsInRefetchOnMount.add(itemKey);

          if (disableRefetchOnMount) {
            if (shouldFetch) {
              scheduleItemFetch(fetchType, payload);
              return;
            }
          } else {
            scheduleItemFetch(fetchType, payload);
          }
        }
      }

      for (const itemKey of removedItems) {
        ignoreItemsInRefetchOnMount.delete(itemKey);
      }
    }, [ignoreItemsInRefetchOnMount, loadFromStateOnly, memoizedItemKeys]);

    return storeState;
  }

  function useItem<SelectedItem = ItemState | null>(
    itemPayload: ItemPayload | false | null | undefined,
    {
      selector,
      selectorUsesExternalDeps,
      disableRefetchOnMount,
      returnIdleStatus,
      returnRefetchingStatus,
      ensureIsLoaded,
      loadFromStateOnly,
      isOffScreen,
    }: {
      selector?: (
        data: ItemState | null,
        id: ItemPayload | null,
      ) => SelectedItem;
      selectorUsesExternalDeps?: boolean;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      ensureIsLoaded?: boolean;
      loadFromStateOnly?: boolean;
      isOffScreen?: boolean;
    } = {},
  ) {
    const query = useMemo(
      (): ListQueryUseMultipleItemsQuery<ItemPayload, undefined>[] =>
        itemPayload === false ||
        itemPayload === null ||
        itemPayload === undefined
          ? []
          : [
              {
                payload: itemPayload,
                disableRefetchOnMount,
                isOffScreen,
                returnIdleStatus,
                returnRefetchingStatus,
              },
            ],
      [
        itemPayload,
        disableRefetchOnMount,
        isOffScreen,
        returnIdleStatus,
        returnRefetchingStatus,
      ],
    );

    const queryResult = useMultipleItems<SelectedItem>(query, {
      selector,
      selectorUsesExternalDeps,
      loadFromStateOnly,
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const memoizedSelector = useCallback(
      selector ?? defaultItemDataSelector,
      [],
    );

    const result = useMemo(
      (): TSFDUseListItemReturn<SelectedItem, NError, ItemPayload> =>
        queryResult[0] ?? {
          error: null,
          isLoading: false,
          status: 'idle',
          data: memoizedSelector(null, null),
          payload: itemPayload || null,
          queryMetadata: undefined,
        },
      [itemPayload, memoizedSelector, queryResult],
    );

    const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
      ensureIsLoaded,
      !!itemPayload,
      () => {
        if (itemPayload) {
          scheduleItemFetch('highPriority', itemPayload);
        }
      },
    );

    useSubscribeToStore(store, ({ observe }) => {
      if (!ensureIsLoaded || !itemPayload) return;

      observe
        .ifSelector((state) => state.itemQueries[itemPayload]?.status)
        .change.then(({ current }) => {
          if (current === 'success' || current === 'error') {
            emitIsLoadedEvt('isLoaded', true);
          }
        });
    });

    return useModifyResult(result);
  }

  function useFindItem<SelectedItem = ItemState | null>(
    findItem: (item: ItemState, itemPayload: ItemPayload) => boolean,
    {
      selector = defaultItemDataSelector,
    }: {
      selector?: (data: ItemState, id: ItemPayload) => SelectedItem;
    } = {},
  ) {
    return store.useSelector((state) => {
      const selectedItem = findAndMap(
        Object.entries(state.items),
        ([itemKey, item]) => {
          if (!item) return false;

          const itemQuery = state.itemQueries[itemKey];

          if (!itemQuery) return false;

          if (findItem(item, itemQuery.payload)) {
            return { item, itemQuery };
          }

          return false;
        },
      );

      if (!selectedItem) return null;

      return selector(selectedItem.item, selectedItem.itemQuery.payload);
    });
  }

  function updateItemState(
    itemIds: ItemPayload | ItemPayload[] | FilterItemFn,
    produceNewData: (
      draftData: ItemState,
      itemPayload: ItemPayload,
    ) => void | ItemState,
    {
      ifNothingWasUpdated,
    }: {
      ifNothingWasUpdated?: () => void;
    } = {},
  ): boolean {
    const itemKeys = getItemsKeyArray(itemIds);

    let someItemWasUpdated = false as boolean;

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

        if (ifNothingWasUpdated && !someItemWasUpdated) {
          ifNothingWasUpdated();
        }
      },
      { type: 'update-item-state', item: itemKeys },
    );

    return someItemWasUpdated;
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
                  const itemPayload = store.state.itemQueries[itemId]?.payload;

                  if (!itemState || !itemPayload) return Infinity;

                  return sort.sortBy(itemState, itemPayload);
                },
                {
                  order: sort.order,
                },
              );
            }
          }
        }
      }
    });

    if (queriesToInvalidate.length) invalidateQuery(queriesToInvalidate);
  }

  /** adds a item to state, if the item already exist replace it with the new one */
  function addItemToState(
    itemPayload: ItemPayload,
    data: ItemState,
    {
      addItemToQueries,
    }: {
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

          if (addItemToQueries) {
            const queries = getQueriesKeyArray(addItemToQueries.queries);

            for (const { key } of queries) {
              if (draftState.queries[key]) {
                const queryState = draftState.queries[key];

                if (!queryState) continue;

                if (queryState.items.includes(itemKey)) continue;

                if (addItemToQueries.appendTo === 'start') {
                  queryState.items.unshift(itemKey);
                } else if (addItemToQueries.appendTo === 'end') {
                  queryState.items.push(itemKey);
                } else {
                  const index = addItemToQueries.appendTo(
                    filterAndMap(
                      queryState.items,
                      (itemKey2, ignore) =>
                        draftState.itemQueries[itemKey2]?.payload || ignore,
                    ),
                  );

                  queryState.items.splice(index, 0, itemKey);
                }
              }
            }
          }
        },
        { action: { type: 'create-item-state', itemPayload } },
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

  function reset() {
    fetchItemOrquestrator?.reset();
    fetchQueryOrquestrator.reset();
    store.setState({
      items: {},
      queries: {},
      itemQueries: {},
    });
  }

  return {
    store,
    reset,
    scheduleListQueryFetch,
    getQueryState,
    getQueryKey,
    deleteItemState,
    getItemState,
    loadMore,
    invalidateQuery,
    invalidateItem,
    scheduleItemFetch,
    awaitItemFetch,
    awaitListQueryFetch,
    useMultipleListQueries,
    useListQuery,
    getItemKey,
    useItem,
    useMultipleItems,
    addItemToState,
    updateItemState,
    startItemMutation,
    getQueriesState,
    getQueriesRelatedToItem,
    useFindItem,
  };
}

export type TSFDListQueryStore<
  ItemState extends ValidStoreState,
  NError,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = ReturnType<
  typeof newTSDFListQueryStore<ItemState, NError, QueryPayload, ItemPayload>
>;
