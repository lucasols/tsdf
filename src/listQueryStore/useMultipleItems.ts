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
import { FetchType, ScheduleFetchResults } from '../requestScheduler';
import { shouldScheduleAutomaticFetch } from '../utils/automaticFetchPolicy';
import {
  getPayloadDebounceOptions,
  shouldDebouncePayload,
} from '../utils/payloadDebounce';
import {
  fetchTypePriority,
  type PayloadDebounce,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect';
import type { ListQueryStoreEvents } from './listQueryStore';
import {
  type FieldsInput,
  type ListQueryUseMultipleItemsQuery,
  type PartialResourcesConfig,
  type TSDFItemQuery,
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
  /**
   * Debounces automatic fetches caused by payload changes, while selection
   * still reads from the latest payload. Supports trailing debounce via `ms`,
   * optional `leading`, and optional `maxWait`.
   */
  debouncePayload?: PayloadDebounce;
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
    debouncePayload,
  }: UseMultipleItemsOptions<ItemState, Selected>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  events: Emitter<ListQueryStoreEvents>,
  getItemKey: (params: ItemPayload) => string,
  registerActiveItems: (itemKeys: string[]) => () => void,
  touchItems: (itemKeys: string[]) => void,
  scheduleAutomaticItemFetch: (
    fetchType: FetchType,
    payload: ItemPayload,
    options?: { fields?: FieldsInput },
  ) => ScheduleFetchResults,
  preloadItems: ((payloads: ItemPayload[]) => Promise<boolean[]>) | undefined,
  preloadItemsBeforePaint: boolean,
  readFallbackItemState:
    | ((
        itemKey: string,
      ) =>
        | {
            item: ItemState | null | undefined;
            itemQuery: TSDFItemQuery<ItemPayload> | null | undefined;
            loadedFields: string[] | undefined;
          }
        | undefined)
    | undefined,
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
          const hasCachedDataInState = rawItemState != null;
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
    [loadFromStateOnly, partialResources, queriesWithId, selector],
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
  const visibleStoreState = useMemo(() => {
    return storeState.map(
      (
        result,
        index,
      ): TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata> => {
        const query = queriesWithId[index];
        if (
          result.status !== 'loading' &&
          result.status !== 'idle' &&
          !(result.status === 'error' && result.error?.id === cacheMissError.id)
        ) {
          return result;
        }

        if (loadFromStateOnly) return result;

        if (query && readFallbackItemState) {
          const fallbackItemState = readFallbackItemState(query.itemKey);
          const fallbackLoadedFields = fallbackItemState?.loadedFields ?? [];
          const hasAllRequestedFallbackFields =
            !partialResources ||
            query.fields === undefined ||
            query.fields === '*' ||
            query.fields.every((field) => fallbackLoadedFields.includes(field));

          if (!hasAllRequestedFallbackFields) return result;

          if (fallbackItemState?.itemQuery === null) {
            return {
              itemStateKey: result.itemStateKey,
              status: 'deleted',
              error: null,
              isLoading: false,
              payload: query.payload,
              data: selector
                ? selector(null, null)
                : __LEGIT_CAST__<Selected, null>(null),
              isPendingOfflineSync: false,
              queryMetadata: result.queryMetadata,
            };
          }

          if (
            fallbackItemState?.itemQuery &&
            fallbackItemState.item !== undefined &&
            fallbackItemState.item !== null
          ) {
            let itemState = fallbackItemState.item;

            if (
              partialResources &&
              Array.isArray(query.fields) &&
              query.fields.length > 0
            ) {
              itemState = partialResources.selectFields(
                query.fields,
                itemState,
              );
            }

            return {
              itemStateKey: result.itemStateKey,
              status: 'success',
              error: null,
              isLoading: false,
              payload: query.payload,
              data: selector
                ? selector(itemState, fallbackItemState.itemQuery.payload)
                : __LEGIT_CAST__<Selected, ItemState>(itemState),
              isPendingOfflineSync: false,
              queryMetadata: result.queryMetadata,
            };
          }
        }

        return result;
      },
    );
  }, [
    loadFromStateOnly,
    partialResources,
    queriesWithId,
    readFallbackItemState,
    selector,
    storeState,
  ]);
  const autoFetchSignals = store.useSelectorRC(autoFetchSignalSelector, {
    equalityFn: deepEqual,
  });

  useOnEvtmitterEvent(events, 'invalidateItem', ({ payload: event }) => {
    if (loadFromStateOnly || !fetchItemFn) return;

    const matchingQueries = fetchQueriesWithId.filter(
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

  useIsomorphicLayoutEffect(() => {
    if (
      loadFromStateOnly ||
      !preloadItemsBeforePaint ||
      !preloadItems ||
      fetchQueriesWithId.length < 1
    ) {
      return;
    }

    void preloadItems(fetchQueriesWithId.map(({ payload }) => payload));
  }, [
    fetchQueriesWithId,
    loadFromStateOnly,
    preloadItems,
    preloadItemsBeforePaint,
  ]);

  useEffect(() => {
    const effectState = { cancelled: false };

    void (async () => {
      if (loadFromStateOnly) return;

      if (
        !preloadItemsBeforePaint &&
        preloadItems &&
        fetchQueriesWithId.length > 0
      ) {
        await preloadItems(fetchQueriesWithId.map(({ payload }) => payload));
        if (effectState.cancelled) return;
      }

      if (!fetchItemFn) return;

      const removedItems = new Set(ignoreItemsInRefetchOnMount);

      for (const {
        payload,
        fields,
        itemKey,
        isOffScreen,
        disableRefetches,
        disableRefetchOnMount,
      } of fetchQueriesWithId) {
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
    preloadItemsBeforePaint,
    fetchQueriesWithId,
    scheduleAutomaticItemFetch,
    autoFetchSignals,
    fetchItemFn,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    partialResources,
    store,
  ]);

  return visibleStoreState;
}
