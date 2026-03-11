import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
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

  const query = useMemo(
    (): ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[] =>
      payload === false ||
      payload === null ||
      payload === undefined ||
      payload === ''
        ? []
        : [
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
          ],
    [
      disableRefetches,
      disableRefetchOnMount,
      fields,
      isOffScreen,
      loadSize,
      omitPayload,
      payload,
      returnIdleStatus,
      returnRefetchingStatus,
      showPartialAsRefetching,
    ],
  );

  const queryResult = useMultipleListQueries(query, { itemSelector });

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
            isPendingOfflineSync: false,
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
            isPendingOfflineSync: false,
            queryMetadata: undefined,
          }),
    [queryResult, fields, isInvalidPayload],
  );

  const queryKey = payload ? getQueryKey(payload) : '';

  const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
    ensureIsLoaded,
    !!payload,
    () => {
      if (payload) {
        scheduleListQueryFetch('highPriority', payload, undefined, { fields });
      }
    },
  );

  useSubscribeToStore(store, ({ observe }) => {
    if (!ensureIsLoaded || !queryKey) return;

    observe
      .ifSelector((state) => state.queries[queryKey]?.status)
      .change.then(({ current }) => {
        if (current === 'success' || current === 'error') {
          emitIsLoadedEvt();
        }
      });
  });

  return useModifyResult(result);
}
