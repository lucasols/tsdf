import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { useCallback, useEffect, useMemo } from 'react';
import { Result, ResultValidErrors, unknownToError } from 't-result';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { Store, useSubscribeToStore } from 't-state';
import {
  FetchContext,
  FetchType,
  RequestScheduler,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from './requestScheduler';
import {
  fetchTypePriority,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
} from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';

export type CollectionItemStatus = TSDFStatus;

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

export type CollectionStoreOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError extends ResultValidErrors,
> = {
  debugName?: string;
  fetchFn: (params: ItemPayload, signal: AbortSignal) => Promise<ItemState>;
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  errorNormalizer: (exception: Error) => NError;
  disableRefetchOnMount?: boolean;
  getInitialData?: () =>
    | CollectionInitialStateItem<ItemPayload, ItemState>[]
    | undefined;
  disableInitialDataInvalidation?: boolean;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  onInvalidate?: OnCollectionItemInvalidate<ItemState, ItemPayload>;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { silentErrors?: boolean },
  ) => void;
};

export type CollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError extends ResultValidErrors,
> = ReturnType<typeof createCollectionStore<ItemState, ItemPayload, NError>>;

type CollectionStoreEvents = {
  invalidateData: { priority: FetchType; itemKey: string };
};

export function createCollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  NError extends ResultValidErrors,
>({
  debugName,
  fetchFn,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  errorNormalizer,
  disableInitialDataInvalidation,
  mediumPriorityDelayMs,
  getInitialData,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  dynamicRealtimeThrottleMs,
  getCollectionItemKey: filterCollectionItemObjKey,
  onInvalidate,
  onSchedulerEvent,
  onMutationError,
}: CollectionStoreOptions<ItemState, ItemPayload, NError>) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload, NError>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload, NError>;

  const store = new Store<CollectionState>({
    debugName,
    state: () => {
      const initialState: CollectionState = {};

      const initialStateItems = getInitialData?.();

      if (initialStateItems) {
        for (const item of initialStateItems) {
          const itemKey = getItemKey(item.payload);

          initialState[itemKey] = {
            data: item.data,
            error: null,
            status: 'success',
            payload: item.payload,
            refetchOnMount:
              disableInitialDataInvalidation ? false : 'lowPriority',
            wasLoaded: true,
          };
        }
      }

      return initialState;
    },
  });

  function getItemKey(params: ItemPayload): string {
    return getCompositeKey(
      filterCollectionItemObjKey ? filterCollectionItemObjKey(params) : params,
    );
  }

  const events = evtmitter<CollectionStoreEvents>();

  // Scheduler manager - one RequestScheduler per item key
  const schedulers = new Map<string, RequestScheduler<ItemPayload>>();

  function getScheduler(itemKey: string): RequestScheduler<ItemPayload> {
    let scheduler = schedulers.get(itemKey);
    if (!scheduler) {
      scheduler = new RequestScheduler<ItemPayload>({
        fetchFn: (fetchCtx, params) => executeFetch(fetchCtx, params),
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
      });
      schedulers.set(itemKey, scheduler);
    }
    return scheduler;
  }

  async function executeFetch(
    fetchCtx: FetchContext,
    itemPayload: ItemPayload,
  ): Promise<boolean> {
    const itemId = getItemKey(itemPayload);
    const payload = klona(itemPayload);

    const itemState = store.state[itemId];

    store.produceState(
      (draft) => {
        const current = draft[itemId];

        if (!current) {
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

        current.status = current.data !== null ? 'refetching' : 'loading';
        current.payload = payload;
        current.error = null;
        current.refetchOnMount = false;
      },
      {
        equalityCheck: deepEqual,
        action:
          !itemState?.data ? 'fetch-start-loading' : 'fetch-start-refetching',
      },
    );

    try {
      const data = await fetchFn(payload, fetchCtx.signal);

      if (fetchCtx.shouldAbort()) return false;

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.data = reusePrevIfEqual({ current: data, prev: item.data });
          item.status = 'success';
          item.wasLoaded = true;
        },
        { action: 'fetch-success' },
      );

      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      const error = errorNormalizer(unknownToError(exception));

      store.produceState(
        (draft) => {
          const item = draft[itemId];

          if (!item) return;

          item.error = error;
          item.status = 'error';
        },
        { action: 'fetch-error' },
      );

      return false;
    }
  }

  type FilterItemsFn = (params: ItemPayload, data: ItemState | null) => boolean;

  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults;
  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload[],
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults[];
  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload | ItemPayload[],
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const multiplePayloads = Array.isArray(payload);

    const payloads = multiplePayloads ? payload : [payload];

    const results: ScheduleFetchResults[] = [];

    for (const param of payloads) {
      const itemKey = getItemKey(param);

      results.push(
        getScheduler(itemKey).scheduleFetch(fetchType, param, options),
      );
    }

    if (multiplePayloads) return results;

    const firstResult = results[0];
    if (!firstResult) {
      throw new Error('Unexpected empty results array');
    }
    return firstResult;
  }

  async function awaitFetch(
    params: ItemPayload,
  ): Promise<{ data: null; error: NError } | { data: ItemState; error: null }> {
    const itemId = getItemKey(params);

    const wasAborted = await getScheduler(itemId).awaitFetch(params);

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
      return filterAndMap(Object.entries(items), ([itemKey, item]) => {
        return item && params(item.payload, item.data) ? itemKey : false;
      });
    } else {
      return [getItemKey(params)];
    }
  }

  const invalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemPayload: ItemPayload | ItemPayload[] | FilterItemsFn,
    priority: FetchType = 'highPriority',
  ) {
    const itemsKey = getItemsKeyArray(itemPayload);

    for (const itemKey of itemsKey) {
      const item = store.state[itemKey];

      if (!item) continue;

      const currentInvalidationPriority =
        item.refetchOnMount ? fetchTypePriority[item.refetchOnMount] : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const draftItem = draft[itemKey];
          if (!draftItem) return;

          draftItem.refetchOnMount = priority;
        },
        { action: 'invalidate-data' },
      );

      invalidationWasTriggered.delete(itemKey);
      events.emit('invalidateData', { priority, itemKey });

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

      return filterAndMap(itemsId, (itemId) => {
        return store.state[itemId] || false;
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
      returnIdleStatus: allItemsReturnIdleStatus,
      returnRefetchingStatus: allItemsReturnRefetchingStatus,
      omitPayload: allItemsOmitPayload,
      disableRefetchOnMount: allItemsDisableRefetchOnMount,
      isOffScreen: allItemsIsOffScreen,
    }: {
      selector?: (data: ItemState | null) => Selected;
      returnIdleStatus?: boolean;
      returnRefetchingStatus?: boolean;
      omitPayload?: boolean;
      disableRefetchOnMount?: boolean;
      isOffScreen?: boolean;
    } = {},
  ) {
    type QueryWithId = {
      itemKey: string;
      payload: ItemPayload;
      disableRefetchOnMount: boolean;
      returnIdleStatus: boolean;
      returnRefetchingStatus: boolean;
      omitPayload: boolean;
      isOffScreen: boolean;
      queryMetadata: QueryMetadata | undefined;
    };

    const queriesWithId = useMemo((): QueryWithId[] => {
      const newQueries = items.map((queryProps) => ({
        itemKey: getItemKey(queryProps.payload),
        payload: queryProps.payload,
        disableRefetchOnMount:
          queryProps.disableRefetchOnMount
          ?? allItemsDisableRefetchOnMount
          ?? globalDisableRefetchOnMount
          ?? false,
        returnIdleStatus:
          queryProps.returnIdleStatus ?? allItemsReturnIdleStatus ?? false,
        returnRefetchingStatus:
          queryProps.returnRefetchingStatus
          ?? allItemsReturnRefetchingStatus
          ?? false,
        omitPayload: queryProps.omitPayload ?? allItemsOmitPayload ?? false,
        isOffScreen: queryProps.isOffScreen ?? allItemsIsOffScreen ?? false,
        queryMetadata: queryProps.queryMetadata,
      }));

      return newQueries;
    }, [
      items,
      allItemsDisableRefetchOnMount,
      allItemsIsOffScreen,
      allItemsOmitPayload,
      allItemsReturnIdleStatus,
      allItemsReturnRefetchingStatus,
    ]);

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

            const data =
              selector ?
                selector(item?.data ?? null)
              : __LEGIT_CAST__<Selected>(item?.data ?? null);

            if (item === null) {
              return {
                itemStateKey: itemKey,
                status: 'deleted',
                data,
                error: null,
                payload: omitPayload ? undefined : payload,
                isLoading: false,
                queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
              };
            }

            if (!item) {
              return {
                itemStateKey: itemKey,
                status: returnIdleStatus ? 'idle' : 'loading',
                data,
                error: null,
                payload: omitPayload ? undefined : payload,
                isLoading: !returnIdleStatus,
                queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
              };
            }

            let status = item.status;

            if (!returnRefetchingStatus && item.status === 'refetching') {
              status = 'success';
            }

            return {
              itemStateKey: itemKey,
              status,
              data,
              error: item.error,
              isLoading: status === 'loading',
              payload: omitPayload ? undefined : item.payload,
              queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
            };
          },
        );
      },
      [queriesWithId, selector],
    );

    const storeState = store.useSelectorRC(resultSelector, {
      equalityFn: deepEqual,
    });

    useOnEvtmitterEvent(events, 'invalidateData', ({ payload: event }) => {
      for (const { itemKey, payload, isOffScreen } of queriesWithId) {
        if (isOffScreen) continue;

        if (itemKey !== event.itemKey) continue;

        if (!invalidationWasTriggered.has(itemKey)) {
          store.produceState((draft) => {
            const item = draft[itemKey];
            if (!item) return;

            item.refetchOnMount = false;
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
      ensureIsLoaded,
      returnRefetchingStatus,
      disableRefetchOnMount,
      returnIdleStatus,
      isOffScreen,
    }: {
      selector?: (data: ItemState | null) => Selected;
      omitPayload?: boolean;
      returnRefetchingStatus?: boolean;
      disableRefetchOnMount?: boolean;
      ensureIsLoaded?: boolean;
      returnIdleStatus?: boolean;
      isOffScreen?: boolean;
    } = {},
  ) {
    // FIX: throw error if payload is empty string (in all stores)
    const query = useMemo(
      () =>
        payload === false || payload === null || payload === undefined ?
          []
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
    });

    const result = useMemo(
      (): TSFDUseCollectionItemReturn<Selected, ItemPayload, NError> =>
        item[0] ?? {
          payload: undefined,
          data: selector ? selector(null) : __LEGIT_CAST__<Selected>(null),
          error: null,
          status: 'idle',
          itemStateKey: '',
          isLoading: false,
          queryMetadata: undefined,
        },
      [item, selector],
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
            emitIsLoadedEvt();
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
      endMutations.push(getScheduler(itemKey).startMutation());
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
      (draft) => {
        draft[itemKey] = {
          data,
          status: 'success',
          wasLoaded: true,
          refetchOnMount: false,
          error: null,
          payload: klona(fetchParams),
        };
      },
      { action: 'create-item-state' },
    );
  }

  function deleteItemState(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
  ) {
    const itemKeys = getItemsKeyArray(fetchParams);

    store.produceState(
      (draft) => {
        for (const itemKey of itemKeys) {
          draft[itemKey] = null;
        }
      },
      { action: 'delete-item-state' },
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

    let someItemWasUpdated: boolean = false;

    store.produceState(
      (draft) => {
        for (const itemKey of itemKeys) {
          const item = draft[itemKey];

          if (!item?.data) continue;

          someItemWasUpdated = true;

          const originalItem = store.state[itemKey];
          if (!originalItem) continue;

          const result = produceNewData(
            __LEGIT_CAST__<ItemState>(item.data),
            originalItem,
          );

          if (result !== undefined) {
            item.data = __LEGIT_CAST__(result);
          }
        }

        if (ifNothingWasUpdated && !someItemWasUpdated) {
          ifNothingWasUpdated();
        }
      },
      { action: 'update-item-state' },
    );

    return someItemWasUpdated;
  }

  async function performMutation<T>(
    payload: ItemPayload,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      onSuccess,
      debounce: _debounce,
    }: {
      optimisticUpdate?: (payload: ItemPayload) => void | boolean;
      mutation: (payload: ItemPayload) => Promise<T>;
      onSuccess?: (response: Awaited<T>, payload: ItemPayload) => void;
      revalidateOnSuccess?: boolean;
      silentErrors?: boolean;
      debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
    },
  ): Promise<Result<Awaited<T>, NError | true>> {
    const endMutation = startMutation(payload);

    if (optimisticUpdate) {
      if (optimisticUpdate(payload) === false) {
        endMutation();
        return Result.err(true);
      }
    }

    let unblockWindowClose: VoidFunction | null = null;

    try {
      if (_debounce) {
        unblockWindowClose = blockWindowClose().unblock;

        return Result.err(true);

        // FIX: Implement debounce
        // const debounceResult = await awaitDebounce({
        //   callId: [_debounce.context, _debounce.payload],
        //   debounce: _debounce.ms,
        // });

        // if (debounceResult === 'skip') {
        //   endMutation();
        //   return Result.err(true);
        // }
      }

      const result = await mutation(payload);

      endMutation();

      if (revalidateOnSuccess) {
        invalidateItem(payload);
      }

      if (onSuccess) {
        onSuccess(result, payload);
      }

      return Result.ok(result);
    } catch (exception) {
      endMutation();

      const error = errorNormalizer(unknownToError(exception));

      if (!silentErrors && onMutationError) {
        onMutationError(exception, { silentErrors });
      }

      invalidateItem(payload);

      return Result.err(error);
    } finally {
      unblockWindowClose?.();
    }
  }

  function reset() {
    schedulers.clear();
    store.setState({});
  }

  return {
    store,
    events,
    get invalidationWasTriggered() {
      return invalidationWasTriggered;
    },
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
    performMutation,
  };
}

function blockWindowClose() {
  return {
    unblock: () => {
      // FIX: Implement unblock
    },
  };
}
