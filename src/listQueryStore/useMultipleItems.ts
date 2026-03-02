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
import {
  type FieldsInput,
  type ListQueryUseMultipleItemsQuery,
  type PartialResourcesConfig,
  type TSFDListQueryState,
  type TSFDUseListItemReturn,
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
  /** Only loads the data if it is not already loaded and skip any other refetches */
  disableRefetches?: boolean;
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
    disableRefetches: allItemsDisableRefetches,
    disableRefetchOnMount: allItemsDisableRefetchOnMount,
    isOffScreen: allItemsIsOffScreen,
  }: UseMultipleItemsOptions<ItemState, Selected>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  events: Emitter<ListQueryStoreEvents>,
  getItemKey: (params: ItemPayload) => string,
  scheduleAutomaticItemFetch: (
    fetchType: FetchType,
    payload: ItemPayload,
    options?: { fields?: FieldsInput },
  ) => ScheduleFetchResults,
  itemInvalidationWasTriggered: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
  fetchItemFn: unknown,
  partialResources?: PartialResourcesConfig<ItemState>,
): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[] {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    itemKey: string;
    payload: ItemPayload;
    fields: FieldsInput | undefined;
    disableRefetches: boolean;
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
      fields: itemProps.fields,
      disableRefetches:
        itemProps.disableRefetches ?? allItemsDisableRefetches ?? false,
      disableRefetchOnMount:
        itemProps.disableRefetchOnMount ??
        allItemsDisableRefetchOnMount ??
        globalDisableRefetchOnMount ??
        false,
      returnIdleStatus:
        itemProps.returnIdleStatus ?? allItemsReturnIdleStatus ?? false,
      returnRefetchingStatus:
        itemProps.returnRefetchingStatus ??
        allItemsReturnRefetchingStatus ??
        false,
      isOffScreen: itemProps.isOffScreen ?? allItemsIsOffScreen ?? false,
      queryMetadata: itemProps.queryMetadata,
    }));
  }, [
    items,
    getItemKey,
    allItemsDisableRefetches,
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
          fields,
          returnIdleStatus,
          returnRefetchingStatus,
          queryMetadata,
        }): TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata> => {
          const itemQuery = state.itemQueries[itemKey];
          const rawItemState = state.items[itemKey];
          let itemState = rawItemState;

          // Apply field selection for partial resources
          if (
            partialResources &&
            itemState &&
            Array.isArray(fields) &&
            fields.length > 0
          ) {
            itemState = partialResources.selectFields(fields, itemState);
          }

          const data = selector
            ? selector(itemState ?? null, itemQuery?.payload ?? null)
            : __LEGIT_CAST__<Selected, ItemState | null>(itemState ?? null);

          if (itemQuery === null) {
            return {
              itemStateKey: itemKey,
              status: 'deleted',
              error: null,
              isLoading: false,
              payload,
              data,
              queryMetadata: __LEGIT_CAST__<
                QueryMetadata,
                QueryMetadata | undefined
              >(queryMetadata),
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
                queryMetadata: __LEGIT_CAST__<
                  QueryMetadata,
                  QueryMetadata | undefined
                >(queryMetadata),
              };
            }

            return {
              itemStateKey: itemKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              error: null,
              isLoading: !returnIdleStatus,
              payload,
              data,
              queryMetadata: __LEGIT_CAST__<
                QueryMetadata,
                QueryMetadata | undefined
              >(queryMetadata),
            };
          }

          let status = itemQuery.status;
          const itemFieldInvalidationFields =
            state.itemFieldInvalidationFields[itemKey];

          // Override status when partial resources has missing fields
          if (
            partialResources &&
            Array.isArray(fields) &&
            fields.length > 0 &&
            (status === 'success' || status === 'refetching')
          ) {
            const loadedFields = state.itemLoadedFields[itemKey] ?? [];
            const missingFields = fields.filter(
              (f) => !loadedFields.includes(f),
            );
            const hasMissingFields = missingFields.length > 0;
            const missingFieldsAreFromPerFieldInvalidation =
              !!itemFieldInvalidationFields &&
              missingFields.every((f) =>
                itemFieldInvalidationFields.includes(f),
              );
            const missingFieldsAreAvailableInState =
              hasMissingFields &&
              !!rawItemState &&
              typeof rawItemState === 'object' &&
              missingFields.every((f) => f in rawItemState);

            if (
              hasMissingFields &&
              !(
                missingFieldsAreFromPerFieldInvalidation &&
                missingFieldsAreAvailableInState
              )
            ) {
              status = 'loading';
            }
          }

          if (
            partialResources &&
            status === 'refetching' &&
            Array.isArray(fields) &&
            fields.length > 0 &&
            itemFieldInvalidationFields &&
            !fields.some((f) => itemFieldInvalidationFields.includes(f))
          ) {
            // Keep unaffected hooks at success during per-field invalidation refetches.
            status = 'success';
          }

          if (!returnRefetchingStatus && status === 'refetching') {
            status = 'success';
          }

          return {
            itemStateKey: itemKey,
            status,
            error: itemQuery.error,
            isLoading: status === 'loading',
            data:
              status === 'loading' && partialResources
                ? selector
                  ? selector(null, itemQuery.payload)
                  : __LEGIT_CAST__<Selected, null>(null)
                : data,
            payload,
            queryMetadata: __LEGIT_CAST__<
              QueryMetadata,
              QueryMetadata | undefined
            >(queryMetadata),
          };
        },
      );
    },
    [loadFromStateOnly, queriesWithId, selector, partialResources],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });

  useOnEvtmitterEvent(events, 'invalidateItem', ({ payload: event }) => {
    if (loadFromStateOnly || !fetchItemFn) return;

    const matchingQueries = queriesWithId.filter(
      ({ itemKey, isOffScreen }) => !isOffScreen && itemKey === event.itemKey,
    );

    if (matchingQueries.length === 0) return;
    if (itemInvalidationWasTriggered.has(event.itemKey)) return;

    const allQueriesDisableRefetches = matchingQueries.every(
      (q) => q.disableRefetches,
    );
    if (
      allQueriesDisableRefetches &&
      store.state.itemQueries[event.itemKey]?.wasLoaded
    ) {
      return;
    }

    let fieldsToFetch: string[] | undefined;
    if (event.invalidateFields && event.invalidateFields.length > 0) {
      fieldsToFetch = Array.from(new Set(event.invalidateFields)).sort();

      const hasAffectedHook = matchingQueries.some(({ fields }) => {
        if (fields === '*') return true;
        if (!fields || fields.length === 0) return true;
        return fields.some((field) => event.invalidateFields?.includes(field));
      });

      if (!hasAffectedHook) return;
    }

    const firstQuery = matchingQueries[0];
    if (!firstQuery) return;

    store.produceState((draft) => {
      const query = draft.itemQueries[event.itemKey];
      if (!query?.refetchOnMount) return;

      query.refetchOnMount = false;
    });

    scheduleAutomaticItemFetch(event.priority, firstQuery.payload, {
      fields: fieldsToFetch ?? firstQuery.fields,
    });
    itemInvalidationWasTriggered.add(event.itemKey);
  });

  const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

  useEffect(() => {
    if (loadFromStateOnly || !fetchItemFn) return;

    const removedItems = new Set(ignoreItemsInRefetchOnMount);

    for (const {
      payload,
      fields,
      itemKey,
      isOffScreen,
      disableRefetches,
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

      let shouldFetch =
        itemState === undefined ||
        !itemState.wasLoaded ||
        itemState.refetchOnMount;

      // For partial resources, check if all requested fields are loaded
      if (
        partialResources &&
        !shouldFetch &&
        Array.isArray(fields) &&
        fields.length > 0
      ) {
        const loadedFields = store.state.itemLoadedFields[itemKey] ?? [];
        const hasMissingFields = fields.some((f) => !loadedFields.includes(f));

        if (hasMissingFields) {
          shouldFetch = true;
        }
      }

      if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemKey)) {
        continue;
      }

      ignoreItemsInRefetchOnMount.add(itemKey);

      if (disableRefetches) {
        if (!itemState?.wasLoaded) {
          scheduleItemFetch(fetchType, payload, { fields });
        }
      } else if (disableRefetchOnMount) {
        if (shouldFetch) {
          scheduleAutomaticItemFetch(fetchType, payload, { fields });
        }
      } else if (!partialResources || shouldFetch) {
        scheduleAutomaticItemFetch(fetchType, payload, { fields });
      }
    }

    for (const itemKey of removedItems) {
      ignoreItemsInRefetchOnMount.delete(itemKey);
    }
  }, [
    ignoreItemsInRefetchOnMount,
    loadFromStateOnly,
    queriesWithId,
    scheduleAutomaticItemFetch,
    store.state.itemQueries,
    store.state.itemLoadedFields,
    fetchItemFn,
    partialResources,
  ]);

  return storeState;
}
