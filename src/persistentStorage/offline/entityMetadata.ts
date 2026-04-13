import type { GlobalOfflineEntity } from './types';

export function createOfflineEntityLookup(
  entities: readonly GlobalOfflineEntity[],
): ReadonlyMap<string, GlobalOfflineEntity> {
  const entitiesByKey = new Map<string, GlobalOfflineEntity>();

  for (const entity of entities) {
    entitiesByKey.set(entity.entityKey, entity);
  }

  return entitiesByKey;
}

export function getIsPendingOfflineSync(
  entity: GlobalOfflineEntity | null | undefined,
): boolean {
  return !!entity && !entity.requiresResolution;
}

export function hasPendingOfflineSync(
  entitiesByKey: ReadonlyMap<string, GlobalOfflineEntity>,
  entityKeys: readonly string[],
): boolean {
  for (const entityKey of entityKeys) {
    if (getIsPendingOfflineSync(entitiesByKey.get(entityKey))) {
      return true;
    }
  }

  return false;
}

export function shouldApplyOfflineOverlay(
  entity: GlobalOfflineEntity | null | undefined,
  overlay: unknown,
): boolean {
  return (
    !!entity &&
    (!entity.requiresResolution ||
      entity.blockedResolutionCount > 0 ||
      entity.childResolutionCount > 0 ||
      (typeof overlay === 'object' &&
        overlay !== null &&
        'keepVisibleWhileResolutionRequired' in overlay &&
        overlay.keepVisibleWhileResolutionRequired === true))
  );
}

/**
 * Batch-filters offline overlays to only include entries with a pending sync
 * (entity exists and does not require resolution). Use this instead of calling
 * {@link getActiveOfflineOverlay} per item when all active overlays are needed
 * at once.
 */
export function filterActiveOfflineOverlays<Overlay>(
  entitiesByKey: ReadonlyMap<string, GlobalOfflineEntity>,
  overlays: Readonly<Record<string, Overlay>>,
): Record<string, Overlay> {
  const result: Record<string, Overlay> = {};

  for (const [entityKey, overlay] of Object.entries(overlays)) {
    if (shouldApplyOfflineOverlay(entitiesByKey.get(entityKey), overlay)) {
      result[entityKey] = overlay;
    }
  }

  return result;
}
