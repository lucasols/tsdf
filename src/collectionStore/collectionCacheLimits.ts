import { Store } from 't-state';

import { LruCacheRuntime } from '../cacheLimits/lruCacheRuntime';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  CollectionStateCleanup,
  TSFDCollectionItem,
  TSFDCollectionState,
} from './collectionStore';

export function createCollectionCacheLimits<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>({
  store,
  maxItems,
  itemCacheRuntime,
  isProtectedFromEviction,
  cleanupItemResources,
  onStateCleanup,
}: {
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>;
  maxItems: number | undefined;
  itemCacheRuntime: Pick<LruCacheRuntime, 'getLastUsed'>;
  isProtectedFromEviction: (
    itemKey: string,
    item: TSFDCollectionItem<ItemState, ItemPayload>,
  ) => boolean;
  cleanupItemResources: (itemKey: string, payload: ItemPayload) => void;
  onStateCleanup:
    | ((cleanup: CollectionStateCleanup<ItemPayload>) => void)
    | undefined;
}) {
  let isEnforcingCacheLimits = false;

  function enforceCacheLimits(): void {
    if (maxItems === undefined || isEnforcingCacheLimits) return;

    const cachedItems = Object.entries(store.state).flatMap(([itemKey, item]) =>
      item !== null ? ([[itemKey, item]] as const) : [],
    );

    if (cachedItems.length <= maxItems) return;

    const evictionCandidates = cachedItems
      .filter(([itemKey, item]) => !isProtectedFromEviction(itemKey, item))
      .sort(
        ([itemKeyA], [itemKeyB]) =>
          itemCacheRuntime.getLastUsed(itemKeyA) -
          itemCacheRuntime.getLastUsed(itemKeyB),
      );

    let remainingItems = cachedItems.length;
    const itemsToEvict: { itemKey: string; payload: ItemPayload }[] = [];

    for (const [itemKey, item] of evictionCandidates) {
      if (remainingItems <= maxItems) break;
      itemsToEvict.push({ itemKey, payload: item.payload });
      remainingItems--;
    }

    if (itemsToEvict.length === 0) return;

    isEnforcingCacheLimits = true;
    try {
      store.produceState(
        (draft) => {
          for (const { itemKey } of itemsToEvict) {
            delete draft[itemKey];
          }
        },
        { action: 'evict-collection-items' },
      );
    } finally {
      isEnforcingCacheLimits = false;
    }

    for (const { itemKey, payload } of itemsToEvict) {
      cleanupItemResources(itemKey, payload);
    }

    onStateCleanup?.({
      reason: 'cacheLimitEviction',
      itemKeys: itemsToEvict.map(({ itemKey }) => itemKey),
      payloads: itemsToEvict.map(({ payload }) => payload),
    });
  }

  return { enforceCacheLimits };
}
