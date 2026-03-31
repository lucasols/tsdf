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
import {
  createOfflineEntityLookup,
  filterActiveOfflineOverlays,
  getIsPendingOfflineSync,
} from '../persistentStorage/offline/entityMetadata';
import type { GlobalOfflineEntity } from '../persistentStorage/offline/types';
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
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect';
import type {
  CollectionStoreEvents,
  CollectionUseMultipleItemsQuery,
  TSFDCollectionItem,
  TSFDCollectionState,
  TSFDUseCollectionItemReturn,
} from './collectionStore';

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
  readFallbackItemState:
    | ((
        itemKey: string,
      ) => TSFDCollectionItem<ItemState, ItemPayload> | null | undefined)
    | undefined,
  registerActiveItems: (itemKeys: string[]) => () => void,
  touchItems: (itemKeys: string[]) => void,
  preloadItems: ((payloads: ItemPayload[]) => Promise<boolean[]>) | undefined,
  preloadItemsBeforePaint: boolean,
  scheduleAutomaticFetch: (fetchType: FetchType, payload: ItemPayload) => void,
  invalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
  offlineEntities: readonly GlobalOfflineEntity[],
  offlineOverlays: Readonly<
    Record<string, { data: ItemState | null; payload?: ItemPayload }>
  >,
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
    return items.map((queryProps) => ({
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

  const offlineEntitiesByKey = useMemo(
    () => createOfflineEntityLookup(offlineEntities),
    [offlineEntities],
  );
  const activeOfflineOverlays = useMemo(
    () => filterActiveOfflineOverlays(offlineEntitiesByKey, offlineOverlays),
    [offlineEntitiesByKey, offlineOverlays],
  );

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
          const overlay = activeOfflineOverlays[itemKey];
          const hasOverlay = overlay !== undefined;
          const resolvedData = hasOverlay ? overlay.data : (item?.data ?? null);
          const resolvedPayload = overlay?.payload ?? item?.payload ?? payload;

          const data = selector
            ? selector(resolvedData)
            : // WORKAROUND: Runtime selector presence does not narrow Selected, so the unselected path must forward the raw item state through the generic.
              __LEGIT_CAST__<Selected, ItemState | null>(resolvedData);
          const resultQueryMetadata =
            // WORKAROUND: queryMetadata stays optional on input queries, but the public hook result preserves the caller's QueryMetadata generic.
            __LEGIT_CAST__<QueryMetadata, QueryMetadata | undefined>(
              queryMetadata,
            );

          if (hasOverlay ? overlay.data === null : item === null) {
            return {
              itemStateKey: itemKey,
              status: 'deleted',
              data,
              error: null,
              payload: omitPayload ? undefined : payload,
              isLoading: false,
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(itemKey),
              ),
              queryMetadata: resultQueryMetadata,
            };
          }

          if (!item && !hasOverlay) {
            return {
              itemStateKey: itemKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              data,
              error: null,
              payload: omitPayload ? undefined : payload,
              isLoading: !returnIdleStatus,
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(itemKey),
              ),
              queryMetadata: resultQueryMetadata,
            };
          }

          let status = item?.status ?? 'success';

          if (!returnRefetchingStatus && item?.status === 'refetching') {
            status = 'success';
          }

          return {
            itemStateKey: itemKey,
            status,
            data,
            error: item?.error ?? null,
            isLoading: status === 'loading',
            pendingSync: getIsPendingOfflineSync(
              offlineEntitiesByKey.get(itemKey),
            ),
            payload: omitPayload ? undefined : resolvedPayload,
            queryMetadata: resultQueryMetadata,
          };
        },
      );
    },
    [activeOfflineOverlays, offlineEntitiesByKey, queriesWithId, selector],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });
  const visibleStoreState = useMemo(() => {
    return storeState.map(
      (
        result,
        index,
      ): TSFDUseCollectionItemReturn<Selected, ItemPayload, QueryMetadata> => {
        const query = queriesWithId[index];
        if (result.status !== 'loading' && result.status !== 'idle') {
          return result;
        }

        if (query && readFallbackItemState) {
          const fallbackItem = readFallbackItemState(query.itemKey);
          const overlay = activeOfflineOverlays[result.itemStateKey];
          const hasOverlay = overlay !== undefined;
          const fallbackData = hasOverlay
            ? overlay.data
            : (fallbackItem?.data ?? null);
          const fallbackPayload =
            overlay?.payload ?? fallbackItem?.payload ?? query.payload;

          if (hasOverlay ? overlay.data === null : fallbackItem === null) {
            return {
              itemStateKey: result.itemStateKey,
              status: 'deleted',
              data: selector
                ? selector(null)
                : // WORKAROUND: Runtime selector presence does not narrow Selected, so the deleted fallback still has to express null through the caller's generic.
                  __LEGIT_CAST__<Selected, null>(null),
              error: null,
              payload: query.omitPayload ? undefined : query.payload,
              isLoading: false,
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(result.itemStateKey),
              ),
              queryMetadata: result.queryMetadata,
            };
          }

          if (fallbackItem || hasOverlay) {
            let status = fallbackItem?.status ?? 'success';

            if (!query.returnRefetchingStatus && status === 'refetching') {
              status = 'success';
            }

            return {
              itemStateKey: result.itemStateKey,
              status,
              data: selector
                ? selector(fallbackData)
                : // WORKAROUND: Runtime selector presence does not narrow Selected, so fallback item data still has to flow through the caller's generic unchanged.
                  __LEGIT_CAST__<Selected, ItemState | null>(fallbackData),
              error: fallbackItem?.error ?? null,
              payload: query.omitPayload ? undefined : fallbackPayload,
              isLoading: status === 'loading',
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(result.itemStateKey),
              ),
              queryMetadata: result.queryMetadata,
            };
          }
        }

        return result;
      },
    );
  }, [
    activeOfflineOverlays,
    offlineEntitiesByKey,
    queriesWithId,
    readFallbackItemState,
    selector,
    storeState,
  ]);
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

  useIsomorphicLayoutEffect(() => {
    if (
      !preloadItemsBeforePaint ||
      !preloadItems ||
      fetchQueriesWithId.length < 1
    ) {
      return;
    }

    void preloadItems(fetchQueriesWithId.map(({ payload }) => payload));
  }, [fetchQueriesWithId, preloadItems, preloadItemsBeforePaint]);

  useEffect(() => {
    const effectState = { cancelled: false };

    void (async () => {
      if (
        !preloadItemsBeforePaint &&
        preloadItems &&
        fetchQueriesWithId.length > 0
      ) {
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
    preloadItemsBeforePaint,
    scheduleAutomaticFetch,
  ]);

  return visibleStoreState;
}
