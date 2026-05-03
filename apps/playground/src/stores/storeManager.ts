import { clearSessionStorage, createStoreManager, type StoreError } from 'tsdf';

export const PLAYGROUND_SESSION_KEY = 'tsdf-playground-session';
export const PLAYGROUND_STORAGE_ADAPTER = 'local-sync';

function normalizeError(error: Error): StoreError {
  return { code: 500, id: 'playground-error', message: error.message };
}

export const storeManager = createStoreManager({
  getSessionKey: () => PLAYGROUND_SESSION_KEY,
  errorNormalizer: normalizeError,
  revalidateOnWindowFocus: true,
  debug: true,
  onMutationError(error) {
    console.warn('[tsdf playground] mutation failed', error);
  },
});

export async function clearPlaygroundStorage(): Promise<void> {
  await clearSessionStorage(PLAYGROUND_SESSION_KEY, PLAYGROUND_STORAGE_ADAPTER);
}

export function resetPlaygroundStores(): void {
  storeManager.resetAll([]);
}
