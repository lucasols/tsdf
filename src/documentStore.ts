import { evtmitter } from 'evtmitter';
import { useOnEvtmitterEvent } from 'evtmitter/react';
import { produce } from 'immer';
import { useCallback, useEffect, useMemo } from 'react';
import { Store, deepEqual, useSubscribeToStore } from 't-state';
import {
  FetchContext,
  FetchType,
  ScheduleFetchResults,
  createFetchOrquestrator,
} from './fetchOrquestrator';
import { TSDFStatus, ValidStoreState, fetchTypePriority } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';

type DocumentStatus = TSDFStatus | 'idle';

export type TSDFDocumentStoreState<State extends ValidStoreState, NError> = {
  data: State | null;
  error: NError | null;
  status: DocumentStatus;
  refetchOnMount: false | FetchType;
};

export type TSDFUseDocumentReturn<Selected, NError> = {
  status: DocumentStatus;
  data: Selected;
  error: NError | null;
  isLoading: boolean;
};

export type OnDocumentInvalidate = (priority: FetchType) => void;

export function newTSDFDocumentStore<State extends ValidStoreState, NError>({
  debugName,
  fetchFn,
  getInitialData,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  lowPriorityThrottleMs,
  mediumPriorityThrottleMs,
  dynamicRealtimeThrottleMs,
  disableInitialDataInvalidation,
  errorNormalizer,
  onInvalidate,
}: {
  debugName?: string;
  fetchFn: () => Promise<State>;
  getInitialData?: () => State | undefined;
  disableInitialDataInvalidation?: boolean;
  errorNormalizer: (exception: unknown) => NError;
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  onInvalidate?: OnDocumentInvalidate;
}) {
  type DocState = TSDFDocumentStoreState<State, NError>;

  const store = new Store<DocState>({
    debugName,
    state: () => {
      const initialData = getInitialData?.();

      return {
        data: initialData ?? null,
        error: null,
        status: initialData ? 'success' : 'idle',
        refetchOnMount:
          !!initialData && !disableInitialDataInvalidation
            ? 'lowPriority'
            : false,
      };
    },
  });

  async function fetch(fetchCtx: FetchContext, _: null): Promise<boolean> {
    store.setPartialState(
      {
        status: store.state.status === 'success' ? 'refetching' : 'loading',
        error: null,
        refetchOnMount: false,
      },
      {
        action:
          store.state.status === 'success'
            ? 'fetch-start-refetching'
            : 'fetch-start-loading',
      },
    );

    try {
      const data = await fetchFn();

      if (fetchCtx.shouldAbort()) return false;

      store.setPartialState(
        {
          data: reusePrevIfEqual({ prev: store.state.data, current: data }),
          status: 'success',
        },
        { action: 'fetch-success' },
      );

      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      store.setPartialState(
        {
          error: errorNormalizer(exception),
          status: 'error',
        },
        { action: 'fetch-error' },
      );

      return false;
    }
  }

  const fetchOrquestrator = createFetchOrquestrator<null>({
    fetchFn: fetch,
    lowPriorityThrottleMs,
    dynamicRealtimeThrottleMs,
    mediumPriorityThrottleMs,
  });

  function scheduleFetch(fetchType: FetchType): ScheduleFetchResults {
    return fetchOrquestrator.scheduleFetch(fetchType, null);
  }

  async function awaitFetch(): Promise<
    { data: State; error: null } | { data: null; error: NError }
  > {
    const wasAborted = await fetchOrquestrator.awaitFetch(null);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    if (store.state.error) {
      return { data: null, error: store.state.error };
    }

    if (!store.state.data) {
      return { data: null, error: errorNormalizer(new Error('Not found')) };
    }

    return { data: store.state.data, error: null };
  }

  const storeEvents = evtmitter<{ invalidateData: FetchType }>();

  let invalidationWasTriggered = false;

  function invalidateData(priority: FetchType = 'highPriority') {
    const currentInvalidationPriority = store.state.refetchOnMount
      ? fetchTypePriority[store.state.refetchOnMount]
      : -1;
    const newInvalidationPriority = fetchTypePriority[priority];

    if (currentInvalidationPriority >= newInvalidationPriority) return;

    store.setKey('refetchOnMount', priority, { action: 'invalidate-data' });
    invalidationWasTriggered = false;
    storeEvents.emit('invalidateData', priority);

    onInvalidate?.(priority);
  }

  function useDocument<Selected = State | null>({
    selector,
    isOffScreen,
    disabled = isOffScreen,
    returnRefetchingStatus,
    disableRefetchOnMount = globalDisableRefetchOnMount,
    returnIdleStatus = !!disabled,
    ensureIsLoaded,
    selectorUsesExternalDeps,
  }: {
    selector?: (data: State | null) => Selected;
    disabled?: boolean;
    isOffScreen?: boolean;
    disableRefetchOnMount?: boolean;
    returnIdleStatus?: boolean;
    ensureIsLoaded?: boolean;
    returnRefetchingStatus?: boolean;
    selectorUsesExternalDeps?: boolean;
  } = {}) {
    const memoizedSelector = useMemo(
      () => selector,
      // eslint-disable-next-line @lucasols/extended-lint/exhaustive-deps
      [selectorUsesExternalDeps ? selector : 0],
    );

    const storeStateSelector = useCallback(
      (state: DocState): TSDFUseDocumentReturn<Selected, NError> => {
        const { error } = state;

        const data = memoizedSelector
          ? memoizedSelector(state.data)
          : (state.data as Selected);

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
      [returnRefetchingStatus, returnIdleStatus, memoizedSelector],
    );

    const storeState = store.useSelector(storeStateSelector, {
      useExternalDeps: true,
      equalityFn: deepEqual,
    });

    useOnEvtmitterEvent(storeEvents, 'invalidateData', (priority) => {
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
            emitIsLoadedEvt('isLoaded', true);
          }
        });
    });

    return useModifyResult(storeState);
  }

  function updateState(
    produceNewData: (draftData: State) => State | void | undefined,
  ) {
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

  function reset() {
    fetchOrquestrator.reset();
    store.setState({
      data: null,
      error: null,
      status: 'idle',
      refetchOnMount: 'lowPriority',
    });
  }

  return {
    store,
    reset,
    awaitFetch,
    scheduleFetch,
    invalidateData,
    useDocument,
    updateState,
    startMutation: fetchOrquestrator.startMutation,
  };
}

export type TSDFDocumentStore<
  State extends ValidStoreState,
  NError,
> = ReturnType<typeof newTSDFDocumentStore<State, NError>>;
