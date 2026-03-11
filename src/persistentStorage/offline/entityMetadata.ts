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

export type OfflineEntityMetadata = {
  isPendingOfflineSync: boolean;
  pendingOfflineMutations: number;
  hasOfflineConflict: boolean;
};

export function getOfflineEntityMetadata(
  entity: GlobalOfflineEntity | null | undefined,
): OfflineEntityMetadata {
  return {
    isPendingOfflineSync: !!entity && !entity.hasConflict,
    pendingOfflineMutations: entity?.pendingMutations ?? 0,
    hasOfflineConflict: entity?.hasConflict ?? false,
  };
}

export type OfflineEntitiesMetadata = OfflineEntityMetadata & {
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
    isPendingOfflineSync: pendingItemKeys.length > 0,
    pendingOfflineMutations,
    hasOfflineConflict: conflictedItemKeys.length > 0,
    pendingItemKeys,
    conflictedItemKeys,
  };
}
