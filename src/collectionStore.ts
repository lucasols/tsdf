import mitt from 'mitt';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { deepEqual, Store, useSubscribeToStore } from 't-state';
import { createCollectionFetchOrquestrator } from './collectionFetchOrquestrator';
import {
  FetchType,
  ScheduleFetchResults,
  ShouldAbortFetch,
} from './fetchOrquestrator';
import { Status, ValidFetchParams, ValidStoreState } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { filterAndMap } from './utils/filterAndMap';
import { getCacheId } from './utils/getCacheId';
import { useDeepMemo, useOnChange, useOnMittEvent } from './utils/hooks';
import { serializableClone } from './utils/serializableClone';

type CollectionItemStatus = Status | 'deleted';

export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload,
  Error,
> = {
  data: ItemState | null;
  error: Error | null;
  status: CollectionItemStatus;
  payload: ItemPayload;
  refetchOnMount: boolean;
};

export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload,
  Error,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload, Error>>;

export type TSFDUseCollectionItemReturn<Selected, ItemPayload, Error> = {
  data: Selected;
  status: CollectionItemStatus | 'idle';
  payload: ItemPayload | undefined;
  error: Error | null;
  itemKey: string;
  isLoading: boolean;
};

export function newTSDFCollectionStore<
  ItemState extends ValidStoreState,
  Error,
  FetchParams extends ValidFetchParams,
  ItemPayload,
