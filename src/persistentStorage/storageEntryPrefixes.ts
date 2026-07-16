export const COLLECTION_STORAGE_ENTRY_PREFIX = 'ci';
export const LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX = 'li';
export const LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX = 'lq';
export const OFFLINE_QUEUE_STORAGE_ENTRY_PREFIX = 'oq';
export const OFFLINE_CONFLICT_STORAGE_ENTRY_PREFIX = 'oc';
export const OFFLINE_ENTITY_STORAGE_ENTRY_PREFIX = 'oe';

/**
 * Store-name root reserved for offline coordination data. Every payload key
 * of the form `tsdf.<sessionKey>._o_.<name>` belongs to the offline runtime
 * and is never evicted by quota recovery or expired by generic cleanup.
 */
export const OFFLINE_ROOT_STORE_NAME = '_o_';

/** Store name of the per-session offline mode status entry. */
export const OFFLINE_SESSION_STATUS_STORE_NAME = '_o_.s';

/** Builds the `localStorage` key holding a session's offline mode status. */
export function getOfflineSessionStatusStorageKey(sessionKey: string): string {
  return `tsdf.${sessionKey}.${OFFLINE_SESSION_STATUS_STORE_NAME}`;
}
