import type { ValidPayload } from '../utils/storeShared';

const utf8Encoder = new TextEncoder();

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

export function getUtf8ByteSize(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function serializeJsonForStorage(value: unknown): {
  rawValue: string;
  sizeBytes: number;
} {
  const rawValue = JSON.stringify(value);
  return { rawValue, sizeBytes: getUtf8ByteSize(rawValue) };
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

  const sortedEntries = [...args.entries].sort(
    createEvictionComparator(
      [args.isProtected, args.isPinned],
      args.getLastAccessAt,
    ),
  );
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
