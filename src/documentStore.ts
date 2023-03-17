import { produce } from 'immer';
import mitt from 'mitt';
import { useCallback, useEffect } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import {
  createFetchOrquestrator,
  FetchType,
  ScheduleFetchResults,
  FetchContext,
} from './fetchOrquestrator';
import { fetchTypePriority, TSDFStatus, ValidStoreState } from './storeShared';
import { useEnsureIsLoaded } from './useEnsureIsLoaded';
import { useOnMittEvent } from './utils/hooks';
import { reusePrevIfEqual } from './utils/reuseRefIfEqual';

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

export function newTSDFDocumentStore<State extends ValidStoreState, NError>({
  debugName,
  fetchFn,
  initialData,
  disableRefetchOnMount: globalDisableRefetchOnMount,
  lowPriorityThrottleMs,
  mediumPriorityThrottleMs,
  dynamicRealtimeThrottleMs,
  disableInitialDataInvalidation,
  errorNormalizer,
}: {
  debugName?: string;
  fetchFn: () => Promise<State>;
  initialData?: State;
  disableInitialDataInvalidation?: boolean;
  errorNormalizer: (exception: unknown) => NError;
  disableRefetchOnMount?: boolean;
  lowPriorityThrottleMs?: number;
  mediumPriorityThrottleMs?: number;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
}) {
  type DocState = TSDFDocumentStoreState<State, NError>;

  const store = new Store<DocState>({
    debugName,
    state: {
      data: initialData ?? null,
      error: null,
      status: initialData ? 'success' : 'idle',
      refetchOnMount:
        !!initialData && !disableInitialDataInvalidation
          ? 'lowPriority'
          : false,
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

    if (!store.state.data) {
      return { data: null, error: errorNormalizer(new Error('No data')) };
    }

    return store.state.error
      ? { data: null, error: store.state.error }
      : { data: store.state.data, error: null };
  }

  const storeEvents = mitt<{ invalidateData: FetchType }>();

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
  }

  function useDocument<Selected = State | null>({
    selector,
    disabled,
    returnRefetchingStatus,
    disableRefetchOnMount = globalDisableRefetchOnMount,
    returnIdleStatus = !!disabled,
    ensureIsLoaded,
  }: {
    selector?: (data: State | null) => Selected;
    disabled?: boolean;
    disableRefetchOnMount?: boolean;
    returnIdleStatus?: boolean;
    ensureIsLoaded?: boolean;
    returnRefetchingStatus?: boolean;
  } = {}) {
    const storeStateSelector = useCallback(
      (state: DocState): TSDFUseDocumentReturn<Selected, NError> => {
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
      [returnRefetchingStatus, returnIdleStatus, selector],
    );

    const storeState = store.useSelector(storeStateSelector, {
      useExternalDeps: true,
    });

    useOnMittEvent(storeEvents, 'invalidateData', (priority) => {
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
    store.setKey(
      'data',
      (current) => {
        if (!current) return current;

        return produce(current, produceNewData);
      },
      { action: 'update-state' },
    );
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

export type TSDFDocumentStore<
  State extends ValidStoreState,
  NError,
> = ReturnType<typeof newTSDFDocumentStore<State, NError>>;
