import { evtmitter } from 'evtmitter';
import { useOnEvtmitterEvent } from 'evtmitter/react';
import { klona } from 'klona/json';
import { useCallback, useEffect, useMemo } from 'react';
import { Store, deepEqual, useSubscribeToStore } from 't-state';
import { createCollectionFetchOrchestrator } from './collectionFetchOrquestrator';
import {
    FetchContext,
    FetchType,
    ScheduleFetchResults,
} from './fetchOrchestrator';
import {
    TSDFStatus,
    ValidPayload,
    ValidStoreState,
    fetchTypePriority,
} from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { filterAndMap } from './utils/filterAndMap';
import { getCacheId } from './utils/getCacheId';
import { useConst, useDeepMemo } from './utils/hooks';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import { NonPartial } from './utils/types';

type CollectionItemStatus = TSDFStatus;

export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError,
> = {
  data: ItemState | null;
  error: NError | null;
  status: CollectionItemStatus;
  payload: ItemPayload;
  refetchOnMount: false | FetchType;
  wasLoaded: boolean;
};

export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload, NError> | null>;

export type TSFDUseCollectionItemReturn<
  Selected,
  ItemPayload,
  NError,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  data: Selected;
  status: CollectionItemStatus | 'idle' | 'deleted';
  payload: ItemPayload | undefined;
  error: NError | null;
  itemStateKey: string;
  isLoading: boolean;
  queryMetadata: QueryMetadata;
};

export type CollectionInitialStateItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = {
  payload: ItemPayload;
  data: ItemState;
};

export type OnCollectionItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  itemState: ItemState;
  payload: ItemPayload;
  priority: FetchType;
}) => void;

export type CollectionUseMultipleItemsQuery<
  ItemPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  payload: ItemPayload;
  queryMetadata?: QueryMetadata;
  omitPayload?: boolean;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
};

export function newTSDFCollectionStore<
  ItemState extends ValidStoreState,
  NError,
  ItemPayload extends ValidPayload,
