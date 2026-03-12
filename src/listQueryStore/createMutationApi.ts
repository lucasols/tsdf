import { filterAndMap, sortBy } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { Result, unknownToError, type Result as ResultType } from 't-result';
import { Store } from 't-state';
import { offlineSessionUnavailableError } from '../persistentStorage/offline/storeController';
import { FetchType, getAutoIncrementId } from '../requestScheduler';
import type {
  AnyOfflineOperationDefinition,
  ListQueryOfflineEntityRef,
  OfflineMutationDescriptor,
  OperationInput,
} from '../persistentStorage/offline/types';
import { type SnapshotConsistency } from '../utils/browserTabsSync';
import {
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from '../utils/performMutation';
import {
  fetchTypePriority,
  StoreError,
  ValidPayload,
  ValidStoreState,
} from '../utils/storeShared';
import { type FilterItemFn, type FilterQueryFn } from './createFetchApi';
import {
  type OnListQueryInvalidate,
  type OnListQueryItemInvalidate,
  type OptimisticListUpdate,
  type PartialResourcesConfig,
  type TSFDListQueryState,
} from './types';

export type ListQueryStoreStoreEvents<ItemPayload extends ValidPayload> = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number; items: ItemPayload[] };
  /** Emitted when a mutation completes or fails */
  mutationEnd: { mutationId: number; items: ItemPayload[]; success: boolean };
};

type InvalidateQueryEvent = { priority: FetchType; queryKey: string };
type InvalidateItemEvent = {
  priority: FetchType;
  itemKey: string;
  invalidateFields?: string[];
};

type SchedulerWithMutation = { startMutation: (key: string) => () => boolean };

type InternalListQueryOfflineOperations<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  AnyOfflineOperationDefinition & {
    getEntityRefs: (ctx: {
      input: __LEGIT_ANY__;
    }) => ListQueryOfflineEntityRef<ItemPayload>[];
  }
> &
  ([ItemState | QueryPayload | ItemPayload] extends [never] ? never : unknown);

export type CreateMutationApiOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends InternalListQueryOfflineOperations<
    ItemState,
    QueryPayload,
    ItemPayload
  > = InternalListQueryOfflineOperations<ItemState, QueryPayload, ItemPayload>,
> = {
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>;
  fetchItemFn?: (
    payload: ItemPayload,
    options: { signal: AbortSignal; fields?: string[] },
  ) => Promise<ItemState>;
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
    options: { silentErrors?: boolean },
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
  offlineController?: {
    canQueueMutation: () => boolean;
    queueMutation: <TName extends keyof TOfflineOperations>(args: {
      operationName: TName;
      input: OperationInput<TOfflineOperations, TName>;
    }) => Promise<void>;
  } | null;
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
};

export function createMutationApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends InternalListQueryOfflineOperations<
    ItemState,
    QueryPayload,
    ItemPayload
  > = InternalListQueryOfflineOperations<ItemState, QueryPayload, ItemPayload>,
