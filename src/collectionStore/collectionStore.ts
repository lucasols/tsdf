import { filterAndMap } from '@ls-stack/utils/arrayUtils';
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
  StoreFetchError,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
  type StoreError,
} from '../utils/storeShared';
import { executeBatchFetch as executeBatchFetchBase } from './executeBatchFetch';
import { useItem as useItemBase, UseItemOptions } from './useItem';
import {
  useMultipleItems as useMultipleItemsBase,
  UseMultipleItemsOptions,
} from './useMultipleItems';

export type CollectionItemStatus = TSDFStatus;

export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  data: ItemState | null;
  error: StoreError | null;
  status: CollectionItemStatus;
  payload: ItemPayload;
  refetchOnMount: false | FetchType;
  wasLoaded: boolean;
};

export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload> | null>;

export type TSFDUseCollectionItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  data: Selected;
  status: CollectionItemStatus | 'idle' | 'deleted';
  payload: ItemPayload | undefined;
  error: StoreError | null;
  itemStateKey: string;
  isLoading: boolean;
  queryMetadata: QueryMetadata;
};

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

export type OnCollectionItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  itemState: ItemState;
  payload: ItemPayload;
  priority: FetchType;
}) => void;

export type CollectionInitialStateItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = {
  payload: ItemPayload;
  data: ItemState;
};

export type CollectionStoreOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  debugName?: string;
  fetchFn: (params: ItemPayload, signal: AbortSignal) => Promise<ItemState>;
  /** Optional batch fetch function for fetching multiple items at once */
  batchFetchFn?: (
    payloads: ItemPayload[],
    signal: AbortSignal,
  ) => Promise<Map<ItemPayload, ItemState | Error>>;
  /** Max items per batch - triggers immediate fetch when reached */
  maxBatchSize?: number;
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  errorNormalizer: (exception: Error) => StoreError;
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
  usesRealTimeUpdates?: boolean;
  /** @internal */
  '~test'?: {
    initialRefetchOnMount?: FetchType;
    initialStatus?: CollectionItemStatus;
    initialData?: CollectionInitialStateItem<ItemPayload, ItemState>[];
    initialError?: StoreError;
    initialLastFetchStartTime?: number;
  };
};

export type CollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = ReturnType<typeof createCollectionStore<ItemState, ItemPayload>>;

type CollectionStoreEvents = {
  invalidateData: { priority: FetchType; itemKey: string };
};

