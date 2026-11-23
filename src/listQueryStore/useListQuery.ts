import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { assertNoRequireFreshDataWithDebouncePayload } from '../utils/payloadDebounce';
import {
  RequireFreshData,
  ValidPayload,
  ValidStoreState,
  invalidPayloadError,
} from '../utils/storeShared';
import {
  settlesRefresh,
  useRequireFreshData,
} from '../utils/useRequireFreshData';
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
   * Schedules a high-priority fetch on mount and reports `loading` until that
   * refresh succeeds or fails, even when cached data exists. `true` refreshes
   * on every mount, so use it sparingly. `'ifFromStorage'` only refreshes
   * while the cached query was restored from persistent storage and not
   * refreshed from the server yet in this tab. `'ifFromStorage'` only tracks
   * the exact query: a result derived with `derivedQueries` isn't checked, so
   * use `true` when it must be fresh. `'ifFromStorage'` is not supported with
   * `partialResources`. Cannot be combined with `debouncePayload`.
   */
  requireFreshData?: RequireFreshData;
  /**
   * Partial-resource fields to request for each item in this query.
   *
   * Pass `'*'` to fetch complete items. This option is required when
   * `partialResources` is enabled and optional otherwise.
   */
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
    requireFreshData,
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
  isQueryRestoredFromStorage: ((queryKey: string) => boolean) | undefined,
): TSFDUseListQueryReturn<SelectedItem, QueryPayload> {
  const isInvalidPayload = payload === '';
  const hasPayload =
    payload !== false &&
    payload !== null &&
    payload !== undefined &&
    payload !== '';

  assertNoRequireFreshDataWithDebouncePayload(
    'useListQuery',
    requireFreshData,
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
            isDerived: false,
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
            isDerived: false,
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

  const [useModifyResult, markRefreshSettled] = useRequireFreshData(
    requireFreshData,
    hasPayload,
    queryKey,
    requireFreshData === 'ifFromStorage' &&
      hasPayload &&
      !!isQueryRestoredFromStorage?.(queryKey),
    () => {
      // A refresh already in flight brings server data newer than the
      // restored one, so it settles this hook without another request
      if (
        requireFreshData === 'ifFromStorage' &&
        store.state.queries[queryKey]?.status === 'refetching'
      ) {
        return;
      }

      if (fetchQuery && hasPayload) {
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
    if (!requireFreshData || !hasPayload || !queryKey) {
      return;
    }

    observe
      .ifSelector((state) => {
        return state.queries[queryKey]?.status;
      })
      .change.then(({ prev, current }) => {
        if (
          settlesRefresh(
            prev,
            current,
            () => !!isQueryRestoredFromStorage?.(queryKey),
          )
        ) {
          markRefreshSettled();
        }
      });
  });

  return useModifyResult(result);
}
