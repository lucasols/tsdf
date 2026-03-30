import type { GlobalOfflineEntity } from './types';

export function createOfflineEntityLookup(
  entities: GlobalOfflineEntity[],
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
  return !!entity && !entity.hasConflict;
}

export type OfflineEntitiesMetadata = {
  pendingSync: boolean;
  pendingOfflineMutations: number;
  hasOfflineConflict: boolean;
  pendingItemKeys: string[];
  conflictedItemKeys: string[];
};

export function getOfflineEntitiesMetadata(
  entitiesByKey: ReadonlyMap<string, GlobalOfflineEntity>,
  entityKeys: readonly string[],
): OfflineEntitiesMetadata {
  const pendingItemKeys: string[] = [];
  const conflictedItemKeys: string[] = [];
  let pendingOfflineMutations = 0;

  for (const entityKey of entityKeys) {
    const entity = entitiesByKey.get(entityKey);
    if (!entity) continue;

    if (entity.hasConflict) {
      conflictedItemKeys.push(entityKey);
      continue;
    }

    pendingItemKeys.push(entityKey);
    pendingOfflineMutations += entity.pendingMutations;
  }

  return {
    pendingSync: pendingItemKeys.length > 0,
    pendingOfflineMutations,
    hasOfflineConflict: conflictedItemKeys.length > 0,
    pendingItemKeys,
    conflictedItemKeys,
  };
}
