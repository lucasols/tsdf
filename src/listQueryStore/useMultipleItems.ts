import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { type Emitter } from 'evtmitter';
import { useCallback, useContext, useEffect, useMemo } from 'react';
import { Store } from 't-state';
import { IsOffScreenContext } from '../isOffScreenContext';
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { shouldScheduleAutomaticFetch } from '../utils/automaticFetchPolicy';
import {
  fetchTypePriority,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
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
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
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
    showPartialAsRefetching: allItemsShowPartialAsRefetching,
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
  preloadItems: ((payloads: ItemPayload[]) => Promise<boolean[]>) | undefined,
  itemInvalidationWasTriggered: Set<string>,
  itemFieldInvalidationPriorities: Map<string, FetchType>,
  itemPendingInvalidationFields: Map<string, string[]>,
  globalDisableRefetchOnMount: boolean | undefined,
  fetchItemFn: unknown,
  partialResources?: PartialResourcesConfig<ItemState>,
): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[] {
  const isOffScreenFromContext = useContext(IsOffScreenContext);

  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    itemKey: string;
    payload: ItemPayload;
    fields: FieldsInput | undefined;
    disableRefetches: boolean;
    disableRefetchOnMount: boolean;
    returnIdleStatus: boolean;
    returnRefetchingStatus: boolean;
    showPartialAsRefetching: boolean;
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
      showPartialAsRefetching:
        itemProps.showPartialAsRefetching ??
        allItemsShowPartialAsRefetching ??
        false,
      isOffScreen:
        itemProps.isOffScreen ?? allItemsIsOffScreen ?? isOffScreenFromContext,
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
    allItemsShowPartialAsRefetching,
    globalDisableRefetchOnMount,
    isOffScreenFromContext,
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
          showPartialAsRefetching,
          queryMetadata,
        }): TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata> => {
          const itemQuery = state.itemQueries[itemKey];
          const rawItemState = state.items[itemKey];
          const hasCachedDataInState =
            rawItemState !== null && rawItemState !== undefined;
          const loadedFields = state.itemLoadedFields[itemKey] ?? [];
          let itemState = rawItemState;
          let loadingFields: string[] | undefined;

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
              isPendingOfflineSync: false,
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
                isPendingOfflineSync: false,
                queryMetadata: __LEGIT_CAST__<
                  QueryMetadata,
                  QueryMetadata | undefined
                >(queryMetadata),
              };
            }

            const pendingLoadingFields =
              partialResources &&
              showPartialAsRefetching &&
              Array.isArray(fields) &&
              fields.length > 0 &&
              !returnIdleStatus
                ? fields
                : undefined;

            return {
              itemStateKey: itemKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              error: null,
              isLoading: !returnIdleStatus,
              ...(pendingLoadingFields
                ? { loadingFields: pendingLoadingFields }
                : {}),
              payload,
              data,
              isPendingOfflineSync: false,
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
            const missingFields = fields.filter(
              (f) => !loadedFields.includes(f),
            );
            const hasMissingFields = missingFields.length > 0;
            const missingFieldsAreAvailableInState =
              hasMissingFields &&
              !!rawItemState &&
              typeof rawItemState === 'object' &&
              (() => {
                const itemRecord = __LEGIT_CAST__<
                  Record<string, unknown>,
                  ItemState
                >(rawItemState);
                return missingFields.every(
                  (f) => f in itemRecord && itemRecord[f] !== undefined,
                );
              })();

            if (hasMissingFields && !missingFieldsAreAvailableInState) {
              status =
                hasCachedDataInState && showPartialAsRefetching
                  ? 'refetching'
                  : 'loading';
            }
          }

          if (partialResources && showPartialAsRefetching) {
            if (Array.isArray(fields) && fields.length > 0) {
              const pendingRequestedFields = fields.filter(
                (field) => !loadedFields.includes(field),
              );

              if (pendingRequestedFields.length > 0) {
                loadingFields = pendingRequestedFields;
              }
            } else if (
              fields === '*' &&
              itemFieldInvalidationFields &&
              itemFieldInvalidationFields.length > 0
            ) {
              loadingFields = itemFieldInvalidationFields;
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

          const shouldHideDataWhileLoading =
            status === 'loading' && partialResources;

          return {
            itemStateKey: itemKey,
            status,
            error: itemQuery.error,
            isLoading: status === 'loading',
            ...(loadingFields ? { loadingFields } : {}),
            data: shouldHideDataWhileLoading
              ? selector
                ? selector(null, itemQuery.payload)
                : __LEGIT_CAST__<Selected, null>(null)
              : data,
            payload,
            isPendingOfflineSync: false,
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

  const autoFetchSignalSelector = useCallback(
    (state: State) => {
      return queriesWithId.map(({ itemKey, fields }) => {
        const itemQuery = state.itemQueries[itemKey];
        const loadedFields = state.itemLoadedFields[itemKey] ?? [];
        const missingRequestedFields =
          partialResources && Array.isArray(fields) && fields.length > 0
            ? fields.filter((field) => !loadedFields.includes(field)).sort()
            : [];

        return {
          status: itemQuery?.status ?? null,
          refetchOnMount: itemQuery?.refetchOnMount ?? null,
          missingRequestedFieldsKey: JSON.stringify(missingRequestedFields),
        };
      });
    },
    [partialResources, queriesWithId],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });
  const autoFetchSignals = store.useSelectorRC(autoFetchSignalSelector, {
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
    const effectState = { cancelled: false };

    void (async () => {
      if (preloadItems && queriesWithId.length > 0) {
        await preloadItems(queriesWithId.map(({ payload }) => payload));
        if (effectState.cancelled) return;
      }

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
        let fetchType = itemState?.refetchOnMount || 'lowPriority';
        let fieldsToFetch = fields;
        let requiredFetch = itemState === undefined || !itemState?.wasLoaded;

        if (itemState === null) {
          // Deleted items should stay deleted until explicitly fetched/invalidated.
          continue;
        }

        let shouldFetch = requiredFetch || !!itemState?.refetchOnMount;
        const itemFetchIsActive =
          itemState?.status === 'loading' || itemState?.status === 'refetching';

        // For partial resources, check if all requested fields are loaded
        if (
          partialResources &&
          !shouldFetch &&
          Array.isArray(fields) &&
          fields.length > 0
        ) {
          const loadedFields = store.state.itemLoadedFields[itemKey] ?? [];
          const missingFields = fields.filter((f) => !loadedFields.includes(f));
          const hasMissingFields = missingFields.length > 0;
          const pendingInvalidationFields =
            itemPendingInvalidationFields.get(itemKey);
          const unresolvedPendingInvalidationFields =
            pendingInvalidationFields?.filter(
              (field) => !loadedFields.includes(field),
            ) ?? [];
          const hasAffectedFieldInvalidation =
            unresolvedPendingInvalidationFields.length > 0 &&
            fields.some((field) =>
              unresolvedPendingInvalidationFields.includes(field),
            );

          if (hasMissingFields && !itemFetchIsActive) {
            shouldFetch = true;
            requiredFetch = true;
            fieldsToFetch = missingFields;
            // Low-priority follow-ups can be skipped while scheduler phase is still fetching.
            // Keep stronger priorities intact; only lift low priority.
            if (fetchType === 'lowPriority') {
              fetchType = 'highPriority';
            }
          }

          const invalidationPriority =
            itemFieldInvalidationPriorities.get(itemKey);
          if (
            hasAffectedFieldInvalidation &&
            invalidationPriority &&
            fetchTypePriority[invalidationPriority] >
              fetchTypePriority[fetchType]
          ) {
            fetchType = invalidationPriority;
          }
        }

        if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemKey)) {
          continue;
        }

        ignoreItemsInRefetchOnMount.add(itemKey);

        if (
          shouldScheduleAutomaticFetch({
            wasLoaded: itemState?.wasLoaded,
            shouldFetch,
            requiredFetch,
            disableRefetches,
            disableRefetchOnMount,
            refetchOnMount: itemState?.refetchOnMount ?? false,
            skipFreshFetch: !!partialResources,
          })
        ) {
          scheduleAutomaticItemFetch(fetchType, payload, {
            fields: fieldsToFetch,
          });
        }
      }

      for (const itemKey of removedItems) {
        ignoreItemsInRefetchOnMount.delete(itemKey);
      }
    })();

    return () => {
      effectState.cancelled = true;
    };
  }, [
    ignoreItemsInRefetchOnMount,
    loadFromStateOnly,
    preloadItems,
    queriesWithId,
    scheduleAutomaticItemFetch,
    autoFetchSignals,
    fetchItemFn,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    partialResources,
    store,
  ]);

  return storeState;
}
