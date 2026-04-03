import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useDebouncedValue } from '@ls-stack/react-utils/useDebouncedValue';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { type Emitter } from 'evtmitter';
import { useCallback, useContext, useEffect, useMemo } from 'react';
import { Store } from 't-state';

import { useRegisterActiveKeys } from '../cacheLimits/useRegisterActiveKeys';
import { IsOffScreenContext } from '../isOffScreenContext';
import { FetchType } from '../requestScheduler';
import { shouldScheduleAutomaticFetch } from '../utils/automaticFetchPolicy';
import {
  getPayloadDebounceOptions,
  shouldDebouncePayload,
} from '../utils/payloadDebounce';
import {
  type PayloadDebounce,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
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
  /** Only loads the data if it is not already loaded and skip any other refetches */
  disableRefetches?: boolean;
  disableRefetchOnMount?: boolean;
  isOffScreen?: boolean;
  /**
   * Debounces automatic fetches caused by payload changes, while selection
   * still reads from the latest payload. Supports trailing debounce via `ms`,
   * optional `leading`, and optional `maxWait`.
   */
  debouncePayload?: PayloadDebounce;
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
    disableRefetches: allItemsDisableRefetches,
    disableRefetchOnMount: allItemsDisableRefetchOnMount,
    isOffScreen: allItemsIsOffScreen,
    debouncePayload,
  }: UseMultipleItemsOptions<ItemState, Selected>,
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  events: Emitter<CollectionStoreEvents>,
  getItemKey: (params: ItemPayload) => string,
  getItemState: (
    payload: ItemPayload,
  ) => TSFDCollectionItem<ItemState, ItemPayload> | null | undefined,
  registerActiveItems: (itemKeys: string[]) => () => void,
  touchItems: (itemKeys: string[]) => void,
  preloadItems: ((payloads: ItemPayload[]) => Promise<boolean[]>) | undefined,
  scheduleAutomaticFetch: (fetchType: FetchType, payload: ItemPayload) => void,
  invalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
): readonly TSFDUseCollectionItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata
>[] {
  const isOffScreenFromContext = useContext(IsOffScreenContext);

  type CollectionState = TSFDCollectionState<ItemState, ItemPayload>;

  type QueryWithId = {
    itemKey: string;
    payload: ItemPayload;
    disableRefetches: boolean;
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
      disableRefetches:
        queryProps.disableRefetches ?? allItemsDisableRefetches ?? false,
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
      isOffScreen:
        queryProps.isOffScreen ?? allItemsIsOffScreen ?? isOffScreenFromContext,
      queryMetadata: queryProps.queryMetadata,
    }));

    return newQueries;
  }, [
    items,
    allItemsDisableRefetches,
    allItemsDisableRefetchOnMount,
    allItemsIsOffScreen,
    allItemsOmitPayload,
    allItemsReturnIdleStatus,
    allItemsReturnRefetchingStatus,
    getItemKey,
    globalDisableRefetchOnMount,
    isOffScreenFromContext,
  ]);

  const activeItemKeys = useMemo(() => {
    return queriesWithId.map(({ itemKey }) => itemKey);
  }, [queriesWithId]);

  useRegisterActiveKeys(activeItemKeys, registerActiveItems, touchItems);

  const shouldDebounceFetchQueries = shouldDebouncePayload(debouncePayload);
  const [debouncedFetchQueriesWithId] = useDebouncedValue(
    queriesWithId,
    shouldDebounceFetchQueries ? (debouncePayload?.ms ?? 0) : 0,
    getPayloadDebounceOptions(debouncePayload),
  );
  const fetchQueriesWithId = shouldDebounceFetchQueries
    ? debouncedFetchQueriesWithId
    : queriesWithId;

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

          const data = selector
            ? selector(item?.data ?? null)
            : // WORKAROUND: Runtime selector presence does not narrow Selected, so the unselected path must forward the raw item state through the generic.
              __LEGIT_CAST__<Selected, ItemState | null>(item?.data ?? null);
          const resultQueryMetadata =
            // WORKAROUND: queryMetadata stays optional on input queries, but the public hook result preserves the caller's QueryMetadata generic.
            __LEGIT_CAST__<QueryMetadata, QueryMetadata | undefined>(
              queryMetadata,
            );

          if (item === null) {
            return {
              itemStateKey: itemKey,
              status: 'deleted',
              data,
              error: null,
              payload: omitPayload ? undefined : payload,
              isLoading: false,
              queryMetadata: resultQueryMetadata,
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
              queryMetadata: resultQueryMetadata,
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
            queryMetadata: resultQueryMetadata,
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
    for (const {
      itemKey,
      payload,
      isOffScreen,
      disableRefetches,
    } of fetchQueriesWithId) {
      if (isOffScreen) continue;

      if (itemKey !== event.itemKey) continue;

      if (disableRefetches && store.state[itemKey]?.wasLoaded) continue;

      if (!invalidationWasTriggered.has(itemKey)) {
        store.produceState((draft) => {
          const item = draft[itemKey];
          if (!item) return;

          item.refetchOnMount = false;
        });

        scheduleAutomaticFetch(event.priority, payload);
        invalidationWasTriggered.add(itemKey);
      }
    }
  });

  const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

  useEffect(() => {
    const effectState = { cancelled: false };

    void (async () => {
      if (preloadItems && fetchQueriesWithId.length > 0) {
        await preloadItems(fetchQueriesWithId.map(({ payload }) => payload));
        if (effectState.cancelled) return;
      }

      const removedQueries = new Set(ignoreItemsInRefetchOnMount);

      for (const {
        itemKey: itemId,
        payload,
        isOffScreen,
        disableRefetches,
        disableRefetchOnMount,
      } of fetchQueriesWithId) {
        removedQueries.delete(itemId);

        if (isOffScreen) continue;

        if (itemId) {
          const itemState = getItemState(payload);
          const fetchType = itemState?.refetchOnMount || 'lowPriority';
          const requiredFetch = !itemState?.wasLoaded;

          if (itemState === null) {
            // Deleted items should stay deleted until a caller explicitly refetches them.
            continue;
          }

          const shouldFetch = requiredFetch || !!itemState.refetchOnMount;

          if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemId)) {
            continue;
          }

          ignoreItemsInRefetchOnMount.add(itemId);

          if (
            shouldScheduleAutomaticFetch({
              wasLoaded: itemState?.wasLoaded,
              shouldFetch,
              requiredFetch,
              disableRefetches,
              disableRefetchOnMount,
              refetchOnMount: itemState?.refetchOnMount ?? false,
            })
          ) {
            scheduleAutomaticFetch(fetchType, payload);
          }
        }
      }

      for (const itemId of removedQueries) {
        ignoreItemsInRefetchOnMount.delete(itemId);
      }
    })();

    return () => {
      effectState.cancelled = true;
    };
  }, [
    getItemState,
    fetchQueriesWithId,
    ignoreItemsInRefetchOnMount,
    preloadItems,
    scheduleAutomaticFetch,
  ]);

  return storeState;
}
