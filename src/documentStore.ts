import { useOnEvtmitterEvent } from '@evtmitter/react';
import { isWindowFocused, onWindowFocus } from '@ls-stack/browser-utils/window';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import {
  __LEGIT_CAST__,
  type __LEGIT_ANY__,
} from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { produce } from 'immer';
import { useCallback, useEffect } from 'react';
import { unknownToError, type Result } from 't-result';
import { Store, useSubscribeToStore } from 't-state';
import { useListItem as useListItemBase } from './hooks/useListItem';
import { useListItemIsDeleted as useListItemIsDeletedBase } from './hooks/useListItemIsDeleted';
import { useListItemIsLoading as useListItemIsLoadingBase } from './hooks/useListItemIsLoading';
import {
  BatchRequest,
  FetchContext,
  FetchType,
  getAutoIncrementId,
  RequestScheduler,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from './requestScheduler';
import {
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from './utils/performMutation';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import {
  fetchTypePriority,
  StoreFetchError,
  TSDFStatus,
  ValidStoreState,
  type StoreError,
} from './utils/storeShared';
import { setupDocumentPersistence } from './persistentStorage/documentStorePersistence';
import type { DocumentPersistentStorageConfig } from './persistentStorage/types';
import { useEnsureIsLoaded } from './utils/useEnsureIsLoaded';

export type DocumentStatus = 'idle' | TSDFStatus;

export type TSDFUseDocumentReturn<Selected> = {
  status: DocumentStatus;
  data: Selected;
  error: StoreError | null;
  isLoading: boolean;
};

export type DocumentStoreState<State extends ValidStoreState> = {
  data: State | null;
  error: StoreError | null;
  status: DocumentStatus;
  refetchOnMount: false | FetchType;
};

type DocumentStoreEvents = {
  invalidateData: FetchType;
};

export type OnDocumentInvalidate = (priority: FetchType) => void;

export type DocumentStoreStoreEvents = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number };
  /** Emitted when a mutation completes or fails */
  mutationEnd: { mutationId: number; success: boolean };
};