export function createCollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>({
  debugName,
  fetchFn,
  batchFetchFn,
  maxBatchSize,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  errorNormalizer,
  mediumPriorityDelayMs,
  dynamicRealtimeThrottleMs,
  getCollectionItemKey: filterCollectionItemObjKey,
  onInvalidate,
  onSchedulerEvent,
  onMutationError,
  usesRealTimeUpdates = false,
  '~test': testOptions,
}: CollectionStoreOptions<ItemState, ItemPayload>) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload>;

  let initialData:
    | CollectionInitialStateItem<ItemPayload, ItemState>[]
    | undefined;
  let initialRefetchOnMount: FetchType | false = false;
  let initialStatus: CollectionItemStatus = 'success';
  let initialError: StoreError | null = null;

  const globalDisableRefetchOnMount = usesRealTimeUpdates;

  if (import.meta.env.TEST && testOptions) {
    if (testOptions.initialData) {
      initialData = testOptions.initialData;
    }

    if (testOptions.initialRefetchOnMount) {
      initialRefetchOnMount = testOptions.initialRefetchOnMount;
    }

    if (testOptions.initialStatus) {
      initialStatus = testOptions.initialStatus;
    }

    if (testOptions.initialError) {
      initialError = testOptions.initialError;
    }
  }

  const store = new Store<CollectionState>({
    debugName,
    state: () => {
      const initialState: CollectionState = {};

      if (initialData) {
        for (const item of initialData) {
          const itemKey = getItemKey(item.payload);

          initialState[itemKey] = {
            data: item.data,
            error: initialError,
            status: initialStatus,
            payload: item.payload,
            refetchOnMount: initialRefetchOnMount,
            wasLoaded: initialStatus !== 'loading',
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

  // Map to track itemKey -> payload for batch fetch results
  const itemKeyToPayload = new Map<string, ItemPayload>();

  // Use single scheduler only when batchFetchFn is provided
  // Otherwise, use per-item schedulers for backward compatibility
  const useSingleScheduler = !!batchFetchFn;

  // Single scheduler for batch coalescing (only used when batchFetchFn is provided)
  const singleScheduler =
    useSingleScheduler ?
      new RequestScheduler<ItemPayload>({
        fetchFn: async (
          requests: BatchRequest<ItemPayload>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          return executeBatchFetch(requests, fetchCtx);
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        maxBatchSize,
        on: onSchedulerEvent,
        initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
        usesRealTimeUpdates,
      })
    : null;

  // Per-item schedulers for backward compatibility (when batchFetchFn is NOT provided)
  const perItemSchedulers = new Map<string, RequestScheduler<ItemPayload>>();

  function getOrCreateItemScheduler(
    itemKey: string,
  ): RequestScheduler<ItemPayload> {
    let itemScheduler = perItemSchedulers.get(itemKey);
    if (!itemScheduler) {
      itemScheduler = new RequestScheduler<ItemPayload>({
        fetchFn: async (
          requests: BatchRequest<ItemPayload>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          return executeBatchFetch(requests, fetchCtx);
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
        usesRealTimeUpdates,
      });
      perItemSchedulers.set(itemKey, itemScheduler);
    }
    return itemScheduler;
  }

  function getScheduler(itemKey: string): RequestScheduler<ItemPayload> {
    if (singleScheduler) return singleScheduler;
    return getOrCreateItemScheduler(itemKey);
  }

  async function executeBatchFetch(
    requests: BatchRequest<ItemPayload>[],
    fetchCtx: FetchContext,
  ): Promise<Map<string, boolean>> {
    return executeBatchFetchBase(
      requests,
      fetchCtx,
      store,
      itemKeyToPayload,
      fetchFn,
      batchFetchFn,
      errorNormalizer,
    );
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
      const scheduler = getScheduler(itemKey);
      results.push(scheduler.scheduleFetch(itemKey, fetchType, param, options));
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
    options: { timeoutMs?: number } = {},
  ): Promise<
    { data: ItemState; error: null } | { data: null; error: StoreFetchError }
  > {
    const itemId = getItemKey(params);
    const scheduler = getScheduler(itemId);

    const result = await scheduler.awaitFetch(itemId, params, options);

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

    const item = store.state[itemId];

    if (item?.error) {
      return {
        data: null,
        error: new StoreFetchError(item.error, 'fetch'),
      };
    }

    if (!item?.data) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 404, id: 'not-found', message: 'Not found' },
          'fetch',
        ),
      };
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
    options: UseMultipleItemsOptions<ItemState, Selected> = {},
  ) {
    return useMultipleItemsBase<
      ItemState,
      ItemPayload,
      Selected,
      QueryMetadata
    >(
      items,
      options,
      store,
      events,
      getItemKey,
      getItemState,
      scheduleFetch,
      invalidationWasTriggered,
      globalDisableRefetchOnMount,
    );
  }

  function useItem<Selected = ItemState | null>(
    payload: ItemPayload | undefined | false | null,
    options: UseItemOptions<ItemState, Selected> = {},
  ) {
    return useItemBase<ItemState, ItemPayload, Selected>(
      payload,
      options,
      store,
      scheduleFetch,
      useMultipleItems,
    );
  }

  type EndMutation = () => void;

  function startMutation(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
  ): EndMutation {
    const itemKeys = getItemsKeyArray(fetchParams);

    const endMutations: (() => boolean)[] = [];

    for (const itemKey of itemKeys) {
      const scheduler = getScheduler(itemKey);
      endMutations.push(scheduler.startMutation(itemKey));
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
    {
      ifNothingWasUpdated,
    }: {
      ifNothingWasUpdated?: () => void;
    } = {},
  ): boolean {
    const itemKeys = getItemsKeyArray(fetchParams);

    let someItemWasUpdated: boolean = false;

    store.batch(() => {
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
        },
        { action: 'update-item-state' },
      );

      if (ifNothingWasUpdated && !someItemWasUpdated) {
        ifNothingWasUpdated();
      }
    });

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
  ): Promise<Result<Awaited<T>, StoreError | true>> {
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

        const debounceResult = await awaitDebounce({
          callId: [_debounce.context, _debounce.payload],
          debounce: _debounce.ms,
        });

        if (debounceResult === 'skip') {
          endMutation();
          return Result.err(true);
        }
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
    if (singleScheduler) {
      singleScheduler.reset();
    } else {
      for (const scheduler of perItemSchedulers.values()) {
        scheduler.reset();
      }
      perItemSchedulers.clear();
    }
    store.setState({});
  }

  return {
    store,
    events,
    scheduler: singleScheduler,
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
