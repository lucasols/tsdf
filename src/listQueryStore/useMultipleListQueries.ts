import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useDebouncedValue } from '@ls-stack/react-utils/useDebouncedValue';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { type Emitter } from 'evtmitter';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
} from 'react';
import { Store } from 't-state';

import { useRegisterActiveKeys } from '../cacheLimits/useRegisterActiveKeys';
import { IsOffScreenContext } from '../isOffScreenContext';
import {
  createOfflineEntityLookup,
  filterActiveOfflineOverlays,
  hasPendingOfflineSync,
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
import {
  excludeLoadedFields,
  fallbackItemHasRequestedFields,
} from './itemFieldUtils';
import type { ListQueryStoreEvents } from './listQueryStore';
import {
  type DerivedQueryContext,
  type DerivedQueriesConfig,
  type FieldsInput,
  type ListQueryOfflineOverlay,
  type ListQueryUseMultipleListQueriesQuery,
  type PartialResourcesConfig,
  type TSDFItemQuery,
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
  preloadDerivedQueryItems:
    | ((payloads: QueryPayload[]) => Promise<boolean[]>)
    | undefined,
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
  derivedQueries:
    | DerivedQueriesConfig<ItemState, QueryPayload, ItemPayload>
    | undefined,
  isOfflineMode: boolean,
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

  type ResolvedEffectiveQuery = {
    query: TSFDListQuery<QueryPayload>;
    isDerived: boolean;
  } | null;

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

  const stickyDerivedQueryKeys = useConst(() => new Set<string>());

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
      return excludeLoadedFields(
        itemLoadedFields[itemKey],
        itemPendingInvalidationFields.get(itemKey),
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
    (queryKey: string, itemKeys: readonly string[]): readonly string[] => {
      const missingOverlayItems = overlayItemsByQueryKey.get(queryKey);
      const hasDeletions = deletedOverlayItemKeys.size > 0;

      if (
        !hasDeletions &&
        (!missingOverlayItems || missingOverlayItems.length === 0)
      ) {
        return itemKeys;
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

  const getDerivedGroupItems = useCallback(
    (state: State, groupKey: string) => {
      if (!derivedQueries) return [];

      const itemsByKey = new Map<string, ItemState>();

      for (const itemKey of Object.keys(state.items)) {
        const overlay = activeOfflineOverlays[itemKey];
        if (overlay?.item === null) continue;

        const item =
          overlay?.item !== undefined ? overlay.item : state.items[itemKey];
        const itemPayload =
          overlay?.itemPayload ?? state.itemQueries[itemKey]?.payload;

        if (item == null || itemPayload === undefined) continue;
        if (derivedQueries.getItemGroup(item, itemPayload) !== groupKey) {
          continue;
        }

        itemsByKey.set(itemKey, item);
      }

      for (const [itemKey, overlay] of Object.entries(activeOfflineOverlays)) {
        if (Object.hasOwn(state.items, itemKey)) continue;
        if (overlay.item == null || overlay.itemPayload === undefined) continue;
        if (
          derivedQueries.getItemGroup(overlay.item, overlay.itemPayload) !==
          groupKey
        ) {
          continue;
        }

        itemsByKey.set(itemKey, overlay.item);
      }

      return Array.from(itemsByKey, ([key, data]) => ({ key, data }));
    },
    [activeOfflineOverlays, derivedQueries],
  );

  const resolveEffectiveQuery = useCallback(
    (
      state: State,
      queryConfig: {
        key: string;
        payload: QueryPayload;
        fields: FieldsInput | undefined;
      },
    ): ResolvedEffectiveQuery => {
      const exactQuery = state.queries[queryConfig.key];
      const stickyDerived = stickyDerivedQueryKeys.has(queryConfig.key);

      if (!derivedQueries) {
        return exactQuery ? { query: exactQuery, isDerived: false } : null;
      }

      const shouldAttemptDerived =
        isOfflineMode || stickyDerived || exactQuery === undefined;

      if (!shouldAttemptDerived) {
        return { query: exactQuery, isDerived: false };
      }

      const groupKey = derivedQueries.getQueryGroup(queryConfig.payload);

      if (!isOfflineMode && !stickyDerived) {
        const groupQueries = Object.values(state.queries)
          .filter(
            (query) => derivedQueries.getQueryGroup(query.payload) === groupKey,
          )
          .map((query) => ({
            payload: query.payload,
            hasMore: query.hasMore,
            itemCount: query.items.length,
          }));

        if (
          !derivedQueries.isComplete(queryConfig.payload, {
            queries: groupQueries,
          })
        ) {
          return exactQuery ? { query: exactQuery, isDerived: false } : null;
        }
      }

      const derivedItems = getDerivedGroupItems(state, groupKey);
      const deriveQueryContext: DerivedQueryContext = {
        fields: queryConfig.fields,
        isOfflineMode,
        deriveSource: isOfflineMode
          ? 'offline'
          : stickyDerived
            ? 'sticky-offline'
            : 'online',
      };
      const derivedItemKeys = derivedQueries.deriveQuery(
        queryConfig.payload,
        derivedItems,
        deriveQueryContext,
      );

      if (derivedItemKeys !== false) {
        if (derivedItems.length === 0 && derivedItemKeys.length === 0) {
          return exactQuery ? { query: exactQuery, isDerived: false } : null;
        }

        return {
          isDerived: true,
          query: {
            error: null,
            hasMore: false,
            items: derivedItemKeys,
            payload: queryConfig.payload,
            refetchOnMount: false,
            status: 'success',
            wasLoaded: true,
          },
        };
      }

      return exactQuery ? { query: exactQuery, isDerived: false } : null;
    },
    [
      derivedQueries,
      getDerivedGroupItems,
      isOfflineMode,
      stickyDerivedQueryKeys,
    ],
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
          const effectiveQuery = resolveEffectiveQuery(state, {
            key: queryKey,
            payload,
            fields,
          });
          let loadingFields: string[] | undefined;
          const resultQueryMetadata =
            // WORKAROUND: queryMetadata stays optional on input queries, but the public hook result preserves the caller's QueryMetadata generic.
            __LEGIT_CAST__<QueryMetadata, QueryMetadata | undefined>(
              queryMetadata,
            );

          if (!effectiveQuery) {
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
              isDerived: false,
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

          let status = effectiveQuery.query.status;
          const visibleItemKeys = getVisibleQueryItemKeys(
            queryKey,
            effectiveQuery.query.items,
          );
          const hasCachedItemsInState = effectiveQuery.query.items.some(
            (itemKey) => {
              return state.items[itemKey] != null;
            },
          );

          // Override status when partial resources has items with missing fields
          if (
            partialResources &&
            Array.isArray(fields) &&
            fields.length > 0 &&
            (status === 'success' || status === 'refetching')
          ) {
            const someItemMissingFields = effectiveQuery.query.items.some(
              (itemKey) => {
                const loadedFields = state.itemLoadedFields[itemKey] ?? [];
                return fields.some((f) => !loadedFields.includes(f));
              },
            );
            const someItemMissingFieldsInState =
              effectiveQuery.query.items.some((itemKey) => {
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
            const hasAnyFieldInvalidation = effectiveQuery.query.items.some(
              (itemKey) => {
                const itemFieldInvalidationFields =
                  state.itemFieldInvalidationFields[itemKey];

                return (
                  !!itemFieldInvalidationFields &&
                  itemFieldInvalidationFields.length > 0
                );
              },
            );

            if (hasAnyFieldInvalidation) {
              status = 'refetching';
            }
          }

          if (partialResources && showPartialAsRefetching) {
            if (Array.isArray(fields) && fields.length > 0) {
              const pendingRequestedFields = fields.filter((field) =>
                status === 'loading' && effectiveQuery.query.items.length === 0
                  ? true
                  : effectiveQuery.query.items.some((itemKey) => {
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
                  effectiveQuery.query.items.flatMap(
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
            error: effectiveQuery.query.error,
            hasMore: effectiveQuery.query.hasMore,
            isDerived: effectiveQuery.isDerived,
            ...(loadingFields ? { loadingFields } : {}),
            isLoading: status === 'loading',
            payload: omitPayload ? undefined : effectiveQuery.query.payload,
            fields,
            isLoadingMore: status === 'loadingMore',
            pendingSync: hasPendingOfflineSync(
              offlineEntitiesByKey,
              visibleItemKeys,
            ),
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
      resolveEffectiveQuery,
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

        if (
          queryConfig &&
          readFallbackQueryState &&
          !(
            derivedQueries &&
            (isOfflineMode || stickyDerivedQueryKeys.has(queryConfig.key))
          )
        ) {
          const fallbackQuery = readFallbackQueryState(queryConfig.key);

          if (fallbackQuery && readFallbackItemState) {
            const visibleItemKeys = getVisibleQueryItemKeys(
              result.queryKey,
              fallbackQuery.items,
            );
            const requestedFields = Array.isArray(queryConfig.fields)
              ? queryConfig.fields
              : undefined;
            const fallbackItemStatesByKey = new Map<
              string,
              ReturnType<NonNullable<typeof readFallbackItemState>>
            >();

            for (const itemKey of visibleItemKeys) {
              const fallbackItemState = readFallbackItemState(itemKey);
              fallbackItemStatesByKey.set(itemKey, fallbackItemState);

              if (
                requestedFields &&
                partialResources &&
                !fallbackItemHasRequestedFields(
                  fallbackItemState,
                  requestedFields,
                )
              ) {
                return result;
              }
            }
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
              isDerived: false,
              payload: queryConfig.omitPayload
                ? undefined
                : fallbackQuery.payload,
              fields: queryConfig.fields,
              isLoading: false,
              isLoadingMore: false,
              pendingSync: hasPendingOfflineSync(
                offlineEntitiesByKey,
                visibleItemKeys,
              ),
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
    derivedQueries,
    getVisibleQueryItemKeys,
    isOfflineMode,
    offlineEntitiesByKey,
    selectVisibleItems,
    stickyDerivedQueryKeys,
  ]);
  const autoFetchSignals = store.useSelectorRC(
    useCallback(
      (state: State) => {
        if (!partialResources) return [];

        return queriesWithId.map((queryConfig) => {
          const effectiveQuery = resolveEffectiveQuery(state, queryConfig);
          const query = state.queries[queryConfig.key];

          if (!effectiveQuery) {
            return {
              isDerived: false,
              pendingInvalidationPriority: null,
              queryItemKeys: new Array<string>(),
              refetchOnMount: null,
              status: null,
              missingRequestedFieldsKey: '',
              unresolvedInvalidationFieldsKey: '',
            };
          }

          const unresolvedFields = Array.from(
            new Set(
              effectiveQuery.query.items.flatMap((itemKey) =>
                getUnresolvedPendingInvalidationFields(itemKey, state),
              ),
            ),
          ).sort();
          const requestedFields = Array.isArray(queryConfig.fields)
            ? queryConfig.fields
            : undefined;

          const missingRequestedFields =
            requestedFields && requestedFields.length > 0
              ? effectiveQuery.query.items
                  .flatMap((itemKey) => {
                    return excludeLoadedFields(
                      state.itemLoadedFields[itemKey],
                      requestedFields,
                    );
                  })
                  .filter(
                    (field, index, array) => array.indexOf(field) === index,
                  )
                  .sort()
              : [];

          let unresolvedInvalidationFieldsKey = '';
          if (queryConfig.fields === '*') {
            unresolvedInvalidationFieldsKey = JSON.stringify(unresolvedFields);
          } else if (
            Array.isArray(queryConfig.fields) &&
            queryConfig.fields.length > 0
          ) {
            unresolvedInvalidationFieldsKey = JSON.stringify(
              unresolvedFields.filter((field) =>
                queryConfig.fields?.includes(field),
              ),
            );
          }

          const pendingInvalidationPriority =
            queryConfig.fields === '*'
              ? getHighestPendingInvalidationPriority(
                  effectiveQuery.query.items,
                  undefined,
                )
              : Array.isArray(queryConfig.fields) &&
                  queryConfig.fields.length > 0
                ? getHighestPendingInvalidationPriority(
                    effectiveQuery.query.items,
                    queryConfig.fields,
                  )
                : undefined;

          return {
            isDerived: effectiveQuery.isDerived,
            status: effectiveQuery.query.status,
            refetchOnMount: query?.refetchOnMount ?? null,
            queryItemKeys: effectiveQuery.query.items,
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
        resolveEffectiveQuery,
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

      const resolvedQuery = resolveEffectiveQuery(store.state, {
        key,
        payload,
        fields,
      });
      if (disableRefetches && resolvedQuery?.query.wasLoaded) continue;

      if (!queryInvalidationWasTriggered.has(key)) {
        stickyDerivedQueryKeys.delete(key);
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

  useLayoutEffect(() => {
    if (!preloadQueriesBeforePaint || fetchQueriesWithId.length < 1) {
      return;
    }

    const payloads = fetchQueriesWithId.map(
      (query): QueryPayload => query.payload,
    );
    if (preloadQueries) {
      void preloadQueries(payloads);
    }
    if (derivedQueries && isOfflineMode && preloadDerivedQueryItems) {
      void preloadDerivedQueryItems(payloads);
    }
  }, [
    derivedQueries,
    fetchQueriesWithId,
    isOfflineMode,
    preloadDerivedQueryItems,
    preloadQueries,
    preloadQueriesBeforePaint,
  ]);

  useEffect(() => {
    const effectState = { cancelled: false };

    void (async () => {
      const shouldPreloadQueries =
        !preloadQueriesBeforePaint &&
        fetchQueriesWithId.length > 0 &&
        !!(
          preloadQueries ||
          (derivedQueries && isOfflineMode && preloadDerivedQueryItems)
        );

      if (shouldPreloadQueries) {
        const payloads = fetchQueriesWithId.map(
          (query): QueryPayload => query.payload,
        );
        await Promise.all([
          preloadQueries ? preloadQueries(payloads) : Promise.resolve([]),
          derivedQueries && isOfflineMode && preloadDerivedQueryItems
            ? preloadDerivedQueryItems(payloads)
            : Promise.resolve([]),
        ]);
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
        const effectiveQuery = resolveEffectiveQuery(store.state, {
          key: queryId,
          payload,
          fields,
        });
        const effectiveQueryState = effectiveQuery?.query;
        let fetchType = queryState?.refetchOnMount || 'lowPriority';
        let fieldsToFetch = fields;
        let requiredFetch =
          effectiveQueryState === undefined || !effectiveQueryState.wasLoaded;

        let shouldFetch = requiredFetch || !!queryState?.refetchOnMount;

        if (effectiveQuery?.isDerived) {
          requiredFetch = false;
          shouldFetch = !!queryState?.refetchOnMount;
        }

        // For partial resources, refetch when the requested field set changes
        // or when a full-resource hook is affected by field invalidation.
        if (partialResources && !shouldFetch && effectiveQueryState) {
          const isQueryFetchInFlight =
            effectiveQueryState.status === 'loading' ||
            effectiveQueryState.status === 'refetching' ||
            effectiveQueryState.status === 'loadingMore';

          if (Array.isArray(fields) && fields.length > 0) {
            const hasMissingRequestedFields = effectiveQueryState.items.some(
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

            const hasAffectedFieldInvalidation = effectiveQueryState.items.some(
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
                getHighestPendingInvalidationPriority(
                  effectiveQueryState.items,
                  fields,
                );

              if (
                invalidationPriority &&
                fetchTypePriority[invalidationPriority] >
                  fetchTypePriority[fetchType]
              ) {
                fetchType = invalidationPriority;
              }
            }
          } else if (fields === '*') {
            const hasAnyFieldInvalidation = effectiveQueryState.items.some(
              (itemKey) => {
                return (
                  getUnresolvedPendingInvalidationFields(itemKey).length > 0
                );
              },
            );

            if (hasAnyFieldInvalidation && !isQueryFetchInFlight) {
              shouldFetch = true;
              requiredFetch = true;

              const invalidationPriority =
                getHighestPendingInvalidationPriority(
                  effectiveQueryState.items,
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
            wasLoaded: effectiveQueryState?.wasLoaded,
            shouldFetch,
            requiredFetch,
            disableRefetches,
            disableRefetchOnMount,
            refetchOnMount: queryState?.refetchOnMount ?? false,
            skipFreshFetch: !!partialResources,
          })
        ) {
          stickyDerivedQueryKeys.delete(queryId);
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
    derivedQueries,
    isOfflineMode,
    preloadDerivedQueryItems,
    preloadQueries,
    preloadQueriesBeforePaint,
    fetchQueriesWithId,
    resolveEffectiveQuery,
    store,
    scheduleAutomaticListQueryFetch,
    partialResources,
    autoFetchSignals,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    getHighestPendingInvalidationPriority,
    getUnresolvedPendingInvalidationFields,
    stickyDerivedQueryKeys,
  ]);

  useEffect(() => {
    for (const queryConfig of queriesWithId) {
      const resolved = resolveEffectiveQuery(store.state, queryConfig);

      if (resolved?.isDerived && isOfflineMode) {
        stickyDerivedQueryKeys.add(queryConfig.key);
        continue;
      }

      if (resolved?.isDerived) continue;

      if (store.state.queries[queryConfig.key]?.status === 'success') {
        stickyDerivedQueryKeys.delete(queryConfig.key);
      }
    }
  }, [
    isOfflineMode,
    queriesWithId,
    resolveEffectiveQuery,
    stickyDerivedQueryKeys,
    store,
  ]);

  return visibleStoreState;
}
