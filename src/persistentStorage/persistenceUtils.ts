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

export function keepEntriesWithinByteBudget<T>(args: {
  entries: T[];
  getKey: (entry: T) => string;
  getLastAccessAt: (entry: T) => number;
  getSizeBytes: (entry: T) => number;
  isPinned: (entry: T) => boolean;
  isProtected: (entry: T) => boolean;
  maxBytes: number;
}): Set<string> {
  const keptKeys = new Set<string>();
  let unprotectedBytes = 0;

  for (const entry of args.entries) {
    if (args.isProtected(entry)) continue;
    unprotectedBytes += args.getSizeBytes(entry);
  }

  if (unprotectedBytes <= args.maxBytes) {
    for (const entry of args.entries) {
      keptKeys.add(args.getKey(entry));
    }
    return keptKeys;
  }

  // Sort entries for eviction: protected first, then pinned, then by lastAccessAt (MRU first)
  const sortedEntries = [...args.entries].sort((a, b) => {
    const aProtected = args.isProtected(a);
    const bProtected = args.isProtected(b);
    if (aProtected && !bProtected) return -1;
    if (!aProtected && bProtected) return 1;

    const aPinned = args.isPinned(a);
    const bPinned = args.isPinned(b);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;

    return args.getLastAccessAt(b) - args.getLastAccessAt(a);
  });
  let keptUnprotectedBytes = 0;
  let keptUnprotectedEntry = false;

  for (const entry of sortedEntries) {
    const key = args.getKey(entry);
    if (args.isProtected(entry)) {
      keptKeys.add(key);
      continue;
    }

    const sizeBytes = args.getSizeBytes(entry);
    if (keptUnprotectedBytes + sizeBytes <= args.maxBytes) {
      keptKeys.add(key);
      keptUnprotectedBytes += sizeBytes;
      keptUnprotectedEntry = true;
      continue;
    }

    if (!keptUnprotectedEntry && args.maxBytes > 0) {
      keptKeys.add(key);
      keptUnprotectedBytes += sizeBytes;
      keptUnprotectedEntry = true;
    }
  }

  return keptKeys;
}
