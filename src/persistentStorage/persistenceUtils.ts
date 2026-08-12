import type { ValidPayload } from '../utils/storeShared';
import type { IdleCleanupContext } from './scheduleIdleCleanup';

const MAINTENANCE_SORT_CHUNK_SIZE = 100;
const MAINTENANCE_LOOP_CHUNK_SIZE = 25;

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

/**
 * Detects browser storage quota errors thrown by `localStorage.setItem` and
 * IndexedDB writes, covering the standard `QuotaExceededError` name plus the
 * legacy Firefox name.
 */
export function isQuotaExceededError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

export function serializeJsonForStorage(value: unknown): {
  rawValue: string;
  sizeBytes: number;
} {
  const rawValue = JSON.stringify(value);
  return { rawValue, sizeBytes: getSerializedStringSize(rawValue) };
}

export type ByteBudgetResult = {
  keptKeys: Set<string>;
  unprotectedBytes: number;
};

export function keepEntriesWithinByteBudget<T>(
  entries: T[],
  getKey: (entry: T) => string,
  getLastAccessAt: (entry: T) => number,
  getSizeBytes: (entry: T) => number,
  isPinned: (entry: T) => boolean,
  isProtected: (entry: T) => boolean,
  maxBytes: number,
): ByteBudgetResult {
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
    return { keptKeys, unprotectedBytes };
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

  return { keptKeys, unprotectedBytes };
}

/** Deadline-aware variant used by synchronous localStorage maintenance. */
export async function keepEntriesWithinByteBudgetDuringIdle<T>(
  entries: T[],
  getKey: (entry: T) => string,
  getLastAccessAt: (entry: T) => number,
  getSizeBytes: (entry: T) => number,
  isPinned: (entry: T) => boolean,
  isProtected: (entry: T) => boolean,
  maxBytes: number,
  idleContext: IdleCleanupContext,
): Promise<ByteBudgetResult | null> {
  const keptKeys = new Set<string>();
  let unprotectedBytes = 0;

  for (const [entryIndex, entry] of entries.entries()) {
    if (
      entryIndex % MAINTENANCE_LOOP_CHUNK_SIZE === 0 &&
      !(await idleContext.yieldIfNeeded())
    ) {
      return null;
    }
    if (!isProtected(entry)) {
      unprotectedBytes += getSizeBytes(entry);
    }
  }

  if (unprotectedBytes <= maxBytes) {
    for (const [entryIndex, entry] of entries.entries()) {
      if (
        entryIndex % MAINTENANCE_LOOP_CHUNK_SIZE === 0 &&
        !(await idleContext.yieldIfNeeded())
      ) {
        return null;
      }
      keptKeys.add(getKey(entry));
    }
    return { keptKeys, unprotectedBytes };
  }

  const compareEntries = (left: T, right: T): number => {
    const leftProtected = isProtected(left);
    const rightProtected = isProtected(right);
    if (leftProtected && !rightProtected) return -1;
    if (!leftProtected && rightProtected) return 1;

    const leftPinned = isPinned(left);
    const rightPinned = isPinned(right);
    if (leftPinned && !rightPinned) return -1;
    if (!leftPinned && rightPinned) return 1;

    return getLastAccessAt(right) - getLastAccessAt(left);
  };
  const sortedChunks: T[][] = [];
  for (
    let chunkStart = 0;
    chunkStart < entries.length;
    chunkStart += MAINTENANCE_SORT_CHUNK_SIZE
  ) {
    if (!(await idleContext.yieldIfNeeded())) return null;
    sortedChunks.push(
      entries
        .slice(chunkStart, chunkStart + MAINTENANCE_SORT_CHUNK_SIZE)
        .sort(compareEntries),
    );
  }

  let mergeChunks = sortedChunks;
  while (mergeChunks.length > 1) {
    const nextMergeChunks: T[][] = [];
    for (let chunkIndex = 0; chunkIndex < mergeChunks.length; chunkIndex += 2) {
      if (!(await idleContext.yieldIfNeeded())) return null;

      const leftChunk = mergeChunks[chunkIndex];
      const rightChunk = mergeChunks[chunkIndex + 1];
      if (leftChunk === undefined) continue;
      if (rightChunk === undefined) {
        nextMergeChunks.push(leftChunk);
        continue;
      }

      const mergedChunk: T[] = [];
      let leftIndex = 0;
      let rightIndex = 0;
      while (leftIndex < leftChunk.length || rightIndex < rightChunk.length) {
        if (
          mergedChunk.length % MAINTENANCE_LOOP_CHUNK_SIZE === 0 &&
          !(await idleContext.yieldIfNeeded())
        ) {
          return null;
        }

        const leftEntry = leftChunk[leftIndex];
        const rightEntry = rightChunk[rightIndex];
        if (
          rightEntry === undefined ||
          (leftEntry !== undefined &&
            compareEntries(leftEntry, rightEntry) <= 0)
        ) {
          if (leftEntry !== undefined) mergedChunk.push(leftEntry);
          leftIndex++;
        } else {
          mergedChunk.push(rightEntry);
          rightIndex++;
        }
      }
      nextMergeChunks.push(mergedChunk);
    }
    mergeChunks = nextMergeChunks;
  }
  const sortedEntries = mergeChunks[0] ?? [];

  let keptUnprotectedBytes = 0;
  for (const [entryIndex, entry] of sortedEntries.entries()) {
    if (
      entryIndex % MAINTENANCE_LOOP_CHUNK_SIZE === 0 &&
      !(await idleContext.yieldIfNeeded())
    ) {
      return null;
    }

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

  return { keptKeys, unprotectedBytes };
}