export type DocumentStoreOptions<State extends ValidStoreState> = {
  debugName?: string;
  fetchFn: (signal: AbortSignal) => Promise<State>;
  errorNormalizer: (exception: Error) => StoreError;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  backgroundCoalescingWindowMultiplier: number;
  mediumPriorityDelayMs?: number;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { dontShowToast?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  usesRealTimeUpdates?: boolean;
  /** Opt-in persistent storage configuration. When provided, cached data is loaded
   * from storage on initialization and saved back on successful fetches. */
  persistentStorage?: DocumentPersistentStorageConfig<State>;
  /** @internal */
  '~test'?: {
    initialRefetchOnMount?: FetchType;
    initialStatus?: DocumentStatus;
    initialData?: State;
    initialError?: StoreError;
    initialLastFetchStartTime?: number;
  };
};

export type DocumentStore<State extends ValidStoreState> = ReturnType<
  typeof createDocumentStore<State>
>;

// Constant requestId for document store (single-item mode)
const DOC_REQUEST_ID = '_doc';

export function createDocumentStore<State extends ValidStoreState>({
  debugName,
  fetchFn,
  errorNormalizer,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  dynamicRealtimeThrottleMs,
  revalidateOnWindowFocus,
  backgroundCoalescingWindowMultiplier,
  mediumPriorityDelayMs,
  onSchedulerEvent,
  onMutationError,
  blockWindowClose,
  usesRealTimeUpdates = false,
  persistentStorage: persistentStorageConfig,
  '~test': testOptions,
}: DocumentStoreOptions<State>) {
  let invalidationWasTriggered = false;

  let initialData: State | null = null;
  let initialRefetchOnMount: FetchType | false = false;
  let initialStatus: DocumentStatus = 'idle';
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

  // Persistent storage setup
  const persistence = persistentStorageConfig
    ? setupDocumentPersistence(persistentStorageConfig)
    : null;

  if (persistence?.initialState) {
    initialData = persistence.initialState.data;
    initialStatus = persistence.initialState.status;
    initialRefetchOnMount = persistence.initialState.refetchOnMount;
  }

  // Track whether store was hydrated from persistent storage for refetch optimization
  let hydratedFromStorage =
    persistence !== null && persistence.initialState !== null;
  let hydratedRefetchDelayTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHydratedRefetchTimer() {
    if (hydratedRefetchDelayTimer !== null) {
      clearTimeout(hydratedRefetchDelayTimer);
      hydratedRefetchDelayTimer = null;
    }
  }

  const store = new Store<DocumentStoreState<State>>({
    debugName,
    state: () => ({
      data: initialData,
      error: initialError,
      status: initialStatus,
      refetchOnMount: initialRefetchOnMount,
    }),
  });

  const events = evtmitter<DocumentStoreEvents>();

  const storeEvents = evtmitter<DocumentStoreStoreEvents>();

  async function executeFetch(fetchCtx: FetchContext): Promise<boolean> {
    const currentStatus = store.state.status;
    const isHydratedRefetch =
      hydratedFromStorage && currentStatus === 'success';

    if (isHydratedRefetch) {
      // For the first fetch after hydration from persistent storage, delay showing
      // 'refetching' status by 100ms. If the fetch completes within 100ms, the user
      // never sees a loading indicator, providing a seamless experience.
      hydratedFromStorage = false;
      hydratedRefetchDelayTimer = setTimeout(() => {
        hydratedRefetchDelayTimer = null;
        if (store.state.status === 'success') {
          store.setPartialState(
            { status: 'refetching', error: null, refetchOnMount: false },
            { action: 'fetch-start-refetching-delayed' },
          );
        }
      }, 100);

      store.setPartialState(
        { error: null, refetchOnMount: false },
        { action: 'fetch-start-hydrated-refetch' },
      );
    } else {
      store.setPartialState(
        {
          status: currentStatus === 'success' ? 'refetching' : 'loading',
          error: null,
          refetchOnMount: false,
        },
        {
          action:
            currentStatus === 'success'
              ? 'fetch-start-refetching'
              : 'fetch-start-loading',
        },
      );
    }

    try {
      const data = await fetchFn(fetchCtx.signal);

      if (fetchCtx.shouldAbort()) {
        clearHydratedRefetchTimer();
        return false;
      }

      clearHydratedRefetchTimer();

      store.setPartialState(
        {
          data: reusePrevIfEqual({
            prev: store.state.data,
            current: data,
          }),
          status: 'success',
        },
        { action: 'fetch-success' },
      );

      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) {
        clearHydratedRefetchTimer();
        return false;
      }

      clearHydratedRefetchTimer();

      store.setPartialState(
        {
          error: errorNormalizer(
            exception instanceof Error
              ? exception
              : new Error(String(exception), { cause: exception }),
          ),
          status: 'error',
        },
        { action: 'fetch-error' },
      );

      return false;
    }
  }

  const wrappedDynamicRealtimeThrottleMs = dynamicRealtimeThrottleMs
    ? (lastFetchDuration: number) =>
        dynamicRealtimeThrottleMs({
          lastFetchDuration,
          windowIsNotFocused: !isWindowFocused(),
        })
    : undefined;

  // Scheduler with batch-aware fetchFn (but we always use single item)
  const scheduler = new RequestScheduler<null>({
    fetchFn: async (
      requests: BatchRequest<null>[],
      fetchCtx: FetchContext,
    ): Promise<Map<string, boolean>> => {
      // Document store always has single request
      const success = await executeFetch(fetchCtx);
      const results = new Map<string, boolean>();
      for (const { requestId } of requests) {
        results.set(requestId, success);
      }
      return results;
    },
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    on: onSchedulerEvent,
    initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
    usesRealTimeUpdates,
    getCoalescingWindowMultiplier: () =>
      !isWindowFocused() ? backgroundCoalescingWindowMultiplier : 1,
  });

  // Set up window focus listener for non-realtime stores
  let cleanupFocusListener: (() => void) | null = null;
  let cleanupReconnectFocusListener: (() => void) | null = null;

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
        invalidateData('lowPriority');
      }
    });
  }

  setupFocusListener();

  // Attach persistent storage after store creation
  persistence?.attach(store, invalidateData);

  function scheduleFetch(
    fetchType: FetchType,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults {
    return scheduler.scheduleFetch(DOC_REQUEST_ID, fetchType, null, options);
  }

  async function awaitFetch(
    options: { timeoutMs?: number } = {},
  ): Promise<
    { data: State; error: null } | { data: null; error: StoreFetchError }
  > {
    const result = await scheduler.awaitFetch(DOC_REQUEST_ID, null, options);

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

    if (store.state.error) {
      return {
        data: null,
        error: new StoreFetchError(store.state.error, 'fetch'),
      };
    }

    if (!store.state.data) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 404, id: 'not-found', message: 'Not found' },
          'fetch',
        ),
      };
    }

    return { data: store.state.data, error: null };
  }

  function invalidateData(priority: FetchType = 'highPriority'): void {
    const currentRefetchOnMount = store.state.refetchOnMount;
    const currentInvalidationPriority = currentRefetchOnMount
      ? fetchTypePriority[currentRefetchOnMount]
      : -1;
    const newInvalidationPriority = fetchTypePriority[priority];

    if (currentInvalidationPriority >= newInvalidationPriority) return;

    store.setKey('refetchOnMount', priority, {
      action: 'invalidate-data',
    });
    invalidationWasTriggered = false;
    events.emit('invalidateData', priority);
  }

  function updateState(
    produceNewData: (draftData: State) => State | void | undefined,
  ): boolean {
    if (!store.state.data) return false;

    store.setKey(
      'data',
      (current) => {
        if (!current) return current;

        return produce(current, produceNewData);
      },
      { action: 'update-state' },
    );

    return true;
  }

  /**
   * Signals that the real-time transport (e.g. WebSocket) has reconnected after
   * a disconnection. Events may have been missed during the outage, so data
   * needs to be revalidated.
   *
   * - No-op when `usesRealTimeUpdates` is `false`.
   * - If the window is focused, invalidates immediately with `realtimeUpdate` priority.
   * - If the window is **not** focused, defers invalidation until the next window
   *   focus event. Multiple calls while unfocused are coalesced (only one
   *   invalidation fires on focus).
   */
  function onTransportReconnect(): void {
    if (!usesRealTimeUpdates) return;

    cleanupReconnectFocusListener?.();
    cleanupReconnectFocusListener = null;

    if (isWindowFocused()) {
      invalidateData('realtimeUpdate');
    } else {
      cleanupReconnectFocusListener = onWindowFocus(() => {
        cleanupReconnectFocusListener?.();
        cleanupReconnectFocusListener = null;
        invalidateData('realtimeUpdate');
      });
    }
  }

  function reset(): void {
    scheduler.reset();
    cleanupReconnectFocusListener?.();
    cleanupReconnectFocusListener = null;

    if (hydratedRefetchDelayTimer !== null) {
      clearTimeout(hydratedRefetchDelayTimer);
      hydratedRefetchDelayTimer = null;
    }

    hydratedFromStorage = false;

    persistence?.dispose();
    void persistence?.clear();

    store.setState({
      data: null,
      error: null,
      status: 'idle',
      refetchOnMount: 'lowPriority',
    });
    setupFocusListener();
    persistence?.attach(store, invalidateData);
  }

  function startMutation(): () => boolean {
    return scheduler.startMutation(DOC_REQUEST_ID);
  }

  async function performMutation<T>({
    optimisticUpdate,
    mutation,
    debounce,
    dontShowErrorToast,
    revalidateOnSuccess,
  }: {
    optimisticUpdate?: (currentState: State | null) => void | boolean;
    debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
    dontShowErrorToast?: boolean;
    mutation: (ctx: {
      updateState: typeof updateState;
      currentState: State | null;
    }) => Promise<T>;
    revalidateOnSuccess?: boolean;
  }): Promise<Result<Awaited<T>, StoreError | true>> {
    const mutationId = getAutoIncrementId();
    storeEvents.emit('mutationStart', { mutationId });

    const result = await performMutationWithLifecycle({
      startMutation,
      optimisticUpdate: optimisticUpdate
        ? () => optimisticUpdate(store.state.data)
        : undefined,
      debounce,
      blockWindowClose: blockWindowClose ?? undefined,
      mutation: () =>
        mutation({
          updateState,
          currentState: store.state.data,
        }),
      onSuccess: () => {
        if (revalidateOnSuccess) {
          invalidateData();
        }
      },
      onError: (exception) => {
        if (onMutationError) {
          onMutationError(exception, { dontShowToast: dontShowErrorToast });
        }

        invalidateData();

        return errorNormalizer(unknownToError(exception));
      },
    });

    storeEvents.emit('mutationEnd', { mutationId, success: result.ok });

    return result;
  }

  function useDocument<Selected = State | null>({
    selector,
    isOffScreen,
    disabled = isOffScreen,
    returnRefetchingStatus,
    disableRefetchOnMount = globalDisableRefetchOnMount,
    returnIdleStatus = !!disabled,
    ensureIsLoaded,
    disableRefetches,
  }: {
    selector?: (data: State | null) => Selected;
    disabled?: boolean;
    isOffScreen?: boolean;
    /** only loads the data if it is not already loaded and skip any other refetches */
    disableRefetches?: boolean;
    disableRefetchOnMount?: boolean;
    returnIdleStatus?: boolean;
    ensureIsLoaded?: boolean;
    returnRefetchingStatus?: boolean;
  } = {}) {
    const storeStateSelector = useCallback(
      (state: DocumentStoreState<State>): TSDFUseDocumentReturn<Selected> => {
        const { error } = state;

        const data = selector
          ? selector(state.data)
          : __LEGIT_CAST__<Selected, State | null>(state.data);

        let status = state.status;

        if (!returnIdleStatus && status === 'idle') {
          status = 'loading';
        }

        if (!returnRefetchingStatus && status === 'refetching') {
          status = 'success';
        }

        return {
          data,
          error,
          status,
          isLoading: status === 'loading',
        };
      },
      [selector, returnIdleStatus, returnRefetchingStatus],
    );

    const storeState = store.useSelectorRC(storeStateSelector, {
      equalityFn: deepEqual,
    });

    useOnEvtmitterEvent(events, 'invalidateData', ({ payload: priority }) => {
      if (disabled) return;
      if (
        disableRefetches &&
        store.state.status !== 'idle' &&
        store.state.status !== 'error'
      ) {
        return;
      }

      if (!invalidationWasTriggered) {
        store.setKey('refetchOnMount', false);

        scheduleFetch(priority);
        invalidationWasTriggered = true;
      }
    });

    useEffect(() => {
      if (disabled) return;

      const fetchType = store.state.refetchOnMount || 'lowPriority';

      if (disableRefetches) {
        if (store.state.status === 'idle' || store.state.status === 'error') {
          scheduleFetch(fetchType);
        }
      } else if (disableRefetchOnMount) {
        const shouldFetch =
          store.state.refetchOnMount || store.state.status === 'idle';

        if (shouldFetch) {
          scheduleFetch(fetchType);
        }
      } else {
        scheduleFetch(fetchType);
      }
    }, [disableRefetchOnMount, disableRefetches, disabled]);

    const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
      ensureIsLoaded,
      !disabled,
      () => {
        scheduleFetch('highPriority');
      },
    );

    useSubscribeToStore(store, ({ observe }) => {
      observe
        .ifSelector((state) => state.status)
        .change.then(({ current }) => {
          if (current === 'success' || current === 'error') {
            emitIsLoadedEvt();
          }
        });
    });

    return useModifyResult(storeState);
  }

  /** Detects whether a specific item inside the document's data is still loading.
   * Useful when the document holds a list/record of items and a component displays
   * an individual item that may not be present yet. */
  function useListItemIsLoading({
    itemId,
    selector,
    loadItemFallback,
    ensureIsLoaded,
  }: {
    /** Unique identifier of the item within the document */
    itemId: string;
    /** Extracts the item from the document data; returning `null`/`undefined` means "not found" */
    selector: (data: State | null) => unknown;
    /** Called after a timeout if the item is still missing and no refetch is in progress. Defaults to `invalidateData()`. */
    loadItemFallback?: () => void;
    /** If true, forces a high-priority fetch and shows loading until the data is loaded */
    ensureIsLoaded?: boolean;
  }): boolean {
    const doc = useDocument({
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = doc.data != null;
    const listIsLoading = doc.isLoading;
    const isRefetching = doc.status === 'refetching';

    return useListItemIsLoadingBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateData()),
    });
  }

  /** Detects when a specific item inside the document's data has been deleted.
   * Only triggers after the item was previously found and then disappears — not
   * during initial loading. */
  function useListItemIsDeleted({
    itemId,
    selector,
    onDelete,
    ensureIsLoaded,
  }: {
    /** Unique identifier of the item within the document */
    itemId: string;
    /** Extracts the item from the document data; returning `null`/`undefined` means "not found" */
    selector: (data: State | null) => unknown;
    /** Called once when the deletion is detected */
    onDelete?: () => void;
    /** If true, forces a high-priority fetch and shows loading until the data is loaded */
    ensureIsLoaded?: boolean;
  }): boolean {
    const doc = useDocument({
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = doc.data != null;
    const listIsLoading = doc.isLoading;

    return useListItemIsDeletedBase({
      itemId,
      itemExists,
      listIsLoading,
      onDelete,
    });
  }

  /** Combined hook that returns `{ isLoading, isDeleted, data }` for a specific item
   * inside the document's data. Composes `useListItemIsLoading` and `useListItemIsDeleted`. */
  function useListItem<Selected>({
    itemId,
    selector,
    loadItemFallback,
    onDelete,
    ensureIsLoaded,
  }: {
    /** Unique identifier of the item within the document */
    itemId: string;
    /** Extracts and maps the item from the document data */
    selector: (data: State | null) => Selected;
    /** Called after a timeout if the item is still missing. Defaults to `invalidateData()`. */
    loadItemFallback?: () => void;
    /** Called once when the deletion is detected */
    onDelete?: () => void;
    /** If true, forces a high-priority fetch and shows loading until the data is loaded */
    ensureIsLoaded?: boolean;
  }): { isLoading: boolean; isDeleted: boolean; data: Selected } {
    const doc = useDocument({
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = doc.data != null;
    const listIsLoading = doc.isLoading;
    const isRefetching = doc.status === 'refetching';

    return useListItemBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateData()),
      data: doc.data,
      onDelete,
    });
  }

  return {
    store,
    events,
    storeEvents,
    get invalidationWasTriggered() {
      return invalidationWasTriggered;
    },
    set invalidationWasTriggered(value: boolean) {
      invalidationWasTriggered = value;
    },
    scheduleFetch,
    awaitFetch,
    invalidateData,
    updateState,
    reset,
    startMutation,
    useDocument,
    useListItemIsLoading,
    useListItemIsDeleted,
    useListItem,
    performMutation,
    onTransportReconnect,
  };
}
