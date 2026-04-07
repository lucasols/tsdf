import { Store } from 't-state';

type OverlayWithVisibilityFlag = {
  keepVisibleWhileResolutionRequired?: boolean;
};

export function rebindOfflineOverlayEntries<
  TOverlay extends OverlayWithVisibilityFlag,
>(args: {
  createReboundOverlay: (params: {
    existingOverlay: TOverlay;
    nextItemKey: string;
  }) => TOverlay;
  itemKeyRewrites: readonly { nextItemKey: string; previousItemKey: string }[];
  overlayStore: Store<Record<string, TOverlay>>;
}): void {
  if (args.itemKeyRewrites.length === 0) return;

  args.overlayStore.produceState((draft) => {
    for (const { previousItemKey, nextItemKey } of args.itemKeyRewrites) {
      if (previousItemKey === nextItemKey) continue;

      const existingOverlay = draft[previousItemKey];
      if (existingOverlay === undefined) continue;

      if (draft[nextItemKey] === undefined) {
        draft[nextItemKey] = args.createReboundOverlay({
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
>(args: {
  createOverlay: (itemKey: string) => TOverlay;
  itemKeys: readonly string[];
  overlayStore: Store<Record<string, TOverlay>>;
}): void {
  const targetItemKeys = [...new Set(args.itemKeys)];
  if (targetItemKeys.length === 0) return;

  args.overlayStore.produceState((draft) => {
    for (const itemKey of targetItemKeys) {
      const existingOverlay = draft[itemKey];
      if (existingOverlay?.keepVisibleWhileResolutionRequired) {
        existingOverlay.keepVisibleWhileResolutionRequired = false;
        continue;
      }

      draft[itemKey] = args.createOverlay(itemKey);
    }
  });
}
