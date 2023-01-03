import { apiFetch } from '@src/api/apiCall';
import { ApiStoreError } from '@src/api/stores/apiStoresTypes';
import {
  handleError,
  handleErrorAndShowErrorToast,
} from '@src/utils/errorHandling/handleError';
import { matchesOneOf } from '@utils/checkIf';
import { deepFreeze } from '@utils/deepFreeze';
import { produceReducer } from '@utils/immerUtils';
import { Serializable } from '@utils/typings/typings';
import { useEffect } from 'react';
import Store, { deepEqual, Reducers, ReducersPayloads } from 't-state';
import { useSubscribeToStore } from 't-state/subscribeUtils';

// FIX: remove file

type Status =
  | 'idle'
  | 'stale'
  | 'loading'
  | 'loadingError'
  | 'refreshing'
  | 'refreshingError'
  | 'success';

export type ApiState<S> = {
  status: Status;
  error: null | ApiStoreError;
  data: null | S;
};

export type BaseReducers<S, O> = {
  fetchStart: undefined;
  fetchError: ApiStoreError;
  fetchSuccess: S;
  staleData: undefined;
  update: { produceNewData: (data: O) => void | O };
};

export type UseDocumentReturn<T, D = T | null> = {
  status: Exclude<Status, 'idle'>;
  data: D;
  error: ApiStoreError | null;
  isLoading: boolean;
};

/**
 * Generics doc <I, O, P, F>
 *
 * I = the type of the raw data fetched from api
 * O = the final type of the store state, by default is the same as the I
 * P = payloads of the reducers of the store
 * F = Additional payload of the fetch function, in most cases this is not needed
 * because the most document endpoints require only the token, that is included by default
 */
export function createApiDocumentStore<
  I,
  O = I,
  P extends ReducersPayloads = {},
  F extends Record<string, Serializable> = {},
>({
  name,
  fetchPath,
  data,
  reducers,
  convertFromApi,
  includeToken = true,
  fetchPayload,
}: {
  name: string;
  fetchPath: string;
  fetchPayload?: F;
  data?: O;
  includeToken?: boolean;
  convertFromApi?: (data: I) => O;
  reducers?: Reducers<ApiState<O>, P>;
}) {
  const baseReducers: Reducers<ApiState<O>, BaseReducers<I, O>> = {
    fetchStart: produceReducer((state) => {
      state.status = !state.data ? 'loading' : 'refreshing';
      state.error = null;
    }),
    fetchError: produceReducer((state, error) => {
      state.status =
        state.status === 'refreshing' ? 'refreshingError' : 'loadingError';
      state.error = error;
    }),
    fetchSuccess: produceReducer((state, resultData) => {
      state.data = convertFromApi
        ? convertFromApi(resultData)
        : (resultData as unknown as O);
      state.status = 'success';
    }),
    staleData: produceReducer((state) => {
      state.status = 'stale';
    }),
    update: produceReducer((state, { produceNewData }) => {
      if (state.data) {
        const overrideData = produceNewData(state.data);

        if (overrideData) {
          state.data = overrideData;
        }
      }
    }),
  };

  const store = new Store<ApiState<O>, BaseReducers<I, O> & P>({
    name,
    state: {
      status: 'idle',
      error: null,
      data: (data as O) || null,
    },
    reducers: {
      ...baseReducers,
      ...(reducers as any),
    },
  });

  const apiStore = store as Store<ApiState<any>, BaseReducers<any, any>>;

  async function fetch(params?: F, force?: boolean) {
    if (
      !force &&
      matchesOneOf(apiStore.getState().status, [
        'loading',
        'refreshing',
        'loadingError',
        'refreshingError',
      ])
    ) {
      return null;
    }

    apiStore.dispatch('fetchStart');

    try {
      const response = await apiFetch(fetchPath, {
        data: params,
        includeToken,
      });

      apiStore.dispatch('fetchSuccess', response);

      return response as unknown as I;
    } catch (error) {
      const normalizedError = handleError(error);

      apiStore.dispatch('fetchError', {
        id: normalizedError.id,
        message: normalizedError.message,
        code: normalizedError.code,
      });

      return false;
    }
  }

  function awaitFetch(params?: F) {
    return fetch(params, true);
  }

  function invalidateData() {
    apiStore.dispatch('staleData');
  }

  function useDocument<T = O | null>({
    dataSelector,
    selectorDeps,
    disabled,
    disableRefetchOnMount,
    ignoreRefreshingStatus,
    overridePayload = fetchPayload,
  }: {
    dataSelector?: (data: O | null) => T;
    selectorDeps?: any[];
    overridePayload?: F;
    disabled?: boolean;
    ignoreRefreshingStatus?: boolean;
    disableRefetchOnMount?: boolean;
  } = {}) {
    const storeData = store.useSelector(
      (state): UseDocumentReturn<T, T> => {
        const status =
          state.status === 'idle'
            ? 'loading'
            : state.status === 'stale'
            ? 'refreshing'
            : state.status;

        return {
          ...state,
          data: (dataSelector ? dataSelector(state.data) : state.data) as T,
          status:
            status === 'refreshing' && ignoreRefreshingStatus
              ? 'success'
              : status,
          isLoading: status === 'loading',
        };
      },
      { equalityFn: deepEqual, selectorDeps },
    );

    useEffect(() => {
      if (disabled) return;

      if (disableRefetchOnMount) {
        const { status } = apiStore.getState();

        if (status === 'idle' || status === 'stale') {
          void fetch(overridePayload);
        }
      } else {
        void fetch(overridePayload);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [disabled]);

    useSubscribeToStore(apiStore, ({ observe }) => {
      observe
        .ifSelector((state) => state.status)
        .changeTo('stale')
        .then(() => {
          void fetch(overridePayload);
        });
    });

    if (__DEV__) {
      // as mutation of the results can cause bugs in the store behaviour, this prevents that
      deepFreeze(storeData);
    }

    return storeData;
  }

  function updateState(produceNewData: (data: O) => void | O) {
    apiStore.dispatch('update', { produceNewData });

    return store.getState();
  }

  function roolbackOnError(error: unknown) {
    handleErrorAndShowErrorToast(error);
    invalidateData();

    return false;
  }

  return {
    store,
    fetch,
    awaitFetch,
    useDocument,
    invalidateData,
    updateState,
    roolbackOnError,
  };
}
