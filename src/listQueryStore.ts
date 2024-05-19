import { evtmitter } from 'evtmitter';
import { useOnEvtmitterEvent } from 'evtmitter/react';
import { klona } from 'klona/json';
import { useCallback, useEffect, useMemo } from 'react';
import { Store, deepEqual, useSubscribeToStore } from 't-state';
import { getObjectKeyOrInsert } from '../test/utils/mutationUtils';
import { createCollectionFetchOrchestrator } from './collectionFetchOrchestrator';
import {
  FetchContext as FetchCtx,
  FetchType,
  ScheduleFetchResults,
} from './fetchOrchestrator';
import { TSDFStatus, ValidStoreState, fetchTypePriority } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { invariant } from './utils/assertions';
import { filterAndMap } from './utils/filterAndMap';
import { findAndMap } from './utils/findAndMap';
import { getCacheId } from './utils/getCacheId';
import { useConst, useDeepMemo } from './utils/hooks';
import { isObject } from './utils/isObject';
import { mapGetOrInsert } from './utils/mapGetOrInsert';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import { sortBy } from './utils/sortBy';
import { NonPartial } from './utils/types';

type QueryStatus = TSDFStatus | 'loadingMore';

const statusByPriority: Record<QueryStatus, number> = {
  success: 0,
  refetching: 1,
  error: 2,
  loadingMore: 3,
  loading: 4,
};

type ValidPayload =
  | (Record<string, unknown> & { fields?: string[] })
  | string
  | number;

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

export type TSDFPartialItemQuery<NError, ItemPayload> = {
  fields: Record<
    string,
    {
      status: Exclude<QueryStatus, 'loadingMore'>;
      // FIX: test errors scenarios
      error: NError | null;
      wasLoaded: boolean;
      // FIX: test invalidation scenarios
      refetchOnMount: false | FetchType;
    }
  >;
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
  partialItemsQueries: Record<
    string,
    TSDFPartialItemQuery<NError, ItemPayload> | null
  >;
  partialQueries: Record<
    string,
    [queryKey: string, fields: string[], size: number][]
  >;
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
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
} & (QueryMetadata extends undefined
  ? { queryMetadata?: undefined }
  : { queryMetadata: QueryMetadata });

export type ListQueryUseMultipleListQueriesQuery<
  QueryPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown>,
