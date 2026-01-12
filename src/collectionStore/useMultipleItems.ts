import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { type Emitter } from 'evtmitter';
import { useCallback, useEffect, useMemo } from 'react';
import { Store } from 't-state';
import { FetchType } from '../requestScheduler';
import { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  CollectionUseMultipleItemsQuery,
  TSFDCollectionItem,
  TSFDCollectionState,
  TSFDUseCollectionItemReturn,
} from './collectionStore';

type CollectionStoreEvents = {
  invalidateData: { priority: FetchType; itemKey: string };
};

export type UseMultipleItemsOptions<
  ItemState extends ValidStoreState,
  Selected,
> = {
  selector?: (data: ItemState | null) => Selected;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  omitPayload?: boolean;
  disableRefetchOnMount?: boolean;
  isOffScreen?: boolean;
};

export function useMultipleItems<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  Selected = ItemState | null,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
>(
  items: CollectionUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
  {
    selector,
    returnIdleStatus: allItemsReturnIdleStatus,
    returnRefetchingStatus: allItemsReturnRefetchingStatus,
    omitPayload: allItemsOmitPayload,
    disableRefetchOnMount: allItemsDisableRefetchOnMount,
    isOffScreen: allItemsIsOffScreen,
  }: UseMultipleItemsOptions<ItemState, Selected>,
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  events: Emitter<CollectionStoreEvents>,
  getItemKey: (params: ItemPayload) => string,
  getItemState: (
    payload: ItemPayload,
  ) => TSFDCollectionItem<ItemState, ItemPayload> | null | undefined,
  scheduleFetch: (fetchType: FetchType, payload: ItemPayload) => void,
  invalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
): readonly TSFDUseCollectionItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata
>[] {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload>;

  type QueryWithId = {
    itemKey: string;
    payload: ItemPayload;
    disableRefetchOnMount: boolean;
    returnIdleStatus: boolean;
    returnRefetchingStatus: boolean;
    omitPayload: boolean;
    isOffScreen: boolean;
    queryMetadata: QueryMetadata | undefined;
  };

  const queriesWithId = useMemo((): QueryWithId[] => {
    const newQueries = items.map((queryProps) => ({
      itemKey: getItemKey(queryProps.payload),
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
      queryMetadata: queryProps.queryMetadata,
    }));

    return newQueries;
  }, [
    items,
    allItemsDisableRefetchOnMount,
    allItemsIsOffScreen,
    allItemsOmitPayload,
    allItemsReturnIdleStatus,
    allItemsReturnRefetchingStatus,
    getItemKey,
    globalDisableRefetchOnMount,
  ]);

  const resultSelector = useCallback(
    (state: CollectionState) => {
      return queriesWithId.map(
        ({
          itemKey,
          payload,
          omitPayload,
          returnIdleStatus,
          returnRefetchingStatus,
          queryMetadata,
        }): TSFDUseCollectionItemReturn<
          Selected,
          ItemPayload,
          QueryMetadata
        > => {
          const item = state[itemKey];

          const data =
            selector ?
              selector(item?.data ?? null)
            : __LEGIT_CAST__<Selected>(item?.data ?? null);

          if (item === null) {
            return {
              itemStateKey: itemKey,
              status: 'deleted',
              data,
              error: null,
              payload: omitPayload ? undefined : payload,
              isLoading: false,
              queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
            };
          }

          if (!item) {
            return {
              itemStateKey: itemKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              data,
              error: null,
              payload: omitPayload ? undefined : payload,
              isLoading: !returnIdleStatus,
              queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
            };
          }

          let status = item.status;

          if (!returnRefetchingStatus && item.status === 'refetching') {
            status = 'success';
          }

          return {
            itemStateKey: itemKey,
            status,
            data,
            error: item.error,
            isLoading: status === 'loading',
            payload: omitPayload ? undefined : item.payload,
            queryMetadata: __LEGIT_CAST__<QueryMetadata>(queryMetadata),
          };
        },
      );
    },
    [queriesWithId, selector],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });

  useOnEvtmitterEvent(events, 'invalidateData', ({ payload: event }) => {
    for (const { itemKey, payload, isOffScreen } of queriesWithId) {
      if (isOffScreen) continue;

      if (itemKey !== event.itemKey) continue;

      if (!invalidationWasTriggered.has(itemKey)) {
        store.produceState((draft) => {
          const item = draft[itemKey];
          if (!item) return;

          item.refetchOnMount = false;
        });

        scheduleFetch(event.priority, payload);
        invalidationWasTriggered.add(itemKey);
      }
    }
  });

  const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

  useEffect(() => {
    const removedQueries = new Set(ignoreItemsInRefetchOnMount);

    for (const {
      itemKey: itemId,
      payload,
      isOffScreen,
      disableRefetchOnMount,
    } of queriesWithId) {
      removedQueries.delete(itemId);

      if (isOffScreen) continue;

      if (itemId) {
        const itemState = getItemState(payload);
        const fetchType = itemState?.refetchOnMount || 'lowPriority';

        const shouldFetch = !itemState?.wasLoaded || itemState.refetchOnMount;

        if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemId)) {
          continue;
        }

        ignoreItemsInRefetchOnMount.add(itemId);

        if (disableRefetchOnMount) {
          if (shouldFetch) {
            scheduleFetch(fetchType, payload);
            continue;
          }
        } else {
          scheduleFetch(fetchType, payload);
        }
      }
    }

    for (const itemId of removedQueries) {
      ignoreItemsInRefetchOnMount.delete(itemId);
    }
  }, [getItemState, ignoreItemsInRefetchOnMount, queriesWithId, scheduleFetch]);

  return storeState;
}
