import { useOnEvtmitterEvent } from '@evtmitter/react';
import { useConst } from '@ls-stack/react-utils/useConst';
import { useDebouncedValue } from '@ls-stack/react-utils/useDebouncedValue';
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
  getIsPendingOfflineSync,
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
  type PayloadDebounce,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import {
  excludeLoadedFields,
  fallbackItemHasRequestedFields,
  getGenuinelyMissingRequestedFields,
  getStaleOrMissingRequestedFields,
  hasFullyLoadedFields,
  snapshotIsFullyLoaded,
  snapshotIsFullyLoadedAndFresh,
} from './itemFieldUtils';
import type { ListQueryStoreEvents } from './listQueryStore';
import {
  type FieldsInput,
  type ItemLoadedFields,
  type ListQueryOfflineOverlay,
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
  /** Maps each item before it is returned from the hook. */
  selector?: (data: ItemState | null, payload: ValidPayload | null) => Selected;
  /** Reads only from the current store state and never schedules fetches. */
  loadFromStateOnly?: boolean;
  /** Returns `idle` instead of `loading` while items have not been fetched. */
  returnIdleStatus?: boolean;
  /** Returns `refetching` instead of keeping `loaded` status during refetches. */
  returnRefetchingStatus?: boolean;
  /**
   * When requested fields are missing but cached partial data exists, return
   * `refetching` instead of `loading`.
   */
  showPartialAsRefetching?: boolean;
  /**
   * Only fetches when an item is missing from state, skipping stale-state and
   * invalidation refetches.
   */
  disableRefetches?: boolean;
  /** Prevents automatic mount refetches for stale loaded data. */
  disableRefetchOnMount?: boolean;
  /** Marks these subscriptions as off-screen, lowering automatic fetch priority. */
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
            loadedFields: ItemLoadedFields | undefined;
          }
        | undefined)
    | undefined,
  itemInvalidationWasTriggered: Set<string>,
  itemFieldInvalidationPriorities: Map<string, FetchType>,
  itemPendingInvalidationFields: Map<string, string[]>,
  itemsPendingFullInvalidation: Set<string>,
  globalDisableRefetchOnMount: boolean | undefined,
  fetchItemFn: unknown,
  partialResources: PartialResourcesConfig<ItemState> | undefined,
  offlineEntities: readonly GlobalOfflineEntity[],
  offlineOverlays: Readonly<
    Record<string, ListQueryOfflineOverlay<ItemState, ItemPayload>>
  >,
): readonly TSFDUseListItemReturn<Selected, ItemPayload, QueryMetadata>[] {
  const isOffScreenFromContext = useContext(IsOffScreenContext);

  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  type QueryWithId = {
    itemKey: string;
    payload: ItemPayload;
    fields: FieldsInput | undefined;
    retrySignature: string;
    disableRefetches: boolean;
    disableRefetchOnMount: boolean;
    returnIdleStatus: boolean;
    returnRefetchingStatus: boolean;
    showPartialAsRefetching: boolean;
    isOffScreen: boolean;
    queryMetadata: QueryMetadata | undefined;
  };

  const queriesWithId = useMemo((): QueryWithId[] => {
    return items.map((itemProps) => {
      const itemKey = getItemKey(itemProps.payload);
      return {
        itemKey,
        payload: itemProps.payload,
        fields: itemProps.fields,
        retrySignature: `${itemKey}|${createFieldsResourceSignature(itemProps.fields)}`,
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
          itemProps.isOffScreen ??
          allItemsIsOffScreen ??
          isOffScreenFromContext,
        queryMetadata: itemProps.queryMetadata,
      };
    });
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
  const offlineEntitiesByKey = useMemo(
    () => createOfflineEntityLookup(offlineEntities),
    [offlineEntities],
  );
  const activeOfflineOverlays = useMemo(
    () => filterActiveOfflineOverlays(offlineEntitiesByKey, offlineOverlays),
    [offlineEntitiesByKey, offlineOverlays],
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
      return excludeLoadedFields(
        itemLoadedFields[itemKey],
        itemPendingInvalidationFields.get(itemKey),
      );
    },
    [itemPendingInvalidationFields, store],
  );

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
          const overlay = activeOfflineOverlays[itemKey];
          const hasOverlay = overlay !== undefined;
          const itemQuery = state.itemQueries[itemKey];
          const rawItemState = hasOverlay ? overlay.item : state.items[itemKey];
          const resolvedItemPayload =
            overlay?.itemPayload ?? itemQuery?.payload ?? payload;
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
            ? selector(itemState ?? null, resolvedItemPayload)
            : // WORKAROUND: Runtime selector presence does not narrow Selected, so the unselected path must forward the raw item state through the generic.
              __LEGIT_CAST__<Selected, ItemState | null>(itemState ?? null);
          const resultQueryMetadata =
            // WORKAROUND: queryMetadata stays optional on input queries, but the public hook result preserves the caller's QueryMetadata generic.
            __LEGIT_CAST__<QueryMetadata, QueryMetadata | undefined>(
              queryMetadata,
            );

          if (hasOverlay ? overlay.item === null : itemQuery === null) {
            return {
              itemStateKey: itemKey,
              status: 'deleted',
              error: null,
              isLoading: false,
              payload: resolvedItemPayload,
              data,
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(itemKey),
              ),
              queryMetadata: resultQueryMetadata,
            };
          }

          if (!itemQuery) {
            if (hasOverlay && overlay.item !== null) {
              return {
                itemStateKey: itemKey,
                status: 'success',
                error: null,
                isLoading: false,
                payload: resolvedItemPayload,
                data,
                pendingSync: getIsPendingOfflineSync(
                  offlineEntitiesByKey.get(itemKey),
                ),
                queryMetadata: resultQueryMetadata,
              };
            }

            if (loadFromStateOnly) {
              return {
                itemStateKey: itemKey,
                status: 'error',
                error: cacheMissError,
                isLoading: false,
                payload: resolvedItemPayload,
                data,
                pendingSync: getIsPendingOfflineSync(
                  offlineEntitiesByKey.get(itemKey),
                ),
                queryMetadata: resultQueryMetadata,
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
              payload: resolvedItemPayload,
              data,
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(itemKey),
              ),
              queryMetadata: resultQueryMetadata,
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
            // Fields genuinely absent from the snapshot: not tracked as
            // loaded, not vouched by `inferFields`, and not merely stale
            // (awaiting an invalidation re-fetch — stale fields keep their
            // data visible while refetching in the background). The fetch
            // effect acts on the superset of this signal plus stale fields,
            // so a `loading` override here is always matched by a scheduled
            // fetch. Fields may be logical names, so raw key presence must
            // not be used here.
            const absentFields = getGenuinelyMissingRequestedFields(
              itemKey,
              { item: rawItemState, loadedFields },
              fields,
              partialResources.inferFields,
              itemsPendingFullInvalidation,
              getUnresolvedPendingInvalidationFields(itemKey, state),
            );

            if (absentFields.length > 0) {
              status =
                hasCachedDataInState && showPartialAsRefetching
                  ? 'refetching'
                  : 'loading';
            }
          } else if (
            partialResources &&
            fields === '*' &&
            (status === 'success' || status === 'refetching')
          ) {
            // "Data absent" (incomplete snapshot) is different from "complete
            // but stale" (e.g. after a full item invalidation): only a
            // genuinely incomplete snapshot may hide data behind `loading` —
            // stale but complete data stays visible while it refetches. A full
            // item invalidation resets `loadedFields` to `[]` but leaves the
            // pending-full-invalidation marker, which proves the item data was
            // complete when invalidated (and is still present).
            const isIncomplete =
              !snapshotIsFullyLoaded(
                loadedFields,
                rawItemState,
                partialResources.inferFields,
              ) &&
              !(
                itemsPendingFullInvalidation.has(itemKey) &&
                hasCachedDataInState
              );
            const isStale =
              !isIncomplete &&
              !snapshotIsFullyLoadedAndFresh(
                itemKey,
                loadedFields,
                rawItemState,
                partialResources.inferFields,
                itemsPendingFullInvalidation,
              );

            if (isIncomplete) {
              status =
                hasCachedDataInState && showPartialAsRefetching
                  ? 'refetching'
                  : 'loading';
            } else if (
              isStale ||
              (itemFieldInvalidationFields &&
                itemFieldInvalidationFields.length > 0)
            ) {
              status = 'refetching';
            }
          }

          if (partialResources && showPartialAsRefetching) {
            if (Array.isArray(fields) && fields.length > 0) {
              // Same stale-or-missing signal the fetch effect uses: absent
              // unvouched fields plus fields awaiting an invalidation
              // re-fetch. Vouched metadata-free fields are NOT pending — no
              // fetch will run for them.
              const pendingRequestedFields = getStaleOrMissingRequestedFields(
                itemKey,
                loadedFields,
                rawItemState,
                fields,
                partialResources.inferFields,
                itemsPendingFullInvalidation,
                getUnresolvedPendingInvalidationFields(itemKey, state),
              );

              if (pendingRequestedFields.length > 0) {
                loadingFields = pendingRequestedFields;
              }
            } else if (fields === '*') {
              if (
                hasFullyLoadedFields(loadedFields) &&
                itemFieldInvalidationFields &&
                itemFieldInvalidationFields.length > 0
              ) {
                loadingFields = itemFieldInvalidationFields;
              }
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
                ? selector(null, resolvedItemPayload)
                : // WORKAROUND: Runtime selector presence does not narrow Selected, so the loading fallback has to re-express the null result.
                  __LEGIT_CAST__<Selected, null>(null)
              : data,
            payload: resolvedItemPayload,
            pendingSync: getIsPendingOfflineSync(
              offlineEntitiesByKey.get(itemKey),
            ),
            queryMetadata: resultQueryMetadata,
          };
        },
      );
    },
    [
      activeOfflineOverlays,
      getUnresolvedPendingInvalidationFields,
      itemsPendingFullInvalidation,
      loadFromStateOnly,
      offlineEntitiesByKey,
      partialResources,
      queriesWithId,
      selector,
    ],
  );

  const autoFetchSignalSelector = useCallback(
    (state: State) => {
      return queriesWithId.map(({ itemKey, fields }) => {
        const itemQuery = state.itemQueries[itemKey];
        const loadedFields = state.itemLoadedFields[itemKey] ?? [];
        // Same stale-or-missing signal the fetch effect uses, so every
        // transition the effect would act on wakes it. A metadata-only signal
        // misses invalidations of metadata-free (`inferFields`-vouched) items:
        // their tracked missing fields are identical before and after the
        // invalidation, so hooks would not refetch until another state change.
        const missingRequestedFields =
          partialResources && Array.isArray(fields) && fields.length > 0
            ? getStaleOrMissingRequestedFields(
                itemKey,
                state.itemLoadedFields[itemKey],
                state.items[itemKey],
                fields,
                partialResources.inferFields,
                itemsPendingFullInvalidation,
                getUnresolvedPendingInvalidationFields(itemKey, state),
              ).sort()
            : [];
        const needsFullFetch =
          partialResources && fields === '*'
            ? !snapshotIsFullyLoaded(
                loadedFields,
                state.items[itemKey],
                partialResources.inferFields,
              ) ||
              (itemsPendingFullInvalidation.has(itemKey) &&
                !hasFullyLoadedFields(loadedFields))
            : false;

        return {
          status: itemQuery?.status ?? null,
          refetchOnMount: itemQuery?.refetchOnMount ?? null,
          missingRequestedFieldsKey: JSON.stringify(missingRequestedFields),
          needsFullFetch,
        };
      });
    },
    [
      getUnresolvedPendingInvalidationFields,
      itemsPendingFullInvalidation,
      partialResources,
      queriesWithId,
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
          const overlay = activeOfflineOverlays[result.itemStateKey];
          const hasOverlay = overlay !== undefined;
          const hasAllRequestedFallbackFields =
            !partialResources ||
            query.fields === undefined ||
            (query.fields === '*'
              ? snapshotIsFullyLoaded(
                  fallbackItemState?.loadedFields,
                  fallbackItemState?.item,
                  partialResources.inferFields,
                )
              : fallbackItemHasRequestedFields(
                  fallbackItemState,
                  query.fields,
                  partialResources.inferFields,
                ));

          if (!hasAllRequestedFallbackFields) return result;

          const fallbackItemQuery =
            hasOverlay &&
            overlay.item !== null &&
            fallbackItemState?.itemQuery == null
              ? {
                  status: 'success' as const,
                  wasLoaded: true,
                  refetchOnMount: false,
                  error: null,
                  payload: overlay.itemPayload ?? query.payload,
                }
              : fallbackItemState?.itemQuery;
          const fallbackItemPayload =
            overlay?.itemPayload ?? fallbackItemQuery?.payload ?? query.payload;

          if (hasOverlay ? overlay.item === null : fallbackItemQuery === null) {
            return {
              itemStateKey: result.itemStateKey,
              status: 'deleted',
              error: null,
              isLoading: false,
              payload: fallbackItemPayload,
              data: selector
                ? selector(null, null)
                : // WORKAROUND: Runtime selector presence does not narrow Selected, so the deleted fallback still has to express null through the caller's generic.
                  __LEGIT_CAST__<Selected, null>(null),
              pendingSync: getIsPendingOfflineSync(
                offlineEntitiesByKey.get(result.itemStateKey),
              ),
              queryMetadata: result.queryMetadata,
            };
          }

          const fallbackItem = hasOverlay
            ? overlay.item
            : (fallbackItemState?.item ?? undefined);

          if (
            fallbackItemQuery &&
            fallbackItem !== undefined &&
            fallbackItem !== null
          ) {
            let itemState = fallbackItem;

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
              payload: fallbackItemPayload,
              data: selector
                ? selector(itemState, fallbackItemPayload)
                : // WORKAROUND: Runtime selector presence does not narrow Selected, so fallback item data still has to flow through the caller's generic unchanged.
                  __LEGIT_CAST__<Selected, ItemState>(itemState),
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
    loadFromStateOnly,
    activeOfflineOverlays,
    offlineEntitiesByKey,
    partialResources,
    queriesWithId,
    readFallbackItemState,
    selector,
    storeState,
  ]);
  const autoFetchSignals = store.useSelectorRC(autoFetchSignalSelector, {
    equalityFn: deepEqual,
  });
  const automaticRetryState = useConst<AutomaticFetchRetryState>(
    () => new Map(),
  );

  useEffect(() => {
    for (const { itemKey, isOffScreen, retrySignature } of queriesWithId) {
      if (isOffScreen) {
        automaticRetryState.delete(retrySignature);
        continue;
      }

      observeAutomaticFetchStatus(
        automaticRetryState,
        retrySignature,
        store.state.itemQueries[itemKey]?.status,
      );
    }
  }, [automaticRetryState, queriesWithId, store, visibleStoreState]);

  const ignoreItemsInRefetchOnMount = useConst(() => new Set<string>());

  useOnEvtmitterEvent(events, 'invalidateItem', ({ payload: event }) => {
    if (loadFromStateOnly || !fetchItemFn) return;

    const queriesForItem = fetchQueriesWithId.filter(
      ({ itemKey }) => itemKey === event.itemKey,
    );

    let fieldsToFetch: string[] | undefined;
    if (event.invalidateFields && event.invalidateFields.length > 0) {
      fieldsToFetch = Array.from(new Set(event.invalidateFields)).sort();
    }

    const affectedQueries = fieldsToFetch
      ? queriesForItem.filter(({ fields }) => {
          if (fields === '*') return true;
          if (!fields || fields.length === 0) return true;
          return fields.some((field) =>
            event.invalidateFields?.includes(field),
          );
        })
      : queriesForItem;

    if (affectedQueries.length === 0) return;

    // A new invalidation is a new refetch obligation: re-open the mount-once
    // gate so the auto-fetch effect can schedule the refetch of this
    // instance's own stale fields at the tracked invalidation priority. This
    // must happen even when every affected instance is off-screen — the gate
    // means "one automatic attempt per invalidation" and an off-screen
    // instance hasn't spent its attempt yet; the effect schedules its refetch
    // when it returns on-screen. Only the scheduling below is on-screen-only.
    // The fetch scheduled below only covers the first hook instance's fields —
    // the scheduler coalesces/dedupes the per-instance schedules.
    ignoreItemsInRefetchOnMount.delete(event.itemKey);

    const matchingQueries = affectedQueries.filter(
      ({ isOffScreen }) => !isOffScreen,
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

  useLayoutEffect(() => {
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
        retrySignature,
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
        if (partialResources && !shouldFetch) {
          const loadedFields = store.state.itemLoadedFields[itemKey] ?? [];
          const item = store.state.items[itemKey];
          const unresolvedPendingInvalidationFields =
            getUnresolvedPendingInvalidationFields(itemKey);
          // A fully-loaded ('*') item that was fully invalidated has no field
          // list to enumerate; this marker keeps hooks from trusting the stale
          // snapshot until the item is fully reloaded ('*' again).
          const hasUnresolvedFullInvalidation =
            itemsPendingFullInvalidation.has(itemKey) &&
            !hasFullyLoadedFields(loadedFields);
          const invalidationPriority =
            unresolvedPendingInvalidationFields.length > 0 ||
            hasUnresolvedFullInvalidation
              ? itemFieldInvalidationPriorities.get(itemKey)
              : undefined;

          if (Array.isArray(fields) && fields.length > 0) {
            // Per-field stale-or-missing check: `inferFields` keeps vouching
            // for unaffected fields even while other fields of the item have
            // unresolved invalidations (stale pending fields are never
            // vouched).
            const staleOrMissingFields = getStaleOrMissingRequestedFields(
              itemKey,
              loadedFields,
              item,
              fields,
              partialResources.inferFields,
              itemsPendingFullInvalidation,
              unresolvedPendingInvalidationFields,
            );
            // Genuinely missing fields (never loaded, not vouched, not merely
            // stale) justify an immediate required fetch. Stale fields (owed
            // after an invalidation, cached data still present) refetch at the
            // tracked invalidation priority so scheduler throttling (e.g.
            // realtime updates) stays effective; their refetch is handled by
            // the invalidation path below (event handler for mounted hooks,
            // mount-once gate for late-mounting ones) to avoid re-scheduling
            // on every effect run.
            const missingFields = getGenuinelyMissingRequestedFields(
              itemKey,
              { item, loadedFields },
              fields,
              partialResources.inferFields,
              itemsPendingFullInvalidation,
              unresolvedPendingInvalidationFields,
            );
            const staleInvalidatedFields = staleOrMissingFields.filter(
              (field) => !missingFields.includes(field),
            );
            const hasMissingFields = missingFields.length > 0;
            const hasStaleInvalidatedFields = staleInvalidatedFields.length > 0;
            // Stale fields with a tracked invalidation priority are gated on
            // the mount-once set — the local `invalidateItem` event re-opens
            // the gate for each new invalidation. Untracked stale fields
            // (e.g. invalidations adopted from another tab via state sync)
            // have no local event to re-open the gate, so they stay ungated.
            const shouldFetchForInvalidation =
              hasStaleInvalidatedFields &&
              (!invalidationPriority ||
                !ignoreItemsInRefetchOnMount.has(itemKey));

            if (
              (hasMissingFields || shouldFetchForInvalidation) &&
              !itemFetchIsActive
            ) {
              shouldFetch = true;
              requiredFetch = true;
              fieldsToFetch = Array.from(
                new Set([...missingFields, ...staleInvalidatedFields]),
              );
              // Genuinely missing data — or stale fields with no tracked
              // invalidation priority (e.g. invalidations adopted from
              // another tab) — must fetch immediately. Low-priority
              // follow-ups can be skipped while the scheduler phase is still
              // fetching; keep stronger priorities intact, only lift low
              // priority.
              if (
                (hasMissingFields || !invalidationPriority) &&
                fetchType === 'lowPriority'
              ) {
                fetchType = 'highPriority';
              }
            }

            if (
              hasStaleInvalidatedFields &&
              !hasMissingFields &&
              invalidationPriority &&
              fetchTypePriority[invalidationPriority] >
                fetchTypePriority[fetchType]
            ) {
              fetchType = invalidationPriority;
            }
          } else if (fields === '*') {
            // A fully invalidated item whose (now stale) data is still
            // present is a refetch of stale data, not a load of missing data
            // — it must keep the tracked invalidation priority.
            const hasStaleFullInvalidation =
              hasUnresolvedFullInvalidation && !!item;
            const missingFullItem =
              !hasStaleFullInvalidation &&
              (!snapshotIsFullyLoaded(
                loadedFields,
                item,
                partialResources.inferFields,
              ) ||
                hasUnresolvedFullInvalidation);
            // Invalidation-only refetches (stale data still present) are gated
            // on the mount-once set, mirroring the array-field branch. A
            // missing full item is not gated, so a hook mounting while another
            // fetch is in flight still refetches once that fetch settles.
            // Untracked invalidations (adopted from another tab) have no
            // local event to re-open the gate, so they stay ungated too.
            const shouldFetchForInvalidation =
              !missingFullItem &&
              (unresolvedPendingInvalidationFields.length > 0 ||
                hasStaleFullInvalidation) &&
              (!invalidationPriority ||
                !ignoreItemsInRefetchOnMount.has(itemKey));

            if (
              (missingFullItem || shouldFetchForInvalidation) &&
              !itemFetchIsActive
            ) {
              shouldFetch = true;
              requiredFetch = true;
              fieldsToFetch =
                missingFullItem || hasStaleFullInvalidation
                  ? '*'
                  : unresolvedPendingInvalidationFields;

              // Genuinely missing data — or stale data with no tracked
              // invalidation priority — must fetch immediately; only lift low
              // priority. Stale-only refetches keep the tracked invalidation
              // priority so scheduler throttling stays effective.
              if (
                (missingFullItem || !invalidationPriority) &&
                fetchType === 'lowPriority'
              ) {
                fetchType = 'highPriority';
              }

              if (
                !missingFullItem &&
                invalidationPriority &&
                fetchTypePriority[invalidationPriority] >
                  fetchTypePriority[fetchType]
              ) {
                fetchType = invalidationPriority;
              }
            }
          }
        }

        if (!shouldFetch && ignoreItemsInRefetchOnMount.has(itemKey)) {
          continue;
        }

        ignoreItemsInRefetchOnMount.add(itemKey);

        if (
          shouldScheduleAutomaticFetch(
            itemState?.wasLoaded,
            shouldFetch,
            disableRefetches,
            disableRefetchOnMount,
            !!partialResources,
          ) &&
          tryClaimAutomaticFetchSlot(
            automaticRetryState,
            retrySignature,
            itemState?.status,
          )
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
    autoFetchSignals,
    automaticRetryState,
    fetchItemFn,
    fetchQueriesWithId,
    getUnresolvedPendingInvalidationFields,
    ignoreItemsInRefetchOnMount,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    itemsPendingFullInvalidation,
    loadFromStateOnly,
    partialResources,
    preloadItems,
    preloadItemsBeforePaint,
    scheduleAutomaticItemFetch,
    store,
  ]);

  return visibleStoreState;
}
