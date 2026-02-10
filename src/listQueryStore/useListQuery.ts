import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { useMemo } from 'react';
import { Store, useSubscribeToStore } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
import { useEnsureIsLoaded } from '../utils/useEnsureIsLoaded';
import type {
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
  fields?: string[];
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
    disableRefetchOnMount,
    returnIdleStatus,
    returnRefetchingStatus,
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
    options?: { fields?: string[] },
  ) => ScheduleFetchResults,
  useMultipleListQueries: <S = ItemState>(
    queries: ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[],
    options: UseMultipleListQueriesOptions<ItemState, ItemPayload, S>,
  ) => readonly TSFDUseListQueryReturn<S, QueryPayload, undefined>[],
): TSFDUseListQueryReturn<SelectedItem, QueryPayload> {
  const query = useMemo(
    (): ListQueryUseMultipleListQueriesQuery<QueryPayload, undefined>[] =>
      payload === false || payload === null || payload === undefined ?
        []
      : [
          {
            payload,
            fields,
            disableRefetchOnMount,
            returnIdleStatus,
            returnRefetchingStatus,
            omitPayload,
            isOffScreen,
            loadSize,
          },
        ],
    [
      disableRefetchOnMount,
      fields,
      isOffScreen,
      loadSize,
      omitPayload,
      payload,
      returnIdleStatus,
      returnRefetchingStatus,
    ],
  );

  const queryResult = useMultipleListQueries(query, {
    itemSelector,
  });

  const result = useMemo(
    (): TSFDUseListQueryReturn<SelectedItem, QueryPayload> =>
      queryResult[0] ?? {
        payload: undefined,
        error: null,
        hasMore: false,
        isLoading: false,
        status: 'idle',
        queryKey: '',
        items: [],
        isLoadingMore: false,
        queryMetadata: undefined,
      },
    [queryResult],
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

  return __LEGIT_CAST__(useModifyResult(result));
}
