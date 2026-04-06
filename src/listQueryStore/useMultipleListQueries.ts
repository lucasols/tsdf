import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useDebouncedValue } from '@ls-stack/react-utils/useDebouncedValue';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
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
  getOfflineEntitiesMetadata,
} from '../persistentStorage/offline/entityMetadata';
import type { GlobalOfflineEntity } from '../persistentStorage/offline/types';
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
  type ListQueryOfflineOverlay,
  type ListQueryUseMultipleListQueriesQuery,
  type PartialResourcesConfig,
  type TSDFItemQuery,
  type TSFDListQuery,
  type TSFDListQueryState,
  type TSFDUseListQueryReturn,
} from './types';

function fallbackItemHasRequestedFields<ItemState extends ValidStoreState>(
  fallbackItemState:
    | { item: ItemState | null | undefined; loadedFields: string[] | undefined }
    | undefined,
  requestedFields: readonly string[],
): boolean {
  const loadedFields = fallbackItemState?.loadedFields ?? [];

  if (requestedFields.every((field) => loadedFields.includes(field))) {
    return true;
  }

  const item = fallbackItemState?.item;
  if (!item || typeof item !== 'object') return false;

  const itemRecord =
    // WORKAROUND: Fallback field checks need indexed property access, but ItemState is generic and does not expose a string index signature.
    __LEGIT_CAST__<Record<string, unknown>, ItemState>(item);

  return requestedFields.every(
    (field) => field in itemRecord && itemRecord[field] !== undefined,
  );
}

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
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
  omitPayload?: boolean;
  /** Only loads the data if it is not already loaded and skip any other refetches */
  disableRefetches?: boolean;
  disableRefetchOnMount?: boolean;
  isOffScreen?: boolean;
  loadSize?: number;
  /**
   * Debounces automatic fetches caused by payload changes, while selection
   * still reads from the latest payload. Supports trailing debounce via `ms`,
   * optional `leading`, and optional `maxWait`.
   */
  debouncePayload?: PayloadDebounce;
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
    showPartialAsRefetching: allItemsShowPartialAsRefetching,
    omitPayload: allItemsOmitPayload,
    disableRefetches: allItemsDisableRefetches,
    disableRefetchOnMount: allItemsDisableRefetchOnMount,
    isOffScreen: allItemsIsOffScreen,
    loadSize: allItemsLoadSize,
    debouncePayload,
  }: UseMultipleListQueriesOptions<ItemState, ItemPayload, SelectedItem>,
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  events: Emitter<ListQueryStoreEvents>,
  getQueryKey: (params: QueryPayload) => string,
  registerActiveQueries: (queryKeys: string[]) => () => void,
  touchQueries: (queryKeys: string[]) => void,
  getQueryState: (
    params: QueryPayload,
  ) => TSFDListQuery<QueryPayload> | undefined,
  readFallbackQueryState:
    | ((queryKey: string) => TSFDListQuery<QueryPayload> | undefined)
    | undefined,
  preloadQueries:
    | ((payloads: QueryPayload[]) => Promise<boolean[]>)
    | undefined,
  preloadQueriesBeforePaint: boolean,
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
  scheduleAutomaticListQueryFetch: (
    fetchType: FetchType,
    payload: QueryPayload,
    size?: number,
    options?: { fields?: FieldsInput },
  ) => ScheduleFetchResults,
  queryInvalidationWasTriggered: Set<string>,
  itemFieldInvalidationPriorities: Map<string, FetchType>,
  itemPendingInvalidationFields: Map<string, string[]>,
  globalDisableRefetchOnMount: boolean | undefined,
  partialResources: PartialResourcesConfig<ItemState> | undefined,
  offlineEntities: readonly GlobalOfflineEntity[],
  offlineOverlays: Readonly<
    Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>
  >,
): readonly TSFDUseListQueryReturn<
  SelectedItem,
  QueryPayload,
  QueryMetadata
