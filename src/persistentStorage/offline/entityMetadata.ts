import type {
  GlobalOfflineEntity,
  InternalGlobalOfflineEntity,
  ItemOfflineState,
} from './types';

export function createOfflineEntityLookup(
  entities: readonly GlobalOfflineEntity[],
): ReadonlyMap<string, GlobalOfflineEntity> {
  const entitiesByKey = new Map<string, GlobalOfflineEntity>();

  for (const entity of entities) {
    entitiesByKey.set(entity.entityKey, entity);
  }

  return entitiesByKey;
}

const storeEntityLookupsBySessionEntities = new WeakMap<
  readonly InternalGlobalOfflineEntity[],
  Map<string, Map<string, InternalGlobalOfflineEntity>>
>();
const emptyEntityLookup: ReadonlyMap<string, InternalGlobalOfflineEntity> =
  new Map();

/**
 * Entities of one store keyed by entity key, for a snapshot of the session's
 * entities (all stores). The lookups are built once per snapshot and shared by
 * every reader, so per-item readers (one per rendered row) do a keyed read
 * instead of each scanning the whole session on every change.
 */
export function getOfflineStoreEntityLookup(
  sessionEntities: readonly InternalGlobalOfflineEntity[],
  storeName: string,
): ReadonlyMap<string, InternalGlobalOfflineEntity> {
  let lookupsByStoreName =
    storeEntityLookupsBySessionEntities.get(sessionEntities);

  if (!lookupsByStoreName) {
    lookupsByStoreName = new Map();

    for (const entity of sessionEntities) {
      let lookup = lookupsByStoreName.get(entity.storeName);

      if (!lookup) {
        lookup = new Map();
        lookupsByStoreName.set(entity.storeName, lookup);
      }

      lookup.set(entity.entityKey, entity);
    }

    storeEntityLookupsBySessionEntities.set(
      sessionEntities,
      lookupsByStoreName,
    );
  }

  return lookupsByStoreName.get(storeName) ?? emptyEntityLookup;
}

/**
 * @param attemptedCreationEntityIds - ids of the session's unsent creations
 * whose creation was already sent or waits for a manual resolution
 */
export function toItemOfflineState(
  entity: InternalGlobalOfflineEntity | undefined,
  attemptedCreationEntityIds: readonly string[],
): ItemOfflineState | null {
  if (entity?.entityKind !== 'item') return null;

  // A temp entity not reconciled to its server payload yet (the stores'
  // `unsentCreationItemKeys`), or an item with a client-generated id whose
  // creation the server has not confirmed yet.
  const isUnsentCreation =
    entity.tempId !== undefined || entity.isClientIdCreation === true;

  return {
    syncState: entity.syncState,
    pendingMutations: entity.pendingMutations,
    requiresResolution: entity.requiresResolution,
    isUnsentCreation,
    creationAttempted:
      isUnsentCreation && attemptedCreationEntityIds.includes(entity.id),
  };
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
