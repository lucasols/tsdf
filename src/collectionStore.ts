import mitt from 'mitt';
import { useCallback, useEffect, useMemo } from 'react';
import { deepEqual, Store, useSubscribeToStore } from 't-state';
import { createCollectionFetchOrquestrator } from './collectionFetchOrquestrator';
import {
  FetchType,
  ScheduleFetchResults,
  FetchContext,
} from './fetchOrquestrator';
import { Status, ValidPayload, ValidStoreState } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { filterAndMap } from './utils/filterAndMap';
import { getCacheId } from './utils/getCacheId';
import { useDeepMemo, useOnMittEvent } from './utils/hooks';
import { serializableClone } from './utils/serializableClone';

type CollectionItemStatus = Status;

export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError,
> = {
  data: ItemState | null;
  error: NError | null;
  status: CollectionItemStatus;
  payload: ItemPayload;
  refetchOnMount: boolean;
};

export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload, NError> | null>;

export type TSFDUseCollectionItemReturn<Selected, ItemPayload, NError> = {
  data: Selected;
  status: CollectionItemStatus | 'idle' | 'deleted';
  payload: ItemPayload | undefined;
  error: NError | null;
  itemStateKey: string;
  isLoading: boolean;
};

export function newTSDFCollectionStore<
  ItemState extends ValidStoreState,
  NError,
  ItemPayload extends ValidPayload,