>({
  store,
  fetchItemFn,
  partialResources,
  optimisticListUpdates,
  onInvalidateQuery,
  onInvalidateItem,
  onMutationError,
  errorNormalizer,
  getItemKey,
  getQueriesKeyArray,
  getQueriesRelatedToItem,
  getItemsKeyArray,
  getOrCreateItemScheduler,
  getOrCreateQueryScheduler,
  deleteItemFetchResources,
  emitInvalidateQuery,
  emitInvalidateItem,
  blockWindowClose,
  offlineController,
  runWithBroadcastConsistency,
  publishQuerySnapshot,
  publishItemSnapshot,
}: CreateMutationApiOptions<
  ItemState,
  QueryPayload,
  ItemPayload,
  TOfflineOperations
>) {
  type FilterQuery = FilterQueryFn<QueryPayload>;
  type FilterItem = FilterItemFn<ItemState, ItemPayload>;
  type MutationPayload =
    | ItemPayload
    | ItemPayload[]
    | FilterItem
    | undefined
    | null;
  type MutationPayloadToUse = ItemPayload | ItemPayload[] | FilterItem;

  const storeEvents = evtmitter<ListQueryStoreStoreEvents<ItemPayload>>();

  function resolveAffectedItems(payload: MutationPayloadToUse): ItemPayload[] {
    if (Array.isArray(payload)) return payload;
    if (typeof payload === 'function') {
      return getItemsKeyArray(payload).map((item) => item.payload);
    }
    return [payload];
  }

  const queryInvalidationWasTriggered = new Set<string>();
  const itemInvalidationWasTriggered = new Set<string>();
  const itemFieldInvalidationPriorities = new Map<string, FetchType>();
  const itemPendingInvalidationFields = new Map<string, string[]>();

  function invalidateQueryAndItems({
    itemPayload,
    queryPayload,
    type: priority = 'highPriority',
    fields: invalidateFields,
  }: {
    itemPayload: ItemPayload | ItemPayload[] | FilterItem | false;
    queryPayload: QueryPayload | QueryPayload[] | FilterQuery | false;
    type?: FetchType;
    fields?: string[];
  }) {
    const queriesKey = queryPayload ? getQueriesKeyArray(queryPayload) : [];

    for (const { key, payload } of queriesKey) {
      const queryState = store.state.queries[key];

      if (!queryState) continue;

      const currentInvalidationPriority = queryState.refetchOnMount
        ? fetchTypePriority[queryState.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

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
        const nextInvalidationPriorityByItemKey = new Map<string, FetchType>();
        const nextPendingInvalidationFieldsByItemKey = new Map<
          string,
          string[]
        >();

        for (const { itemKey } of itemsKey) {
          const existingPriority = itemFieldInvalidationPriorities.get(itemKey);
          const existingPendingFields =
            itemPendingInvalidationFields.get(itemKey) ?? [];
          nextPendingInvalidationFieldsByItemKey.set(
            itemKey,
            Array.from(
              new Set([...existingPendingFields, ...invalidateFields]),
            ).sort(),
          );

          nextInvalidationPriorityByItemKey.set(
            itemKey,
            existingPriority &&
              fetchTypePriority[existingPriority] > fetchTypePriority[priority]
              ? existingPriority
              : priority,
          );
        }

        // Keep map-based tracking in sync before the state update so selectors
        // that read these maps see the same invalidation transaction.
        for (const [
          itemKey,
          itemPriority,
        ] of nextInvalidationPriorityByItemKey) {
          itemFieldInvalidationPriorities.set(itemKey, itemPriority);
        }
        for (const [
          itemKey,
          invalidationFields,
        ] of nextPendingInvalidationFieldsByItemKey) {
          itemPendingInvalidationFields.set(itemKey, invalidationFields);
        }

        store.produceState(
          (draft) => {
            for (const { itemKey } of itemsKey) {
              const loadedFields = draft.itemLoadedFields[itemKey];
              if (!loadedFields) continue;

              draft.itemLoadedFields[itemKey] = loadedFields.filter(
                (f) => !invalidateFields.includes(f),
              );
              const existingInvalidationFields =
                draft.itemFieldInvalidationFields[itemKey] ?? [];
              draft.itemFieldInvalidationFields[itemKey] = Array.from(
                new Set([...existingInvalidationFields, ...invalidateFields]),
              ).sort();
            }
          },
          { action: 'invalidate-item-fields' },
        );

        // Emit invalidation events so hooks can detect missing fields and refetch
        for (const { itemKey } of itemsKey) {
          itemInvalidationWasTriggered.delete(itemKey);
          const itemPriority =
            nextInvalidationPriorityByItemKey.get(itemKey) ?? priority;
          emitInvalidateItem({
            priority: itemPriority,
            itemKey,
            invalidateFields,
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

      const trackedInvalidationFields = partialResources
        ? Array.from(
            new Set([
              ...(store.state.itemLoadedFields[itemKey] ?? []),
              ...(itemPendingInvalidationFields.get(itemKey) ?? []),
            ]),
          ).sort()
        : [];
      const trackedInvalidationPriority =
        trackedInvalidationFields.length > 0
          ? itemFieldInvalidationPriorities.get(itemKey)
          : undefined;
      const nextInvalidationPriority =
        trackedInvalidationPriority &&
        fetchTypePriority[trackedInvalidationPriority] >
          fetchTypePriority[priority]
          ? trackedInvalidationPriority
          : priority;
      const currentInvalidationPriority = item.refetchOnMount
        ? fetchTypePriority[item.refetchOnMount]
        : -1;
      const newInvalidationPriority =
        fetchTypePriority[nextInvalidationPriority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const query = draft.itemQueries[itemKey];
          if (!query) return;

          query.refetchOnMount = nextInvalidationPriority;

          // Clear loaded fields so all hooks refetch their fields
          if (partialResources) {
            draft.itemLoadedFields[itemKey] = [];
            delete draft.itemFieldInvalidationFields[itemKey];
          }
        },
        { action: 'invalidate-item' },
      );

      if (trackedInvalidationFields.length > 0) {
        itemPendingInvalidationFields.set(itemKey, trackedInvalidationFields);
        itemFieldInvalidationPriorities.set(itemKey, nextInvalidationPriority);
      } else {
        itemPendingInvalidationFields.delete(itemKey);
        itemFieldInvalidationPriorities.delete(itemKey);
      }
      itemInvalidationWasTriggered.delete(itemKey);
      emitInvalidateItem({ priority: nextInvalidationPriority, itemKey });

      if (onInvalidateItem) {
        const itemState = store.state.items[itemKey];

        if (itemState) {
          onInvalidateItem({
            priority: nextInvalidationPriority,
            itemState,
            payload,
          });
        }
      }
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

    const queriesToInvalidate: QueryPayload[] = [];
    const changedQueryKeys = new Set<string>();

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

                if (invalidateQueries) queriesToInvalidate.push(payload);

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
                  if (invalidateQueries)
                    queriesToInvalidate.push(queryState.payload);

                  queryState.items.splice(itemIndex, 1);
                  changedQueryKeys.add(queryKey);
                }
              }
            }

            if (sort) {
              if (!queryState) continue;

              const queryHasItem = queryState.items.includes(itemKey);

              if (!queryHasItem) continue;

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

    if (queriesToInvalidate.length)
      invalidateQueryAndItems({
        queryPayload: queriesToInvalidate,
        itemPayload: false,
      });
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

          for (const query of Object.values(draftState.queries)) {
            if (query.items.includes(itemKey)) {
              query.items = query.items.filter((i) => i !== itemKey);
            }
          }
        }
      },
      { action: 'delete-item-state' },
    );

    for (const { itemKey } of itemsId) {
      itemFieldInvalidationPriorities.delete(itemKey);
      itemPendingInvalidationFields.delete(itemKey);
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
    itemFieldInvalidationPriorities.clear();
    itemPendingInvalidationFields.clear();
  }

  async function performMutation<T>(
    payload: MutationPayload,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      dontRevalidateOnError,
      getRelatedQueries = () => true,
      getRevalidateOnSuccessQueries = getRelatedQueries,
      onSuccess,
      onError,
      debounce,
      offline,
    }: {
      optimisticUpdate?: (payload: MutationPayloadToUse) => void | boolean;
      mutation: (payload: MutationPayloadToUse) => Promise<T>;
      revalidateOnSuccess?: boolean | 'queries';
      dontRevalidateOnError?: boolean;
      getRelatedQueries?: FilterQuery;
      getRevalidateOnSuccessQueries?: FilterQuery;
      onSuccess?: (response: Awaited<T>, payload: MutationPayloadToUse) => void;
      onError?: (error: StoreError | true) => void;
      silentErrors?: boolean;
      debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
      /**
       * When provided, the mutation is durably queued and replayed by the
       * offline sync controller. The immediate result only reflects queue
       * persistence.
       */
      offline?: OfflineMutationDescriptor<TOfflineOperations>;
    },
  ): Promise<ResultType<Awaited<T>, StoreError | true>> {
    const matchAllItems: FilterItem = () => true;
    const payloadToUse: MutationPayloadToUse = payload ?? matchAllItems;

    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(offlineSessionUnavailableError);
    }

    const affectedItems = resolveAffectedItems(payloadToUse);
    const mutationId = getAutoIncrementId();

    storeEvents.emit('mutationStart', { mutationId, items: affectedItems });

    const result = await performMutationWithLifecycle({
      startMutation: () => startItemMutation(payloadToUse),
      optimisticUpdate: optimisticUpdate
        ? () =>
            runWithBroadcastConsistency('optimistic', () =>
              optimisticUpdate(payloadToUse),
            )
        : undefined,
      debounce,
      blockWindowClose: blockWindowClose ?? undefined,
      mutation: async () => {
        if (offline && offlineController) {
          await offlineController.queueMutation({
            operationName: offline.operation,
            input: offline.input,
          });
          return __LEGIT_CAST__<Awaited<T>, undefined>(undefined);
        }

        return mutation(payloadToUse);
      },
      onSuccess: (result) => {
        if (revalidateOnSuccess && !offline) {
          invalidateQueryAndItems({
            itemPayload:
              revalidateOnSuccess === 'queries' ? false : payloadToUse,
            queryPayload: getRevalidateOnSuccessQueries,
          });
        }

        if (onSuccess && !offline) {
          onSuccess(result, payloadToUse);
        }
      },
      onError: (exception) => {
        const error = errorNormalizer(unknownToError(exception));

        if (!silentErrors && onMutationError) {
          onMutationError(exception, { silentErrors });
        }

        if (!dontRevalidateOnError) {
          invalidateQueryAndItems({
            itemPayload: payloadToUse,
            queryPayload: getRelatedQueries,
          });
        }

        if (onError) {
          onError(error);
        }

        return error;
      },
    });

    storeEvents.emit('mutationEnd', {
      mutationId,
      items: affectedItems,
      success: result.ok,
    });

    return result;
  }

  return {
    storeEvents,
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    itemFieldInvalidationPriorities,
    itemPendingInvalidationFields,
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    resetInvalidationTracking,
    performMutation,
  };
}
