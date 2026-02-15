import { useOnEvtmitterEvent } from '@evtmitter/react';
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
import {
  BatchRequest,
  FetchContext,
  FetchType,
  RequestScheduler,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from './requestScheduler';
import { performMutationWithLifecycle, type BlockWindowCloseHandler } from './utils/performMutation';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import {
  fetchTypePriority,
  StoreFetchError,
  TSDFStatus,
  ValidStoreState,
  type StoreError,
} from './utils/storeShared';
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

export type DocumentStoreOptions<State extends ValidStoreState> = {
  debugName?: string;
  fetchFn: (signal: AbortSignal) => Promise<State>;
  errorNormalizer: (exception: Error) => StoreError;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  mediumPriorityDelayMs?: number;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { dontShowToast?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  usesRealTimeUpdates?: boolean;
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
  mediumPriorityDelayMs,
  onSchedulerEvent,
  onMutationError,
  blockWindowClose,
  usesRealTimeUpdates = false,
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

  async function executeFetch(fetchCtx: FetchContext): Promise<boolean> {
    const currentStatus = store.state.status;

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

    try {
      const data = await fetchFn(fetchCtx.signal);

      if (fetchCtx.shouldAbort()) return false;

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
      if (fetchCtx.shouldAbort()) return false;

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
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    on: onSchedulerEvent,
    initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
    usesRealTimeUpdates,
  });

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

  function reset(): void {
    scheduler.reset();
    store.setState({
      data: null,
      error: null,
      status: 'idle',
      refetchOnMount: 'lowPriority',
    });
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
    return performMutationWithLifecycle({
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
  }

  function useDocument<Selected = State | null>({
    selector,
    isOffScreen,
    disabled = isOffScreen,
    returnRefetchingStatus,
    disableRefetchOnMount = globalDisableRefetchOnMount,
    returnIdleStatus = !!disabled,
    ensureIsLoaded,
  }: {
    selector?: (data: State | null) => Selected;
    disabled?: boolean;
    isOffScreen?: boolean;
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

      if (!invalidationWasTriggered) {
        store.setKey('refetchOnMount', false);

        scheduleFetch(priority);
        invalidationWasTriggered = true;
      }
    });

    useEffect(() => {
      if (disabled) return;

      const fetchType = store.state.refetchOnMount || 'lowPriority';

      if (disableRefetchOnMount) {
        const shouldFetch =
          store.state.refetchOnMount || store.state.status === 'idle';

        if (shouldFetch) {
          scheduleFetch(fetchType);
        }
      } else {
        scheduleFetch(fetchType);
      }
    }, [disableRefetchOnMount, disabled]);

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

  return {
    store,
    events,
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
    performMutation,
  };
}