>({
  debugName,
  fetchFn,
  disableRefetchOnWindowFocus,
  lowPriorityThrottleMs,
  errorNormalizer,
  mediumPriorityThrottleMs,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  getDynamicRealtimeThrottleMs,
  getCollectionItemKey: filterCollectionItemObjKey,
}: {
  debugName?: string;
  fetchFn: (params: ItemPayload) => Promise<ItemState>;
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | any[];
  errorNormalizer: (exception: unknown) => NError;
  disableRefetchOnWindowFocus?: boolean;
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload, NError>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload, NError>;

  const store = new Store<CollectionState>({
    debugName,
    state: {},
  });

  function getItemKey(params: ItemPayload): string {
    return getCacheId(
      filterCollectionItemObjKey ? filterCollectionItemObjKey(params) : params,
    );
  }

  async function fetch(
    fetchCtx: FetchContext,
    fetchParams: ItemPayload,
  ): Promise<boolean> {
    const itemId = getItemKey(fetchParams);
    // FIX: test if this is needed
    const params = serializableClone(fetchParams);

    const itemState = store.state[itemId];

    store.produceState(
      (draft) => {
        const item = draft[itemId];

        if (!item) {
          draft[itemId] = {
            data: null,
            error: null,
            status: 'loading',
            payload: params,
            refetchOnMount: false,
          };

          return;
        }

        item.status = item.data !== null ? 'refetching' : 'loading';
        item.payload = params;
        item.error = null;
        item.refetchOnMount = false;
      },
      {
        equalityCheck: deepEqual,
        action: {
          type: !itemState?.data
            ? 'fetch-start-loading'
            : 'fetch-start-refetching',
          params,
        },
      },
    );

    try {
      const data = await fetchFn(params);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.data = data;
          item.status = 'success';
        },
        { action: { type: 'fetch-success', params } },
      );

      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      const error = errorNormalizer(exception);

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.error = error;
          item.status = 'error';
        },
        { action: { type: 'fetch-error', params, error } },
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

  type FilterItemsFn = (params: ItemPayload, data: ItemState | null) => boolean;

  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload,
  ): ScheduleFetchResults;
  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload[],
  ): ScheduleFetchResults[];
  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload | ItemPayload[],
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const multiplePayloads = Array.isArray(payload);

    const payloads = multiplePayloads ? payload : [payload];

    const results: ScheduleFetchResults[] = [];

    for (const param of payloads) {
      const itemKey = getItemKey(param);

      if (store.state[itemKey] === null) {
        results.push('skipped');
      } else {
        results.push(
          fetchOrquestrator.get(itemKey).scheduleFetch(fetchType, param),
        );
      }
    }

    return multiplePayloads ? results : results[0]!;
  }

  async function awaitFetch(
    params: ItemPayload,
  ): Promise<{ data: null; error: NError } | { data: ItemState; error: null }> {
    const itemId = getItemKey(params);

    const wasAborted = await fetchOrquestrator.get(itemId).awaitFetch(params);

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

  function getItemsKeyArray(
    params: ItemPayload[] | FilterItemsFn | ItemPayload,
  ): string[] {
    const items = store.state;

    if (Array.isArray(params)) {
      return params.map(getItemKey);
    } else if (typeof params === 'function') {
      return filterAndMap(Object.entries(items), ([itemKey, item], ignore) => {
        return item && params(item.payload, item.data) ? itemKey : ignore;
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
    itemPayload: ItemPayload | ItemPayload[] | FilterItemsFn,
    priority: 'highPriority' | 'lowPriority' = 'highPriority',
  ) {
    const itemsKey = getItemsKeyArray(itemPayload);

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

  function getItemState(
    fetchParam: ItemPayload,
  ): CollectionItem | undefined | null;
  function getItemState(
    fetchParams: ItemPayload[] | FilterItemsFn,
  ): CollectionItem[];
  function getItemState(
    params: ItemPayload | ItemPayload[] | FilterItemsFn,
  ): CollectionItem | CollectionItem[] | undefined | null {
    if (typeof params === 'function' || Array.isArray(params)) {
      const itemsId = getItemsKeyArray(params);

      return filterAndMap(itemsId, (itemId, ignore) => {
        return store.state[itemId] || ignore;
      });
    }

    return store.state[getItemKey(params)];
  }

  function useMultipleItems<Selected = ItemState | null>(
    queries: readonly ItemPayload[],
    {
      selector,
      omitPayload,
      returnIdleStatus,
      returnRefetchingStatus,
      disableRefetchOnMount = globalDisableRefetchOnMount,
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
      payload: ItemPayload;
    };

    const queriesWithId = useDeepMemo((): QueryWithId[] => {
      return queries.map((payload) => {
        return { itemKey: getItemKey(payload), payload };
      });
    }, [queries]);

    const dataSelector = useCallback((itemState: ItemState | null) => {
      if (selector) return selector(itemState);

      return itemState as Selected;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const resultSelector = useCallback(
      (state: CollectionState) => {
        return queriesWithId.map(
          ({
            itemKey,
            payload,
          }): TSFDUseCollectionItemReturn<Selected, ItemPayload, NError> => {
            const item = state[itemKey];

            if (item === null) {
              return {
                itemStateKey: itemKey,
                status: 'deleted',
                data: dataSelector(null),
                error: null,
                payload: omitPayload ? undefined : payload,
                isLoading: false,
              };
            }

            if (!item) {
              return {
                itemStateKey: itemKey,
                status: returnIdleStatus ? 'idle' : 'loading',
                data: dataSelector(null),
                error: null,
                payload: omitPayload ? undefined : payload,
                isLoading: returnIdleStatus ? false : true,
              };
            }

            let status = item.status;

            if (!returnRefetchingStatus && item.status === 'refetching') {
              status = 'success';
            }

            return {
              itemStateKey: itemKey,
              status,
              data: dataSelector(item.data),
              error: item.error,
              isLoading: status === 'loading',
              payload: omitPayload ? undefined : item.payload,
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

            // FIX: add was loaded?
            const shouldFetch = !itemState || itemState.refetchOnMount;

            if (!shouldFetch) return;
          }

          scheduleFetch('lowPriority', payload);
        }
      }
    }, [disableRefetchOnMount, queriesWithId]);

    return storeState;
  }

  function useItem<Selected = ItemState | null>(
    payload: ItemPayload | undefined | false | null,
    options: {
      selector?: (data: ItemState | null) => Selected;
      omitPayload?: boolean;
      returnRefetchingStatus?: boolean;
      disableRefetchOnMount?: boolean;
      ensureIsLoaded?: boolean;
    } = {},
  ) {
    const { selector, ensureIsLoaded } = options;

    const query = useMemo(
      () =>
        payload === false || payload === null || payload === undefined
          ? []
          : [payload],
      [payload],
    );

    const item = useMultipleItems(query, options);

    const result = useMemo(
      (): TSFDUseCollectionItemReturn<Selected, ItemPayload, NError> =>
        item[0] ?? {
          payload: undefined,
          data: selector ? selector(null) : (null as Selected),
          error: null,
          status: 'idle',
          itemStateKey: '',
          isLoading: false,
        },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [item],
    );

    const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
      ensureIsLoaded,
      !!payload,
      () => {
        if (payload) {
          scheduleFetch('highPriority', payload);
        }
      },
    );

    useSubscribeToStore(store, ({ observe }) => {
      if (!ensureIsLoaded) return;

      observe
        .ifSelector((state) => state[result.itemStateKey]?.status)
        .change.then(({ current }) => {
          if (current === 'success' || current === 'error') {
            emitIsLoadedEvt('isLoaded', true);
          }
        });
    });

    return useModifyResult(result);
  }

  function startMutation(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
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

  function addItemToState(fetchParams: ItemPayload, data: ItemState) {
    const itemKey = getItemKey(fetchParams);

    store.produceState(
      (draftState) => {
        draftState[itemKey] = {
          data,
          status: 'success',
          refetchOnMount: false,
          error: null,
          payload: serializableClone(fetchParams),
        };
      },
      { action: { type: 'create-item-state', payload: fetchParams } },
    );
  }

  function deleteItemState(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
  ) {
    const itemKeys = getItemsKeyArray(fetchParams);

    store.produceState(
      (draftState) => {
        for (const itemKey of itemKeys) {
          draftState[itemKey] = null;
        }
      },
      { action: { type: 'delete-item-state', payload: fetchParams } },
    );
  }

  function updateItemState(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
    produceNewData: (
      draftData: ItemState,
      collectionItem: CollectionItem,
    ) => void | ItemState,
    ifNothingWasUpdated?: () => void,
  ) {
    const itemKeys = getItemsKeyArray(fetchParams);

    store.batch(
      () => {
        let someItemWasUpdated = false as boolean;

        store.produceState((draftState) => {
          for (const itemKey of itemKeys) {
            const item = draftState[itemKey];

            if (!item) continue;

            if (item.data) {
              someItemWasUpdated = true;
              const newData = produceNewData(item.data, item);

              if (newData) {
                item.data = newData;
              }
            }
          }
        });

        if (ifNothingWasUpdated && !someItemWasUpdated) {
          ifNothingWasUpdated();
        }
      },
      { type: 'update-items-state', items: itemKeys },
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
    useItem,
    getItemKey,
    getItemState,
    startMutation,
    invalidateData,
    updateItemState,
    addItemToState,
    deleteItemState,
  };
}

export type TSDFCollectionStore<
  ItemState extends ValidStoreState,
  NError,
  FetchParams extends ValidPayload,
> = ReturnType<typeof newTSDFCollectionStore<ItemState, NError, FetchParams>>;
