import { Store } from 't-state';

type OverlayWithVisibilityFlag = {
  keepVisibleWhileResolutionRequired?: boolean;
};

export function rebindOfflineOverlayEntries<
  TOverlay extends OverlayWithVisibilityFlag,
>(
  overlayStore: Store<Record<string, TOverlay>>,
  itemKeyRewrites: readonly { nextItemKey: string; previousItemKey: string }[],
  createReboundOverlay: (params: {
    existingOverlay: TOverlay;
    nextItemKey: string;
  }) => TOverlay,
): void {
  if (itemKeyRewrites.length === 0) return;

  overlayStore.produceState((draft) => {
    for (const { previousItemKey, nextItemKey } of itemKeyRewrites) {
      if (previousItemKey === nextItemKey) continue;

      const existingOverlay = draft[previousItemKey];
      if (existingOverlay === undefined) continue;

      if (draft[nextItemKey] === undefined) {
        draft[nextItemKey] = createReboundOverlay({
          existingOverlay,
          nextItemKey,
        });
      } else {
        draft[nextItemKey].keepVisibleWhileResolutionRequired = true;
      }

      delete draft[previousItemKey];
    }
  });
}

/**
 * The items of `itemKeys` with an overlay that a capture replaces. Used to
 * capture again the overlays of items changed by a local optimistic update:
 * hooks show the overlay instead of the store state, so until the change is
 * queued (e.g. during a debounce) they would show the version queued before.
 * An overlay moved to the final item of a temp entity keeps its data, as when
 * a mutation is queued (see `captureOfflineOverlayEntries`).
 */
export function getRecapturableOfflineOverlayKeys(
  overlays: Readonly<Record<string, OverlayWithVisibilityFlag>>,
  itemKeys: Iterable<string>,
): string[] {
  const result: string[] = [];

  for (const itemKey of itemKeys) {
    const overlay = overlays[itemKey];
    if (overlay && !overlay.keepVisibleWhileResolutionRequired) {
      result.push(itemKey);
    }
  }

  return result;
}

export function captureOfflineOverlayEntries<
  TOverlay extends OverlayWithVisibilityFlag,
>(
  overlayStore: Store<Record<string, TOverlay>>,
  itemKeys: readonly string[],
  createOverlay: (itemKey: string) => TOverlay,
): void {
  const targetItemKeys = [...new Set(itemKeys)];
  if (targetItemKeys.length === 0) return;

  overlayStore.produceState((draft) => {
    for (const itemKey of targetItemKeys) {
      const existingOverlay = draft[itemKey];
      if (existingOverlay?.keepVisibleWhileResolutionRequired) {
        existingOverlay.keepVisibleWhileResolutionRequired = false;
        continue;
      }

      draft[itemKey] = createOverlay(itemKey);
    }
  });
}
