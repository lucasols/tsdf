import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { type Emitter } from 'evtmitter';
import { useCallback, useEffect, useMemo } from 'react';
import { Store } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type { ListQueryStoreEvents } from './listQueryStore';
import type {
  ListQueryUseMultipleListQueriesQuery,
  TSFDListQuery,
  TSFDListQueryState,
  TSFDUseListQueryReturn,
} from './types';

export type UseMultipleListQueriesOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  SelectedItem,
> = {
  itemSelector?: (
    data: ItemState,
    itemPayload: ItemPayload,
    itemKey: string,
  ) => SelectedItem;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  omitPayload?: boolean;
  disableRefetchOnMount?: boolean;
  isOffScreen?: boolean;
  loadSize?: number;
};

export function useMultipleListQueries<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  SelectedItem = ItemState,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
>(
  queries: ListQueryUseMultipleListQueriesQuery<QueryPayload, QueryMetadata>[],
  {
    itemSelector,
    returnIdleStatus: allItemsReturnIdleStatus,
    returnRefetchingStatus: allItemsReturnRefetchingStatus,
    omitPayload: allItemsOmitPayload,
    disableRefetchOnMount: allItemsDisableRefetchOnMount,
    isOffScreen: allItemsIsOffScreen,
    loadSize: allItemsLoadSize,
  }: UseMultipleListQueriesOptions<ItemState, ItemPayload, SelectedItem>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  events: Emitter<ListQueryStoreEvents>,
  getQueryKey: (params: QueryPayload) => string,
  getQueryState: (
    params: QueryPayload,
  ) => TSFDListQuery<QueryPayload> | undefined,
  scheduleListQueryFetch: (
    fetchType: FetchType,
    payload: QueryPayload,
    size?: number,
  ) => ScheduleFetchResults,
  queryInvalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
): readonly TSFDUseListQueryReturn<
  SelectedItem,
  QueryPayload,
  QueryMetadata
>[] {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    key: string;
    payload: QueryPayload;
    disableRefetchOnMount: boolean;
    returnIdleStatus: boolean;
    returnRefetchingStatus: boolean;
    omitPayload: boolean;
    isOffScreen: boolean;
    loadSize: number | undefined;
    queryMetadata: QueryMetadata | undefined;
  };

  const queriesWithId = useMemo((): QueryWithId[] => {
    return queries.map((queryProps) => ({
      key: getQueryKey(queryProps.payload),
      payload: queryProps.payload,
      disableRefetchOnMount:
        queryProps.disableRefetchOnMount
        ?? allItemsDisableRefetchOnMount
        ?? globalDisableRefetchOnMount
        ?? false,
      returnIdleStatus:
        queryProps.returnIdleStatus ?? allItemsReturnIdleStatus ?? false,
      returnRefetchingStatus:
        queryProps.returnRefetchingStatus
        ?? allItemsReturnRefetchingStatus
        ?? false,
      omitPayload: queryProps.omitPayload ?? allItemsOmitPayload ?? false,
      isOffScreen: queryProps.isOffScreen ?? allItemsIsOffScreen ?? false,
      loadSize: queryProps.loadSize ?? allItemsLoadSize,
      queryMetadata: queryProps.queryMetadata,
    }));
  }, [
    queries,
    getQueryKey,
    allItemsDisableRefetchOnMount,
    allItemsIsOffScreen,
    allItemsLoadSize,
    allItemsOmitPayload,
    allItemsReturnIdleStatus,
    allItemsReturnRefetchingStatus,
    globalDisableRefetchOnMount,
  ]);

  const getQueryItems = useCallback(
    (state: State, query: TSFDListQuery<QueryPayload>): SelectedItem[] => {
      return filterAndMap(query.items, (itemKey) => {
        const item = state.items[itemKey];
        const itemPayload = state.itemQueries[itemKey]?.payload;
        if (!item || !itemPayload) return false;

        if (itemSelector) {
          return itemSelector(item, itemPayload, itemKey);
        }
        return __LEGIT_CAST__<SelectedItem>(item);
      });
    },
    [itemSelector],
  );

  const resultSelector = useCallback(
    (state: State) => {
      return queriesWithId.map(
        ({
          key: queryKey,
          payload,
          omitPayload,
          returnIdleStatus,
          returnRefetchingStatus,
          queryMetadata,
        }): TSFDUseListQueryReturn<
          SelectedItem,
          QueryPayload,
          QueryMetadata
        > => {
          const query = state.queries[queryKey];

          if (!query) {
            return {
              queryKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              items: [],
              error: null,
              hasMore: false,
              payload: omitPayload ? undefined : payload,
              isLoading: !returnIdleStatus,
              isLoadingMore: false,
              queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
            };
          }

          let status = query.status;

          if (!returnRefetchingStatus && query.status === 'refetching') {
            status = 'success';
          }

          return {
            queryKey,
            status,
            items: getQueryItems(state, query),
            error: query.error,
            hasMore: query.hasMore,
            isLoading: status === 'loading',
            payload: omitPayload ? undefined : query.payload,
            isLoadingMore: status === 'loadingMore',
            queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
          };
        },
      );
    },
    [queriesWithId, getQueryItems],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });

  useOnEvtmitterEvent(events, 'invalidateQuery', ({ payload: event }) => {
    for (const { key, payload, isOffScreen } of queriesWithId) {
      if (isOffScreen) continue;

      if (key !== event.queryKey) continue;

      if (!queryInvalidationWasTriggered.has(key)) {
        store.produceState((draft) => {
          const query = draft.queries[key];
          if (!query?.refetchOnMount) return;

          query.refetchOnMount = false;
        });

        scheduleListQueryFetch(event.priority, payload);
        queryInvalidationWasTriggered.add(key);
      }
    }
  });

  const ignoreQueriesInRefetchOnMount = useConst(() => new Set<string>());

  useEffect(() => {
    const removedQueries = new Set(ignoreQueriesInRefetchOnMount);

    for (const {
      key: queryId,
      payload,
      isOffScreen,
      loadSize,
      disableRefetchOnMount,
    } of queriesWithId) {
      removedQueries.delete(queryId);

      if (isOffScreen) continue;

      const queryState = getQueryState(payload);
      const fetchType = queryState?.refetchOnMount || 'lowPriority';

      const shouldFetch =
        !queryState || !queryState.wasLoaded || queryState.refetchOnMount;

      if (!shouldFetch && ignoreQueriesInRefetchOnMount.has(queryId)) {
        continue;
      }

      ignoreQueriesInRefetchOnMount.add(queryId);

      if (disableRefetchOnMount) {
        if (shouldFetch) {
          scheduleListQueryFetch(fetchType, payload, loadSize);
        }
      } else {
        scheduleListQueryFetch(fetchType, payload, loadSize);
      }
    }

    for (const queryId of removedQueries) {
      ignoreQueriesInRefetchOnMount.delete(queryId);
    }
  }, [
    getQueryState,
    ignoreQueriesInRefetchOnMount,
    queriesWithId,
    scheduleListQueryFetch,
  ]);

  return storeState;
}
