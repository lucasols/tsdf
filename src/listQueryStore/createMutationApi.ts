import { filterAndMap, sortBy } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import { klona } from 'klona/json';
import { type Result, unknownToError } from 't-result';
import { Store } from 't-state';
import { FetchType } from '../requestScheduler';
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

type InvalidateQueryEvent = { priority: FetchType; queryKey: string };
type InvalidateItemEvent = {
  priority: FetchType;
  itemKey: string;
  invalidateFields?: string[];
};

type SchedulerWithMutation = {
  startMutation: (key: string) => () => boolean;
};

export type CreateMutationApiOptions<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
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
  emitInvalidateQuery: (event: InvalidateQueryEvent) => void;
  emitInvalidateItem: (event: InvalidateItemEvent) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
};

export function createMutationApi<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
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
  getItemsKeyArray,
  getOrCreateItemScheduler,
  getOrCreateQueryScheduler,
  emitInvalidateQuery,
  emitInvalidateItem,
  blockWindowClose,
}: CreateMutationApiOptions<ItemState, QueryPayload, ItemPayload>) {
  type FilterQuery = FilterQueryFn<QueryPayload>;
  type FilterItem = FilterItemFn<ItemState, ItemPayload>;
  type MutationPayload =
    | ItemPayload
    | ItemPayload[]
    | FilterItem
    | undefined
    | null;
  type MutationPayloadToUse = ItemPayload | ItemPayload[] | FilterItem;

  const queryInvalidationWasTriggered = new Set<string>();
  const itemInvalidationWasTriggered = new Set<string>();

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

        store.produceState(
          (draft) => {
            for (const { itemKey } of itemsKey) {
              const loadedFields = draft.itemLoadedFields[itemKey];
              if (!loadedFields) continue;

              draft.itemLoadedFields[itemKey] = loadedFields.filter(
                (f) => !invalidateFields.includes(f),
              );
              draft.itemFieldInvalidationFields[itemKey] = Array.from(
                new Set(invalidateFields),
              ).sort();
            }
          },
          { action: 'invalidate-item-fields' },
        );

        // Emit invalidation events so hooks can detect missing fields and refetch
        for (const { itemKey } of itemsKey) {
          itemInvalidationWasTriggered.delete(itemKey);
          emitInvalidateItem({
            priority,
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

      const currentInvalidationPriority = item.refetchOnMount
        ? fetchTypePriority[item.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

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

      itemInvalidationWasTriggered.delete(itemKey);
      emitInvalidateItem({ priority, itemKey });

      if (onInvalidateItem) {
        const itemState = store.state.items[itemKey];

        if (itemState) {
          onInvalidateItem({ priority, itemState, payload });
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

                  continue;
                }

                if (queryState.items.includes(itemKey)) continue;

                if (invalidateQueries) queriesToInvalidate.push(payload);

                if (appendNewTo === 'end') {
                  queryState.items.push(itemKey);
                } else {
                  queryState.items.unshift(itemKey);
                }
              } else {
                if (!queryState) continue;

                const itemIndex = queryState.items.indexOf(itemKey);

                if (itemIndex !== -1) {
                  if (invalidateQueries)
                    queriesToInvalidate.push(queryState.payload);

                  queryState.items.splice(itemIndex, 1);
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
            }
          }
        }
      }
    });

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

    store.batch(
      () => {
        store.produceState((draftState) => {
          for (const { itemKey, payload } of itemKeys) {
            const item = draftState.items[itemKey];

            if (!item) continue;

            someItemWasUpdated = true;
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
  }

  function deleteItemState(itemId: ItemPayload | ItemPayload[] | FilterItem) {
    const itemsId = getItemsKeyArray(itemId);

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
    },
  ): Promise<Result<Awaited<T>, StoreError | true>> {
    const matchAllItems: FilterItem = () => true;
    const payloadToUse: MutationPayloadToUse = payload ?? matchAllItems;

    return performMutationWithLifecycle({
      startMutation: () => startItemMutation(payloadToUse),
      optimisticUpdate: optimisticUpdate
        ? () => optimisticUpdate(payloadToUse)
        : undefined,
      debounce,
      blockWindowClose: blockWindowClose ?? undefined,
      mutation: () => mutation(payloadToUse),
      onSuccess: (result) => {
        if (revalidateOnSuccess) {
          invalidateQueryAndItems({
            itemPayload:
              revalidateOnSuccess === 'queries' ? false : payloadToUse,
            queryPayload: getRevalidateOnSuccessQueries,
          });
        }

        if (onSuccess) {
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
  }

  return {
    queryInvalidationWasTriggered,
    itemInvalidationWasTriggered,
    invalidateQueryAndItems,
    invalidateItem,
    startItemMutation,
    updateItemState,
    addItemToState,
    deleteItemState,
    performMutation,
  };
}
