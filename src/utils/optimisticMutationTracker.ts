type EntityMutations = { active: Set<number>; lastSucceededId: number };

/**
 * Tracks the optimistic mutations of each entity, so a failed one can tell
 * whether a newer one may have been saved without changing the local state
 * (e.g. saving the same value), which reverting the failed one would
 * contradict. Mutations that fail or are skipped don't count.
 */
export function createOptimisticMutationTracker() {
  const entities = new Map<string, EntityMutations>();

  return {
    start(key: string, mutationId: number): void {
      const entity = entities.get(key);
      if (entity) {
        entity.active.add(mutationId);
      } else {
        entities.set(key, {
          active: new Set([mutationId]),
          lastSucceededId: 0,
        });
      }
    },
    /**
     * Whether an optimistic mutation other than `selfId`, started after
     * `sinceId`, succeeded or is still in flight. `sinceId` is older than
     * `selfId` when the failing mutation reverts the updates of the debounced
     * calls it superseded.
     */
    hasNewer(key: string, sinceId: number, selfId: number): boolean {
      const entity = entities.get(key);
      if (!entity) return false;
      if (entity.lastSucceededId > sinceId) return true;
      for (const id of entity.active) {
        if (id > sinceId && id !== selfId) return true;
      }
      return false;
    },
    /** Whether an optimistic mutation other than `selfId` is in flight */
    hasOtherInFlight(key: string, selfId: number): boolean {
      const entity = entities.get(key);
      if (!entity) return false;
      for (const id of entity.active) {
        if (id !== selfId) return true;
      }
      return false;
    },
    /** `succeeded` is whether the server accepted the mutation */
    end(key: string, mutationId: number, succeeded: boolean): void {
      const entity = entities.get(key);
      if (!entity?.active.delete(mutationId)) return;

      // Only older mutations still in flight need to know about this one
      if (entity.active.size === 0) {
        entities.delete(key);
      } else if (succeeded) {
        entity.lastSucceededId = Math.max(entity.lastSucceededId, mutationId);
      }
    },
  };
}