>({
  debugName,
  fetchFn,
  lowPriorityThrottleMs,
  errorNormalizer,
  disableInitialDataInvalidation,
  mediumPriorityThrottleMs,
  getInitialData,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  dynamicRealtimeThrottleMs,
  getCollectionItemKey: filterCollectionItemObjKey,
  onInvalidate,
}: {
  debugName?: string;
  fetchFn: (params: ItemPayload) => Promise<ItemState>;
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | any[];
  errorNormalizer: (exception: unknown) => NError;
  disableRefetchOnMount?: boolean;
  getInitialData?: () =>
    | CollectionInitialStateItem<ItemPayload, ItemState>[]
    | undefined;
  disableInitialDataInvalidation?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  onInvalidate?: OnCollectionItemInvalidate<ItemState, ItemPayload>;
}) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload, NError>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload, NError>;

  const store = new Store<CollectionState>({
    debugName,
    state: () => {
      const initialState = {} as CollectionState;

      const initialStateItems = getInitialData?.();

      if (initialStateItems) {
        for (const item of initialStateItems) {
          const itemKey = getItemKey(item.payload);

          initialState[itemKey] = {
            data: item.data,
            error: null,
            status: 'success',
            payload: item.payload,
            refetchOnMount: disableInitialDataInvalidation
              ? false
              : 'lowPriority',
            wasLoaded: true,
          };
        }
      }

      return initialState;
    },
  });

  function getItemKey(params: ItemPayload): string {
    return getCacheId(
      filterCollectionItemObjKey ? filterCollectionItemObjKey(params) : params,
    );
  }

  async function fetch(
    fetchCtx: FetchContext,
    itemPayload: ItemPayload,
  ): Promise<boolean> {
    const itemId = getItemKey(itemPayload);
    const payload = klona(itemPayload);

    const itemState = store.state[itemId];

    store.produceState(
      (draft) => {
        const item = draft[itemId];

        if (!item) {
          draft[itemId] = {
            data: null,
            error: null,
            status: 'loading',
            payload,
            refetchOnMount: false,
            wasLoaded: false,
          };

          return;
        }

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
      const data = await fetchFn(payload);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.data = reusePrevIfEqual({ current: data, prev: item.data });
          item.status = 'success';
          item.wasLoaded = true;
        },
        { action: { type: 'fetch-success', payload } },
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
        { action: { type: 'fetch-error', payload, error } },
      );

      return false;
    }
  }

  const fetchOrquestrator = createCollectionFetchOrchestrator({
    fetchFn: fetch,
    lowPriorityThrottleMs,
    dynamicRealtimeThrottleMs,
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

      results.push(
        fetchOrquestrator.get(itemKey).scheduleFetch(fetchType, param),
      );
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

    if (item?.error) {
      return { data: null, error: item.error };
    }

    if (!item?.data) {
      return { data: null, error: errorNormalizer(new Error('Not found')) };
    }

    return { data: item.data, error: null };
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

  const storeEvents = evtmitter<{
    invalidateData: { priority: FetchType; itemKey: string };
  }>();

  const invalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemPayload: ItemPayload | ItemPayload[] | FilterItemsFn,
    priority: FetchType = 'highPriority',
  ) {
    const itemsKey = getItemsKeyArray(itemPayload);

    for (const itemKey of itemsKey) {
      const item = store.state[itemKey];

      if (!item) continue;

      const currentInvalidationPriority = item.refetchOnMount
        ? fetchTypePriority[item.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const draftItem = draft[itemKey];

          if (!draftItem) return;

          draftItem.refetchOnMount = priority;
        },
        { action: { type: 'invalidate-data', itemKey } },
      );

      invalidationWasTriggered.delete(itemKey);
      storeEvents.emit('invalidateData', { priority, itemKey });

      if (item.data) {
        onInvalidate?.({
          priority,
          payload: item.payload,
          itemState: item.data,
        });
      }
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

  function useMultipleItems<
    Selected = ItemState | null,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    items: CollectionUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
    {
      selector,
      selectorUsesExternalDeps,
      returnIdleStatus: allItemsReturnIdleStatus,
      returnRefetchingStatus: allItemsReturnRefetchingStatus,
      omitPayload: allItemsOmitPayload,
      disableRefetchOnMount: allItemsDisableRefetchOnMount,
      isOffScreen: allItemsIsOffScreen,
    }: {
      selector?: (data: ItemState | null) => Selected;
      selectorUsesExternalDeps?: boolean;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      isOffScreen?: boolean;
    } = {},
  ) {
    type QueryWithId = {
      itemKey: string;
    } & NonPartial<CollectionUseMultipleItemsQuery<ItemPayload, QueryMetadata>>;

    const queriesWithId = useDeepMemo((): QueryWithId[] => {
      return items.map((queryProps) => {
        return {
          itemKey: getItemKey(queryProps.payload),
          payload: queryProps.payload,
          disableRefetchOnMount:
            queryProps.disableRefetchOnMount ??
            allItemsDisableRefetchOnMount ??
            globalDisableRefetchOnMount,
          returnIdleStatus:
            queryProps.returnIdleStatus ?? allItemsReturnIdleStatus,
          returnRefetchingStatus:
            queryProps.returnRefetchingStatus ?? allItemsReturnRefetchingStatus,
          omitPayload: queryProps.omitPayload ?? allItemsOmitPayload,
          isOffScreen: queryProps.isOffScreen ?? allItemsIsOffScreen,
          queryMetadata: queryProps.queryMetadata,
        };
      });
    }, [
      items,
      allItemsDisableRefetchOnMount,
      allItemsIsOffScreen,
      allItemsOmitPayload,
      allItemsReturnIdleStatus,
      allItemsReturnRefetchingStatus,
    ]);

    const dataSelector = useCallback(
      (itemState: ItemState | null) => {
        if (selector) return selector(itemState);

        return itemState as Selected;
      },

      // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
      [selectorUsesExternalDeps ? selector : 0],
    );

    const resultSelector = useCallback(
      (state: CollectionState) => {
        return queriesWithId.map(
          ({
            itemKey,
            payload,
            omitPayload,
            returnIdleStatus,
            returnRefetchingStatus,
            queryMetadata,
          }): TSFDUseCollectionItemReturn<
            Selected,
            ItemPayload,
            NError,
            QueryMetadata
          > => {
            const item = state[itemKey];

            if (item === null) {
              return {
                itemStateKey: itemKey,
                status: 'deleted',
                data: dataSelector(null),
                error: null,
                payload: omitPayload ? undefined : payload,
                isLoading: false,
                queryMetadata: queryMetadata as QueryMetadata,
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
                queryMetadata: queryMetadata as QueryMetadata,
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

    useOnEvtmitterEvent(storeEvents, 'invalidateData', (event) => {
      for (const { itemKey, payload, isOffScreen } of queriesWithId) {
        if (isOffScreen) continue;

        if (itemKey !== event.itemKey) continue;

        if (!invalidationWasTriggered.has(itemKey)) {
          store.produceState((draft) => {
            const draftItem = draft[itemKey];

            if (!draftItem) return;

            draftItem.refetchOnMount = false;
          });

          scheduleFetch(event.priority, payload);
          invalidationWasTriggered.add(itemKey);
        }
      }
    });

    const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

    useEffect(() => {
      const removedQueries = new Set(ignoreItemsInRefetchOnMount);

      for (const {
        itemKey: itemId,
        payload,
        isOffScreen,
        disableRefetchOnMount,
      } of queriesWithId) {
        removedQueries.delete(itemId);

        if (isOffScreen) continue;

        if (itemId) {
          const itemState = getItemState(payload);
          const fetchType = itemState?.refetchOnMount || 'lowPriority';

          const shouldFetch = !itemState?.wasLoaded || itemState.refetchOnMount;

          if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemId)) {
            continue;
          }

          ignoreItemsInRefetchOnMount.add(itemId);

          if (disableRefetchOnMount) {
            if (shouldFetch) {
              scheduleFetch(fetchType, payload);
              continue;
            }
          } else {
            scheduleFetch(fetchType, payload);
          }
        }
      }

      for (const itemId of removedQueries) {
        ignoreItemsInRefetchOnMount.delete(itemId);
      }
    }, [ignoreItemsInRefetchOnMount, queriesWithId]);

    return storeState;
  }

  function useItem<Selected = ItemState | null>(
    payload: ItemPayload | undefined | false | null,
    {
      omitPayload,
      selector,
      selectorUsesExternalDeps,
      ensureIsLoaded,
      returnRefetchingStatus,
      disableRefetchOnMount,
      returnIdleStatus,
      isOffScreen,
    }: {
      selector?: (data: ItemState | null) => Selected;
      selectorUsesExternalDeps?: boolean;
      omitPayload?: boolean;
      returnRefetchingStatus?: boolean;
      disableRefetchOnMount?: boolean;
      ensureIsLoaded?: boolean;
      returnIdleStatus?: boolean;
      isOffScreen?: boolean;
    } = {},
  ) {
    const query = useMemo(
      () =>
        payload === false || payload === null || payload === undefined
          ? []
          : [
              {
                payload,
                omitPayload,
                returnRefetchingStatus,
                disableRefetchOnMount,
                returnIdleStatus,
                isOffScreen,
              },
            ],
      [
        disableRefetchOnMount,
        isOffScreen,
        omitPayload,
        returnIdleStatus,
        returnRefetchingStatus,
        payload,
      ],
    );

    const item = useMultipleItems(query, {
      selector,
      selectorUsesExternalDeps,
    });

    const result = useMemo(
      (): TSFDUseCollectionItemReturn<Selected, ItemPayload, NError> =>
        item[0] ?? {
          payload: undefined,
          data: selector ? selector(null) : (null as Selected),
          error: null,
          status: 'idle',
          itemStateKey: '',
          isLoading: false,
          queryMetadata: undefined,
        },
      // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
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

  type EndMutation = () => void;

  function startMutation(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
  ): EndMutation {
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

  /** adds a item to state, if the item already exist replace it with the new one */
  function addItemToState(fetchParams: ItemPayload, data: ItemState) {
    const itemKey = getItemKey(fetchParams);

    store.produceState(
      (draftState) => {
        draftState[itemKey] = {
          data,
          status: 'success',
          wasLoaded: true,
          refetchOnMount: false,
          error: null,
          payload: klona(fetchParams),
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
  ): boolean {
    const itemKeys = getItemsKeyArray(fetchParams);

    let someItemWasUpdated = false as boolean;

    store.batch(
      () => {
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
      { type: 'update-item-state', item: itemKeys },
    );

    return someItemWasUpdated;
  }

  function reset() {
    fetchOrquestrator.reset();
    store.setState({});
  }

  return {
    store,
    scheduleFetch,
    awaitFetch,
    useMultipleItems,
    useItem,
    reset,
    getItemKey,
    getItemState,
    startMutation,
    invalidateItem,
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
