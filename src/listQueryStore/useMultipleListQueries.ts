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
import {
  createFieldsResourceSignature,
  observeAutomaticFetchStatus,
  shouldScheduleAutomaticFetch,
  tryClaimAutomaticFetchSlot,
  type AutomaticFetchRetryState,
} from '../utils/automaticFetchPolicy';
import {
  getPayloadDebounceOptions,
  shouldDebouncePayload,
} from '../utils/payloadDebounce';
import {
  fetchTypePriority,
  higherFetchType,
  isStrictItemKeyPrefix,
  type PayloadDebounce,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import {
  excludeLoadedFields,
  fallbackItemHasRequestedFields,
  getGenuinelyMissingRequestedFields,
  getPendingInvalidationPriorityOfFields,
  getStaleOrMissingRequestedFields,
  hasFullyLoadedFields,
  snapshotIsFullyLoaded,
  snapshotIsFullyLoadedAndFresh,
} from './itemFieldUtils';
import type { ListQueryStoreEvents } from './listQueryStore';
import {
  type DerivedQueryContext,
  type DerivedQueriesConfig,
  type FieldsInput,
  type ItemLoadedFields,
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
  /** Maps each query item before it is returned from the hook. */
  itemSelector?: (
    data: ItemState,
    itemPayload: ItemPayload,
    itemKey: string,
  ) => SelectedItem;
  /** Returns `idle` instead of `loading` while queries have not been fetched. */
  returnIdleStatus?: boolean;
  /** Returns `refetching` instead of keeping `loaded` status during refetches. */
  returnRefetchingStatus?: boolean;
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
  /** Omits `payload` from each query result unless overridden per query. */
  omitPayload?: boolean;
  /**
   * Only fetches when a query is missing from state, skipping stale-state and
   * invalidation refetches.
   */
  disableRefetches?: boolean;
  /** Prevents automatic mount refetches for stale loaded data. */
  disableRefetchOnMount?: boolean;
  /** Marks these subscriptions as off-screen, lowering automatic fetch priority. */
  isOffScreen?: boolean;
  /** Number of items to request when fetching each query page. */
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
            loadedFields: ItemLoadedFields | undefined;
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
  itemPendingInvalidationFields: Map<string, Map<string, FetchType | null>>,
  itemsPendingFullInvalidation: Map<string, FetchType>,
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
    retrySignature: string;
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
    return queries.map((queryProps) => {
      const key = getQueryKey(queryProps.payload);
      const loadSize = queryProps.loadSize ?? allItemsLoadSize;
      return {
        key,
        payload: queryProps.payload,
        fields: queryProps.fields,
        retrySignature: `${key}|${createFieldsResourceSignature(queryProps.fields)}|${loadSize ?? ''}`,
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
          queryProps.isOffScreen ??
          allItemsIsOffScreen ??
          isOffScreenFromContext,
        loadSize,
        queryMetadata: queryProps.queryMetadata,
      };
    });
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
  const getDerivedPreloadPayloads = useCallback(
    (queryConfigs: QueryWithId[]): QueryPayload[] => {
      if (!derivedQueries || !isOfflineMode || !preloadDerivedQueryItems) {
        return [];
      }

      return queryConfigs.flatMap((queryConfig) => {
        if (getQueryState(queryConfig.payload) !== undefined) {
          return [];
        }

        return readFallbackQueryState?.(queryConfig.key) === undefined
          ? [queryConfig.payload]
          : [];
      });
    },
    [
      derivedQueries,
      getQueryState,
      isOfflineMode,
      preloadDerivedQueryItems,
      readFallbackQueryState,
    ],
  );

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
      const itemFieldInvalidationFields = state
        ? state.itemFieldInvalidationFields
        : store.state.itemFieldInvalidationFields;
      const stateInvalidationFields = itemFieldInvalidationFields[itemKey];
      if (stateInvalidationFields && stateInvalidationFields.length > 0) {
        return stateInvalidationFields;
      }

      const itemLoadedFields = state
        ? state.itemLoadedFields
        : store.state.itemLoadedFields;
      const pendingFields = itemPendingInvalidationFields.get(itemKey);
      return excludeLoadedFields(
        itemLoadedFields[itemKey],
        pendingFields && Array.from(pendingFields.keys()),
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
        const loadedFields = store.state.itemLoadedFields[itemKey];
        // Adopt only the priorities owed to the fields this hook actually
        // requests — a leftover obligation on an undisplayed field must not
        // escalate this hook's refetch. Fields without a tracked priority
        // (e.g. adopted from another tab) contribute nothing; callers treat
        // an undefined result as an immediate refetch. A fully invalidated
        // ('*'-loaded) item has no field list to enumerate — the pending-full
        // marker alone proves every not-yet-reloaded field (requested ones
        // included) is awaiting the re-fetch.
        const itemPriority = getPendingInvalidationPriorityOfFields(
          requestedFields,
          loadedFields,
          getUnresolvedPendingInvalidationFields(itemKey),
          itemPendingInvalidationFields.get(itemKey),
          loadedFields === '*'
            ? undefined
            : itemsPendingFullInvalidation.get(itemKey),
        );
        if (itemPriority) {
          highestPriority = higherFetchType(highestPriority, itemPriority);
        }
      }

      return highestPriority;
    },
    [
      getUnresolvedPendingInvalidationFields,
      itemPendingInvalidationFields,
      itemsPendingFullInvalidation,
      store,
    ],
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

          // Partial-resource bookkeeping shared by the status override and the
          // `loadingFields` computation below — computed at most once per query.
          let staleOrMissingRequestedFields: Set<string> | undefined;
          let hasAnyIncompleteItem = false;
          let hasAnyStaleItem = false;
          const statusCanBeOverridden =
            status === 'success' || status === 'refetching';

          if (
            partialResources &&
            (statusCanBeOverridden || showPartialAsRefetching)
          ) {
            if (Array.isArray(fields) && fields.length > 0) {
              // Union of stale-or-missing requested fields across the query's
              // items.
              staleOrMissingRequestedFields = new Set();

              for (const itemKey of effectiveQuery.query.items) {
                for (const field of getStaleOrMissingRequestedFields(
                  itemKey,
                  state.itemLoadedFields[itemKey],
                  state.items[itemKey],
                  fields,
                  partialResources.inferFields,
                  itemsPendingFullInvalidation,
                  getUnresolvedPendingInvalidationFields(itemKey, state),
                )) {
                  staleOrMissingRequestedFields.add(field);
                }

                // Stop scanning once no further field could be added — or on
                // the first hit when the per-field breakdown is not needed.
                if (
                  staleOrMissingRequestedFields.size === fields.length ||
                  (!showPartialAsRefetching &&
                    staleOrMissingRequestedFields.size > 0)
                ) {
                  break;
                }
              }
            } else if (fields === '*') {
              // "Data absent" (incomplete snapshot) is different from
              // "complete but stale" (e.g. after a full item invalidation):
              // only genuinely incomplete items may hide the list behind
              // `loading` — stale but complete items stay visible while they
              // refetch. A full item invalidation resets `loadedFields` to
              // `[]` but leaves the pending-full-invalidation marker, which
              // proves the item data was complete when invalidated (and is
              // still present).
              hasAnyIncompleteItem = effectiveQuery.query.items.some(
                (itemKey) => {
                  const item = state.items[itemKey];
                  if (
                    snapshotIsFullyLoaded(
                      state.itemLoadedFields[itemKey],
                      item,
                      partialResources.inferFields,
                    )
                  ) {
                    return false;
                  }

                  return !(
                    itemsPendingFullInvalidation.has(itemKey) && item != null
                  );
                },
              );
              hasAnyStaleItem =
                !hasAnyIncompleteItem &&
                effectiveQuery.query.items.some(
                  (itemKey) =>
                    !snapshotIsFullyLoadedAndFresh(
                      itemKey,
                      state.itemLoadedFields[itemKey],
                      state.items[itemKey],
                      partialResources.inferFields,
                      itemsPendingFullInvalidation,
                    ),
                );
            }
          }

          // Override status when partial resources has items with missing fields
          if (
            partialResources &&
            Array.isArray(fields) &&
            statusCanBeOverridden &&
            staleOrMissingRequestedFields &&
            staleOrMissingRequestedFields.size > 0
          ) {
            // Some item genuinely lacks data for a requested field: not
            // tracked as loaded, not vouched by `inferFields`, and not merely
            // stale (awaiting an invalidation re-fetch — stale-only fields
            // keep cached items visible as `refetching` while the fetch
            // effect reloads them). Fields may be logical names, so raw key
            // presence must not be used here.
            const someItemMissingFieldDataInState =
              effectiveQuery.query.items.some(
                (itemKey) =>
                  getGenuinelyMissingRequestedFields(
                    itemKey,
                    {
                      item: state.items[itemKey],
                      loadedFields: state.itemLoadedFields[itemKey],
                    },
                    fields,
                    partialResources.inferFields,
                    itemsPendingFullInvalidation,
                    getUnresolvedPendingInvalidationFields(itemKey, state),
                  ).length > 0,
              );

            if (!hasCachedItemsInState) {
              status = 'loading';
            } else if (someItemMissingFieldDataInState) {
              status = showPartialAsRefetching ? 'refetching' : 'loading';
            } else {
              // Requested fields are present in cached items; keep stale data
              // visible and expose a refetching status while metadata catches up.
              status = 'refetching';
            }
          } else if (
            partialResources &&
            fields === '*' &&
            statusCanBeOverridden
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

            if (hasAnyIncompleteItem) {
              if (!hasCachedItemsInState) {
                status = 'loading';
              } else {
                status = showPartialAsRefetching ? 'refetching' : 'loading';
              }
            } else if (hasAnyStaleItem || hasAnyFieldInvalidation) {
              status = 'refetching';
            }
          }

          if (partialResources && showPartialAsRefetching) {
            if (Array.isArray(fields) && fields.length > 0) {
              const pendingRequestedFields =
                status === 'loading' && effectiveQuery.query.items.length === 0
                  ? [...fields]
                  : fields.filter(
                      (field) =>
                        staleOrMissingRequestedFields?.has(field) ?? false,
                    );

              if (pendingRequestedFields.length > 0) {
                loadingFields = pendingRequestedFields;
              }
            } else if (fields === '*') {
              const hasAnyPartialItem = hasAnyIncompleteItem || hasAnyStaleItem;
              const pendingInvalidationFields = hasAnyPartialItem
                ? []
                : Array.from(
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
            hasMore: isOfflineMode
              ? !!readFallbackQueryState &&
                effectiveQuery.query.hasMore &&
                isStrictItemKeyPrefix(
                  effectiveQuery.query.items,
                  readFallbackQueryState(queryKey)?.items ?? [],
                )
              : effectiveQuery.query.hasMore,
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
      getUnresolvedPendingInvalidationFields,
      getVisibleQueryItemKeys,
      isOfflineMode,
      itemsPendingFullInvalidation,
      offlineEntitiesByKey,
      partialResources,
      queriesWithId,
      readFallbackQueryState,
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
            const requiresFullItems = queryConfig.fields === '*';
            const fallbackItemStatesByKey = new Map<
              string,
              ReturnType<NonNullable<typeof readFallbackItemState>>
            >();

            for (const itemKey of visibleItemKeys) {
              const fallbackItemState = readFallbackItemState(itemKey);
              fallbackItemStatesByKey.set(itemKey, fallbackItemState);

              if (partialResources) {
                // A '*' query must not present a partial fallback snapshot as a
                // fully-loaded success; require each item to be complete (or
                // reported complete by `inferFields`).
                if (requiresFullItems) {
                  if (
                    !snapshotIsFullyLoaded(
                      fallbackItemState?.loadedFields,
                      fallbackItemState?.item,
                      partialResources.inferFields,
                    )
                  ) {
                    return result;
                  }
                } else if (
                  requestedFields &&
                  !fallbackItemHasRequestedFields(
                    fallbackItemState,
                    requestedFields,
                    partialResources.inferFields,
                  )
                ) {
                  return result;
                }
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
              hasMore: isOfflineMode ? false : fallbackQuery.hasMore,
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
                    return getStaleOrMissingRequestedFields(
                      itemKey,
                      state.itemLoadedFields[itemKey],
                      state.items[itemKey],
                      requestedFields,
                      partialResources.inferFields,
                      itemsPendingFullInvalidation,
                      getUnresolvedPendingInvalidationFields(itemKey, state),
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
        itemsPendingFullInvalidation,
        partialResources,
        queriesWithId,
        resolveEffectiveQuery,
      ],
    ),
    { equalityFn: deepEqual },
  );
  const automaticRetryState = useConst<AutomaticFetchRetryState>(
    () => new Map(),
  );

  useEffect(() => {
    for (const queryConfig of queriesWithId) {
      if (queryConfig.isOffScreen) {
        automaticRetryState.delete(queryConfig.retrySignature);
        continue;
      }

      observeAutomaticFetchStatus(
        automaticRetryState,
        queryConfig.retrySignature,
        resolveEffectiveQuery(store.state, queryConfig)?.query.status,
      );
    }
  }, [
    automaticRetryState,
    queriesWithId,
    resolveEffectiveQuery,
    store,
    visibleStoreState,
  ]);

  // Invalidations that arrived while an instance was off-screen, keyed by
  // query key. The first visible instance handling an `invalidateQuery` event
  // clears the query's shared `refetchOnMount`, so an off-screen instance's
  // obligation must survive per hook instance — the auto-fetch effect
  // consumes it when the instance returns on-screen.
  const pendingOffScreenQueryInvalidations = useConst(
    () => new Map<string, FetchType>(),
  );

  useOnEvtmitterEvent(events, 'invalidateQuery', ({ payload: event }) => {
    for (const {
      key,
      payload,
      fields,
      loadSize,
      isOffScreen,
      disableRefetches,
    } of fetchQueriesWithId) {
      if (key !== event.queryKey) continue;

      const resolvedQuery = resolveEffectiveQuery(store.state, {
        key,
        payload,
        fields,
      });
      if (disableRefetches && resolvedQuery?.query.wasLoaded) continue;

      if (isOffScreen) {
        const existingPriority = pendingOffScreenQueryInvalidations.get(key);
        if (
          !existingPriority ||
          fetchTypePriority[event.priority] >
            fetchTypePriority[existingPriority]
        ) {
          pendingOffScreenQueryInvalidations.set(key, event.priority);
        }
        continue;
      }

      if (!queryInvalidationWasTriggered.has(key)) {
        stickyDerivedQueryKeys.delete(key);
        store.produceState((draft) => {
          const query = draft.queries[key];
          if (!query?.refetchOnMount) return;

          query.refetchOnMount = false;
        });

        queryInvalidationWasTriggered.add(key);
      }

      // Every instance schedules its own fields/loadSize — instances watching
      // the same query with different field subsets each contribute theirs,
      // and the scheduler's coalescing window merges the schedules into a
      // single fetch. Deduping the schedule per query key would drop the
      // other instances' fields, leaving them stale forever.
      scheduleAutomaticListQueryFetch(event.priority, payload, loadSize, {
        fields,
      });
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
    const derivedPreloadPayloads =
      getDerivedPreloadPayloads(fetchQueriesWithId);
    if (derivedPreloadPayloads.length > 0 && preloadDerivedQueryItems) {
      void preloadDerivedQueryItems(derivedPreloadPayloads);
    }
  }, [
    fetchQueriesWithId,
    getDerivedPreloadPayloads,
    preloadDerivedQueryItems,
    preloadQueries,
    preloadQueriesBeforePaint,
  ]);

  useEffect(() => {
    const effectState = { cancelled: false };

    void (async () => {
      const derivedPreloadPayloads =
        getDerivedPreloadPayloads(fetchQueriesWithId);
      const shouldPreloadQueries =
        !preloadQueriesBeforePaint &&
        fetchQueriesWithId.length > 0 &&
        !!(preloadQueries || derivedPreloadPayloads.length > 0);

      if (shouldPreloadQueries) {
        const payloads = fetchQueriesWithId.map(
          (query): QueryPayload => query.payload,
        );
        await Promise.all([
          preloadQueries ? preloadQueries(payloads) : Promise.resolve([]),
          derivedPreloadPayloads.length > 0 && preloadDerivedQueryItems
            ? preloadDerivedQueryItems(derivedPreloadPayloads)
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
        retrySignature,
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
            // Stale fields (previously loaded, owed after an invalidation)
            // and genuinely missing fields (never loaded, not vouched by
            // `inferFields`) both require a fetch, but at different
            // priorities: missing data justifies an immediate required fetch,
            // while stale data must refetch at the tracked invalidation
            // priority so scheduler throttling (e.g. realtime updates) stays
            // effective.
            let hasStaleOrMissingRequestedFields = false;
            let hasGenuinelyMissingFields = false;
            for (const itemKey of effectiveQueryState.items) {
              const unresolvedInvalidationFields =
                getUnresolvedPendingInvalidationFields(itemKey);
              if (
                getStaleOrMissingRequestedFields(
                  itemKey,
                  store.state.itemLoadedFields[itemKey],
                  store.state.items[itemKey],
                  fields,
                  partialResources.inferFields,
                  itemsPendingFullInvalidation,
                  unresolvedInvalidationFields,
                ).length === 0
              ) {
                continue;
              }

              hasStaleOrMissingRequestedFields = true;

              if (
                getGenuinelyMissingRequestedFields(
                  itemKey,
                  {
                    item: store.state.items[itemKey],
                    loadedFields: store.state.itemLoadedFields[itemKey],
                  },
                  fields,
                  partialResources.inferFields,
                  itemsPendingFullInvalidation,
                  unresolvedInvalidationFields,
                ).length > 0
              ) {
                hasGenuinelyMissingFields = true;
                break;
              }
            }

            if (hasStaleOrMissingRequestedFields && !isQueryFetchInFlight) {
              shouldFetch = true;
              requiredFetch = true;
              fieldsToFetch = fields;

              const invalidationPriority = hasGenuinelyMissingFields
                ? undefined
                : getHighestPendingInvalidationPriority(
                    effectiveQueryState.items,
                    fields,
                  );

              if (!invalidationPriority) {
                // Genuinely missing data — or stale fields with no tracked
                // invalidation priority (e.g. invalidations adopted from
                // another tab) — must fetch immediately. Low-priority
                // follow-ups can be skipped while the scheduler phase is
                // still fetching; keep stronger priorities intact, only lift
                // low priority.
                if (fetchType === 'lowPriority') {
                  fetchType = 'highPriority';
                }
              } else if (
                fetchTypePriority[invalidationPriority] >
                fetchTypePriority[fetchType]
              ) {
                fetchType = invalidationPriority;
              }
            }
          } else if (fields === '*') {
            // Genuinely missing data (fields never loaded on some item) and
            // stale-but-displayable data (a full invalidation whose snapshot
            // is still present, or pending field invalidations) both require
            // a fetch, but at different priorities — mirroring the array
            // branch above and the item-side '*' branch: missing data
            // justifies an immediate fetch, while stale-only data must keep
            // the tracked invalidation priority so scheduler throttling
            // (e.g. realtime updates) stays effective.
            let hasStaleItemData = false;
            let hasGenuinelyMissingItemData = false;
            for (const itemKey of effectiveQueryState.items) {
              const item = store.state.items[itemKey];
              const loadedFields = store.state.itemLoadedFields[itemKey];
              // A '*'-loaded item resolved its full invalidation even if the
              // tracking marker hasn't been pruned yet.
              const hasUnresolvedFullInvalidation =
                itemsPendingFullInvalidation.has(itemKey) &&
                !hasFullyLoadedFields(loadedFields);
              // A fully invalidated item whose (now stale) snapshot is still
              // present is a refetch of stale data, not a load of missing
              // data.
              const hasStaleFullInvalidation =
                hasUnresolvedFullInvalidation && !!item;

              if (
                !hasStaleFullInvalidation &&
                (!snapshotIsFullyLoaded(
                  loadedFields,
                  item,
                  partialResources.inferFields,
                ) ||
                  hasUnresolvedFullInvalidation)
              ) {
                hasGenuinelyMissingItemData = true;
                break;
              }

              if (
                hasStaleFullInvalidation ||
                getUnresolvedPendingInvalidationFields(itemKey).length > 0
              ) {
                hasStaleItemData = true;
              }
            }

            if (
              (hasGenuinelyMissingItemData || hasStaleItemData) &&
              !isQueryFetchInFlight
            ) {
              shouldFetch = true;
              requiredFetch = true;

              const invalidationPriority = hasGenuinelyMissingItemData
                ? undefined
                : getHighestPendingInvalidationPriority(
                    effectiveQueryState.items,
                    undefined,
                  );

              if (!invalidationPriority) {
                // Genuinely missing data — or stale data with no tracked
                // invalidation priority (e.g. invalidations adopted from
                // another tab) — must fetch immediately; only lift low
                // priority.
                if (fetchType === 'lowPriority') {
                  fetchType = 'highPriority';
                }
              } else if (
                fetchTypePriority[invalidationPriority] >
                fetchTypePriority[fetchType]
              ) {
                fetchType = invalidationPriority;
              }
            }
          }
        }

        // A fetch owed via `refetchOnMount` inherits the tracked invalidation
        // priority, which the scheduler may delay (e.g. `realtimeUpdate` with
        // `dynamicRealtimeThrottleMs`). Waiting is only acceptable when the
        // requested data is stale-but-displayable — genuinely missing data
        // has nothing to show, so its fetch must run immediately.
        if (queryState?.refetchOnMount && fetchType !== 'highPriority') {
          let hasMissingRequestedData = requiredFetch;

          if (
            !hasMissingRequestedData &&
            partialResources &&
            effectiveQueryState
          ) {
            if (Array.isArray(fields) && fields.length > 0) {
              for (const itemKey of effectiveQueryState.items) {
                if (
                  getGenuinelyMissingRequestedFields(
                    itemKey,
                    {
                      item: store.state.items[itemKey],
                      loadedFields: store.state.itemLoadedFields[itemKey],
                    },
                    fields,
                    partialResources.inferFields,
                    itemsPendingFullInvalidation,
                    getUnresolvedPendingInvalidationFields(itemKey),
                  ).length > 0
                ) {
                  hasMissingRequestedData = true;
                  break;
                }
              }
            } else if (fields === '*') {
              for (const itemKey of effectiveQueryState.items) {
                const item = store.state.items[itemKey];
                const loadedFields = store.state.itemLoadedFields[itemKey];
                // A fully invalidated item whose (stale) snapshot is still
                // present is stale data, not missing data.
                const hasStaleFullInvalidation =
                  itemsPendingFullInvalidation.has(itemKey) &&
                  !hasFullyLoadedFields(loadedFields) &&
                  !!item;
                if (
                  !hasStaleFullInvalidation &&
                  !snapshotIsFullyLoaded(
                    loadedFields,
                    item,
                    partialResources.inferFields,
                  )
                ) {
                  hasMissingRequestedData = true;
                  break;
                }
              }
            }
          }

          if (hasMissingRequestedData) {
            fetchType = 'highPriority';
          }
        }

        // `refetchOnMount` carries only the priority of the LAST invalidation
        // that set it — fields this hook displays may still be owed at a
        // higher tracked priority from an earlier invalidation (e.g. a
        // high-priority per-field invalidation recorded before a later
        // realtime full invalidation). Adopt the highest priority owed to the
        // displayed fields so the mount fetch is not under-prioritized.
        if (
          partialResources &&
          queryState?.refetchOnMount &&
          fetchType !== 'highPriority' &&
          effectiveQueryState
        ) {
          const invalidationPriority = getHighestPendingInvalidationPriority(
            effectiveQueryState.items,
            Array.isArray(fields) && fields.length > 0 ? fields : undefined,
          );
          if (
            invalidationPriority &&
            fetchTypePriority[invalidationPriority] >
              fetchTypePriority[fetchType]
          ) {
            fetchType = invalidationPriority;
          }
        }

        // Consume an invalidation that arrived while this instance was
        // off-screen: the visible instances consumed the event itself (and
        // cleared the query's shared `refetchOnMount`), so this per-instance
        // record is the only surviving signal that the instance's fields are
        // still owed a refetch.
        const offScreenInvalidationPriority =
          pendingOffScreenQueryInvalidations.get(queryId);
        if (offScreenInvalidationPriority !== undefined) {
          pendingOffScreenQueryInvalidations.delete(queryId);
          shouldFetch = true;
          if (
            fetchTypePriority[offScreenInvalidationPriority] >
            fetchTypePriority[fetchType]
          ) {
            fetchType = offScreenInvalidationPriority;
          }
        }

        if (!shouldFetch && ignoreQueriesInRefetchOnMount.has(queryId)) {
          continue;
        }

        ignoreQueriesInRefetchOnMount.add(queryId);

        if (
          shouldScheduleAutomaticFetch(
            effectiveQueryState?.wasLoaded,
            shouldFetch,
            disableRefetches,
            disableRefetchOnMount,
            !!partialResources,
          ) &&
          tryClaimAutomaticFetchSlot(
            automaticRetryState,
            retrySignature,
            effectiveQueryState?.status,
          )
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
    getDerivedPreloadPayloads,
    ignoreQueriesInRefetchOnMount,
    pendingOffScreenQueryInvalidations,
    preloadDerivedQueryItems,
    preloadQueries,
    preloadQueriesBeforePaint,
    fetchQueriesWithId,
    resolveEffectiveQuery,
    store,
    scheduleAutomaticListQueryFetch,
    partialResources,
    autoFetchSignals,
    automaticRetryState,
    itemPendingInvalidationFields,
    itemsPendingFullInvalidation,
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