>[] {
  const isOffScreenFromContext = useContext(IsOffScreenContext);

  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    key: string;
    payload: QueryPayload;
    fields: FieldsInput | undefined;
    disableRefetches: boolean;
    disableRefetchOnMount: boolean;
    returnIdleStatus: boolean;
    returnRefetchingStatus: boolean;
    showPartialAsRefetching: boolean;
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
      showPartialAsRefetching:
        queryProps.showPartialAsRefetching ??
        allItemsShowPartialAsRefetching ??
        false,
      omitPayload: queryProps.omitPayload ?? allItemsOmitPayload ?? false,
      isOffScreen:
        queryProps.isOffScreen ?? allItemsIsOffScreen ?? isOffScreenFromContext,
      loadSize: queryProps.loadSize ?? allItemsLoadSize,
      queryMetadata: queryProps.queryMetadata,
    }));
  }, [
    queries,
    getQueryKey,
    allItemsDisableRefetches,
    allItemsDisableRefetchOnMount,
    allItemsIsOffScreen,
    allItemsLoadSize,
    allItemsOmitPayload,
    allItemsReturnIdleStatus,
    allItemsReturnRefetchingStatus,
    allItemsShowPartialAsRefetching,
    globalDisableRefetchOnMount,
    isOffScreenFromContext,
  ]);

  const activeQueryKeys = useMemo(() => {
    return queriesWithId.map(({ key }) => key);
  }, [queriesWithId]);

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
  const { deletedOverlayItemKeys, overlayItemsByQueryKey } = useMemo(() => {
    const deleted = new Set<string>();
    const byQueryKey = new Map<string, { itemKey: string; index: number }[]>();

    for (const [itemKey, overlay] of Object.entries(activeOfflineOverlays)) {
      if (overlay.item === null) {
        deleted.add(itemKey);
        continue;
      }

      for (const [queryKey, index] of Object.entries(
        overlay.queryMemberships,
      )) {
        let queryItems = byQueryKey.get(queryKey);

        if (!queryItems) {
          queryItems = [];
          byQueryKey.set(queryKey, queryItems);
        }

        queryItems.push({ itemKey, index });
      }
    }

    for (const queryItems of byQueryKey.values()) {
      queryItems.sort((left, right) => {
        if (left.index !== right.index) {
          return left.index - right.index;
        }

        return left.itemKey.localeCompare(right.itemKey);
      });
    }

    return {
      deletedOverlayItemKeys: deleted,
      overlayItemsByQueryKey: byQueryKey,
    };
  }, [activeOfflineOverlays]);

  const selectVisibleItems = useCallback(
    (
      itemKeys: readonly string[],
      fields: FieldsInput | undefined,
      getItemState: (
        itemKey: string,
      ) =>
        | {
            item: ItemState | null | undefined;
            itemPayload: ItemPayload | undefined;
          }
        | undefined,
    ): SelectedItem[] => {
      return filterAndMap(itemKeys, (itemKey) => {
        const overlay = activeOfflineOverlays[itemKey];
        if (overlay?.item === null) return false;
        let item = overlay?.item;
        let itemPayload = overlay?.itemPayload;

        if (item === undefined || itemPayload === undefined) {
          const currentItemState = getItemState(itemKey);

          if (item === undefined) {
            item = currentItemState?.item ?? undefined;
          }

          if (itemPayload === undefined) {
            itemPayload = currentItemState?.itemPayload;
          }
        }

        if (!item || itemPayload === undefined) {
          return false;
        }

        if (partialResources && Array.isArray(fields) && fields.length > 0) {
          item = partialResources.selectFields(fields, item);
        }

        if (itemSelector) {
          return itemSelector(item, itemPayload, itemKey);
        }

        // WORKAROUND: Runtime itemSelector presence does not narrow
        // SelectedItem, so the default branch must forward ItemState through
        // the caller's generic.
        return __LEGIT_CAST__<SelectedItem, ItemState>(item);
      });
    },
    [activeOfflineOverlays, itemSelector, partialResources],
  );

  const getUnresolvedPendingInvalidationFields = useCallback(
    (itemKey: string, state?: State): string[] => {
      const itemLoadedFields = state
        ? state.itemLoadedFields
        : store.state.itemLoadedFields;
      const loadedFields = itemLoadedFields[itemKey] ?? [];
      return (itemPendingInvalidationFields.get(itemKey) ?? []).filter(
        (field) => !loadedFields.includes(field),
      );
    },
    [itemPendingInvalidationFields, store],
  );

  const getHighestPendingInvalidationPriority = useCallback(
    (
      itemKeys: string[],
      requestedFields: string[] | undefined,
    ): FetchType | undefined => {
      let highestPriority: FetchType | undefined;

      for (const itemKey of itemKeys) {
        const unresolvedInvalidationFields =
          getUnresolvedPendingInvalidationFields(itemKey);
        if (unresolvedInvalidationFields.length === 0) continue;
        if (
          requestedFields &&
          !requestedFields.some((field) =>
            unresolvedInvalidationFields.includes(field),
          )
        ) {
          continue;
        }

        const itemPriority = itemFieldInvalidationPriorities.get(itemKey);
        if (!itemPriority) continue;
        if (
          !highestPriority ||
          fetchTypePriority[itemPriority] > fetchTypePriority[highestPriority]
        ) {
          highestPriority = itemPriority;
        }
      }

      return highestPriority;
    },
    [getUnresolvedPendingInvalidationFields, itemFieldInvalidationPriorities],
  );

  const getVisibleQueryItemKeys = useCallback(
    (queryKey: string, itemKeys: readonly string[]): string[] => {
      const missingOverlayItems = overlayItemsByQueryKey.get(queryKey);
      const hasDeletions = deletedOverlayItemKeys.size > 0;

      if (
        !hasDeletions &&
        (!missingOverlayItems || missingOverlayItems.length === 0)
      ) {
        return [...itemKeys];
      }

      const visibleItemKeys = hasDeletions
        ? itemKeys.filter((itemKey) => !deletedOverlayItemKeys.has(itemKey))
        : [...itemKeys];

      if (!missingOverlayItems || missingOverlayItems.length === 0) {
        return visibleItemKeys;
      }

      const existingItemKeys = new Set(visibleItemKeys);

      for (const { itemKey, index } of missingOverlayItems) {
        if (existingItemKeys.has(itemKey)) continue;

        visibleItemKeys.splice(
          Math.min(index, visibleItemKeys.length),
          0,
          itemKey,
        );
        existingItemKeys.add(itemKey);
      }

      return visibleItemKeys;
    },
    [deletedOverlayItemKeys, overlayItemsByQueryKey],
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
          showPartialAsRefetching,
          queryMetadata,
        }): TSFDUseListQueryReturn<
          SelectedItem,
          QueryPayload,
          QueryMetadata
        > => {
          const query = state.queries[queryKey];
          let loadingFields: string[] | undefined;
          const resultQueryMetadata =
            // WORKAROUND: queryMetadata stays optional on input queries, but the public hook result preserves the caller's QueryMetadata generic.
            __LEGIT_CAST__<QueryMetadata, QueryMetadata | undefined>(
              queryMetadata,
            );

          if (!query) {
            const pendingLoadingFields =
              partialResources &&
              showPartialAsRefetching &&
              Array.isArray(fields) &&
              fields.length > 0 &&
              !returnIdleStatus
                ? fields
                : undefined;

            return {
              queryKey,
              status: returnIdleStatus ? 'idle' : 'loading',
              items: [],
              error: null,
              hasMore: false,
              payload: omitPayload ? undefined : payload,
              fields,
              ...(pendingLoadingFields
                ? { loadingFields: pendingLoadingFields }
                : {}),
              isLoading: !returnIdleStatus,
              isLoadingMore: false,
              pendingSync: false,
              queryMetadata: resultQueryMetadata,
            };
          }

          let status = query.status;
          const visibleItemKeys = getVisibleQueryItemKeys(
            queryKey,
            query.items,
          );
          const hasCachedItemsInState = query.items.some((itemKey) => {
            return state.items[itemKey] != null;
          });

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
            const someItemMissingFieldsInState = query.items.some((itemKey) => {
              const item = state.items[itemKey];
              if (!item || typeof item !== 'object') return true;
              const itemRecord =
                // WORKAROUND: Partial-resource checks need indexed property access, but ItemState is generic and does not expose a string index signature.
                __LEGIT_CAST__<Record<string, unknown>, ItemState>(item);
              return fields.some(
                (f) => !(f in itemRecord) || itemRecord[f] === undefined,
              );
            });

            if (someItemMissingFields) {
              if (!hasCachedItemsInState) {
                status = 'loading';
              } else if (someItemMissingFieldsInState) {
                status = showPartialAsRefetching ? 'refetching' : 'loading';
              } else {
                // Requested fields are present in cached items; keep stale data
                // visible and expose a refetching status while metadata catches up.
                status = 'refetching';
              }
            }
          } else if (
            partialResources &&
            fields === '*' &&
            (status === 'success' || status === 'refetching')
          ) {
            const hasAnyFieldInvalidation = query.items.some((itemKey) => {
              const itemFieldInvalidationFields =
                state.itemFieldInvalidationFields[itemKey];

              return (
                !!itemFieldInvalidationFields &&
                itemFieldInvalidationFields.length > 0
              );
            });

            if (hasAnyFieldInvalidation) {
              status = 'refetching';
            }
          }

          if (partialResources && showPartialAsRefetching) {
            if (Array.isArray(fields) && fields.length > 0) {
              const pendingRequestedFields = fields.filter((field) =>
                status === 'loading' && query.items.length === 0
                  ? true
                  : query.items.some((itemKey) => {
                      const loadedFields =
                        state.itemLoadedFields[itemKey] ?? [];
                      return !loadedFields.includes(field);
                    }),
              );

              if (pendingRequestedFields.length > 0) {
                loadingFields = pendingRequestedFields;
              }
            } else if (fields === '*') {
              const pendingInvalidationFields = Array.from(
                new Set(
                  query.items.flatMap(
                    (itemKey) =>
                      state.itemFieldInvalidationFields[itemKey] ?? [],
                  ),
                ),
              ).sort();

              if (pendingInvalidationFields.length > 0) {
                loadingFields = pendingInvalidationFields;
              }
            }
          }

          if (!returnRefetchingStatus && status === 'refetching') {
            status = 'success';
          }

          const shouldHideItemsWhileLoading =
            status === 'loading' && partialResources;

          return {
            queryKey,
            status,
            items: shouldHideItemsWhileLoading
              ? []
              : selectVisibleItems(visibleItemKeys, fields, (itemKey) => ({
                  item: state.items[itemKey],
                  itemPayload: state.itemQueries[itemKey]?.payload,
                })),
            error: query.error,
            hasMore: query.hasMore,
            ...(loadingFields ? { loadingFields } : {}),
            isLoading: status === 'loading',
            payload: omitPayload ? undefined : query.payload,
            fields,
            isLoadingMore: status === 'loadingMore',
            pendingSync: getOfflineEntitiesMetadata(
              offlineEntitiesByKey,
              visibleItemKeys,
            ).pendingSync,
            queryMetadata: resultQueryMetadata,
          };
        },
      );
    },
    [
      getVisibleQueryItemKeys,
      offlineEntitiesByKey,
      partialResources,
      queriesWithId,
      selectVisibleItems,
    ],
  );

  const storeState = store.useSelectorRC(resultSelector, {
    equalityFn: deepEqual,
  });
  const visibleStoreState = useMemo(() => {
    return storeState.map(
      (
        result,
        index,
      ): TSFDUseListQueryReturn<SelectedItem, QueryPayload, QueryMetadata> => {
        const queryConfig = queriesWithId[index];
        if (result.status !== 'loading' && result.status !== 'idle') {
          return result;
        }

        if (queryConfig && readFallbackQueryState) {
          const fallbackQuery = readFallbackQueryState(queryConfig.key);

          if (fallbackQuery && readFallbackItemState) {
            const visibleItemKeys = getVisibleQueryItemKeys(
              result.queryKey,
              fallbackQuery.items,
            );
            const requestedFields = Array.isArray(queryConfig.fields)
              ? queryConfig.fields
              : undefined;
            const fallbackItemStates = visibleItemKeys.map((itemKey) => ({
              itemKey,
              fallbackItemState: readFallbackItemState(itemKey),
            }));
            const canUseFallbackItems =
              !partialResources ||
              queryConfig.fields === undefined ||
              queryConfig.fields === '*' ||
              (requestedFields &&
                fallbackItemStates.every(({ fallbackItemState }) => {
                  return fallbackItemHasRequestedFields(
                    fallbackItemState,
                    requestedFields,
                  );
                }));

            if (!canUseFallbackItems) return result;

            const fallbackItemStatesByKey = new Map(
              fallbackItemStates.map(({ itemKey, fallbackItemState }) => [
                itemKey,
                fallbackItemState,
              ]),
            );
            const fallbackItems = selectVisibleItems(
              visibleItemKeys,
              queryConfig.fields,
              (itemKey) => {
                const fallbackItemState = fallbackItemStatesByKey.get(itemKey);

                return {
                  item: fallbackItemState?.item,
                  itemPayload: fallbackItemState?.itemQuery?.payload,
                };
              },
            );

            return {
              queryKey: result.queryKey,
              status: 'success',
              items: fallbackItems,
              error: null,
              hasMore: fallbackQuery.hasMore,
              payload: queryConfig.omitPayload
                ? undefined
                : fallbackQuery.payload,
              fields: queryConfig.fields,
              isLoading: false,
              isLoadingMore: false,
              pendingSync: getOfflineEntitiesMetadata(
                offlineEntitiesByKey,
                visibleItemKeys,
              ).pendingSync,
              queryMetadata: result.queryMetadata,
            };
          }
        }

        return result;
      },
    );
  }, [
    storeState,
    queriesWithId,
    readFallbackQueryState,
    readFallbackItemState,
    partialResources,
    getVisibleQueryItemKeys,
    offlineEntitiesByKey,
    selectVisibleItems,
  ]);
  const autoFetchSignals = store.useSelectorRC(
    useCallback(
      (state: State) => {
        if (!partialResources) return [];

        return queriesWithId.map(({ key, fields }) => {
          const query = state.queries[key];
          if (!query) {
            return {
              status: null,
              refetchOnMount: null,
              missingRequestedFieldsKey: '',
              unresolvedInvalidationFieldsKey: '',
              pendingInvalidationPriority: null,
            };
          }

          const unresolvedFields = Array.from(
            new Set(
              query.items.flatMap((itemKey) =>
                getUnresolvedPendingInvalidationFields(itemKey, state),
              ),
            ),
          ).sort();

          const missingRequestedFields =
            Array.isArray(fields) && fields.length > 0
              ? query.items
                  .flatMap((itemKey) => {
                    const loadedFields = state.itemLoadedFields[itemKey] ?? [];
                    return fields.filter(
                      (field) => !loadedFields.includes(field),
                    );
                  })
                  .filter(
                    (field, index, array) => array.indexOf(field) === index,
                  )
                  .sort()
              : [];

          let unresolvedInvalidationFieldsKey = '';
          if (fields === '*') {
            unresolvedInvalidationFieldsKey = JSON.stringify(unresolvedFields);
          } else if (Array.isArray(fields) && fields.length > 0) {
            unresolvedInvalidationFieldsKey = JSON.stringify(
              unresolvedFields.filter((field) => fields.includes(field)),
            );
          }

          const pendingInvalidationPriority =
            fields === '*'
              ? getHighestPendingInvalidationPriority(query.items, undefined)
              : Array.isArray(fields) && fields.length > 0
                ? getHighestPendingInvalidationPriority(query.items, fields)
                : undefined;

          return {
            status: query.status,
            refetchOnMount: query.refetchOnMount,
            missingRequestedFieldsKey: JSON.stringify(missingRequestedFields),
            unresolvedInvalidationFieldsKey,
            pendingInvalidationPriority: pendingInvalidationPriority ?? null,
          };
        });
      },
      [
        getHighestPendingInvalidationPriority,
        getUnresolvedPendingInvalidationFields,
        partialResources,
        queriesWithId,
      ],
    ),
    { equalityFn: deepEqual },
  );

  useOnEvtmitterEvent(events, 'invalidateQuery', ({ payload: event }) => {
    for (const {
      key,
      payload,
      fields,
      isOffScreen,
      disableRefetches,
    } of fetchQueriesWithId) {
      if (isOffScreen) continue;

      if (key !== event.queryKey) continue;

      if (disableRefetches && store.state.queries[key]?.wasLoaded) continue;

      if (!queryInvalidationWasTriggered.has(key)) {
        store.produceState((draft) => {
          const query = draft.queries[key];
          if (!query?.refetchOnMount) return;

          query.refetchOnMount = false;
        });

        scheduleAutomaticListQueryFetch(event.priority, payload, undefined, {
          fields,
        });
        queryInvalidationWasTriggered.add(key);
      }
    }
  });

  const ignoreQueriesInRefetchOnMount = useConst(() => new Set<string>());

  useRegisterActiveKeys(activeQueryKeys, registerActiveQueries, touchQueries);

  useIsomorphicLayoutEffect(() => {
    if (
      !preloadQueriesBeforePaint ||
      !preloadQueries ||
      fetchQueriesWithId.length < 1
    ) {
      return;
    }

    void preloadQueries(fetchQueriesWithId.map(({ payload }) => payload));
  }, [fetchQueriesWithId, preloadQueries, preloadQueriesBeforePaint]);

  useEffect(() => {
    const effectState = { cancelled: false };

    void (async () => {
      if (
        !preloadQueriesBeforePaint &&
        preloadQueries &&
        fetchQueriesWithId.length > 0
      ) {
        await preloadQueries(fetchQueriesWithId.map(({ payload }) => payload));
        if (effectState.cancelled) return;
      }

      const removedQueries = new Set(ignoreQueriesInRefetchOnMount);

      for (const {
        key: queryId,
        payload,
        fields,
        isOffScreen,
        loadSize,
        disableRefetches,
        disableRefetchOnMount,
      } of fetchQueriesWithId) {
        removedQueries.delete(queryId);

        if (isOffScreen) continue;

        const queryState = getQueryState(payload);
        let fetchType = queryState?.refetchOnMount || 'lowPriority';
        let fieldsToFetch = fields;
        let requiredFetch = queryState === undefined || !queryState.wasLoaded;

        let shouldFetch = requiredFetch || !!queryState?.refetchOnMount;

        // For partial resources, refetch when the requested field set changes
        // or when a full-resource hook is affected by field invalidation.
        if (partialResources && !shouldFetch && queryState) {
          const isQueryFetchInFlight =
            queryState.status === 'loading' ||
            queryState.status === 'refetching' ||
            queryState.status === 'loadingMore';

          if (Array.isArray(fields) && fields.length > 0) {
            const hasMissingRequestedFields = queryState.items.some(
              (itemKey) => {
                const loadedFields =
                  store.state.itemLoadedFields[itemKey] ?? [];
                return fields.some((field) => !loadedFields.includes(field));
              },
            );

            if (hasMissingRequestedFields && !isQueryFetchInFlight) {
              shouldFetch = true;
              requiredFetch = true;
              fieldsToFetch = fields;
              // Low-priority follow-ups can be skipped while scheduler phase is still fetching.
              // Keep stronger priorities intact; only lift low priority.
              if (fetchType === 'lowPriority') {
                fetchType = 'highPriority';
              }
            }

            const hasAffectedFieldInvalidation = queryState.items.some(
              (itemKey) => {
                const itemFieldInvalidationFields =
                  getUnresolvedPendingInvalidationFields(itemKey);

                return (
                  itemFieldInvalidationFields.length > 0 &&
                  fields.some((f) => itemFieldInvalidationFields.includes(f))
                );
              },
            );

            if (hasAffectedFieldInvalidation && !isQueryFetchInFlight) {
              shouldFetch = true;
              requiredFetch = true;
              fieldsToFetch = fields;

              const invalidationPriority =
                getHighestPendingInvalidationPriority(queryState.items, fields);

              if (
                invalidationPriority &&
                fetchTypePriority[invalidationPriority] >
                  fetchTypePriority[fetchType]
              ) {
                fetchType = invalidationPriority;
              }
            }
          } else if (fields === '*') {
            const hasAnyFieldInvalidation = queryState.items.some((itemKey) => {
              return getUnresolvedPendingInvalidationFields(itemKey).length > 0;
            });

            if (hasAnyFieldInvalidation && !isQueryFetchInFlight) {
              shouldFetch = true;
              requiredFetch = true;

              const invalidationPriority =
                getHighestPendingInvalidationPriority(
                  queryState.items,
                  undefined,
                );

              if (
                invalidationPriority &&
                fetchTypePriority[invalidationPriority] >
                  fetchTypePriority[fetchType]
              ) {
                fetchType = invalidationPriority;
              }
            }
          }
        }

        if (!shouldFetch && ignoreQueriesInRefetchOnMount.has(queryId)) {
          continue;
        }

        ignoreQueriesInRefetchOnMount.add(queryId);

        if (
          shouldScheduleAutomaticFetch({
            wasLoaded: queryState?.wasLoaded,
            shouldFetch,
            requiredFetch,
            disableRefetches,
            disableRefetchOnMount,
            refetchOnMount: queryState?.refetchOnMount ?? false,
            skipFreshFetch: !!partialResources,
          })
        ) {
          scheduleAutomaticListQueryFetch(fetchType, payload, loadSize, {
            fields: fieldsToFetch,
          });
        }
      }

      for (const queryId of removedQueries) {
        ignoreQueriesInRefetchOnMount.delete(queryId);
      }
    })();
    return () => {
      effectState.cancelled = true;
    };
  }, [
    getQueryState,
    ignoreQueriesInRefetchOnMount,
    preloadQueries,
    preloadQueriesBeforePaint,
    fetchQueriesWithId,
    store,
    scheduleAutomaticListQueryFetch,
    partialResources,
    autoFetchSignals,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    getHighestPendingInvalidationPriority,
    getUnresolvedPendingInvalidationFields,
  ]);

  return visibleStoreState;
}