> = {
  payload: QueryPayload;
  omitPayload?: boolean;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
  loadSize?: number;
} & (QueryMetadata extends undefined
  ? { queryMetadata?: undefined }
  : { queryMetadata: QueryMetadata });

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
  // FIX: test it
  getInitialData,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  lowPriorityThrottleMs,
  disableInitialDataInvalidation,
  mediumPriorityThrottleMs,
  dynamicRealtimeThrottleMs,
  optimisticListUpdates,
  onInvalidateItem,
  onInvalidateQuery,
  getItemCacheKey,
  getListQueryKey,
  partialResources,
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
  disableRefetchOnMount?: boolean;
  /** @default 200ms */
  lowPriorityThrottleMs?: number;
  /** @default 10ms */
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
  partialResources?: {
    getNewStateFromFetchedItem: (
      prevItem: ItemState | undefined,
      item: ItemState,
      partialFields: string[],
    ) => ItemState;
    getDerivedStateFromPartialFields: (
      partialFields: string[],
      item: ItemState,
    ) => ItemState;
  };
  getItemCacheKey?: (params: ItemPayload) => ValidPayload | any[];
  getListQueryKey?: (params: QueryPayload) => ValidPayload | any[];
}) {
  type State = TSFDListQueryState<ItemState, NError, QueryPayload, ItemPayload>;
  type Query = TSFDListQuery<NError, QueryPayload>;
  type PartialItemQuery = TSDFPartialItemQuery<NError, ItemPayload>;

  const equivalentQueries = new Map<string, string[]>();

  const store = new Store<State>({
    debugName,
    state: () => {
      const initialState: State = {
        items: {},
        queries: {},
        itemQueries: {},
        partialItemsQueries: {},
        partialQueries: {},
      };

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

  function getFieldsFromPayload(payload: ValidPayload): string[] | undefined {
    if (partialResources) {
      invariant(isObject(payload));

      return payload.fields;
    }

    return undefined;
  }

  function cleanFieldsFromPayload(payload: ValidPayload): ValidPayload {
    let paramsToUse = payload;

    invariant(
      isObject(paramsToUse),
      'partial resources cannot use string | number as query key',
    );

    paramsToUse = { ...paramsToUse };

    invariant(paramsToUse.fields, 'key fields not found in payload');

    delete paramsToUse.fields;

    return paramsToUse;
  }

  function getQueryKey(params: QueryPayload): string {
    return getCacheId(getListQueryKey ? getListQueryKey(params) : params);
  }

  function getItemKey(params: ItemPayload, keepFields = false): string {
    const paramsToUse =
      partialResources && !keepFields
        ? (cleanFieldsFromPayload(params) as ItemPayload)
        : params;

    return getCacheId(
      getItemCacheKey ? getItemCacheKey(paramsToUse) : paramsToUse,
    );
  }

  function normalizePayloadFields<T extends ValidPayload>(itemPayload: T): T {
    if (partialResources) {
      const payloadToUse = {
        ...(itemPayload as Exclude<ValidPayload, string | number>),
      };

      payloadToUse.fields = [];

      return payloadToUse as T;
    }

    return itemPayload;
  }

  function getEquivalentQuery(
    state: State,
    queryKey: string,
    normalizedPayloadWithoutFields: QueryPayload,
    loadSize: number,
    partialFields: string[],
  ): [Query, string] | [undefined, undefined] {
    const equivalentQueriesKeys = equivalentQueries.get(queryKey);

    if (__DEV__) {
      if (
        (
          normalizedPayloadWithoutFields as Exclude<
            ValidPayload,
            string | number
          >
        ).fields?.length !== 0
      ) {
        throw new Error('Fields param must be empty');
      }
    }

    if (equivalentQueriesKeys) {
      for (const key of equivalentQueriesKeys) {
        const fallback = state.queries[key];

        if (fallback && !fallback?.error) {
          return [fallback, key];
        }
      }
    }

    const queryKeyWithNoFields = getQueryKey(normalizedPayloadWithoutFields);

    const partialQueries = state.partialQueries[queryKeyWithNoFields];

    if (partialQueries) {
      for (const [partialQueryKey, fields, size] of partialQueries) {
        if (size >= loadSize) {
          if (partialFields.every((field) => fields.includes(field))) {
            const fallback = state.queries[partialQueryKey];

            if (fallback) {
              mapGetOrInsert(equivalentQueries, queryKey, () => []).push(
                partialQueryKey,
              );
            }

            if (fallback && !fallback?.error) {
              return [fallback, partialQueryKey];
            }
          }
        }
      }
    }

    return [undefined, undefined];
  }

  async function fetchQuery(
    fetchCtx: FetchCtx,
    [fetchType, queryPayload, size = defaultQuerySize]: [
      'load' | 'loadMore',
      QueryPayload,
      number | undefined,
    ],
  ): Promise<boolean> {
    const payload = queryPayload;
    const queryKey = getQueryKey(payload);
    const partialFields = getFieldsFromPayload(payload);

    const queryState = store.state.queries[queryKey];

    const isLoading = !queryState?.wasLoaded;

    if (partialResources) {
      invariant(partialFields?.length, 'Fields param cannot be empty');
    }

    const normalizedPayloadWithoutFields =
      partialFields && normalizePayloadFields(payload);

    const partialQueryKey =
      normalizedPayloadWithoutFields &&
      getQueryKey(normalizedPayloadWithoutFields);

    store.produceState(
      (draft) => {
        const query = draft.queries[queryKey];

        const payloadToUse = klona(payload);

        if (!query) {
          const equivalentQuery =
            normalizedPayloadWithoutFields &&
            getEquivalentQuery(
              draft,
              queryKey,
              normalizedPayloadWithoutFields,
              size,
              partialFields,
            )[0];

          if (equivalentQuery) {
            draft.queries[queryKey] = {
              error: null,
              payload: payloadToUse,
              hasMore: equivalentQuery.hasMore,
              items: equivalentQuery.items,
              refetchOnMount: equivalentQuery.refetchOnMount,
              status:
                equivalentQuery.status === 'loadingMore'
                  ? 'loading'
                  : equivalentQuery.status === 'success'
                  ? 'refetching'
                  : equivalentQuery.status,
              wasLoaded: equivalentQuery.wasLoaded,
            };
          } else {
            draft.queries[queryKey] = {
              error: null,
              status: 'loading',
              wasLoaded: false,
              payload: payloadToUse,
              refetchOnMount: false,
              hasMore: false,
              items: [],
            };
          }

          if (partialQueryKey) {
            const partialQueries = getObjectKeyOrInsert(
              draft.partialQueries,
              partialQueryKey,
              () => [],
            );

            partialQueries.push([queryKey, partialFields, size]);
          }

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

          // FIX: update all equivalent queries

          for (const { data, itemPayload } of items) {
            const itemKey = getItemKey(itemPayload);

            const prev = draft.items[itemKey] ?? undefined;

            draft.items[itemKey] = reusePrevIfEqual<ItemState>({
              current:
                partialFields && partialResources
                  ? partialResources.getNewStateFromFetchedItem(
                      prev,
                      data,
                      partialFields,
                    )
                  : data,
              prev,
            });
            query.items.push(String(itemKey));

            if (partialFields) {
              const partialItemQuery = getObjectKeyOrInsert(
                draft.partialItemsQueries,
                itemKey,
                () => ({
                  fields: {},
                  payload: normalizePayloadFields(itemPayload),
                }),
              );

              if (!partialItemQuery) continue;

              for (const field of partialFields) {
                const itemQueryField = partialItemQuery.fields[field];

                if (
                  !itemQueryField ||
                  (itemQueryField.status !== 'loading' &&
                    itemQueryField.status !== 'refetching')
                ) {
                  partialItemQuery.fields[field] = {
                    error: null,
                    status: 'success',
                    wasLoaded: true,
                    refetchOnMount: false,
                  };
                }
              }
            } else {
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
          }

          if (partialQueryKey) {
            const partialQueries = getObjectKeyOrInsert(
              draft.partialQueries,
              partialQueryKey,
              () => [],
            );

            for (const partialQuery of partialQueries) {
              if (partialQuery[0] === queryKey) {
                const loadedItems = query.items.length;

                if (loadedItems > partialQuery[2]) {
                  partialQuery[2] = loadedItems;
                }
              }
            }
          }
        },
        {
          action: { type: 'fetch-query-success', payload },
        },
      );

      for (const { itemPayload: id } of items) {
        // FIX: should get all equivalent queries
        const itemFetchOrchestrator = fetchItemOrchestrator?.get(String(id));

        if (itemFetchOrchestrator) {
          itemFetchOrchestrator.setLastFetchStartTime(fetchCtx.getStartTime());
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

  const fetchQueryOrchestrator = createCollectionFetchOrchestrator({
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
      const currentFetchOrchestrator = fetchQueryOrchestrator.get(
        getQueryKey(param),
      );

      if (partialResources) {
        const [, equivalentQueryKey] = getEquivalentQuery(
          store.state,
          getQueryKey(param),
          normalizePayloadFields(param),
          size ?? defaultQuerySize,
          getFieldsFromPayload(param)!,
        );

        if (equivalentQueryKey) {
          const equivalentQueryFetchOrchestrator =
            fetchQueryOrchestrator.get(equivalentQueryKey);

          // FIX: test it
          currentFetchOrchestrator.setLastFetchStartTime(
            equivalentQueryFetchOrchestrator.getProps().lastFetchStartTime,
          );
        }
      }

      return currentFetchOrchestrator.scheduleFetch(fetchType, [
        'load',
        param,
        size,
      ]);
    });

    return multiplePayloads ? results : results[0]!;
  }

  function loadMore(params: QueryPayload, size?: number): ScheduleFetchResults {
    const queryState = getQueryState(params);

    if (!queryState || !queryState.hasMore) return 'skipped';

    if (queryState.status !== 'success') return 'skipped';

    return fetchQueryOrchestrator
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
    partialFields: string[] | undefined,
  ): T[] {
    return filterAndMap(query.items, (itemKey, ignore) => {
      const state = store.state;
      let item = state.items[itemKey];

      if (partialFields && partialResources && item) {
        item = partialResources.getDerivedStateFromPartialFields(
          partialFields,
          item,
        );
      }

      const itemPayload = partialResources
        ? state.partialItemsQueries[itemKey]?.payload
        : state.itemQueries[itemKey]?.payload;
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

    const wasAborted = await fetchQueryOrchestrator
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
    if (!fetchItemOrchestrator) throw new Error(noFetchFnError);

    const itemKey = getItemKey(itemPayload);

    const wasAborted = await fetchItemOrchestrator
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

  const itemInvalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemId: ItemPayload | ItemPayload[] | FilterItemFn,
    priority: FetchType = 'highPriority',
  ) {
    if (!fetchItemOrchestrator) {
      return;
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
          onInvalidateItem({ priority, itemState, payload });
        }
      }
    }
  }

  const queryInvalidationWasTriggered = new Set<string>();

  function invalidateQueryAndItems({
    itemPayload,
    queryPayload,
    type: priority = 'highPriority',
  }: {
    itemPayload: ItemPayload | ItemPayload[] | FilterItemFn | false;
    queryPayload: QueryPayload | QueryPayload[] | FilterQueryFn | false;
    type?: FetchType;
  }) {
    const queriesKey = queryPayload ? getQueriesKeyArray(queryPayload) : [];

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

    if (itemPayload) {
      invalidateItem(itemPayload, priority);
    }
  }

  function defaultItemSelector<T>(data: ItemState): T {
    return data as unknown as T;
  }

  type DefaultSelectedItem = ItemState;

  function getQueryWithEquivalentAsFallback(
    state: State,
    queryKey: string,
    normalizedPayloadWithoutFields: QueryPayload,
    loadSize: number,
    partialFields: string[] | undefined,
  ) {
    const query = state.queries[queryKey];

    if (partialFields && !query) {
      return getEquivalentQuery(
        state,
        queryKey,
        normalizedPayloadWithoutFields,
        loadSize,
        partialFields,
      )[0];
    }

    return query;
  }

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
      returnIdleStatus: allItemsReturnIdleStatus,
      returnRefetchingStatus: allItemsReturnRefetchingStatus,
      omitPayload: allItemsOmitPayload,
      disableRefetchOnMount: allItemsDisableRefetchOnMount,
      isOffScreen: allItemsIsOffScreen,
      loadSize: allItemsLoadSize,
    }: {
      itemSelector?: (
        data: ItemState,
        id: ItemPayload,
        itemKey: string,
      ) => SelectedItem;
      selectorUsesExternalDeps?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      isOffScreen?: boolean;
      loadSize?: number;
    } = {},
  ) {
    type QueryWithId = {
      key: string;
    } & NonPartial<ListQueryUseMultipleListQueriesQuery<QueryPayload, any>>;

    const queriesWithId = useDeepMemo(() => {
      return queries.map((item): QueryWithId => {
        return {
          key: getQueryKey(item.payload),
          payload: item.payload,
          disableRefetchOnMount:
            item.disableRefetchOnMount ??
            allItemsDisableRefetchOnMount ??
            globalDisableRefetchOnMount,
          returnIdleStatus: item.returnIdleStatus ?? allItemsReturnIdleStatus,
          returnRefetchingStatus:
            item.returnRefetchingStatus ?? allItemsReturnRefetchingStatus,
          queryMetadata: item.queryMetadata,
          isOffScreen: item.isOffScreen ?? allItemsIsOffScreen,
          omitPayload: item.omitPayload ?? allItemsOmitPayload,
          loadSize: item.loadSize ?? allItemsLoadSize,
        };
      });
    }, [
      allItemsDisableRefetchOnMount,
      allItemsIsOffScreen,
      allItemsLoadSize,
      allItemsOmitPayload,
      allItemsReturnIdleStatus,
      allItemsReturnRefetchingStatus,
      queries,
    ]);

    // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
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
            loadSize = defaultQuerySize,
            queryMetadata,
          }): TSFDUseListQueryReturn<
            SelectedItem,
            QueryPayload,
            NError,
            QueryMetadata
          > => {
            const partialFields = getFieldsFromPayload(payload);

            const query = getQueryWithEquivalentAsFallback(
              state,
              queryKey,
              normalizePayloadFields(payload),
              loadSize,
              partialFields,
            );

            let payloadToUse = query?.payload ?? payload;

            if (partialFields) {
              payloadToUse = {
                ...(payloadToUse as Exclude<ValidPayload, string | number>),
                fields: partialFields,
              } as QueryPayload;
            }

            if (!query) {
              return {
                queryKey,
                status: returnIdleStatus ? 'idle' : 'loading',
                items: [],
                error: null,
                hasMore: false,
                payload: omitPayload ? undefined : payloadToUse,
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
              items: getQueryItems(query, dataSelector, partialFields),
              error: query.error,
              hasMore: query.hasMore,
              isLoading: status === 'loading',
              payload: omitPayload ? undefined : payloadToUse,
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
          const itemState = getQueryWithEquivalentAsFallback(
            store.state,
            itemId,
            normalizePayloadFields(fetchParams),
            loadSize ?? defaultQuerySize,
            getFieldsFromPayload(fetchParams),
          );

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
    if (!fetchItemOrchestrator) {
      throw new Error(noFetchFnError);
    }

    const itemKey = getItemKey(itemPayload);
    const partialFields = getFieldsFromPayload(itemPayload);

    const isLoaded = !store.state.itemQueries[itemKey]?.wasLoaded;

    store.produceState(
      (draft) => {
        if (partialFields) {
          invariant(partialFields.length, 'Fields param cannot be empty');

          const itemQuery = draft.partialItemsQueries[itemKey];

          if (!itemQuery) {
            const fields: PartialItemQuery['fields'] = {};

            for (const field of partialFields) {
              fields[field] = {
                status: 'loading',
                error: null,
                wasLoaded: false,
                refetchOnMount: false,
              };
            }

            const payloadToUse = klona(itemPayload);

            (payloadToUse as Record<string, unknown>).fields = [];

            draft.partialItemsQueries[itemKey] = {
              payload: payloadToUse,
              fields,
            };

            return;
          }

          for (const field of partialFields) {
            const itemQueryField = itemQuery.fields[field];

            if (!itemQueryField) {
              itemQuery.fields[field] = {
                status: 'loading',
                error: null,
                wasLoaded: false,
                refetchOnMount: false,
              };

              continue;
            }

            itemQueryField.status = itemQueryField.wasLoaded
              ? 'refetching'
              : 'loading';
            itemQueryField.error = null;
            itemQueryField.refetchOnMount = false;
          }
        } else {
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
        }
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
          if (partialFields) {
            invariant(
              partialResources,
              __DEV__ ? 'Partial resources not enabled' : undefined,
            );

            const partialItemQuery = draft.partialItemsQueries[itemKey];

            if (!partialItemQuery) return;

            for (const field of partialFields) {
              const itemQueryField =
                draft.partialItemsQueries[itemKey]?.fields[field];

              invariant(
                itemQueryField,
                __DEV__ ? 'Field query not found' : undefined,
              );

              itemQueryField.status = 'success';
              itemQueryField.wasLoaded = true;
            }

            const prev = draft.items[itemKey] ?? undefined;

            draft.items[itemKey] = reusePrevIfEqual<ItemState>({
              current: partialResources.getNewStateFromFetchedItem(
                prev,
                item,
                partialFields,
              ),
              prev,
            });
          } else {
            const itemQuery = draft.itemQueries[itemKey];

            if (!itemQuery) return;

            itemQuery.status = 'success';
            itemQuery.wasLoaded = true;

            draft.items[itemKey] = reusePrevIfEqual<ItemState>({
              current: item,
              prev: draft.items[itemKey] ?? undefined,
            });
          }
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
          if (partialFields) {
            const itemQuery = draft.partialItemsQueries[itemKey];

            if (!itemQuery) return;

            for (const field of partialFields) {
              const itemQueryField =
                draft.partialItemsQueries[itemKey]?.fields[field];

              if (!itemQueryField) continue;

              itemQueryField.status = 'error';
              itemQueryField.error = error;
            }
          } else {
            const itemQuery = draft.itemQueries[itemKey];

            if (!itemQuery) return;

            itemQuery.status = 'error';
            itemQuery.error = error;
          }
        },
        {
          action: { type: 'fetch-item-error', itemPayload },
        },
      );

      return false;
    }
  }

  const fetchItemOrchestrator =
    fetchItemFn &&
    createCollectionFetchOrchestrator({
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
    if (!fetchItemOrchestrator) {
      throw new Error(noFetchFnError);
    }

    const fetchMultiple = Array.isArray(itemPayload);

    const itemsId = fetchMultiple ? itemPayload : [itemPayload];

    const results = itemsId.map((payload) => {
      const itemKey = getItemKey(payload, true);

      return fetchItemOrchestrator
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

  function startItemMutation(
    itemId: ItemPayload | ItemPayload[] | FilterItemFn,
  ) {
    const itemsKey = getItemsKeyArray(itemId);

    const endMutations: (() => void)[] = [];

    for (const { itemKey } of itemsKey) {
      endMutations.push(
        fetchItemOrchestrator?.get(itemKey).startMutation() || (() => {}),
      );

      for (const [queryKey, query] of Object.entries(store.state.queries)) {
        if (query.items.includes(itemKey)) {
          endMutations.push(
            fetchQueryOrchestrator.get(queryKey).startMutation(),
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
      returnIdleStatus: allItemsReturnIdleStatus,
      returnRefetchingStatus: allItemsReturnRefetchingStatus,
      disableRefetchOnMount: allItemsDisableRefetchOnMount,
      isOffScreen: allItemsIsOffScreen,
    }: {
      loadFromStateOnly?: boolean;
      selector?: (
        data: ItemState | null,
        id: ItemPayload | null,
      ) => SelectedItem;
      selectorUsesExternalDeps?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      disableRefetchOnMount?: boolean;
      isOffScreen?: boolean;
    } = {},
  ) {
    // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
    const dataSelector = useCallback(selector, [
      selectorUsesExternalDeps ? selector : 0,
    ]);

    type PayloadWithKey = {
      itemKey: string;
    } & NonPartial<ListQueryUseMultipleItemsQuery<ItemPayload, any>>;

    const memoizedItemKeys = useDeepMemo(
      () =>
        items.map(
          (itemPayload): PayloadWithKey => ({
            itemKey: getItemKey(itemPayload.payload),
            payload: itemPayload.payload,
            disableRefetchOnMount:
              itemPayload.disableRefetchOnMount ??
              allItemsDisableRefetchOnMount,
            returnIdleStatus:
              itemPayload.returnIdleStatus ?? allItemsReturnIdleStatus,
            returnRefetchingStatus:
              itemPayload.returnRefetchingStatus ??
              allItemsReturnRefetchingStatus,
            isOffScreen: itemPayload.isOffScreen ?? allItemsIsOffScreen,
            queryMetadata: itemPayload.queryMetadata,
          }),
        ),
      [
        allItemsDisableRefetchOnMount,
        allItemsIsOffScreen,
        allItemsReturnIdleStatus,
        allItemsReturnRefetchingStatus,
        items,
      ],
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
            let isDeleted = false;
            let isNotFetched = false;
            let status: QueryStatus = 'loading';
            const error: NError | null = null;
            let payloadToUse: ItemPayload | null = null;

            const partialFields = getFieldsFromPayload(payload);

            if (partialFields) {
              const itemQuery = state.partialItemsQueries[itemKey];

              isDeleted = itemQuery === null;

              isNotFetched = !itemQuery;

              if (itemQuery) {
                payloadToUse = itemQuery.payload;

                let highestStatusPriority = 0;
                status = 'success';

                for (const field of partialFields) {
                  const fieldState = itemQuery.fields[field];

                  if (!fieldState) {
                    isNotFetched = true;
                    break;
                  }

                  const statusPriority = statusByPriority[fieldState.status];

                  if (statusPriority > highestStatusPriority) {
                    highestStatusPriority = statusPriority;
                    status = fieldState.status;
                  }
                }
              }
            } else {
              const itemQuery = state.itemQueries[itemKey];

              isDeleted = itemQuery === null;
              isNotFetched = !itemQuery;

              if (itemQuery) {
                payloadToUse = itemQuery.payload;
                status = itemQuery.status;
              }
            }

            if (isDeleted) {
              return {
                status: 'deleted',
                error: null,
                isLoading: false,
                payload,
                data: dataSelector(null, null),
                queryMetadata: queryMetadata as QueryMetadata,
              };
            }

            if (isNotFetched) {
              return {
                status: returnIdleStatus ? 'idle' : 'loading',
                error: null,
                isLoading: returnIdleStatus ? false : true,
                payload,
                data: dataSelector(null, null),
                queryMetadata: queryMetadata as QueryMetadata,
              };
            }

            if (!returnRefetchingStatus && status === 'refetching') {
              status = 'success';
            }

            let itemState = state.items[itemKey];

            const isLoading = status === 'loading';

            if (isLoading) {
              itemState = null;
            }

            if (partialFields && partialResources && itemState) {
              itemState = partialResources.getDerivedStateFromPartialFields(
                partialFields,
                itemState,
              );
            }

            return {
              status,
              error,
              isLoading,
              data: dataSelector(itemState ?? null, payloadToUse),
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
          let fetchType: FetchType = 'lowPriority';
          let shouldFetch: boolean | FetchType = false;

          const partialFields = getFieldsFromPayload(payload);

          if (partialFields) {
            const queryState = store.state.partialItemsQueries[itemKey];

            let refetchOnMountPriority = 0;
            let refetchOnMount: FetchType | false = false;
            let wasLoaded = true;

            for (const field of partialFields) {
              const fieldQueryState = queryState?.fields[field];

              if (!fieldQueryState) {
                wasLoaded = false;
                break;
              }

              if (fieldQueryState.refetchOnMount) {
                const priority =
                  fetchTypePriority[fieldQueryState.refetchOnMount];

                if (priority > refetchOnMountPriority) {
                  refetchOnMountPriority = priority;
                  refetchOnMount = fieldQueryState.refetchOnMount;
                }
              }
            }

            fetchType = refetchOnMount || 'lowPriority';

            shouldFetch = !wasLoaded || refetchOnMount;
          } else {
            const itemState = store.state.itemQueries[itemKey];

            fetchType = itemState?.refetchOnMount || 'lowPriority';

            shouldFetch =
              !itemState || !itemState.wasLoaded || itemState.refetchOnMount;
          }

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

    // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
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

    if (queriesToInvalidate.length)
      invalidateQueryAndItems({
        queryPayload: queriesToInvalidate,
        itemPayload: false,
      });
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
    fetchItemOrchestrator?.reset();
    fetchQueryOrchestrator.reset();
    store.setState({
      items: {},
      queries: {},
      itemQueries: {},
      partialItemsQueries: {},
      partialQueries: {},
    });
    equivalentQueries.clear();
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
    invalidateQueryAndItems,
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
