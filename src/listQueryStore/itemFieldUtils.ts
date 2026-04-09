import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { ValidStoreState } from '../utils/storeShared';

export function fallbackItemHasRequestedFields<
  ItemState extends ValidStoreState,
>(
  fallbackItemState:
    | { item: ItemState | null | undefined; loadedFields: string[] | undefined }
    | undefined,
  requestedFields: readonly string[],
): boolean {
  const loadedFields = fallbackItemState?.loadedFields ?? [];

  if (requestedFields.every((field) => loadedFields.includes(field))) {
    return true;
  }

  const item = fallbackItemState?.item;
  if (!item || typeof item !== 'object') return false;

  const itemRecord =
    // WORKAROUND: Fallback field checks need indexed property access, but ItemState is generic and does not expose a string index signature.
    __LEGIT_CAST__<Record<string, unknown>, ItemState>(item);

  return requestedFields.every(
    (field) => field in itemRecord && itemRecord[field] !== undefined,
  );
}

/**
 * Returns the fields from `requestedFields` that are not yet present in
 * `loadedFields`. When either argument is `undefined` or empty, returns `[]`.
 */
export function excludeLoadedFields(
  loadedFields: string[] | undefined,
  requestedFields: string[] | undefined,
): string[] {
  if (!requestedFields || requestedFields.length === 0) return [];
  if (!loadedFields || loadedFields.length === 0) return [...requestedFields];

  return requestedFields.filter((field) => !loadedFields.includes(field));
}
