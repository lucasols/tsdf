import {
  clearAllSessionStorage,
  createStoreManager,
  type StoreError,
} from 'tsdf';
import { indexedDbPersistentStorage } from 'tsdf/indexed-db-storage';
import { opfsPersistentStorage } from 'tsdf/opfs-storage';

export const PLAYGROUND_SESSION_KEY = 'tsdf-playground-session';
export const PLAYGROUND_DOCUMENT_STORAGE_ADAPTER = 'local-sync';
export const PLAYGROUND_COLLECTION_STORAGE_ADAPTER = indexedDbPersistentStorage;
export const PLAYGROUND_LIST_QUERY_STORAGE_ADAPTER = opfsPersistentStorage;

function normalizeError(error: Error): StoreError {
  return { code: 500, id: 'playground-error', message: error.message };
}

export const storeManager = createStoreManager({
  getSessionKey: () => PLAYGROUND_SESSION_KEY,
  errorNormalizer: normalizeError,
  revalidateOnWindowFocus: true,
  debug: true,
  dynamicRealtimeThrottleMs: () => 500,
  onMutationError(error) {
    console.warn('[tsdf playground] mutation failed', error);
  },
});

export async function clearPlaygroundStorage(): Promise<void> {
  await clearAllSessionStorage(PLAYGROUND_SESSION_KEY);
}

export function resetPlaygroundStores(): void {
  storeManager.resetAll([]);
}
