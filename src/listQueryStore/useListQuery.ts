import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { assertNoEnsureIsLoadedWithDebouncePayload } from '../utils/payloadDebounce';
import {
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import { useEnsureIsLoaded } from '../utils/useEnsureIsLoaded';
import type {
  FieldsInput,
  ListQueryUseMultipleListQueriesQuery,
  TSFDListQueryState,
  TSFDUseListQueryReturn,
} from './types';
import type { UseMultipleListQueriesOptions } from './useMultipleListQueries';

export type UseListQueryOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  SelectedItem,
> = UseMultipleListQueriesOptions<ItemState, ItemPayload, SelectedItem> & {
  /**
   * Forces a high-priority fetch on mount and keeps the hook in `loading`
   * until the current payload finishes loading. Cannot be combined with
   * `debouncePayload`.
   */
  ensureIsLoaded?: boolean;
  fields?: FieldsInput;
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
};

export function useListQuery<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  SelectedItem = ItemState,
>(
  payload: QueryPayload | false | null | undefined,
  {
    itemSelector,
    omitPayload,
    disableRefetches,
    disableRefetchOnMount,
    returnIdleStatus,
    returnRefetchingStatus,
    showPartialAsRefetching,
    loadSize,
    isOffScreen,
    ensureIsLoaded,
    fields,
    debouncePayload,
  }: UseListQueryOptions<ItemState, ItemPayload, SelectedItem>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  getQueryKey: (params: QueryPayload) => string,
  scheduleListQueryFetch: (
    fetchType: FetchType,
    payload: QueryPayload,
    size?: number,
    options?: { fields?: FieldsInput },
  ) => ScheduleFetchResults,
  useMultipleListQueries: <S = ItemState>(
    queries: ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[],
    options: UseMultipleListQueriesOptions<ItemState, ItemPayload, S>,
  ) => readonly TSFDUseListQueryReturn<S, QueryPayload, undefined>[],
): TSFDUseListQueryReturn<SelectedItem, QueryPayload> {
  const isInvalidPayload = payload === '';
  const hasPayload =
    payload !== false &&
    payload !== null &&
    payload !== undefined &&
    payload !== '';

  assertNoEnsureIsLoadedWithDebouncePayload(
    'useListQuery',
    ensureIsLoaded,
    debouncePayload,
  );

  const query = useMemo(
    (): ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[] =>
      hasPayload
        ? [
            {
              payload,
              fields,
              disableRefetches,
              disableRefetchOnMount,
              returnIdleStatus,
              returnRefetchingStatus,
              showPartialAsRefetching,
              omitPayload,
              isOffScreen,
              loadSize,
            },
          ]
        : [],
    [
      disableRefetches,
      disableRefetchOnMount,
      fields,
      hasPayload,
      isOffScreen,
      loadSize,
      omitPayload,
      payload,
      returnIdleStatus,
      returnRefetchingStatus,
      showPartialAsRefetching,
    ],
  );

  const queryResult = useMultipleListQueries(query, {
    itemSelector,
    debouncePayload,
  });

  const result = useMemo(
    (): TSFDUseListQueryReturn<SelectedItem, QueryPayload> =>
      queryResult[0] ??
      (isInvalidPayload
        ? {
            payload: undefined,
            fields,
            error: invalidPayloadError,
            hasMore: false,
            isLoading: false,
            status: 'error',
            queryKey: '',
            items: [],
            isLoadingMore: false,
            pendingSync: false,
            queryMetadata: undefined,
          }
        : {
            payload: undefined,
            fields,
            error: null,
            hasMore: false,
            isLoading: false,
            status: 'idle',
            queryKey: '',
            items: [],
            isLoadingMore: false,
            pendingSync: false,
            queryMetadata: undefined,
          }),
    [fields, isInvalidPayload, queryResult],
  );

  const queryKey = hasPayload ? getQueryKey(payload) : '';
  const fetchQuery = hasPayload ? query[0] : undefined;
  const isPayloadReadyForFetch = hasPayload;

  const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
    ensureIsLoaded,
    hasPayload && isPayloadReadyForFetch,
    () => {
      if (fetchQuery && isPayloadReadyForFetch) {
        scheduleListQueryFetch(
          'highPriority',
          fetchQuery.payload,
          fetchQuery.loadSize,
          { fields: fetchQuery.fields },
        );
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (
      !ensureIsLoaded ||
      !hasPayload ||
      !isPayloadReadyForFetch ||
      !queryKey
    ) {
      return;
    }

    observe
      .ifSelector((state) => {
        return state.queries[queryKey]?.status;
      })
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          emitIsLoadedEvt();
        }
      });
  });

  return useModifyResult(result);
}
