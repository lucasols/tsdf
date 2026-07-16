import type { FetchType } from '../requestScheduler';
import { reusePrevIfEqual } from '../utils/reusePrevIfEqual';
import { higherFetchType } from '../utils/storeShared';
import type { ValidStoreState } from '../utils/storeShared';
import type { ItemLoadedFields, PartialResourcesConfig } from './types';

export function hasFullyLoadedFields(
  loadedFields: ItemLoadedFields | undefined,
): boolean {
  return loadedFields === '*';
}

/**
 * Whether a snapshot should be treated as holding every field of the item.
 * True when the tracked `loadedFields` is the `'*'` sentinel, or when the
 * snapshot carries no field metadata but `inferFields` reports the item is
 * complete (`'*'`) — e.g. manually inserted items, offline optimistic rows, or
 * persisted fallback snapshots.
 */
export function snapshotIsFullyLoaded<ItemState extends ValidStoreState>(
  loadedFields: ItemLoadedFields | undefined,
  item: ItemState | null | undefined,
  inferFields: (item: ItemState) => ItemLoadedFields,
): boolean {
  if (loadedFields === '*') return true;
  if (!item) return false;
  return inferFields(item) === '*';
}

/**
 * Like {@link snapshotIsFullyLoaded}, but also returns `false` when the item is
 * awaiting a full ('*') re-fetch after a full invalidation. A fully-loaded
 * snapshot that was fully invalidated has its `loadedFields` reset while the
 * (now stale) item data is still present, so `inferFields` would otherwise
 * wrongly vouch for it as complete.
 */
export function snapshotIsFullyLoadedAndFresh<
  ItemState extends ValidStoreState,
>(
  itemKey: string,
  loadedFields: ItemLoadedFields | undefined,
  item: ItemState | null | undefined,
  inferFields: (item: ItemState) => ItemLoadedFields,
  itemsPendingFullInvalidation: Map<string, FetchType>,
): boolean {
  if (loadedFields !== '*' && itemsPendingFullInvalidation.has(itemKey)) {
    return false;
  }
  return snapshotIsFullyLoaded(loadedFields, item, inferFields);
}

/**
 * Missing requested fields for an item snapshot, letting `inferFields` vouch
 * for metadata-free item data (e.g. client-created items) — except for stale
 * fields awaiting a re-fetch after an invalidation (per-field or full), when
 * the item's stale data must not be vouched for.
 */
export function getStaleOrMissingRequestedFields<
  ItemState extends ValidStoreState,
>(
  itemKey: string,
  loadedFields: ItemLoadedFields | undefined,
  item: ItemState | null | undefined,
  requestedFields: readonly string[],
  inferFields: (item: ItemState) => ItemLoadedFields,
  itemsPendingFullInvalidation: Map<string, FetchType>,
  pendingInvalidationFields: readonly string[],
): string[] {
  // Requested fields awaiting an invalidation re-fetch are stale even when
  // they are tracked as loaded — e.g. per-field invalidations on a fully
  // loaded ('*') item keep `loadedFields === '*'` while the stale fields live
  // only in the pending invalidation list.
  const staleRequestedFields =
    pendingInvalidationFields.length > 0
      ? requestedFields.filter((field) =>
          pendingInvalidationFields.includes(field),
        )
      : [];

  const missingLoadedFields = excludeLoadedFields(
    loadedFields,
    requestedFields,
  );
  if (missingLoadedFields.length === 0) return staleRequestedFields;

  // While a full ('*') invalidation is unresolved, or when there is no item
  // data to inspect, `inferFields` must not vouch for any missing field.
  const unvouchedMissingFields =
    (loadedFields !== '*' && itemsPendingFullInvalidation.has(itemKey)) || !item
      ? missingLoadedFields
      : (() => {
          const inferredFields = inferFields(item);
          return missingLoadedFields.filter(
            (field) =>
              inferredFields !== '*' && !inferredFields.includes(field),
          );
        })();

  if (staleRequestedFields.length === 0) return unvouchedMissingFields;

  // Preserve the requested-fields order while deduping the stale ∪ missing
  // union (a stale field is usually also missing from `loadedFields`).
  const resultFields = new Set([
    ...staleRequestedFields,
    ...unvouchedMissingFields,
  ]);
  return requestedFields.filter((field) => resultFields.has(field));
}

export function fallbackItemHasRequestedFields<
  ItemState extends ValidStoreState,
>(
  fallbackItemState:
    | {
        item: ItemState | null | undefined;
        loadedFields: ItemLoadedFields | undefined;
      }
    | undefined,
  requestedFields: readonly string[],
  inferFields: (item: ItemState) => ItemLoadedFields,
): boolean {
  return (
    getFallbackMissingRequestedFields(
      fallbackItemState,
      requestedFields,
      inferFields,
    ).length === 0
  );
}

export function getFallbackMissingRequestedFields<
  ItemState extends ValidStoreState,
