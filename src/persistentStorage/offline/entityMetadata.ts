import { useCallback, useMemo } from 'react';

import { useOfflineStoreEntities } from './sessionCoordinator';
import type { GlobalOfflineEntity } from './types';

/**
 * React hook that returns a memoized `getPendingSync` callback for checking
 * whether a single item has a pending offline sync.
 *
 * Used by collection and list-query `useMultipleItems` wrappers.
 */
export function useGetPendingSync(args: {
  sessionKey: string | false;
  inactiveScope: string;
  storeName?: string;
}): (itemStateKey: string) => boolean {
  const offlineEntities = useOfflineStoreEntities(args);
  const offlineEntitiesByKey = useMemo(
    () => createOfflineEntityLookup(offlineEntities),
    [offlineEntities],
  );
  return useCallback(
    (itemStateKey: string) => {
      return getIsPendingOfflineSync(offlineEntitiesByKey.get(itemStateKey));
    },
    [offlineEntitiesByKey],
  );
}

/**
 * React hook that returns a memoized callback for checking whether any items
 * in a set of keys have pending offline sync.
 *
 * Used by the list-query `useMultipleListQueries` wrapper.
 */
export function useGetPendingSyncForItemKeys(args: {
  sessionKey: string | false;
  inactiveScope: string;
  storeName?: string;
}): (itemKeys: string[]) => boolean {
  const offlineEntities = useOfflineStoreEntities(args);
  const offlineEntitiesByKey = useMemo(
    () => createOfflineEntityLookup(offlineEntities),
    [offlineEntities],
  );
  return useCallback(
    (itemKeys: string[]) => {
      return getOfflineEntitiesMetadata(offlineEntitiesByKey, itemKeys)
        .pendingSync;
    },
    [offlineEntitiesByKey],
  );
}

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
