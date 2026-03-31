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
    if (getIsPendingOfflineSync(entitiesByKey.get(entityKey))) {
      result[entityKey] = overlay;
    }
  }

  return result;
}

export type OfflineEntitiesMetadata = {
  pendingSync: boolean;
  pendingOfflineMutations: number;
  hasOfflineResolution: boolean;
  pendingItemKeys: string[];
  resolutionRequiredItemKeys: string[];
};

export function getOfflineEntitiesMetadata(
  entitiesByKey: ReadonlyMap<string, GlobalOfflineEntity>,
  entityKeys: readonly string[],
): OfflineEntitiesMetadata {
  const pendingItemKeys: string[] = [];
  const resolutionRequiredItemKeys: string[] = [];
  let pendingOfflineMutations = 0;

  for (const entityKey of entityKeys) {
    const entity = entitiesByKey.get(entityKey);
    if (!entity) continue;

    if (entity.requiresResolution) {
      resolutionRequiredItemKeys.push(entityKey);
      continue;
    }

    pendingItemKeys.push(entityKey);
    pendingOfflineMutations += entity.pendingMutations;
  }

  return {
    pendingSync: pendingItemKeys.length > 0,
    pendingOfflineMutations,
    hasOfflineResolution: resolutionRequiredItemKeys.length > 0,
    pendingItemKeys,
    resolutionRequiredItemKeys,
  };
}
