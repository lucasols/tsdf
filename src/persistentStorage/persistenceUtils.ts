import type { ValidPayload } from '../utils/storeShared';

/**
 * Creates a key set that auto-clears entries after a microtask.
 * Used to deduplicate sync storage reads within the same event loop tick.
 */
export function createTimedKeySet(): {
  has: (key: string) => boolean;
  remember: (key: string) => void;
  clear: (key: string) => void;
  clearAll: () => void;
} {
  const keys = new Set<string>();
  let clearScheduled = false;

  function scheduleClear(): void {
    if (clearScheduled) return;

    clearScheduled = true;
    queueMicrotask(() => {
      clearScheduled = false;
      keys.clear();
    });
  }

  return {
    has: (key: string) => keys.has(key),
    remember: (key: string) => {
      keys.add(key);
      scheduleClear();
    },
    clear: (key: string) => {
      keys.delete(key);
    },
    clearAll: () => {
      keys.clear();
    },
  };
}

export function createShouldIgnoreItemPredicate<
  ItemPayload extends ValidPayload,
>(
  ignoreItems: ItemPayload[] | ((payload: ItemPayload) => boolean) | undefined,
  resolveItemKey: (payload: ItemPayload) => string,
): (payload: ItemPayload) => boolean {
  if (!ignoreItems) return () => false;
  if (typeof ignoreItems === 'function') return ignoreItems;

  const ignoredItemKeys = new Set(ignoreItems.map(resolveItemKey));
  return (payload) => ignoredItemKeys.has(resolveItemKey(payload));
}

/**
 * Creates a comparator for eviction sorting. Entries matching earlier tiers
 * are kept first (sorted to the front). Within the same tier, entries with
 * more recent `lastAccessAt` are kept first.
 */
export function createEvictionComparator<T>(
  tiers: Array<(entry: T) => boolean>,
  getLastAccessAt: (entry: T) => number,
): (a: T, b: T) => number {
  return (a, b) => {
    for (const tier of tiers) {
      const aInTier = tier(a);
      const bInTier = tier(b);
      if (aInTier && !bInTier) return -1;
      if (!aInTier && bInTier) return 1;
    }
    return getLastAccessAt(b) - getLastAccessAt(a);
  };
}
