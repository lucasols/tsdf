import { useOnEvtmitterEvent } from '@evtmitter/react';
import {
  __LEGIT_CAST__,
  type __LEGIT_ANY__,
} from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { produce } from 'immer';
import { useCallback, useEffect } from 'react';
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
import { fetchTypePriority, TSDFStatus, ValidStoreState } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';

export type DocumentStatus = 'idle' | TSDFStatus;

export type TSDFUseDocumentReturn<Selected, NError> = {
  status: DocumentStatus;
  data: Selected;
  error: NError | null;
  isLoading: boolean;
};

export type DocumentStoreState<
  State extends ValidStoreState,
  NError extends ResultValidErrors,
> = {
  data: State | null;
  error: NError | null;
  status: DocumentStatus;
  refetchOnMount: false | FetchType;
};

type DocumentStoreEvents = {
  invalidateData: FetchType;
};

export type OnDocumentInvalidate = (priority: FetchType) => void;

export type DocumentStoreOptions<
  State extends ValidStoreState,
  NError extends ResultValidErrors,
> = {
  debugName?: string;
  fetchFn: (signal: AbortSignal) => Promise<State>;
  getInitialData?: () => State | undefined;
  disableInitialDataInvalidation?: boolean;
  disableRefetchOnMount?: boolean;
  errorNormalizer: (exception: Error) => NError;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  mediumPriorityDelayMs?: number;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { dontShowToast?: boolean },
  ) => void;
};

export type DocumentStore<
  State extends ValidStoreState,
  NError extends ResultValidErrors,
> = ReturnType<typeof createDocumentStore<State, NError>>;

export function createDocumentStore<
  State extends ValidStoreState,
  NError extends ResultValidErrors,
>({
  debugName,
  fetchFn,
  getInitialData,
  disableInitialDataInvalidation,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  errorNormalizer,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  dynamicRealtimeThrottleMs,
  mediumPriorityDelayMs,
  onSchedulerEvent,
  onMutationError,
}: DocumentStoreOptions<State, NError>) {
  let invalidationWasTriggered = false;

  const initialData = getInitialData?.();

  const store = new Store<DocumentStoreState<State, NError>>({
    debugName,
    state: () => ({
      data: initialData ?? null,
      error: null,
      status: initialData !== undefined ? 'success' : 'idle',
      refetchOnMount:
        initialData !== undefined && !disableInitialDataInvalidation ?
          'lowPriority'
        : false,
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
          currentStatus === 'success' ?
            'fetch-start-refetching'
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
            exception instanceof Error ? exception : (
              new Error(String(exception), { cause: exception })
            ),
          ),
          status: 'error',
        },
        { action: 'fetch-error' },
      );

      return false;
    }
  }

  const scheduler = new RequestScheduler<null>({
    fetchFn: executeFetch,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    on: onSchedulerEvent,
  });

  function scheduleFetch(
    fetchType: FetchType,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults {
    return scheduler.scheduleFetch(fetchType, null, options);
  }

  async function awaitFetch(): Promise<
    { data: State; error: null } | { data: null; error: NError }
  > {
    const wasAborted = await scheduler.awaitFetch(null);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    if (store.state.error) {
      return { data: null, error: store.state.error };
    }

    if (!store.state.data) {
      return {
        data: null,
        error: errorNormalizer(new Error('Not found')),
      };
    }

    return { data: store.state.data, error: null };
  }

  function invalidateData(priority: FetchType = 'highPriority'): void {
    const currentRefetchOnMount = store.state.refetchOnMount;
    const currentInvalidationPriority =
      currentRefetchOnMount ? fetchTypePriority[currentRefetchOnMount] : -1;
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
    return scheduler.startMutation();
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
  }): Promise<Result<Awaited<T>, NError | true>> {
    const endMutation = startMutation();

    if (optimisticUpdate) {
      if (optimisticUpdate(store.state.data) === false) {
        endMutation();
        return Result.err(true);
      }
    }

    let unblockWindowClose: VoidFunction | null = null;

    try {
      if (debounce) {
        unblockWindowClose = blockWindowClose().unblock;

        return Result.err(true);

        // FIX: Implement debounce
        // const debounceResult = await awaitDebouce({
        //   callId: [debounce.context, debounce.payload],
        //   debounce: debounce.ms,
        // });

        // if (debounceResult === 'skip') {
        //   endMutation();
        //   return Result.err(true);
        // }
      }

      const result = await mutation({
        updateState,
        currentState: store.state.data,
      });

      endMutation();

      if (revalidateOnSuccess) {
        invalidateData();
      }

      return Result.ok(result);
    } catch (exception) {
      endMutation();

      if (onMutationError) {
        onMutationError(exception, { dontShowToast: dontShowErrorToast });
      }

      invalidateData();

      return Result.err(errorNormalizer(unknownToError(exception)));
    } finally {
      unblockWindowClose?.();
    }
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
      (
        state: DocumentStoreState<State, NError>,
      ): TSDFUseDocumentReturn<Selected, NError> => {
        const { error } = state;

        const data =
          selector ?
            selector(state.data)
          : __LEGIT_CAST__<Selected>(state.data);

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

function blockWindowClose() {
  return {
    unblock: () => {
      // FIX: Implement unblock
    },
  };
}
