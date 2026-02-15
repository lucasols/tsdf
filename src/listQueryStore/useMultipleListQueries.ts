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
import {
  type FieldsInput,
  type ListQueryUseMultipleListQueriesQuery,
  type PartialResourcesConfig,
  type TSFDListQuery,
  type TSFDListQueryState,
  type TSFDUseListQueryReturn,
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
    options?: { fields?: FieldsInput },
  ) => ScheduleFetchResults,
  queryInvalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
  partialResources: PartialResourcesConfig<ItemState> | undefined,
): readonly TSFDUseListQueryReturn<
  SelectedItem,
  QueryPayload,
  QueryMetadata
>[] {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    key: string;
    payload: QueryPayload;
    fields: FieldsInput | undefined;
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
      fields: queryProps.fields,
      disableRefetchOnMount:
        queryProps.disableRefetchOnMount ??
        allItemsDisableRefetchOnMount ??
        globalDisableRefetchOnMount ??
        false,
      returnIdleStatus:
        queryProps.returnIdleStatus ?? allItemsReturnIdleStatus ?? false,
      returnRefetchingStatus:
        queryProps.returnRefetchingStatus ??
        allItemsReturnRefetchingStatus ??
        false,
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
    (
      state: State,
      query: TSFDListQuery<QueryPayload>,
      fields: FieldsInput | undefined,
    ): SelectedItem[] => {
      return filterAndMap(query.items, (itemKey) => {
        let item = state.items[itemKey];
        const itemPayload = state.itemQueries[itemKey]?.payload;
        if (!item || !itemPayload) return false;

        // Apply field selection for partial resources
        if (partialResources && Array.isArray(fields) && fields.length > 0) {
          item = partialResources.selectFields(fields, item);
        }

        if (itemSelector) {
          return itemSelector(item, itemPayload, itemKey);
        }
        return __LEGIT_CAST__<SelectedItem, ItemState>(item);
      });
    },
    [itemSelector, partialResources],
  );

  const resultSelector = useCallback(
    (state: State) => {
      return queriesWithId.map(
        ({
          key: queryKey,
          payload,
          fields,
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
              fields,
              isLoading: !returnIdleStatus,
              isLoadingMore: false,
              queryMetadata: __LEGIT_CAST__<
                QueryMetadata,
                QueryMetadata | undefined
              >(queryMetadata),
            };
          }

          let status = query.status;

          // Override status when partial resources has items with missing fields
          if (
            partialResources &&
            Array.isArray(fields) &&
            fields.length > 0 &&
            (status === 'success' || status === 'refetching')
          ) {
            const someItemMissingFields = query.items.some((itemKey) => {
              const loadedFields = state.itemLoadedFields[itemKey] ?? [];
              return fields.some((f) => !loadedFields.includes(f));
            });

            const hasAffectedFieldInvalidation = query.items.some((itemKey) => {
              const itemFieldInvalidationFields =
                state.itemFieldInvalidationFields[itemKey];

              return (
                !!itemFieldInvalidationFields &&
                fields.some((f) => itemFieldInvalidationFields.includes(f))
              );
            });

            if (someItemMissingFields && hasAffectedFieldInvalidation) {
              status = 'refetching';
            } else if (someItemMissingFields) {
              status = 'loading';
            }
          }

          if (!returnRefetchingStatus && status === 'refetching') {
            status = 'success';
          }

          return {
            queryKey,
            status,
            items:
              status === 'loading' && partialResources
                ? []
                : getQueryItems(state, query, fields),
            error: query.error,
            hasMore: query.hasMore,
            isLoading: status === 'loading',
            payload: omitPayload ? undefined : query.payload,
            fields,
            isLoadingMore: status === 'loadingMore',
            queryMetadata: __LEGIT_CAST__<
              QueryMetadata,
              QueryMetadata | undefined
            >(queryMetadata),
          };
        },
      );
    },
    [queriesWithId, getQueryItems, partialResources],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });

  useOnEvtmitterEvent(events, 'invalidateQuery', ({ payload: event }) => {
    for (const { key, payload, fields, isOffScreen } of queriesWithId) {
      if (isOffScreen) continue;

      if (key !== event.queryKey) continue;

      if (!queryInvalidationWasTriggered.has(key)) {
        store.produceState((draft) => {
          const query = draft.queries[key];
          if (!query?.refetchOnMount) return;

          query.refetchOnMount = false;
        });

        scheduleListQueryFetch(event.priority, payload, undefined, { fields });
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
      fields,
      isOffScreen,
      loadSize,
      disableRefetchOnMount,
    } of queriesWithId) {
      removedQueries.delete(queryId);

      if (isOffScreen) continue;

      const queryState = getQueryState(payload);
      let fetchType = queryState?.refetchOnMount || 'lowPriority';

      let shouldFetch =
        !queryState || !queryState.wasLoaded || queryState.refetchOnMount;

      // For partial resources, fetch again when requested fields are missing
      // or when a full-resource hook is affected by field invalidation.
      if (partialResources && !shouldFetch && queryState) {
        const isQueryFetchInFlight =
          queryState.status === 'loading' ||
          queryState.status === 'refetching' ||
          queryState.status === 'loadingMore';

        if (Array.isArray(fields) && fields.length > 0) {
          const someItemMissingFields = queryState.items.some((itemKey) => {
            const loadedFields = store.state.itemLoadedFields[itemKey] ?? [];
            return fields.some((f) => !loadedFields.includes(f));
          });

          if (someItemMissingFields && !isQueryFetchInFlight) {
            shouldFetch = true;

            const hasAffectedFieldInvalidation = queryState.items.some(
              (itemKey) => {
                const itemFieldInvalidationFields =
                  store.state.itemFieldInvalidationFields[itemKey];

                return (
                  !!itemFieldInvalidationFields &&
                  fields.some((f) => itemFieldInvalidationFields.includes(f))
                );
              },
            );

            if (hasAffectedFieldInvalidation && fetchType === 'lowPriority') {
              fetchType = 'highPriority';
            }
          }
        } else if (fields === '*') {
          const hasAnyFieldInvalidation = queryState.items.some((itemKey) => {
            const itemFieldInvalidationFields =
              store.state.itemFieldInvalidationFields[itemKey];
            return (
              !!itemFieldInvalidationFields &&
              itemFieldInvalidationFields.length > 0
            );
          });

          if (hasAnyFieldInvalidation && !isQueryFetchInFlight) {
            shouldFetch = true;

            if (fetchType === 'lowPriority') {
              fetchType = 'highPriority';
            }
          }
        }
      }

      if (!shouldFetch && ignoreQueriesInRefetchOnMount.has(queryId)) {
        continue;
      }

      ignoreQueriesInRefetchOnMount.add(queryId);

      if (disableRefetchOnMount) {
        if (shouldFetch) {
          scheduleListQueryFetch(fetchType, payload, loadSize, { fields });
        }
      } else if (!partialResources || shouldFetch) {
        scheduleListQueryFetch(fetchType, payload, loadSize, { fields });
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
    partialResources,
    store.state.itemLoadedFields,
    store.state.itemFieldInvalidationFields,
  ]);

  return storeState;
}
