import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { type Emitter } from 'evtmitter';
import { useCallback, useEffect, useMemo } from 'react';
import { Store } from 't-state';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type { ListQueryStoreEvents } from './listQueryStore';
import type {
  ListQueryUseMultipleItemsQuery,
  TSFDListQueryState,
  TSFDUseListItemReturn,
} from './types';

const cacheMissError = {
  code: 460,
  id: 'cache-miss',
  message: 'Cache miss',
} as const;

export type UseMultipleItemsOptions<
  ItemState extends ValidStoreState,
  Selected,
> = {
  selector?: (data: ItemState | null, payload: ValidPayload | null) => Selected;
  loadFromStateOnly?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  disableRefetchOnMount?: boolean;
  isOffScreen?: boolean;
};

export function useMultipleItems<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  Selected = ItemState | null,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
>(
  items: ListQueryUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
  {
    selector,
    loadFromStateOnly,
    returnIdleStatus: allItemsReturnIdleStatus,
    returnRefetchingStatus: allItemsReturnRefetchingStatus,
    disableRefetchOnMount: allItemsDisableRefetchOnMount,
    isOffScreen: allItemsIsOffScreen,
  }: UseMultipleItemsOptions<ItemState, Selected>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  events: Emitter<ListQueryStoreEvents>,
  getItemKey: (params: ItemPayload) => string,
  scheduleItemFetch: (
    fetchType: FetchType,
    payload: ItemPayload,
  ) => ScheduleFetchResults,
  itemInvalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
  fetchItemFn: unknown,
): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[] {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    itemKey: string;
    payload: ItemPayload;
    disableRefetchOnMount: boolean;
    returnIdleStatus: boolean;
    returnRefetchingStatus: boolean;
    isOffScreen: boolean;
    queryMetadata: QueryMetadata | undefined;
  };

  const queriesWithId = useMemo((): QueryWithId[] => {
    return items.map((itemProps) => ({
      itemKey: getItemKey(itemProps.payload),
      payload: itemProps.payload,
      disableRefetchOnMount:
        itemProps.disableRefetchOnMount
        ?? allItemsDisableRefetchOnMount
        ?? globalDisableRefetchOnMount
        ?? false,
      returnIdleStatus:
        itemProps.returnIdleStatus ?? allItemsReturnIdleStatus ?? false,
      returnRefetchingStatus:
        itemProps.returnRefetchingStatus
        ?? allItemsReturnRefetchingStatus
        ?? false,
      isOffScreen: itemProps.isOffScreen ?? allItemsIsOffScreen ?? false,
      queryMetadata: itemProps.queryMetadata,
    }));
  }, [
    items,
    getItemKey,
    allItemsDisableRefetchOnMount,
    allItemsIsOffScreen,
    allItemsReturnIdleStatus,
    allItemsReturnRefetchingStatus,
    globalDisableRefetchOnMount,
  ]);

  const resultSelector = useCallback(
    (state: State) => {
      return queriesWithId.map(
        ({
          itemKey,
          payload,
          returnIdleStatus,
          returnRefetchingStatus,
          queryMetadata,
        }): TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata> => {
          const itemQuery = state.itemQueries[itemKey];
          const itemState = state.items[itemKey];

          const data =
            selector ?
              selector(itemState ?? null, itemQuery?.payload ?? null)
            : __LEGIT_CAST__<Selected>(itemState ?? null);

          if (itemQuery === null) {
            return {
              itemStateKey: itemKey,
              status: 'deleted',
              error: null,
              isLoading: false,
              payload,
              data,
              queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
            };
          }

          if (!itemQuery) {
            if (loadFromStateOnly) {
              return {
                itemStateKey: itemKey,
                status: 'error',
                error: cacheMissError,
                isLoading: false,
                payload,
                data,
                queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
              };
            }

            return {
              itemStateKey: itemKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              error: null,
              isLoading: !returnIdleStatus,
              payload,
              data,
              queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
            };
          }

          let status = itemQuery.status;

          if (!returnRefetchingStatus && itemQuery.status === 'refetching') {
            status = 'success';
          }

          return {
            itemStateKey: itemKey,
            status,
            error: itemQuery.error,
            isLoading: status === 'loading',
            data,
            payload,
            queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
          };
        },
      );
    },
    [loadFromStateOnly, queriesWithId, selector],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });

  useOnEvtmitterEvent(events, 'invalidateItem', ({ payload: event }) => {
    if (loadFromStateOnly || !fetchItemFn) return;

    for (const { payload, itemKey, isOffScreen } of queriesWithId) {
      if (isOffScreen) continue;

      if (itemKey !== event.itemKey) continue;

      if (!itemInvalidationWasTriggered.has(itemKey)) {
        store.produceState((draft) => {
          const query = draft.itemQueries[itemKey];
          if (!query?.refetchOnMount) return;

          query.refetchOnMount = false;
        });

        scheduleItemFetch(event.priority, payload);
        itemInvalidationWasTriggered.add(itemKey);
      }
    }
  });

  const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

  useEffect(() => {
    if (loadFromStateOnly || !fetchItemFn) return;

    const removedItems = new Set(ignoreItemsInRefetchOnMount);

    for (const {
      payload,
      itemKey,
      isOffScreen,
      disableRefetchOnMount,
    } of queriesWithId) {
      removedItems.delete(itemKey);

      if (isOffScreen) continue;

      const itemState = store.state.itemQueries[itemKey];
      const fetchType = itemState?.refetchOnMount || 'lowPriority';

      if (itemState === null) {
        // Deleted items should stay deleted until explicitly fetched/invalidated.
        continue;
      }

      const shouldFetch =
        itemState === undefined
        || !itemState.wasLoaded
        || itemState.refetchOnMount;

      if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemKey)) {
        continue;
      }

      ignoreItemsInRefetchOnMount.add(itemKey);

      if (disableRefetchOnMount) {
        if (shouldFetch) {
          scheduleItemFetch(fetchType, payload);
        }
      } else {
        scheduleItemFetch(fetchType, payload);
      }
    }

    for (const itemKey of removedItems) {
      ignoreItemsInRefetchOnMount.delete(itemKey);
    }
  }, [
    ignoreItemsInRefetchOnMount,
    loadFromStateOnly,
    queriesWithId,
    scheduleItemFetch,
    store.state.itemQueries,
    fetchItemFn,
  ]);

  return storeState;
}
