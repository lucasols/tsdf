import { filterAndMap, sortBy } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { Result, type Result as ResultType } from 't-result';
import { Store } from 't-state';
import type { TestOfflineTimelineEvent } from '../internal/testTimelineTypes';
import { GET_ALL } from '../invalidationUtils';
import {
  type OfflineMutationResult,
  runHybridOfflineMutation,
  type OfflineAwareMutationController,
} from '../persistentStorage/offline/mutationRuntime';
import { OfflineSessionUnavailableError } from '../persistentStorage/offline/storeController';
import type { OfflineMutationInput } from '../persistentStorage/offline/types';
import type { OfflineMutationUploadsInput } from '../persistentStorage/offlineUploadTypes';
import type { ListQueryOfflineOperationsConfig } from '../persistentStorage/types';
import { FetchType, getAutoIncrementId } from '../requestScheduler';
import { type SnapshotConsistency } from '../utils/browserTabsSync';
import {
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from '../utils/performMutation';
import {
  fetchTypePriority,
  higherFetchType,
  mutationSkipped,
  type MutationSkipped,
  type StoreError,
  type StoreMutationErrorOptions,
  StoreMutationError,
  toStoreMutationError,
  unwrapTSDFResult,
  type MaybeTSDFResult,
  type UnwrapTSDFResult,
  type ValidPayload,
  type ValidStoreState,
} from '../utils/storeShared';
import { type FilterItemFn, type FilterQueryFn } from './createFetchApi';
import {
  type OnListQueryInvalidate,
  type OnListQueryItemInvalidate,
  type OptimisticListUpdate,
  type ItemLoadedFields,
  type PartialResourcesConfig,
  type TSDFItemQuery,
  type TSFDListQuery,
  type TSFDListQueryState,
} from './types';

type InvalidateQueryEvent = { priority: FetchType; queryKey: string };
type InvalidateItemEvent = {
  priority: FetchType;
  itemKey: string;
  invalidateFields?: string[];
};

type SchedulerWithMutation = { startMutation: (key: string) => () => boolean };

type CreateMutationApiOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
> = {
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>;
  fetchItemFn?: (
    payload: ItemPayload,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<MaybeTSDFResult<ItemState>>;
  partialResources?: PartialResourcesConfig<ItemState>;
  optimisticListUpdates?: OptimisticListUpdate<
    ItemState,
    QueryPayload,
    ItemPayload
  >[];
  onInvalidateQuery?: OnListQueryInvalidate<QueryPayload>;
  onInvalidateItem?: OnListQueryItemInvalidate<ItemState, ItemPayload>;
  onMutationError?: (
    error: unknown,
    options: StoreMutationErrorOptions,
  ) => void;
  errorNormalizer: (exception: Error) => StoreError;
  getItemKey: (params: ItemPayload) => string;
  getQueriesKeyArray: (
    payloads: QueryPayload | QueryPayload[] | FilterQueryFn<QueryPayload>,
  ) => { key: string; payload: QueryPayload }[];
  getQueriesRelatedToItem: (
    itemPayload: ItemPayload,
  ) => { key: string; query: { items: string[] } }[];
  getItemsKeyArray: (
    itemsPayload:
      | ItemPayload
      | ItemPayload[]
      | FilterItemFn<ItemState, ItemPayload>,
  ) => { itemKey: string; payload: ItemPayload }[];
  getOrCreateItemScheduler: (
    itemKey: string,
    payload: ItemPayload,
  ) => SchedulerWithMutation;
  getOrCreateQueryScheduler: (queryKey: string) => SchedulerWithMutation;
  deleteItemFetchResources: (
    items: { itemKey: string; payload: ItemPayload }[],
  ) => void;
  emitInvalidateQuery: (event: InvalidateQueryEvent) => void;
  emitInvalidateItem: (event: InvalidateItemEvent) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  offlineController?: OfflineAwareMutationController<
    Exclude<TOfflineOperations, null>
  > | null;
  runWithBroadcastConsistency: <T>(
    consistency: SnapshotConsistency,
    callback: () => T,
  ) => T;
  publishQuerySnapshot: (
    queryKey: string,
    consistency?: SnapshotConsistency,
  ) => void;
  publishItemSnapshot: (
    itemKey: string,
    consistency?: SnapshotConsistency,
  ) => void;
  onOfflineTimelineEvent?: (event: TestOfflineTimelineEvent) => void;
};

type ListQueryStoreStoreEvents<ItemPayload extends ValidPayload> = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number; items: ItemPayload[] };
  /** Emitted when a mutation completes, fails, or is skipped */
  mutationEnd: {
    mutationId: number;
    items: ItemPayload[];
    status: 'success' | 'error' | 'skipped';
  };
  /** Emitted when an offline temp item is reconciled to its final payload. */
  tempEntityReconciled: { tempId: ItemPayload; finalPayload: ItemPayload };
};

/**
 * A per-field invalidation that arrived for a field with no displayable
 * cached value. It is deliberately not recorded as stale (the field must stay
 * "genuinely missing" so its first load runs immediately instead of being
 * throttled), but a fetch already in flight at `invalidatedAt` will commit a
 * response produced before the invalidation — fetch-settle re-announces the
 * invalidation when such a fetch ends up loading the field.
 *
 * @internal
 */
export type DroppedFieldInvalidation = {
  invalidatedAt: number;
  priority: FetchType;
};

