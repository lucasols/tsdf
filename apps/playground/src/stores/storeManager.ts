import {
  clearAllSessionStorage,
  createStoreManager,
  type TSDFDebugLogEntry,
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

type PlaygroundDebugEntry = {
  area: string;
  operation: string;
  message: string;
  details: Readonly<Record<string, unknown>> | undefined;
};

let playgroundDebugEntries: readonly PlaygroundDebugEntry[] = [];
const playgroundDebugListeners = new Set<() => void>();

export function getPlaygroundDebugEntries(): readonly PlaygroundDebugEntry[] {
  return playgroundDebugEntries;
}

export function subscribePlaygroundDebugEntries(
  listener: () => void,
): () => void {
  playgroundDebugListeners.add(listener);
  return () => {
    playgroundDebugListeners.delete(listener);
  };
}

function logPlaygroundDebugEntry(entry: TSDFDebugLogEntry): void {
  console[entry.level](`[tsdf:${entry.area}] ${entry.message}`, {
    operation: entry.operation,
    ...entry.details,
  });
  playgroundDebugEntries = [
    {
      area: entry.area,
      operation: entry.operation,
      message: entry.message,
      details: entry.details,
    },
    ...playgroundDebugEntries,
  ].slice(0, 30);
  for (const listener of playgroundDebugListeners) {
    listener();
  }
}

export const storeManager = createStoreManager({
  getSessionKey: () => PLAYGROUND_SESSION_KEY,
  errorNormalizer: normalizeError,
  revalidateOnWindowFocus: true,
  debugLogger: logPlaygroundDebugEntry,
  logger: logPlaygroundDebugEntry,
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