>({
  debugName,
  fetchFn,
  disableRefetchOnWindowFocus,
  lowPriorityThrottleMs,
  errorNormalizer,
  mediumPriorityThrottleMs,
  getDynamicRealtimeThrottleMs,
  getCollectionItemPayload,
}: {
  debugName?: string;
  fetchFn: (params: FetchParams) => Promise<ItemState>;
  getCollectionItemPayload: (params: FetchParams) => ItemPayload;
  errorNormalizer: (exception: unknown) => Error;
  disableRefetchOnWindowFocus?: boolean;
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload, Error>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload, Error>;

  const store = new Store<CollectionState>({
    debugName,
    state: {},
  });

  function getItemKey(params: FetchParams): string {
    return getCacheId(getCollectionItemPayload(params));
  }

  async function fetch(
    shouldAbort: ShouldAbortFetch,
    params: FetchParams,
  ): Promise<boolean> {
    const itemId = getItemKey(params);
    const payload = serializableClone(getCollectionItemPayload(params));

    const itemState = store.state[itemId];

    store.produceState(
      (draft) => {
        if (!draft[itemId]) {
          draft[itemId] = {
            data: null,
            error: null,
            status: 'loading',
            payload,
            refetchOnMount: false,
          };

          return;
        }

        const item = draft[itemId]!;

        item.status = item.data !== null ? 'refetching' : 'loading';
        item.payload = payload;
        item.error = null;
        item.refetchOnMount = false;
      },
      {
        equalityCheck: deepEqual,
        action: {
          type: !itemState?.data
            ? 'fetch-start-loading'
            : 'fetch-start-refetching',
          payload,
        },
      },
    );

    try {
      const data = await fetchFn(params);

      if (shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.data = data;
          item.status = 'success';
        },
        { action: { type: 'fetch-success', payload } },
      );

      return true;
    } catch (exception) {
      if (shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.error = errorNormalizer(exception);
          item.status = 'error';
        },
        { action: { type: 'fetch-error', payload } },
      );

      return false;
    }
  }

  const fetchOrquestrator = createCollectionFetchOrquestrator({
    fetchFn: fetch,
    lowPriorityThrottleMs,
    getDynamicRealtimeThrottleMs,
    mediumPriorityThrottleMs,
  });

  function scheduleFetch(
    fetchType: FetchType,
    params: FetchParams,
  ): ScheduleFetchResults {
    return fetchOrquestrator
      .get(getItemKey(params))
      .scheduleFetch(fetchType, params);
  }

  async function awaitFetch(
    params: FetchParams,
  ): Promise<{ data: null; error: Error } | { data: ItemState; error: null }> {
    const itemId = getItemKey(params);

    const fetchOrquestratorItem = fetchOrquestrator.get(itemId);

    const wasAborted = await fetchOrquestratorItem.awaitFetch(params);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    const item = store.state[itemId];

    if (!item?.data) {
      return { data: null, error: errorNormalizer(new Error('Not found')) };
    }

    return item.error
      ? { data: null, error: item.error }
      : { data: item.data, error: null };
  }

  type FilterItemsFn = (params: ItemPayload) => boolean;
  function getItemsKeyArray(
    params: FetchParams[] | FilterItemsFn | FetchParams,
  ): string[] {
    const items = store.state;

    if (Array.isArray(params)) {
      return params.map(getItemKey);
    } else if (typeof params === 'function') {
      const keys: string[] = [];

      for (const [itemId, item] of Object.entries(items)) {
        if (params(item.payload)) {
          keys.push(itemId);
        }
      }

      return filterAndMap(Object.entries(items), ([itemKey, item], ignore) => {
        if (params(item.payload)) {
          return itemKey;
        }

        return ignore;
      });
    } else {
      return [getItemKey(params)];
    }
  }

  const storeEvents = mitt<{
    invalidateData: { priority: FetchType; itemKey: string };
  }>();

  const invalidationWasTriggered = new Set<string>();

  function invalidateData(
    fetchParams: FetchParams | FetchParams[] | FilterItemsFn,
    priority: 'highPriority' | 'lowPriority' = 'highPriority',
  ) {
    const itemsKey = getItemsKeyArray(fetchParams);

    for (const itemKey of itemsKey) {
      store.produceState(
        (draft) => {
          const item = draft[itemKey];

          if (!item) return;

          item.refetchOnMount = true;
        },
        { action: { type: 'invalidate-data', itemKey } },
      );

      invalidationWasTriggered.delete(itemKey);
      storeEvents.emit('invalidateData', { priority, itemKey });
    }
  }

  function getItemState(fetchParam: FetchParams): CollectionItem | undefined;
  function getItemState(
    fetchParams: FetchParams[] | FilterItemsFn,
  ): CollectionItem[] | undefined;
  function getItemState(
    params: FetchParams | FetchParams[] | FilterItemsFn,
  ): CollectionItem | CollectionItem[] | undefined {
    if (typeof params === 'function' || Array.isArray(params)) {
      const itemsId = getItemsKeyArray(params);

      return filterAndMap(itemsId, (itemId, ignore) => {
        return store.state[itemId] || ignore;
      });
    }

    return store.state[getItemKey(params)];
  }

  function useMultipleItems<Selected = ItemState | null, QueryData = undefined>(
    queries: readonly MultipleItemsQuery<FetchParams, QueryData>[],
    {
      selector,
      omitPayload,
      returnIdleStatus,
      returnRefetchingStatus,
      disableRefetchOnMount,
    }: {
      selector?: (data: ItemState | null) => Selected;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
    } = {},
  ) {
    type QueryWithId = {
      itemKey: string;
      payload: FetchParams;
      queryData: QueryData;
    };

    const queriesWithId = useMemo((): QueryWithId[] => {
      return queries.map((item) => {
        return {
          itemKey: getItemKey(item.fetchParams),
          payload: item.fetchParams,
          queryData: item.queryData as QueryData,
        };
      });
    }, [queries]);

    const dataSelector = useCallback((itemState: ItemState | null) => {
      if (selector) return selector(itemState);

      return itemState as Selected;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const storeStateSelector = useCallback(
      (state: CollectionState) => {
        return queriesWithId.map(
          ({
            itemKey,
            payload,
            queryData,
          }): {
            result: TSFDUseCollectionItemReturn<Selected, ItemPayload, Error>;
            queryData: QueryData;
          } => {
            const item = state[itemKey];

            if (!item) {
              return {
                result: {
                  itemKey,
                  status: returnIdleStatus ? 'idle' : 'loading',
                  data: dataSelector(null),
                  error: null,
                  payload: omitPayload
                    ? undefined
                    : getCollectionItemPayload(payload),
                  isLoading: returnIdleStatus ? false : true,
                },
                queryData,
              };
            }

            let status = item.status;

            if (!returnRefetchingStatus && item.status === 'refetching') {
              status = 'success';
            }

            return {
              result: {
                itemKey,
                status,
                data: dataSelector(item.data),
                error: item.error,
                isLoading: status === 'loading',
                payload: omitPayload ? undefined : item.payload,
              },
              queryData,
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

    const storeState = store.useSelector(storeStateSelector, {
      equalityFn: deepEqual,
      useExternalDeps: true,
    });

    useOnMittEvent(storeEvents, 'invalidateData', (event) => {
      for (const { itemKey, payload } of queriesWithId) {
        if (itemKey !== event.itemKey) continue;

        if (!invalidationWasTriggered.has(itemKey)) {
          scheduleFetch(event.priority, payload);
          invalidationWasTriggered.add(itemKey);
        }
      }
    });

    useEffect(() => {
      for (const { itemKey: itemId, payload } of queriesWithId) {
        if (itemId) {
          if (disableRefetchOnMount) {
            const itemState = getItemState(payload);

            if (!itemState || itemState.refetchOnMount) {
              scheduleFetch('lowPriority', payload);
            }
          } else {
            scheduleFetch('lowPriority', payload);
          }
        }
      }
    }, [disableRefetchOnMount, queriesWithId]);

    return storeState;
  }

  function useItem<Selected = ItemState | null>(
    fetchParam: FetchParams | undefined | false,
    props: {
      selector?: (data: ItemState | null) => Selected;
      omitPayload?: boolean;
      ignoreRefreshingStatus?: boolean;
      disableRefetchOnMount?: boolean;
      ensureIsLoaded?: boolean;
    } = {},
  ) {
    const { selector, ensureIsLoaded } = props;

    const memoizedFetchParam = useDeepMemo(() => fetchParam, [fetchParam]);

    const queries = useMemo(
      () => (memoizedFetchParam ? [{ fetchParams: memoizedFetchParam }] : []),
      [memoizedFetchParam],
    );

    const item = useMultipleItems(queries, props);

    const result = useMemo(
      (): TSFDUseCollectionItemReturn<Selected, ItemPayload, Error> =>
        item[0]?.result ?? {
          payload: undefined,
          data: selector ? selector(null) : (null as Selected),
          error: null,
          status: 'idle',
          itemKey: '',
          isLoading: false,
        },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [item],
    );

    // FIX: test this
    return useEnsureIsLoaded(
      ensureIsLoaded,
      !!memoizedFetchParam,
      result.status !== 'loading' &&
        result.status !== 'refetching' &&
        result.status !== 'idle',
      () => {
        if (memoizedFetchParam) {
          scheduleFetch('highPriority', memoizedFetchParam);
        }
      },
      result,
    );
  }

  function startMutation(
    fetchParams: FetchParams | FetchParams[] | FilterItemsFn,
  ) {
    const itemKeys = getItemsKeyArray(fetchParams);

    const endMutations: (() => boolean)[] = [];

    for (const itemKey of itemKeys) {
      endMutations.push(fetchOrquestrator.get(itemKey).startMutation());
    }

    return () => {
      for (const endMutation of endMutations) {
        endMutation();
      }
    };
  }

  function updateItemState(
    fetchParams: FetchParams | FetchParams[] | FilterItemsFn,
    produceNewData: (
      draftData: ItemState,
      collectionItem: CollectionItem,
    ) => void | ItemState,
    // FIX: test this
    createIfNotExists?: {
      fetchParams: FetchParams | FetchParams[];
      itemState: ItemState;
    },
  ) {
    const itemKeys = getItemsKeyArray(fetchParams);

    store.produceState(
      (draftState) => {
        // FIX: test this
        if (itemKeys.length === 0 && createIfNotExists) {
          const createFetchParams = Array.isArray(createIfNotExists.fetchParams)
            ? createIfNotExists.fetchParams
            : [createIfNotExists.fetchParams];

          for (const fetchParam of createFetchParams) {
            const itemKey = getItemKey(fetchParam);

            draftState[itemKey] = {
              data: createIfNotExists.itemState,
              status: 'success',
              error: null,
              refetchOnMount: false,
              payload: getCollectionItemPayload(fetchParam),
            };
          }
        }

        for (const itemKey of itemKeys) {
          const item = draftState[itemKey];

          // FIX: test this
          if (!item) {
            if (
              createIfNotExists &&
              !Array.isArray(createIfNotExists.fetchParams)
            ) {
              draftState[itemKey] = {
                data: createIfNotExists.itemState,
                status: 'success',
                error: null,
                refetchOnMount: false,
                payload: getCollectionItemPayload(
                  createIfNotExists.fetchParams,
                ),
              };
            }
          } else if (item.data) {
            const newData = produceNewData(item.data, item);

            if (newData) {
              item.data = newData;
            }
          } else if (createIfNotExists) {
            draftState[itemKey] = {
              data: createIfNotExists.itemState,
              status: 'success',
              error: null,
              refetchOnMount: false,
              payload: item.payload,
            };
          }
        }
      },
      {
        action: { type: 'update-items-state', items: fetchParams },
      },
    );
  }

  if (!disableRefetchOnWindowFocus) {
    function handleFocus() {
      invalidateData(() => true, 'lowPriority');
    }

    window.addEventListener('focus', handleFocus);
    window.addEventListener('visibilitychange', handleFocus);
  }

  return {
    store,
    scheduleFetch,
    awaitFetch,
    useMultipleItems,
    updateItemState,
    useItem,
    getItemKey,
    getItemState,
    startMutation,
    invalidateData,
  };
}

export type MultipleItemsQuery<
  FetchParams extends ValidFetchParams,
  QueryData = undefined,
> = {
  fetchParams: FetchParams;
} & (QueryData extends undefined
  ? { queryData?: undefined }
  : { queryData: QueryData });

export type TSDFCollectionStore<
  ItemState extends ValidStoreState,
  Error,
  FetchParams extends ValidFetchParams,
  ItemPayload,
> = ReturnType<
  typeof newTSDFCollectionStore<ItemState, Error, FetchParams, ItemPayload>
>;
