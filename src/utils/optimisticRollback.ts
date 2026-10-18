import { typedObjectKeys } from '@ls-stack/utils/typingFnUtils';

function revertFields<T extends Record<string, unknown>>(
  current: T,
  before: T,
  after: T,
): { value: T; changed: boolean } {
  const value = { ...current };
  let restored = false;
  let changed = false;
  for (const key of typedObjectKeys(after)) {
    if (before[key] === after[key]) continue;

    if (current[key] === after[key]) {
      value[key] = before[key];
      restored = true;
    } else {
      changed = true;
    }
  }

  // Keep the current reference when nothing was restored, so callers can
  // skip a no-op write
  return { value: restored ? value : current, changed };
}

/**
 * Reverts the change an optimistic update made to an entity (`before` ->
 * `after`) on top of its `current` value, one level deep and by reference:
 * fields still equal to `after` are restored and fields the update didn't
 * touch keep their current value. A field changed again since the update is
 * kept and reported as `changed`, so the caller can revalidate the entity.
 */
export function revertOptimisticChange<
  T extends Record<string, unknown> | null | undefined,
>(current: T, before: T, after: T): { value: T; changed: boolean } {
  if (current === after) return { value: before, changed: false };
  if (before === after) return { value: current, changed: false };
  if (!current || !before || !after) return { value: current, changed: true };

  return revertFields(current, before, after);
}
