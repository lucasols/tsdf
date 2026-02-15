import { isWindowFocused, onWindowFocus } from '@ls-stack/browser-utils/window';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { unknownToError, type Result } from 't-result';
import { Store } from 't-state';
import { useListItem as useListItemBase } from '../hooks/useListItem';
import { useListItemIsDeleted as useListItemIsDeletedBase } from '../hooks/useListItemIsDeleted';
import { useListItemIsLoading as useListItemIsLoadingBase } from '../hooks/useListItemIsLoading';
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
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from '../utils/performMutation';
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
    batchKey: string,
  ) => Promise<Map<ItemPayload, ItemState | Error>>;
  /** Optional function to group batch fetches by key. Return false to fall back to individual fetchFn */
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  /** Max items per batch - triggers immediate fetch when reached */
  maxBatchSize?: number;
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  errorNormalizer: (exception: Error) => StoreError;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  backgroundCoalescingWindowMultiplier: number;
  onInvalidate?: OnCollectionItemInvalidate<ItemState, ItemPayload>;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { silentErrors?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
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
  getItemsBatchKey,
  maxBatchSize,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  errorNormalizer,
  mediumPriorityDelayMs,
  dynamicRealtimeThrottleMs,
  revalidateOnWindowFocus,
  backgroundCoalescingWindowMultiplier,
  getCollectionItemKey: filterCollectionItemObjKey,
  onInvalidate,
  onSchedulerEvent,
  onMutationError,
  blockWindowClose,
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

  const wrappedDynamicRealtimeThrottleMs = dynamicRealtimeThrottleMs
    ? (lastFetchDuration: number) =>
        dynamicRealtimeThrottleMs({
          lastFetchDuration,
          windowIsNotFocused: !isWindowFocused(),
        })
    : undefined;

  const getCoalescingWindowMultiplier = (): number =>
    !isWindowFocused() ? backgroundCoalescingWindowMultiplier : 1;

  const useBatchSchedulers = !!batchFetchFn;

  const batchKeySchedulers = new Map<string, RequestScheduler<ItemPayload>>();

  function getOrCreateBatchKeyScheduler(
    batchKey: string,
  ): RequestScheduler<ItemPayload> {
    let scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) {
      scheduler = new RequestScheduler<ItemPayload>({
        fetchFn: async (
          requests: BatchRequest<ItemPayload>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          return executeBatchFetch(requests, fetchCtx, batchKey);
        },
        lowPriorityThrottleMs,
        baseCoalescingWindowMs,
        dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        maxBatchSize,
        on: onSchedulerEvent,
        initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
        usesRealTimeUpdates,
        getCoalescingWindowMultiplier,
      });
      batchKeySchedulers.set(batchKey, scheduler);
    }
    return scheduler;
  }

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
        dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
        usesRealTimeUpdates,
        getCoalescingWindowMultiplier,
      });
      perItemSchedulers.set(itemKey, itemScheduler);
    }
    return itemScheduler;
  }

  function getScheduler(
    itemKey: string,
    payload: ItemPayload,
  ): RequestScheduler<ItemPayload> {
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
    return getOrCreateItemScheduler(itemKey);
  }

  async function executeBatchFetch(
    requests: BatchRequest<ItemPayload>[],
    fetchCtx: FetchContext,
    batchKey?: string,
  ): Promise<Map<string, boolean>> {
    return executeBatchFetchBase(
      requests,
      fetchCtx,
      store,
      fetchFn,
      batchFetchFn,
      errorNormalizer,
      batchKey,
    );
  }

  function getBatchKey(payload: ItemPayload): string | false {
    if (!useBatchSchedulers) return false;
    if (!getItemsBatchKey) return '__default__';
    return getItemsBatchKey(payload);
  }

  function maybeDisposeBatchScheduler(payload: ItemPayload): void {
    const batchKey = getBatchKey(payload);
    if (batchKey === false) return;

    const scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) return;

    const hasRelatedItems = Object.values(store.state).some((item) => {
      if (!item) return false;
      return getBatchKey(item.payload) === batchKey;
    });

    if (!hasRelatedItems) {
      scheduler.reset();
      batchKeySchedulers.delete(batchKey);
    }
  }

  function cleanupItemResources(itemKey: string, payload: ItemPayload): void {
    invalidationWasTriggered.delete(itemKey);

    const itemScheduler = perItemSchedulers.get(itemKey);
    if (itemScheduler) {
      itemScheduler.reset();
      perItemSchedulers.delete(itemKey);
    }

    maybeDisposeBatchScheduler(payload);
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
      const scheduler = getScheduler(itemKey, param);
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
    const scheduler = getScheduler(itemId, params);

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
  ): { itemKey: string; payload: ItemPayload }[] {
    const items = store.state;

    if (Array.isArray(params)) {
      return params.map((p) => ({ itemKey: getItemKey(p), payload: p }));
    } else if (typeof params === 'function') {
      return filterAndMap(Object.entries(items), ([itemKey, item]) => {
        return item && params(item.payload, item.data)
          ? { itemKey, payload: item.payload }
          : false;
      });
    } else {
      return [{ payload: params, itemKey: getItemKey(params) }];
    }
  }

  const invalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemPayload: ItemPayload | ItemPayload[] | FilterItemsFn,
    priority: FetchType = 'highPriority',
  ) {
    const itemsKey = getItemsKeyArray(itemPayload);

    for (const { itemKey } of itemsKey) {
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

      return filterAndMap(itemsId, ({ itemKey }) => {
        return store.state[itemKey] || false;
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

    for (const { itemKey, payload } of itemKeys) {
      const scheduler = getScheduler(itemKey, payload);
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
        for (const { itemKey } of itemKeys) {
          draft[itemKey] = null;
        }
      },
      { action: 'delete-item-state' },
    );

    for (const { itemKey, payload } of itemKeys) {
      cleanupItemResources(itemKey, payload);
    }
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
          for (const { itemKey } of itemKeys) {
            const item = draft[itemKey];

            if (!item?.data) continue;

            someItemWasUpdated = true;

            const originalItem = store.state[itemKey];
            if (!originalItem) continue;

            const result = produceNewData(item.data, originalItem);

            if (result !== undefined) {
              item.data = result;
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
    return performMutationWithLifecycle({
      startMutation: () => startMutation(payload),
      optimisticUpdate: optimisticUpdate
        ? () => optimisticUpdate(payload)
        : undefined,
      debounce: _debounce,
      blockWindowClose: blockWindowClose ?? undefined,
      mutation: () => mutation(payload),
      onSuccess: (result) => {
        if (revalidateOnSuccess) {
          invalidateItem(payload);
        }

        if (onSuccess) {
          onSuccess(result, payload);
        }
      },
      onError: (exception) => {
        const error = errorNormalizer(unknownToError(exception));

        if (!silentErrors && onMutationError) {
          onMutationError(exception, { silentErrors });
        }

        invalidateItem(payload);

        return error;
      },
    });
  }

  // Set up window focus listener for non-realtime stores
  let cleanupFocusListener: (() => void) | null = null;

  function setupFocusListener() {
    cleanupFocusListener?.();
    cleanupFocusListener = null;

    if (!revalidateOnWindowFocus || usesRealTimeUpdates) return;

    cleanupFocusListener = onWindowFocus(() => {
      const enabled =
        typeof revalidateOnWindowFocus === 'function'
          ? revalidateOnWindowFocus()
          : revalidateOnWindowFocus;

      if (enabled) {
        invalidateItem(() => true, 'lowPriority');
      }
    });
  }

  setupFocusListener();

  function reset() {
    for (const scheduler of batchKeySchedulers.values()) {
      scheduler.reset();
    }
    batchKeySchedulers.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();

    invalidationWasTriggered.clear();

    store.setState({});
    setupFocusListener();
  }

  /** Detects whether a specific item inside a collection item's data is still loading.
   * Useful when a collection item holds a list/record of sub-items and a component
   * displays one that may not be present yet. */
  function useListItemIsLoading(
    payload: ItemPayload,
    {
      itemId,
      selector,
      loadItemFallback,
      ensureIsLoaded,
    }: {
      /** Unique identifier of the sub-item within the collection item */
      itemId: string;
      /** Extracts the sub-item from the collection item data; returning `null`/`undefined` means "not found" */
      selector: (data: ItemState | null) => unknown;
      /** Called after a timeout if the sub-item is still missing and no refetch is in progress. Defaults to `invalidateItem(payload)`. */
      loadItemFallback?: () => void;
      /** If true, forces a high-priority fetch and shows loading until the data is loaded */
      ensureIsLoaded?: boolean;
    },
  ): boolean {
    const item = useItem(payload, {
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = item.data != null;
    const listIsLoading = item.isLoading;
    const isRefetching = item.status === 'refetching';

    return useListItemIsLoadingBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateItem(payload)),
    });
  }

  /** Detects when a specific item inside a collection item's data has been deleted.
   * Only triggers after the sub-item was previously found and then disappears — not
   * during initial loading. */
  function useListItemIsDeleted(
    payload: ItemPayload,
    {
      itemId,
      selector,
      onDelete,
      ensureIsLoaded,
    }: {
      /** Unique identifier of the sub-item within the collection item */
      itemId: string;
      /** Extracts the sub-item from the collection item data; returning `null`/`undefined` means "not found" */
      selector: (data: ItemState | null) => unknown;
      /** Called once when the deletion is detected */
      onDelete?: () => void;
      /** If true, forces a high-priority fetch and shows loading until the data is loaded */
      ensureIsLoaded?: boolean;
    },
  ): boolean {
    const item = useItem(payload, {
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = item.data != null;
    const listIsLoading = item.isLoading;

    return useListItemIsDeletedBase({
      itemId,
      itemExists,
      listIsLoading,
      onDelete,
    });
  }

  /** Combined hook that returns `{ isLoading, isDeleted, data }` for a specific item
   * inside a collection item's data. Composes `useListItemIsLoading` and `useListItemIsDeleted`. */
  function useListItem<Selected>(
    payload: ItemPayload,
    {
      itemId,
      selector,
      loadItemFallback,
      onDelete,
      ensureIsLoaded,
    }: {
      /** Unique identifier of the sub-item within the collection item */
      itemId: string;
      /** Extracts and maps the sub-item from the collection item data */
      selector: (data: ItemState | null) => Selected;
      /** Called after a timeout if the sub-item is still missing. Defaults to `invalidateItem(payload)`. */
      loadItemFallback?: () => void;
      /** Called once when the deletion is detected */
      onDelete?: () => void;
      /** If true, forces a high-priority fetch and shows loading until the data is loaded */
      ensureIsLoaded?: boolean;
    },
  ): { isLoading: boolean; isDeleted: boolean; data: Selected } {
    const item = useItem(payload, {
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = item.data != null;
    const listIsLoading = item.isLoading;
    const isRefetching = item.status === 'refetching';

    return useListItemBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateItem(payload)),
      data: item.data,
      onDelete,
    });
  }

  return {
    store,
    events,
    scheduler: null,
    get invalidationWasTriggered() {
      return invalidationWasTriggered;
    },
    scheduleFetch,
    awaitFetch,
    useMultipleItems,
    useItem,
    useListItemIsLoading,
    useListItemIsDeleted,
    useListItem,
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