>(
  fallbackItemState:
    | {
        item: ItemState | null | undefined;
        loadedFields: ItemLoadedFields | undefined;
      }
    | undefined,
  requestedFields: readonly string[],
  inferFields: (item: ItemState) => ItemLoadedFields,
): string[] {
  const loadedFields = fallbackItemState?.loadedFields;

  if (loadedFields === '*') return [];

  const missingLoadedFields = requestedFields.filter(
    (field) => !(loadedFields?.includes(field) ?? false),
  );
  if (missingLoadedFields.length === 0) return [];

  const item = fallbackItemState?.item;
  if (!item) return missingLoadedFields;

  const inferredFields = inferFields(item);
  if (inferredFields === '*') return [];

  return missingLoadedFields.filter((field) => !inferredFields.includes(field));
}

/**
 * Fields from `requestedFields` that are genuinely absent from the snapshot —
 * not tracked as loaded, not vouched by `inferFields`, and not merely stale
 * (awaiting an invalidation re-fetch). Stale fields were loaded when their
 * invalidation was recorded, so their stale data is still present and may stay
 * visible while the re-fetch runs; only genuinely absent fields have no data
 * to show. Staleness is proven either by the field being in the unresolved
 * pending invalidation list, or — for an item with data still present — by the
 * unresolved full ('*') invalidation marker, which means the snapshot was
 * complete when invalidated.
 */
export function getGenuinelyMissingRequestedFields<
  ItemState extends ValidStoreState,
>(
  itemKey: string,
  fallbackItemState:
    | {
        item: ItemState | null | undefined;
        loadedFields: ItemLoadedFields | undefined;
      }
    | undefined,
  requestedFields: readonly string[],
  inferFields: (item: ItemState) => ItemLoadedFields,
  itemsPendingFullInvalidation: Map<string, FetchType>,
  unresolvedPendingInvalidationFields: readonly string[],
): string[] {
  const fallbackMissingFields = getFallbackMissingRequestedFields(
    fallbackItemState,
    requestedFields,
    inferFields,
  );
  if (fallbackMissingFields.length === 0) return fallbackMissingFields;

  if (itemsPendingFullInvalidation.has(itemKey) && fallbackItemState?.item) {
    return [];
  }

  if (unresolvedPendingInvalidationFields.length === 0) {
    return fallbackMissingFields;
  }

  return fallbackMissingFields.filter(
    (field) => !unresolvedPendingInvalidationFields.includes(field),
  );
}

/**
 * Highest tracked invalidation priority owed to `requestedFields` (or to any
 * unresolved field when `requestedFields` is `undefined` — an unbounded hook).
 * Fields without a tracked priority (e.g. invalidations adopted from another
 * tab via state sync) contribute nothing, so an all-unknown result stays
 * `undefined` and callers treat the refetch as untracked (ungated, immediate).
 * The full-invalidation marker owes a requested field only when that field is
 * neither reloaded nor covered by a per-field entry (an entry supersedes the
 * marker for its field).
 */
export function getPendingInvalidationPriorityOfFields(
  requestedFields: readonly string[] | undefined,
  loadedFields: ItemLoadedFields | undefined,
  unresolvedPendingInvalidationFields: readonly string[],
  pendingFieldPriorities: Map<string, FetchType | null> | undefined,
  fullInvalidationPriority: FetchType | undefined,
): FetchType | undefined {
  let highestPriority: FetchType | undefined;

  const fieldsToCheck = requestedFields
    ? requestedFields.filter((field) =>
        unresolvedPendingInvalidationFields.includes(field),
      )
    : unresolvedPendingInvalidationFields;
  for (const field of fieldsToCheck) {
    const fieldPriority = pendingFieldPriorities?.get(field);
    if (fieldPriority) {
      highestPriority = higherFetchType(highestPriority, fieldPriority);
    }
  }

  if (fullInvalidationPriority !== undefined) {
    const owedByMarker = requestedFields
      ? requestedFields.some(
          (field) =>
            !(loadedFields?.includes(field) ?? false) &&
            !pendingFieldPriorities?.has(field),
        )
      : true;
    if (owedByMarker) {
      highestPriority = higherFetchType(
        highestPriority,
        fullInvalidationPriority,
      );
    }
  }

  return highestPriority;
}

/**
 * Returns the fields from `requestedFields` that are not yet present in
 * `loadedFields`. When either argument is `undefined` or empty, returns `[]`.
 */
export function excludeLoadedFields(
  loadedFields: ItemLoadedFields | undefined,
  requestedFields: readonly string[] | undefined,
): string[] {
  if (!requestedFields || requestedFields.length === 0) return [];
  if (loadedFields === '*') return [];
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
    itemLoadedFields: Record<string, ItemLoadedFields>;
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
    const existingFields = draft.itemLoadedFields[itemKey];
    if (existingFields === '*') return merged;

    const fieldSet = new Set([...(existingFields ?? []), ...fields]);
    draft.itemLoadedFields[itemKey] = Array.from(fieldSet).sort();
  } else {
    draft.itemLoadedFields[itemKey] = '*';
  }

  return merged;
}
