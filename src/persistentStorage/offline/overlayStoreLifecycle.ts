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
