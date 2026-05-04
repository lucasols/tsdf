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

export function getSerializedStringSize(value: string): number {
  return value.length;
}

export function serializeJsonForStorage(value: unknown): {
  rawValue: string;
  sizeBytes: number;
} {
  const rawValue = JSON.stringify(value);
  return { rawValue, sizeBytes: getSerializedStringSize(rawValue) };
}

export function keepEntriesWithinByteBudget<T>(
  entries: T[],
  getKey: (entry: T) => string,
  getLastAccessAt: (entry: T) => number,
  getSizeBytes: (entry: T) => number,
  isPinned: (entry: T) => boolean,
  isProtected: (entry: T) => boolean,
  maxBytes: number,
): Set<string> {
  const keptKeys = new Set<string>();
  let unprotectedBytes = 0;

  for (const entry of entries) {
    if (isProtected(entry)) continue;
    unprotectedBytes += getSizeBytes(entry);
  }

  if (unprotectedBytes <= maxBytes) {
    for (const entry of entries) {
      keptKeys.add(getKey(entry));
    }
    return keptKeys;
  }

  // Sort entries for eviction: protected first, then pinned, then by lastAccessAt (MRU first)
  const sortedEntries = [...entries].sort((a, b) => {
    const aProtected = isProtected(a);
    const bProtected = isProtected(b);
    if (aProtected && !bProtected) return -1;
    if (!aProtected && bProtected) return 1;

    const aPinned = isPinned(a);
    const bPinned = isPinned(b);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;

    return getLastAccessAt(b) - getLastAccessAt(a);
  });
  let keptUnprotectedBytes = 0;

  for (const entry of sortedEntries) {
    const key = getKey(entry);
    if (isProtected(entry)) {
      keptKeys.add(key);
      continue;
    }

    const sizeBytes = getSizeBytes(entry);
    if (isPinned(entry)) {
      keptKeys.add(key);
      keptUnprotectedBytes += sizeBytes;
      continue;
    }

    if (keptUnprotectedBytes + sizeBytes <= maxBytes) {
      keptKeys.add(key);
      keptUnprotectedBytes += sizeBytes;
    }
  }

  return keptKeys;
}