/** @internal */
export function createMutationApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends ListQueryOfflineOperationsConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
>(
  store: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['store'],
  fetchItemFn: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['fetchItemFn'],
  partialResources: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['partialResources'],
  optimisticListUpdates: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['optimisticListUpdates'],
  onInvalidateQuery: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['onInvalidateQuery'],
  onInvalidateItem: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['onInvalidateItem'],
  onMutationError: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['onMutationError'],
  errorNormalizer: (exception: Error) => StoreError,
  getItemKey: (params: ItemPayload) => string,
  getQueriesKeyArray: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['getQueriesKeyArray'],
  getQueriesRelatedToItem: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['getQueriesRelatedToItem'],
  getItemsKeyArray: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['getItemsKeyArray'],
  getOrCreateItemScheduler: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['getOrCreateItemScheduler'],
  getOrCreateQueryScheduler: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['getOrCreateQueryScheduler'],
  deleteItemFetchResources: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['deleteItemFetchResources'],
  emitInvalidateQuery: (event: InvalidateQueryEvent) => void,
  emitInvalidateItem: (event: InvalidateItemEvent) => void,
  blockWindowClose: BlockWindowCloseHandler | null,
  offlineController: CreateMutationApiOptions<
    ItemState,
    QueryPayload,
    ItemPayload,
    TOfflineOperations
  >['offlineController'],
  runWithBroadcastConsistency: <T>(
    consistency: SnapshotConsistency,
    callback: () => T,
  ) => T,
  publishQuerySnapshot: (
    queryKey: string,
    consistency?: SnapshotConsistency,
  ) => void,
  publishItemSnapshot: (
    itemKey: string,
    consistency?: SnapshotConsistency,
  ) => void,
  onOfflineTimelineEvent:
    | ((event: TestOfflineTimelineEvent) => void)
    | undefined,
  itemPendingInvalidationFields: Map<string, Map<string, FetchType | null>>,
  itemsPendingFullInvalidation: Map<string, FetchType>,
  itemDroppedFieldInvalidations: Map<
    string,
    Map<string, DroppedFieldInvalidation>
  >,
) {
  type FilterQuery = FilterQueryFn<QueryPayload>;
  type FilterItem = FilterItemFn<ItemState, ItemPayload>;
  type MutationPayload = ItemPayload | ItemPayload[] | FilterItem | null;
  type MutationPayloadToUse = ItemPayload | ItemPayload[] | FilterItem;
  type InvalidateQueryAndItemsArgs =
    | {
        all: true;
        type?: FetchType;
        fields?: string[];
        itemPayload?: never;
        queryPayload?: never;
      }
    | {
        all?: never;
        itemPayload: ItemPayload | ItemPayload[] | FilterItem | false;
        queryPayload: QueryPayload | QueryPayload[] | FilterQuery | false;
        type?: FetchType;
        fields?: string[];
      };
  type MutationItemRollbackSnapshot = {
    itemKey: string;
    item: ItemState | null | undefined;
    itemQuery: TSDFItemQuery<ItemPayload> | null | undefined;
    loadedFields: ItemLoadedFields | undefined;
    invalidationFields: string[] | undefined;
    pendingInvalidationFields: Map<string, FetchType | null> | undefined;
    invalidationWasTriggered: boolean;
  };
  type MutationQueryRollbackSnapshot = {
    queryKey: string;
    query: TSFDListQuery<QueryPayload> | undefined;
    invalidationWasTriggered: boolean;
  };
  type OptimisticMutationQueryContext = {
    dynamicQueryMutationEnders: Array<() => boolean>;
    lockedQueryKeys: Set<string>;
    queryRollbackSnapshots: Map<string, MutationQueryRollbackSnapshot>;
  };

  const storeEvents = evtmitter<ListQueryStoreStoreEvents<ItemPayload>>();
  // Stack of Maps that collect query invalidations triggered by optimistic list
  // updates. During an optimistic mutation, applyOptimisticListUpdates is called
  // indirectly via user callbacks (updateItemState/addItemToState), so we cannot
  // thread a collector parameter without changing the public API. Instead, the
  // mutation pushes a Map onto this stack before calling the optimistic update
  // callback and pops it in a finally block; applyOptimisticListUpdates reads
  // the top of the stack to defer invalidations until the mutation succeeds.
  const deferredOptimisticQueryInvalidationsStack: Map<string, QueryPayload>[] =
    [];
  const optimisticMutationQueryContextStack: OptimisticMutationQueryContext[] =
    [];

  function resolveAffectedItems(payload: MutationPayloadToUse): ItemPayload[] {
    if (Array.isArray(payload)) return payload;
    if (typeof payload === 'function') {
      return getItemsKeyArray(payload).map((item) => item.payload);
    }
    return [payload];
  }

  function restoreMutationRollbackState({
    itemSnapshots,
    querySnapshots,
  }: {
    itemSnapshots: MutationItemRollbackSnapshot[];
    querySnapshots: MutationQueryRollbackSnapshot[];
  }): void {
    if (itemSnapshots.length === 0 && querySnapshots.length === 0) return;

    runWithBroadcastConsistency('confirmed', () => {
      store.produceState(
        (draftState) => {
          for (const snapshot of itemSnapshots) {
            if (snapshot.item === undefined) {
              delete draftState.items[snapshot.itemKey];
            } else {
              draftState.items[snapshot.itemKey] = snapshot.item;
            }

            if (snapshot.itemQuery === undefined) {
              delete draftState.itemQueries[snapshot.itemKey];
            } else {
              draftState.itemQueries[snapshot.itemKey] = snapshot.itemQuery;
            }

            if (snapshot.loadedFields === undefined) {
              delete draftState.itemLoadedFields[snapshot.itemKey];
            } else {
              draftState.itemLoadedFields[snapshot.itemKey] =
                snapshot.loadedFields;
            }

            if (snapshot.invalidationFields === undefined) {
              delete draftState.itemFieldInvalidationFields[snapshot.itemKey];
            } else {
              draftState.itemFieldInvalidationFields[snapshot.itemKey] =
                snapshot.invalidationFields;
            }
          }

          for (const snapshot of querySnapshots) {
            if (snapshot.query === undefined) {
              delete draftState.queries[snapshot.queryKey];
            } else {
              draftState.queries[snapshot.queryKey] = snapshot.query;
            }
          }
        },
        { action: 'rollback-mutation-error' },
      );

      for (const snapshot of itemSnapshots) {
        if (snapshot.pendingInvalidationFields === undefined) {
          itemPendingInvalidationFields.delete(snapshot.itemKey);
        } else {
          itemPendingInvalidationFields.set(
            snapshot.itemKey,
            new Map(snapshot.pendingInvalidationFields),
          );
        }

        if (snapshot.invalidationWasTriggered) {
          itemInvalidationWasTriggered.add(snapshot.itemKey);
        } else {
          itemInvalidationWasTriggered.delete(snapshot.itemKey);
        }

        publishItemSnapshot(snapshot.itemKey);
      }

      for (const snapshot of querySnapshots) {
        if (snapshot.invalidationWasTriggered) {
          queryInvalidationWasTriggered.add(snapshot.queryKey);
        } else {
          queryInvalidationWasTriggered.delete(snapshot.queryKey);
        }

        publishQuerySnapshot(snapshot.queryKey);
      }
    });
  }

  function getCurrentOptimisticMutationQueryContext():
    | OptimisticMutationQueryContext
    | undefined {
    return optimisticMutationQueryContextStack[
      optimisticMutationQueryContextStack.length - 1
    ];
  }

  function captureAndLockOptimisticMutationQuery(queryKey: string): void {
    const context = getCurrentOptimisticMutationQueryContext();

    if (!context) return;

    if (!context.queryRollbackSnapshots.has(queryKey)) {
      context.queryRollbackSnapshots.set(queryKey, {
        queryKey,
        query: klona(store.state.queries[queryKey]),
        invalidationWasTriggered: queryInvalidationWasTriggered.has(queryKey),
      });
    }

    if (context.lockedQueryKeys.has(queryKey)) return;

    context.lockedQueryKeys.add(queryKey);
    context.dynamicQueryMutationEnders.push(
      getOrCreateQueryScheduler(queryKey).startMutation(queryKey),
    );
  }

  const queryInvalidationWasTriggered = new Set<string>();
  const itemInvalidationWasTriggered = new Set<string>();

  /**
   * The staleness baseline for invalidations: a field is invalidatable
   * exactly when it is displayable, and hooks display the UNION of the
   * tracked `itemLoadedFields` metadata and whatever `inferFields` currently
   * vouches for (e.g. fields a mutation wrote beyond the tracked metadata).
   * Collapses to '*' when either side is '*' — the displayable set is then
   * not enumerable.
   */
  function getInvalidationBaselineFields(
    itemKey: string,
  ): ItemLoadedFields | undefined {
    const trackedLoadedFields = store.state.itemLoadedFields[itemKey];
    if (trackedLoadedFields === '*') return '*';

    if (!partialResources) return trackedLoadedFields;

    const itemState = store.state.items[itemKey];
    if (!itemState) return trackedLoadedFields;

    const inferredFields = partialResources.inferFields(itemState);
    if (inferredFields === '*') return '*';

    if (!trackedLoadedFields || trackedLoadedFields.length === 0) {
      return inferredFields;
    }

    return Array.from(new Set([...trackedLoadedFields, ...inferredFields]));
  }

  function invalidateQueryAndItems(args: InvalidateQueryAndItemsArgs) {
    const itemPayload: ItemPayload | ItemPayload[] | FilterItem | false =
      args.all ? GET_ALL : args.itemPayload;
    const queryPayload: QueryPayload | QueryPayload[] | FilterQuery | false =
      args.all ? GET_ALL : args.queryPayload;
    const priority = args.type ?? 'highPriority';
    const invalidateFields = args.fields;
    const queriesKey = queryPayload ? getQueriesKeyArray(queryPayload) : [];

    for (const { key, payload } of queriesKey) {
      const queryState = store.state.queries[key];

      if (!queryState) continue;

      const currentInvalidationPriority = queryState.refetchOnMount
        ? fetchTypePriority[queryState.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      captureAndLockOptimisticMutationQuery(key);

      store.produceState(
        (draft) => {
          const query = draft.queries[key];
          if (!query) return;

          query.refetchOnMount = priority;
        },
        { action: 'invalidate-query' },
      );

      queryInvalidationWasTriggered.delete(key);
      emitInvalidateQuery({ priority, queryKey: key });

      onInvalidateQuery?.(payload, priority);
    }

    if (itemPayload) {
      if (partialResources && invalidateFields) {
        // Per-field invalidation: remove specified fields from itemLoadedFields
        const itemsKey = getItemsKeyArray(itemPayload);
        // Only fields with a displayable cached value can go stale (see
        // getInvalidationBaselineFields). A never-loaded field must not be
        // recorded — it stays classified as genuinely missing so its first
        // load runs immediately instead of waiting out a throttle.
        const staleInvalidateFieldsByItemKey = new Map<string, string[]>();

        for (const { itemKey } of itemsKey) {
          const effectiveLoadedFields = getInvalidationBaselineFields(itemKey);

          const staleInvalidateFields =
            effectiveLoadedFields === '*'
              ? invalidateFields
              : invalidateFields.filter(
                  (field) => effectiveLoadedFields?.includes(field) ?? false,
                );

          // Fields dropped from the stale record (never loaded) would be lost
          // to a fetch already in flight — its response predates this
          // invalidation but will still commit the field as fresh. Remember
          // when each dropped invalidation arrived so fetch-settle can
          // re-announce it when such a fetch loads the field.
          if (staleInvalidateFields.length < invalidateFields.length) {
            let droppedForItem = itemDroppedFieldInvalidations.get(itemKey);
            for (const field of invalidateFields) {
              if (staleInvalidateFields.includes(field)) continue;

              if (!droppedForItem) {
                droppedForItem = new Map();
                itemDroppedFieldInvalidations.set(itemKey, droppedForItem);
              }
              const existingDropped = droppedForItem.get(field);
              droppedForItem.set(field, {
                invalidatedAt: Date.now(),
                priority: higherFetchType(existingDropped?.priority, priority),
              });
            }
          }

          if (staleInvalidateFields.length === 0) continue;

          staleInvalidateFieldsByItemKey.set(itemKey, staleInvalidateFields);
        }

        // Keep map-based tracking in sync before the state update so selectors
        // that read these maps see the same invalidation transaction. Each
        // field keeps the highest priority it has been invalidated with since
        // it was last reloaded.
        for (const [
          itemKey,
          staleInvalidateFields,
        ] of staleInvalidateFieldsByItemKey) {
          let pendingFields = itemPendingInvalidationFields.get(itemKey);
          if (!pendingFields) {
            pendingFields = new Map();
            itemPendingInvalidationFields.set(itemKey, pendingFields);
          }

          const fullInvalidationPriority =
            itemsPendingFullInvalidation.get(itemKey);
          const loadedFields = store.state.itemLoadedFields[itemKey];

          for (const field of staleInvalidateFields) {
            let fieldPriority = higherFetchType(
              pendingFields.get(field),
              priority,
            );
            // A field not reloaded since an unresolved full invalidation is
            // still owed at the marker's priority — absorb it into the field
            // entry, which supersedes the marker for this field from now on.
            if (
              fullInvalidationPriority !== undefined &&
              loadedFields !== '*' &&
              !(loadedFields?.includes(field) ?? false)
            ) {
              fieldPriority = higherFetchType(
                fullInvalidationPriority,
                fieldPriority,
              );
            }
            pendingFields.set(field, fieldPriority);
          }
        }

        store.produceState(
          (draft) => {
            for (const [
              itemKey,
              staleInvalidateFields,
            ] of staleInvalidateFieldsByItemKey) {
              const loadedFields = draft.itemLoadedFields[itemKey];
              if (!loadedFields) continue;

              if (loadedFields !== '*') {
                draft.itemLoadedFields[itemKey] = loadedFields.filter(
                  (f) => !staleInvalidateFields.includes(f),
                );
              }
              const existingInvalidationFields =
                draft.itemFieldInvalidationFields[itemKey] ?? [];
              draft.itemFieldInvalidationFields[itemKey] = Array.from(
                new Set([
                  ...existingInvalidationFields,
                  ...staleInvalidateFields,
                ]),
              ).sort();
            }
          },
          { action: 'invalidate-item-fields' },
        );

        // Emit invalidation events so hooks can refetch their stale fields.
        // Items where no invalidated field was loaded have nothing stale to
        // re-announce; hooks requesting such fields already treat them as
        // missing and fetch immediately on their own.
        // The event carries the INCOMING priority only: fields owed to
        // earlier invalidations keep their own tracked per-field priorities,
        // and merging them into the event would escalate unrelated
        // lower-priority refetches (e.g. break the realtime throttle).
        for (const [
          itemKey,
          staleInvalidateFields,
        ] of staleInvalidateFieldsByItemKey) {
          itemInvalidationWasTriggered.delete(itemKey);
          emitInvalidateItem({
            priority,
            itemKey,
            invalidateFields: staleInvalidateFields,
          });
        }
      } else {
        invalidateItem(itemPayload, priority);
      }
    }
  }

  function invalidateItem(
    itemId: ItemPayload | ItemPayload[] | FilterItem,
    priority: FetchType = 'highPriority',
  ) {
    if (!fetchItemFn) return;

    const itemsKey = getItemsKeyArray(itemId);

    for (const { itemKey, payload } of itemsKey) {
      const item = store.state.itemQueries[itemKey];

      if (!item) continue;

      const effectiveLoadedFields = getInvalidationBaselineFields(itemKey);

      const itemWasFullyLoaded =
        partialResources && effectiveLoadedFields === '*';
      const existingPendingFields = itemPendingInvalidationFields.get(itemKey);
      const trackedInvalidationFields =
        partialResources && !itemWasFullyLoaded
          ? Array.from(
              new Set([
                ...(effectiveLoadedFields === '*'
                  ? []
                  : (effectiveLoadedFields ?? [])),
                ...(existingPendingFields?.keys() ?? []),
              ]),
            ).sort()
          : [];
      const currentInvalidationPriority = item.refetchOnMount
        ? fetchTypePriority[item.refetchOnMount]
        : -1;

      if (currentInvalidationPriority >= fetchTypePriority[priority]) continue;

      // Update the invalidation tracking maps before the state change so
      // subscribers notified by it see the same invalidation transaction.
      // This invalidation itself only propagates at the INCOMING priority;
      // fields owed to earlier invalidations keep their own tracked
      // priorities instead of escalating the whole item (which would e.g.
      // break the realtime throttle for every later realtime invalidation).
      if (itemWasFullyLoaded) {
        // No enumerable field list for a '*' item — record the durable
        // full-invalidation marker so catch-up hooks refetch their own fields
        // instead of trusting the stale snapshot. The marker keeps the
        // highest priority it was invalidated with; per-field entries fold
        // into it since the marker now owes every field until a '*' reload.
        let markerPriority = higherFetchType(
          itemsPendingFullInvalidation.get(itemKey),
          priority,
        );
        if (existingPendingFields) {
          for (const fieldPriority of existingPendingFields.values()) {
            markerPriority = higherFetchType(fieldPriority, markerPriority);
          }
        }
        itemsPendingFullInvalidation.set(itemKey, markerPriority);
        itemPendingInvalidationFields.delete(itemKey);
      } else if (trackedInvalidationFields.length > 0) {
        const markerPriority = itemsPendingFullInvalidation.get(itemKey);
        const loadedFields = store.state.itemLoadedFields[itemKey];
        const pendingFields =
          existingPendingFields ?? new Map<string, FetchType | null>();

        for (const field of trackedInvalidationFields) {
          let fieldPriority = higherFetchType(
            pendingFields.get(field),
            priority,
          );
          // A field not reloaded since an unresolved full invalidation is
          // still owed at the marker's priority — absorb it into the field
          // entry, which supersedes the marker for this field from now on.
          if (
            markerPriority !== undefined &&
            loadedFields !== '*' &&
            !(loadedFields?.includes(field) ?? false)
          ) {
            fieldPriority = higherFetchType(markerPriority, fieldPriority);
          }
          pendingFields.set(field, fieldPriority);
        }
        itemPendingInvalidationFields.set(itemKey, pendingFields);
      } else {
        itemPendingInvalidationFields.delete(itemKey);
      }
      itemInvalidationWasTriggered.delete(itemKey);

      store.produceState(
        (draft) => {
          const query = draft.itemQueries[itemKey];
          if (!query) return;

          query.refetchOnMount = priority;

          // Clear loaded fields so all hooks refetch their fields
          if (partialResources) {
            draft.itemLoadedFields[itemKey] = [];
            delete draft.itemFieldInvalidationFields[itemKey];
          }
        },
        { action: 'invalidate-item' },
      );

      emitInvalidateItem({ priority, itemKey });

      if (onInvalidateItem) {
        const itemState = store.state.items[itemKey];

        if (itemState) {
          onInvalidateItem({ priority, itemState, payload });
        }
      }
    }
  }

  /**
   * Called when a fetch settles for `itemKeys` (item fetches and list fetches
   * that committed the items). Per-field invalidations of never-loaded fields
   * are dropped at invalidation time (see `invalidateQueryAndItems`) — but a
   * fetch that STARTED BEFORE such an invalidation commits a response
   * produced before it, so the just-loaded value may already be stale.
   * Re-announce those invalidations as a regular per-field invalidation (the
   * field now has a displayable value). Fields loaded by a fetch started
   * after the invalidation are fresh relative to it — their record is simply
   * discarded.
   */
  function reannounceInvalidationsDroppedDuringFetch(
    itemKeys: string[],
    fetchStartedAt: number,
  ): void {
    for (const itemKey of itemKeys) {
      const droppedForItem = itemDroppedFieldInvalidations.get(itemKey);
      if (!droppedForItem) continue;

      const loadedFields = store.state.itemLoadedFields[itemKey];
      let staleFieldPriorities: Map<string, FetchType> | undefined;
      let stalePriority: FetchType | undefined;

      for (const [field, dropped] of droppedForItem) {
        const fieldIsLoaded =
          loadedFields === '*' || (loadedFields?.includes(field) ?? false);
        // Still unloaded: nothing was committed for the field, keep waiting
        // for a fetch that loads it.
        if (!fieldIsLoaded) continue;

        droppedForItem.delete(field);

        if (dropped.invalidatedAt > fetchStartedAt) {
          (staleFieldPriorities ??= new Map()).set(field, dropped.priority);
          stalePriority = higherFetchType(stalePriority, dropped.priority);
        }
      }

      if (droppedForItem.size === 0) {
        itemDroppedFieldInvalidations.delete(itemKey);
      }

      if (!staleFieldPriorities || !stalePriority) continue;

      const staleFields = Array.from(staleFieldPriorities.keys());

      // Same transaction as the per-field path of `invalidateQueryAndItems`:
      // record the pending fields, strip them from the loaded metadata, and
      // re-emit the invalidation event.
      let pendingFields = itemPendingInvalidationFields.get(itemKey);
      if (!pendingFields) {
        pendingFields = new Map();
        itemPendingInvalidationFields.set(itemKey, pendingFields);
      }
      for (const [field, fieldPriority] of staleFieldPriorities) {
        pendingFields.set(
          field,
          higherFetchType(pendingFields.get(field), fieldPriority),
        );
      }

      const staleFieldsToApply = staleFields;
      store.produceState(
        (draft) => {
          const draftLoadedFields = draft.itemLoadedFields[itemKey];
          if (!draftLoadedFields) return;

          if (draftLoadedFields !== '*') {
            draft.itemLoadedFields[itemKey] = draftLoadedFields.filter(
              (f) => !staleFieldsToApply.includes(f),
            );
          }
          const existingInvalidationFields =
            draft.itemFieldInvalidationFields[itemKey] ?? [];
          draft.itemFieldInvalidationFields[itemKey] = Array.from(
            new Set([...existingInvalidationFields, ...staleFieldsToApply]),
          ).sort();
        },
        { action: 'invalidate-item-fields' },
      );

      itemInvalidationWasTriggered.delete(itemKey);
      emitInvalidateItem({
        priority: stalePriority,
        itemKey,
        invalidateFields: staleFields,
      });
    }
  }

  function startItemMutation(
    itemId: ItemPayload | ItemPayload[] | FilterItem,
  ): () => void {
    const itemsKey = getItemsKeyArray(itemId);

    const endMutations: (() => boolean)[] = [];

    for (const { itemKey, payload } of itemsKey) {
      if (fetchItemFn) {
        const itemScheduler = getOrCreateItemScheduler(itemKey, payload);
        endMutations.push(itemScheduler.startMutation(itemKey));
      }

      for (const [queryKey, query] of Object.entries(store.state.queries)) {
        if (query.items.includes(itemKey)) {
          endMutations.push(
            getOrCreateQueryScheduler(queryKey).startMutation(queryKey),
          );
        }
      }
    }

    return () => {
      for (const endMutation of endMutations) {
        endMutation();
      }
    };
  }

  function applyOptimisticListUpdates(itemKeys: string[]) {
    if (!optimisticListUpdates) return;

    const queriesToInvalidate = new Map<string, QueryPayload>();
    const changedQueryKeys = new Set<string>();
    const deferredOptimisticQueryInvalidations =
      deferredOptimisticQueryInvalidationsStack[
        deferredOptimisticQueryInvalidationsStack.length - 1
      ];

    store.produceState((draftState) => {
      for (const itemKey of itemKeys) {
        const item = draftState.items[itemKey];

        if (!item) continue;

        for (const {
          queries,
          filterItem,
          appendNewTo = 'end',
          invalidateQueries,
          sort,
        } of optimisticListUpdates) {
          const relatedFilterQueries = getQueriesKeyArray(queries);

          for (const { key: queryKey, payload } of relatedFilterQueries) {
            const queryState = draftState.queries[queryKey];

            if (filterItem) {
              const itemShouldBeIncluded = filterItem(item);

              if (itemShouldBeIncluded === null) continue;

              if (itemShouldBeIncluded) {
                captureAndLockOptimisticMutationQuery(queryKey);

                if (!queryState) {
                  draftState.queries[queryKey] = {
                    status: 'success',
                    items: [itemKey],
                    error: null,
                    hasMore: false,
                    payload,
                    refetchOnMount: 'lowPriority',
                    wasLoaded: true,
                  };

                  changedQueryKeys.add(queryKey);

                  continue;
                }

                if (queryState.items.includes(itemKey)) continue;

                if (invalidateQueries) {
                  queriesToInvalidate.set(queryKey, payload);
                }

                if (appendNewTo === 'end') {
                  queryState.items.push(itemKey);
                } else {
                  queryState.items.unshift(itemKey);
                }
                changedQueryKeys.add(queryKey);
              } else {
                if (!queryState) continue;

                const itemIndex = queryState.items.indexOf(itemKey);

                if (itemIndex !== -1) {
                  captureAndLockOptimisticMutationQuery(queryKey);

                  if (invalidateQueries) {
                    queriesToInvalidate.set(queryKey, queryState.payload);
                  }

                  queryState.items.splice(itemIndex, 1);
                  changedQueryKeys.add(queryKey);
                }
              }
            }

            if (sort) {
              if (!queryState) continue;

              const queryHasItem = queryState.items.includes(itemKey);

              if (!queryHasItem) continue;

              captureAndLockOptimisticMutationQuery(queryKey);

              queryState.items = sortBy(
                queryState.items,
                (itemId) => {
                  const itemState = store.state.items[itemId];
                  const itemPayloadFromState =
                    store.state.itemQueries[itemId]?.payload;

                  if (!itemState || !itemPayloadFromState) return Infinity;

                  return sort.sortBy(itemState, itemPayloadFromState);
                },
                { order: sort.order },
              );
              changedQueryKeys.add(queryKey);
            }
          }
        }
      }
    });

    for (const queryKey of changedQueryKeys) {
      publishQuerySnapshot(queryKey);
    }

    if (queriesToInvalidate.size === 0) return;

    if (deferredOptimisticQueryInvalidations) {
      for (const [queryKey, queryPayload] of queriesToInvalidate) {
        deferredOptimisticQueryInvalidations.set(queryKey, queryPayload);
      }

      return;
    }

    invalidateQueryAndItems({
      queryPayload: [...queriesToInvalidate.values()],
      itemPayload: false,
    });
  }

  function getSuccessInvalidationQueryPayloads(
    deferredOptimisticQueryInvalidations: ReadonlyMap<string, QueryPayload>,
    revalidateQueries: FilterQuery | null,
    shouldRevalidateOnSuccess: boolean,
  ): QueryPayload[] {
    const queryPayloads = new Map(deferredOptimisticQueryInvalidations);

    if (shouldRevalidateOnSuccess && revalidateQueries) {
      for (const { key, payload } of getQueriesKeyArray(revalidateQueries)) {
        queryPayloads.set(key, payload);
      }
    }

    return [...queryPayloads.values()];
  }

  type RevalidateOnSuccessOption =
    | boolean
    | 'queries'
    | FilterQuery
    | { queries: FilterQuery; items?: boolean };

  function normalizeRevalidateOnSuccessOption(
    revalidateOnSuccess: RevalidateOnSuccessOption | undefined,
  ): {
    shouldRevalidate: boolean;
    includeItems: boolean;
    queryFilter: FilterQuery | null;
  } {
    if (!revalidateOnSuccess) {
      return {
        shouldRevalidate: false,
        includeItems: false,
        queryFilter: null,
      };
    }

    if (revalidateOnSuccess === true) {
      return {
        shouldRevalidate: true,
        includeItems: true,
        queryFilter: () => true,
      };
    }

    if (revalidateOnSuccess === 'queries') {
      return {
        shouldRevalidate: true,
        includeItems: false,
        queryFilter: () => true,
      };
    }

    if (typeof revalidateOnSuccess === 'function') {
      return {
        shouldRevalidate: true,
        includeItems: true,
        queryFilter: revalidateOnSuccess,
      };
    }

    return {
      shouldRevalidate: true,
      includeItems: revalidateOnSuccess.items ?? true,
      queryFilter: revalidateOnSuccess.queries,
    };
  }

  function updateItemState(
    itemIds: ItemPayload | ItemPayload[] | FilterItem,
    produceNewData: (
      draftData: ItemState,
      itemPayload: ItemPayload,
    ) => void | ItemState,
    options: { ifNothingWasUpdated?: () => void } = {},
  ): boolean {
    const itemKeys = getItemsKeyArray(itemIds);

    let someItemWasUpdated = false;
    const updatedItemKeys = new Set<string>();

    store.batch(
      () => {
        store.produceState((draftState) => {
          for (const { itemKey, payload } of itemKeys) {
            const item = draftState.items[itemKey];

            if (!item) continue;

            someItemWasUpdated = true;
            updatedItemKeys.add(itemKey);
            const newData = produceNewData(item, payload);

            if (newData) {
              draftState.items[itemKey] = newData;
            }
          }
        });

        if (someItemWasUpdated) {
          applyOptimisticListUpdates(itemKeys.map((i) => i.itemKey));
        }

        if (options.ifNothingWasUpdated && !someItemWasUpdated) {
          options.ifNothingWasUpdated();
        }
      },
      { type: 'update-item-state' },
    );

    if (updatedItemKeys.size > 0) {
      const relatedQueryKeys = new Set<string>();
      for (const { itemKey, payload } of itemKeys) {
        if (!updatedItemKeys.has(itemKey)) continue;
        publishItemSnapshot(itemKey);
        for (const { key } of getQueriesRelatedToItem(payload)) {
          relatedQueryKeys.add(key);
        }
      }

      for (const queryKey of relatedQueryKeys) {
        publishQuerySnapshot(queryKey);
      }
    }

    return someItemWasUpdated;
  }

  function addItemToState(
    itemPayload: ItemPayload,
    data: ItemState,
    options: {
      addItemToQueries?: {
        queries: QueryPayload[] | FilterQuery | QueryPayload;
        appendTo: 'start' | 'end' | ((itemsPayload: ItemPayload[]) => number);
      };
    } = {},
  ) {
    const itemKey = getItemKey(itemPayload);

    store.batch(() => {
      store.produceState(
        (draftState) => {
          draftState.items[itemKey] = data;
          draftState.itemQueries[itemKey] = {
            status: 'success',
            wasLoaded: true,
            refetchOnMount: false,
            error: null,
            payload: klona(itemPayload),
          };

          if (options.addItemToQueries) {
            const queries = getQueriesKeyArray(
              options.addItemToQueries.queries,
            );

            for (const { key } of queries) {
              const queryState = draftState.queries[key];
              if (!queryState) continue;

              if (queryState.items.includes(itemKey)) continue;

              captureAndLockOptimisticMutationQuery(key);

              if (options.addItemToQueries.appendTo === 'start') {
                queryState.items.unshift(itemKey);
              } else if (options.addItemToQueries.appendTo === 'end') {
                queryState.items.push(itemKey);
              } else {
                const index = options.addItemToQueries.appendTo(
                  filterAndMap(queryState.items, (itemKey2) => {
                    const payload = draftState.itemQueries[itemKey2]?.payload;
                    return payload ?? false;
                  }),
                );

                queryState.items.splice(index, 0, itemKey);
              }
            }
          }
        },
        { action: 'create-item-state' },
      );

      applyOptimisticListUpdates([itemKey]);
    });

    publishItemSnapshot(itemKey);
    for (const { key } of getQueriesRelatedToItem(itemPayload)) {
      publishQuerySnapshot(key);
    }
  }

  function deleteItemState(itemId: ItemPayload | ItemPayload[] | FilterItem) {
    const itemsId = getItemsKeyArray(itemId);
    const relatedQueryKeys = new Set<string>();
    for (const { payload } of itemsId) {
      for (const { key } of getQueriesRelatedToItem(payload)) {
        relatedQueryKeys.add(key);
      }
    }

    store.produceState(
      (draftState) => {
        for (const { itemKey } of itemsId) {
          draftState.items[itemKey] = null;
          draftState.itemQueries[itemKey] = null;
          delete draftState.itemLoadedFields[itemKey];
          delete draftState.itemFieldInvalidationFields[itemKey];

          for (const [queryKey, query] of Object.entries(draftState.queries)) {
            if (query.items.includes(itemKey)) {
              captureAndLockOptimisticMutationQuery(queryKey);
              query.items = query.items.filter((i) => i !== itemKey);
            }
          }
        }
      },
      { action: 'delete-item-state' },
    );

    for (const { itemKey } of itemsId) {
      itemPendingInvalidationFields.delete(itemKey);
      itemsPendingFullInvalidation.delete(itemKey);
      itemDroppedFieldInvalidations.delete(itemKey);
      itemInvalidationWasTriggered.delete(itemKey);
      publishItemSnapshot(itemKey);
    }

    deleteItemFetchResources(itemsId);

    for (const queryKey of relatedQueryKeys) {
      publishQuerySnapshot(queryKey);
    }
  }

  function resetInvalidationTracking() {
    queryInvalidationWasTriggered.clear();
    itemInvalidationWasTriggered.clear();
    itemPendingInvalidationFields.clear();
    itemsPendingFullInvalidation.clear();
    itemDroppedFieldInvalidations.clear();
  }

  type ListQueryMutationArgs<T> = {
    /**
     * Applies optimistic updates for the affected item payloads before the
     * mutation runs. Return `false` to cancel the mutation before the async
     * mutation function is called.
     */
    optimisticUpdate?: (payload: MutationPayloadToUse) => void | boolean;
    /** Performs the server mutation for the affected item payloads. */
    mutation: (payload: MutationPayloadToUse) => Promise<T>;
    /** Controls query/item invalidation after a successful online mutation. */
    revalidateOnSuccess?: RevalidateOnSuccessOption;
    /** Called after a successful online mutation. */
    onSuccess?: (
      response: UnwrapTSDFResult<Awaited<T>>,
      payload: MutationPayloadToUse,
    ) => void;
    /** Called after a failed mutation with the normalized mutation error. */
    onError?: (error: StoreMutationError | MutationSkipped) => void;
    /**
     * Passes `{ silentErrors: true }` to `onMutationError`.
     *
     * The handler is still called so centralized logging and recovery can run,
     * but UI handlers can suppress user-facing notifications.
     */
    silentErrors?: boolean;
    /** Debounces mutations with the same context and payload. Superseded calls are skipped. */
    debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
  };

  type ListQueryOnlineMutationArgs<T> = ListQueryMutationArgs<T> & {
    offline?: undefined;
    upload?: undefined;
  };

  type ListQueryOfflineMutationArgs<T> = ListQueryMutationArgs<T> & {
    /**
     * When provided, the mutation tries the direct request while the session is
     * online, but degrades into durable offline queueing when the session is
     * already offline or the failure is classified as offline/outage. Callers
     * must not assume a successful result always includes the server payload.
     */
    offline: TOfflineOperations extends null
      ? never
      : OfflineMutationInput<Exclude<TOfflineOperations, null>>;
    upload?: OfflineMutationUploadsInput;
  };

  /**
   * Runs a list-query mutation for one or more existing item payloads, or for a
   * mutation with no current item target.
   *
   * Pass `null` for create mutations that do not have a pre-generated item
   * payload yet. Returns the direct server result when offline replay is not
   * configured for this call.
   */
  async function performMutation<T>(
    payload: MutationPayload,
    args: ListQueryOnlineMutationArgs<T>,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a list-query mutation that may fall back to durable offline queueing.
   *
   * Pass `null` for create mutations that do not have a pre-generated item
   * payload yet. When the mutation is queued, the result is `{ kind: 'queued' }`
   * instead of the server payload.
   */
  async function performMutation<T>(
    payload: MutationPayload,
    args: ListQueryOfflineMutationArgs<T>,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>(
    payload: MutationPayload,
    args: ListQueryOnlineMutationArgs<T> | ListQueryOfflineMutationArgs<T>,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>(
    payload: MutationPayload,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      onSuccess,
      onError,
      debounce,
      offline,
      upload,
    }: ListQueryOnlineMutationArgs<T> | ListQueryOfflineMutationArgs<T>,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  > {
    const payloadToUse: MutationPayloadToUse = payload === null ? [] : payload;

    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(
        toStoreMutationError(
          new OfflineSessionUnavailableError(),
          errorNormalizer,
        ),
      );
    }

    const affectedItemEntries = optimisticUpdate
      ? getItemsKeyArray(payloadToUse)
      : undefined;
    const affectedItems = affectedItemEntries
      ? affectedItemEntries.map(({ payload: p }) => p)
      : resolveAffectedItems(payloadToUse);
    const normalizedRevalidateOnSuccess =
      normalizeRevalidateOnSuccessOption(revalidateOnSuccess);
    const mutationId = getAutoIncrementId();

    let itemRollbackSnapshots: MutationItemRollbackSnapshot[] = [];
    const deferredOptimisticQueryInvalidations = new Map<
      string,
      QueryPayload
    >();
    const optimisticMutationQueryContext: OptimisticMutationQueryContext = {
      dynamicQueryMutationEnders: [],
      lockedQueryKeys: new Set<string>(),
      queryRollbackSnapshots: new Map<string, MutationQueryRollbackSnapshot>(),
    };

    if (affectedItemEntries) {
      itemRollbackSnapshots = affectedItemEntries.map(({ itemKey }) => {
        const pendingInvalidationFields =
          itemPendingInvalidationFields.get(itemKey);
        return {
          itemKey,
          item: klona(store.state.items[itemKey]),
          itemQuery: klona(store.state.itemQueries[itemKey]),
          loadedFields: klona(store.state.itemLoadedFields[itemKey]),
          invalidationFields: klona(
            store.state.itemFieldInvalidationFields[itemKey],
          ),
          pendingInvalidationFields:
            pendingInvalidationFields && new Map(pendingInvalidationFields),
          invalidationWasTriggered: itemInvalidationWasTriggered.has(itemKey),
        };
      });
    }

    storeEvents.emit('mutationStart', { mutationId, items: affectedItems });

    const directMutation = async () =>
      unwrapTSDFResult(await mutation(payloadToUse));

    const result = await performMutationWithLifecycle(
      () => {
        const endBaseMutations = startItemMutation(payloadToUse);

        return () => {
          endBaseMutations();

          for (const endQueryMutation of optimisticMutationQueryContext.dynamicQueryMutationEnders) {
            endQueryMutation();
          }
        };
      },
      offline
        ? () =>
            runHybridOfflineMutation(
              offlineController,
              offline,
              upload,
              directMutation,
            )
        : async () => ({
            kind: 'online' as const,
            data: await directMutation(),
          }),
      (exception) => {
        const error = toStoreMutationError(exception, errorNormalizer);
        const queryRollbackSnapshots = [
          ...optimisticMutationQueryContext.queryRollbackSnapshots.values(),
        ];

        if (itemRollbackSnapshots.length > 0 || queryRollbackSnapshots.length) {
          restoreMutationRollbackState({
            itemSnapshots: itemRollbackSnapshots,
            querySnapshots: queryRollbackSnapshots,
          });
        }

        if (onMutationError) {
          onMutationError(exception, { silentErrors });
        }

        if (onError) {
          onError(error);
        }

        return error;
      },
      optimisticUpdate
        ? () => {
            deferredOptimisticQueryInvalidationsStack.push(
              deferredOptimisticQueryInvalidations,
            );
            optimisticMutationQueryContextStack.push(
              optimisticMutationQueryContext,
            );

            try {
              return runWithBroadcastConsistency('optimistic', () =>
                optimisticUpdate(payloadToUse),
              );
            } finally {
              optimisticMutationQueryContextStack.pop();
              deferredOptimisticQueryInvalidationsStack.pop();
            }
          }
        : undefined,
      (result) => {
        const successInvalidationQueryPayloads =
          result.kind === 'online'
            ? getSuccessInvalidationQueryPayloads(
                deferredOptimisticQueryInvalidations,
                normalizedRevalidateOnSuccess.queryFilter,
                normalizedRevalidateOnSuccess.shouldRevalidate,
              )
            : [];

        if (
          result.kind === 'online' &&
          (normalizedRevalidateOnSuccess.shouldRevalidate ||
            successInvalidationQueryPayloads.length > 0)
        ) {
          invalidateQueryAndItems({
            itemPayload:
              !normalizedRevalidateOnSuccess.includeItems ||
              affectedItems.length === 0
                ? false
                : payloadToUse,
            queryPayload:
              successInvalidationQueryPayloads.length > 0
                ? successInvalidationQueryPayloads
                : false,
          });
        }

        if (onSuccess && result.kind === 'online') {
          onSuccess(result.data, payloadToUse);
        }
      },
      debounce,
      blockWindowClose ?? undefined,
    );

    storeEvents.emit('mutationEnd', {
      mutationId,
      items: affectedItems,
      status: result.ok
        ? 'success'
        : result.error === mutationSkipped
          ? 'skipped'
          : 'error',
    });

    if (import.meta.env.TEST) {
      if (offline && result.ok && result.value.kind === 'queued') {
        onOfflineTimelineEvent?.({
          operation: offline.operation,
          phase: 'queued',
        });
      }
    }

    if (!offline && result.ok && result.value.kind === 'online') {
      return Result.ok(result.value.data);
    }

    return result;
  }

  return {
    storeEvents,
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    invalidateQueryAndItems,
    invalidateItem,
    reannounceInvalidationsDroppedDuringFetch,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    resetInvalidationTracking,
    performMutation,
  };
}
