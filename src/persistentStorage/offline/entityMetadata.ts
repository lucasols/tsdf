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

export function getActiveOfflineOverlay<Overlay>(
  entitiesByKey: ReadonlyMap<string, GlobalOfflineEntity>,
  overlays: Readonly<Record<string, Overlay>>,
  entityKey: string,
): Overlay | undefined {
  return getIsPendingOfflineSync(entitiesByKey.get(entityKey))
    ? overlays[entityKey]
    : undefined;
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
