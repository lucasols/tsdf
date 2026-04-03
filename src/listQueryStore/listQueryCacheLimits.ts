import { Store } from 't-state';

import { LruCacheRuntime } from '../cacheLimits/lruCacheRuntime';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type { ListQueryStateCleanup } from './listQueryStore';
import type { TSDFItemQuery, TSFDListQuery, TSFDListQueryState } from './types';

type LiveItemEntry<ItemPayload extends ValidPayload> = {
  itemKey: string;
  itemQuery: TSDFItemQuery<ItemPayload>;
};

export function createListQueryCacheLimits<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>({
  store,
  maxItems,
  maxQueries,
  itemCacheRuntime,
  queryCacheRuntime,
  isQueryProtectedFromEviction,
  isStandaloneItemProtectedFromEviction,
  cleanupItemStateMetadata,
  cleanupQueryStateMetadata,
  deleteQueryFetchResources,
  deleteItemFetchResources,
  onStateCleanup,
}: {
  store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>;
  maxItems: number | undefined;
  maxQueries: number | undefined;
  itemCacheRuntime: Pick<LruCacheRuntime, 'getLastUsed'>;
  queryCacheRuntime: Pick<LruCacheRuntime, 'getLastUsed'>;
  isQueryProtectedFromEviction: (
    queryKey: string,
    query: TSFDListQuery<QueryPayload>,
  ) => boolean;
  isStandaloneItemProtectedFromEviction: (
    itemKey: string,
    itemQuery: TSDFItemQuery<ItemPayload>,
  ) => boolean;
  cleanupItemStateMetadata: (itemKey: string) => void;
  cleanupQueryStateMetadata: (queryKey: string) => void;
  deleteQueryFetchResources: (queryKeys: string[]) => void;
  deleteItemFetchResources: (
    itemsToCleanup: { itemKey: string; payload: ItemPayload }[],
  ) => void;
  onStateCleanup:
    | ((cleanup: ListQueryStateCleanup<QueryPayload, ItemPayload>) => void)
    | undefined;
}) {
  let isEnforcingCacheLimits = false;

  function getReferencedItemKeysFromQueries(
    queryKeys: Iterable<string> = Object.keys(store.state.queries),
  ): Set<string> {
    const referencedItemKeys = new Set<string>();

    for (const queryKey of queryKeys) {
      const query = store.state.queries[queryKey];
      if (!query) continue;

      for (const itemKey of query.items) {
        referencedItemKeys.add(itemKey);
      }
    }

    return referencedItemKeys;
  }

  function getLiveItemEntries(): LiveItemEntry<ItemPayload>[] {
    return Object.keys(store.state.items).flatMap((itemKey) => {
      const item = store.state.items[itemKey];
      const itemQuery = store.state.itemQueries[itemKey];

      if (!item || !itemQuery) return [];

      return [{ itemKey, itemQuery }];
    });
  }

  function deleteQueriesFromState(queryKeys: string[]): void {
    if (queryKeys.length === 0) return;
    const queryPayloads = queryKeys.flatMap((queryKey) => {
      const query = store.state.queries[queryKey];
      return query ? [query.payload] : [];
    });

    isEnforcingCacheLimits = true;
    try {
      store.produceState(
        (draft) => {
          for (const queryKey of queryKeys) {
            delete draft.queries[queryKey];
          }
        },
        { action: 'evict-list-queries' },
      );
    } finally {
      isEnforcingCacheLimits = false;
    }

    deleteQueryFetchResources(queryKeys);
    for (const queryKey of queryKeys) {
      cleanupQueryStateMetadata(queryKey);
    }
    onStateCleanup?.({
      reason: 'cacheLimitEviction',
      itemKeys: [],
      itemPayloads: [],
      queryKeys,
      queryPayloads,
    });
  }

  function deleteItemsFromState(itemKeys: string[]): void {
    if (itemKeys.length === 0) return;

    const itemsToCleanup = itemKeys.flatMap((itemKey) => {
      const itemQuery = store.state.itemQueries[itemKey];
      return itemQuery ? [{ itemKey, payload: itemQuery.payload }] : [];
    });
    const itemPayloads = itemsToCleanup.map(({ payload }) => payload);

    isEnforcingCacheLimits = true;
    try {
      store.produceState(
        (draft) => {
          for (const itemKey of itemKeys) {
            delete draft.items[itemKey];
            delete draft.itemQueries[itemKey];
            delete draft.itemLoadedFields[itemKey];
            delete draft.itemFieldInvalidationFields[itemKey];
          }
        },
        { action: 'evict-list-items' },
      );
    } finally {
      isEnforcingCacheLimits = false;
    }

    deleteItemFetchResources(itemsToCleanup);
    for (const itemKey of itemKeys) {
      cleanupItemStateMetadata(itemKey);
    }
    onStateCleanup?.({
      reason: 'cacheLimitEviction',
      itemKeys,
      itemPayloads,
      queryKeys: [],
      queryPayloads: [],
    });
  }

  function collectEvictableOrphanItemKeys(
    referencedItemKeys: Set<string>,
  ): string[] {
    return getLiveItemEntries()
      .filter(({ itemKey, itemQuery }) => {
        return (
          !referencedItemKeys.has(itemKey) &&
          !isStandaloneItemProtectedFromEviction(itemKey, itemQuery)
        );
      })
      .map(({ itemKey }) => itemKey);
  }

  function garbageCollectOrphanItems(): void {
    const referencedItemKeys = getReferencedItemKeysFromQueries();
    const orphanItemKeys = collectEvictableOrphanItemKeys(referencedItemKeys);

    if (orphanItemKeys.length > 0) {
      deleteItemsFromState(orphanItemKeys);
    }
  }

  function getStandaloneProtectedItemKeys(
    liveItems: LiveItemEntry<ItemPayload>[],
  ): Set<string> {
    const protectedItemKeys = new Set<string>();

    for (const { itemKey, itemQuery } of liveItems) {
      if (isStandaloneItemProtectedFromEviction(itemKey, itemQuery)) {
        protectedItemKeys.add(itemKey);
      }
    }

    return protectedItemKeys;
  }

  function buildReferencedItemCounts(
    queryEntries: [string, TSFDListQuery<QueryPayload>][],
  ): Map<string, number> {
    const referencedItemCounts = new Map<string, number>();

    for (const [, query] of queryEntries) {
      for (const itemKey of query.items) {
        referencedItemCounts.set(
          itemKey,
          (referencedItemCounts.get(itemKey) ?? 0) + 1,
        );
      }
    }

    return referencedItemCounts;
  }

  function enforceCacheLimits(): void {
    if (
      isEnforcingCacheLimits ||
      (maxQueries === undefined && maxItems === undefined)
    ) {
      return;
    }

    if (maxQueries !== undefined) {
      const queryEntries = Object.entries(store.state.queries);
      if (queryEntries.length > maxQueries) {
        let remainingQueries = queryEntries.length;
        const queryKeysToEvict = queryEntries
          .filter(([queryKey, query]) => {
            return !isQueryProtectedFromEviction(queryKey, query);
          })
          .sort(
            ([queryKeyA], [queryKeyB]) =>
              queryCacheRuntime.getLastUsed(queryKeyA) -
              queryCacheRuntime.getLastUsed(queryKeyB),
          )
          .flatMap(([queryKey]) => {
            if (remainingQueries <= maxQueries) return [];
            remainingQueries--;
            return [queryKey];
          });

        if (queryKeysToEvict.length > 0) {
          deleteQueriesFromState(queryKeysToEvict);
          garbageCollectOrphanItems();
        }
      }
    }

    if (maxItems === undefined) return;

    let liveItems = getLiveItemEntries();
    let liveItemCount = liveItems.length;
    if (liveItemCount <= maxItems) return;

    const currentQueryEntries = Object.entries(store.state.queries);
    let referencedItemCounts = buildReferencedItemCounts(currentQueryEntries);
    const standaloneProtectedItemKeys =
      getStandaloneProtectedItemKeys(liveItems);
    const itemPressureQueryEvictions = currentQueryEntries
      .filter(([queryKey, query]) => {
        return !isQueryProtectedFromEviction(queryKey, query);
      })
      .sort(
        ([queryKeyA], [queryKeyB]) =>
          queryCacheRuntime.getLastUsed(queryKeyA) -
          queryCacheRuntime.getLastUsed(queryKeyB),
      )
      .flatMap(([queryKey]) => {
        if (liveItemCount <= maxItems) return [];

        const query = store.state.queries[queryKey];
        if (!query) return [];

        const nextReferencedItemCounts = new Map(referencedItemCounts);
        let nextLiveItemCount = liveItemCount;
        let wouldFreeItems = false;
        for (const itemKey of query.items) {
          const nextRefCount = (nextReferencedItemCounts.get(itemKey) ?? 0) - 1;
          if (nextRefCount > 0) {
            nextReferencedItemCounts.set(itemKey, nextRefCount);
            continue;
          }

          nextReferencedItemCounts.delete(itemKey);
          if (!standaloneProtectedItemKeys.has(itemKey)) {
            nextLiveItemCount--;
            wouldFreeItems = true;
          }
        }

        if (!wouldFreeItems) return [];
        referencedItemCounts = nextReferencedItemCounts;
        liveItemCount = nextLiveItemCount;
        return [queryKey];
      });

    if (itemPressureQueryEvictions.length > 0) {
      deleteQueriesFromState(itemPressureQueryEvictions);
      garbageCollectOrphanItems();
    }

    const referencedItemKeys = getReferencedItemKeysFromQueries();
    liveItems = getLiveItemEntries();
    liveItemCount = liveItems.length;
    if (liveItemCount <= maxItems) return;

    const standaloneItemKeysToEvict = liveItems
      .filter(({ itemKey, itemQuery }) => {
        return (
          !referencedItemKeys.has(itemKey) &&
          !isStandaloneItemProtectedFromEviction(itemKey, itemQuery)
        );
      })
      .sort(
        ({ itemKey: itemKeyA }, { itemKey: itemKeyB }) =>
          itemCacheRuntime.getLastUsed(itemKeyA) -
          itemCacheRuntime.getLastUsed(itemKeyB),
      )
      .flatMap(({ itemKey }) => {
        if (liveItemCount <= maxItems) return [];
        liveItemCount--;
        return [itemKey];
      });

    if (standaloneItemKeysToEvict.length > 0) {
      deleteItemsFromState(standaloneItemKeysToEvict);
    }
  }

  return { enforceCacheLimits };
}
