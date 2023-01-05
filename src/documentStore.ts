import produce from 'immer';
import mitt from 'mitt';
import { useEffect } from 'react';
import { Store } from 't-state';
import {
  createFetchOrquestrator,
  FetchType,
  ScheduleFetchResults,
  ShouldAbortFetch,
} from './fetchOrquestrator';
import { Status, ValidStoreState } from './storeShared';
import { useOnMittEvent } from './utils/useOnMittEvent';

type DocumentStatus = Status | 'idle';

export type TSDFDocumentStoreState<State extends ValidStoreState, Error> = {
  data: State | null;
  error: Error | null;
  status: DocumentStatus;
  refetchOnMount: boolean;
};

export type TSDFUseDocumentReturn<Selected, Error> = {
  status: DocumentStatus;
  data: Selected;
  error: Error | null;
  isLoading: boolean;
};

export function newTSDFDocumentStore<State extends ValidStoreState, Error>({
  debugName,
  fetchFn,
  initialData,
  disableRefetchOnWindowFocus,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  lowPriorityThrottleMs,
  mediumPriorityThrottleMs,
  getDynamicRealtimeThrottleMs,
  errorNormalizer,
}: {
  debugName?: string;
  fetchFn: () => Promise<State>;
  initialData?: State;
  errorNormalizer: (exception: unknown) => Error;
  disableRefetchOnWindowFocus?: boolean;
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  getDynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
  const store = new Store<TSDFDocumentStoreState<State, Error>>({
    debugName,
    state: {
      data: initialData ?? null,
      error: null,
      status: initialData ? 'success' : 'idle',
      refetchOnMount: false,
    },
  });

  async function fetch(
    shouldAbort: ShouldAbortFetch,
    _: null,
  ): Promise<boolean> {
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

      if (shouldAbort()) return false;

      store.setPartialState(
        {
          data,
          status: 'success',
        },
        { action: 'fetch-success' },
      );

      return true;
    } catch (exception) {
      if (shouldAbort()) return false;

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
    getDynamicRealtimeThrottleMs,
    mediumPriorityThrottleMs,
  });

  function scheduleFetch(fetchType: FetchType): ScheduleFetchResults {
    return fetchOrquestrator.scheduleFetch(fetchType, null);
  }

  async function awaitFetch(): Promise<
    { data: State; error: null } | { data: null; error: Error }
  > {
    const wasAborted = await fetchOrquestrator.awaitFetch(null);

    if (wasAborted) {
      return { data: null, error: errorNormalizer(new Error('Aborted')) };
    }

    if (!store.state.data) {
      return { data: null, error: errorNormalizer(new Error('No data')) };
    }

    return store.state.error
      ? { data: null, error: store.state.error }
      : { data: store.state.data, error: null };
  }

  const storeEvents = mitt<{ invalidateData: FetchType }>();

  let invalidationWasTriggered = false;

  function invalidateData(
    priority: 'highPriority' | 'lowPriority' = 'highPriority',
  ) {
    store.setKey('refetchOnMount', true, { action: 'invalidate-data' });
    invalidationWasTriggered = false;
    storeEvents.emit('invalidateData', priority);
  }

  function useDocument<Selected = State | null>({
    selector,
    disabled,
    returnIdleStatus = !!disabled,
    returnRefetchingStatus,
    disableRefetchOnMount = globalDisableRefetchOnMount,
  }: {
    selector?: (data: State | null) => Selected;
    disabled?: boolean;
    disableRefetchOnMount?: boolean;
    returnIdleStatus?: boolean;
    returnRefetchingStatus?: boolean;
  } = {}) {
    const storeState = store.useSelector(
      (state): TSDFUseDocumentReturn<Selected, Error> => {
        const { error } = state;

        const data = selector ? selector(state.data) : (state.data as Selected);

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
    );

    useOnMittEvent(storeEvents, 'invalidateData', (priority) => {
      if (!invalidationWasTriggered) {
        scheduleFetch(priority);
        invalidationWasTriggered = true;
      }
    });

    useEffect(() => {
      if (disabled) return;

      if (disableRefetchOnMount) {
        if (store.state.refetchOnMount || store.state.status === 'idle') {
          scheduleFetch('lowPriority');
        }
      } else {
        scheduleFetch('lowPriority');
      }
    }, [disableRefetchOnMount, disabled]);

    return storeState;
  }

  function updateState(
    produceNewData: (draftData: State) => State | void | undefined,
  ) {
    store.setKey(
      'data',
      (current) => {
        if (!current) return current;

        return produce(current, produceNewData);
      },
      { action: 'update-state' },
    );
  }

  if (!disableRefetchOnWindowFocus) {
    function handleFocus() {
      invalidateData('lowPriority');
    }

    window.addEventListener('focus', handleFocus);
    window.addEventListener('visibilitychange', handleFocus);
  }

  return {
    store,
    awaitFetch,
    scheduleFetch,
    invalidateData,
    useDocument,
    updateState,
    startMutation: fetchOrquestrator.startMutation,
  };
}

// FIX: create a proper type for this
export type TSDFDocumentStore<
  State extends ValidStoreState,
  Error,
> = ReturnType<typeof newTSDFDocumentStore<State, Error>>;
