import mitt from 'mitt';
import { useEffect } from 'react';
import { RcType } from 'runcheck';
import { Store } from 't-state';
import { useOnMittEvent } from './utils/useOnMittEvent';

type Status = 'idle' | 'loading' | 'refetching' | 'error' | 'success';

type StoreError = {
  exception: unknown;
  message: string;
};

export type DocumentStoreState<State> = {
  data: State | null;
  error: StoreError | null;
  status: Status;
  refetchOnMount: boolean;
};

type UseDocumentReturn<State> = {
  status: Status;
  data: State | null;
  error: StoreError | null;
  isLoading: boolean;
};

type CreateDocumentStoreProps<State> = {
  debugName?: string;
  responseValidator?: RcType<State>;
  fetchFn: () => Promise<State>;
  initialData?: State;
};

export function createDocumentStore<State>({
  debugName,
  fetchFn,
  responseValidator,
  initialData,
}: CreateDocumentStoreProps<State>) {
  const store = new Store<DocumentStoreState<State>>({
    debugName,
    state: {
      data: initialData ?? null,
      error: null,
      status: initialData ? 'success' : 'idle',
      refetchOnMount: false,
    },
  });

  async function scheduleFetch(): Promise<void> {
    const { status } = store.state;

    if (status === 'loading' || status === 'refetching') {
      return;
    }

    store.setPartialState({
      status: store.state.status === 'success' ? 'refetching' : 'loading',
      error: null,
      refetchOnMount: false,
    });

    try {
      const data = await fetchFn();

      store.setPartialState({
        data,
        status: 'success',
      });
    } catch (exception) {
      store.setPartialState({
        error: normalizeError(exception),
        status: 'error',
      });
    }
  }

  const storeEvents = mitt<{
    invalidateData: undefined;
  }>();

  function invalidateData() {
    store.setKey('refetchOnMount', true);
    storeEvents.emit('invalidateData');
  }

  // FIX: data selector
  // FIX: return idle status
  // FIX: add disabled option
  // FIX: ignore refreshing status by default
  function useDocument() {
    const storeState = store.useSelector((state): UseDocumentReturn<State> => {
      const { data, error } = state;

      const status = state.status === 'idle' ? 'loading' : state.status;

      return {
        data,
        error,
        status,
        isLoading: status === 'loading',
      };
    });

    useOnMittEvent(storeEvents, 'invalidateData', () => {
      scheduleFetch();
    });

    useEffect(() => {
      if (store.state.refetchOnMount || store.state.status === 'idle') {
        scheduleFetch();
      }
    }, []);

    return storeState;
  }

  return {
    store,
    scheduleFetch,
    invalidateData,
    useDocument,
  };
}

export type DocumentStore<State> = ReturnType<
  typeof createDocumentStore<State>
>;

function normalizeError(exception: unknown): StoreError {
  if (exception instanceof Error) {
    return {
      exception,
      message: exception.message,
    };
  }

  return {
    exception,
    message: String(exception),
  };
}
