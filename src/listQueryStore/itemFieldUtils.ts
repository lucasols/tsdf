import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { reusePrevIfEqual } from '../utils/reusePrevIfEqual';
import type { ValidStoreState } from '../utils/storeShared';
import type { PartialResourcesConfig } from './types';

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

/**
 * Applies a fetched item to the state using partial-resource merging. Merges
 * `data` into any existing item and updates `itemLoadedFields` to reflect the
 * fields now available. When `fields` is empty the loaded-field set is
 * replaced with the keys of the merged item (a full fetch is assumed).
 */
export function applyPartialItemMerge<ItemState extends ValidStoreState>(
  draft: {
    items: Record<string, ItemState | null>;
    itemLoadedFields: Record<string, string[]>;
  },
  itemKey: string,
  data: ItemState,
  fields: string[] | undefined,
  partialResources: PartialResourcesConfig<ItemState>,
): ItemState {
  const prev = draft.items[itemKey] ?? undefined;
  const merged = partialResources.mergeItems(prev, data);
  draft.items[itemKey] = reusePrevIfEqual(prev, merged);

  if (fields && fields.length > 0) {
    const existingFields = draft.itemLoadedFields[itemKey] ?? [];
    const fieldSet = new Set([...existingFields, ...fields]);
    draft.itemLoadedFields[itemKey] = Array.from(fieldSet).sort();
  } else {
    draft.itemLoadedFields[itemKey] = Object.keys(merged).sort();
  }

  return merged;
}
