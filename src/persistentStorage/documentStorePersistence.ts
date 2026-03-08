import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type { DocumentStoreState } from '../documentStore';
import type { ValidStoreState } from '../utils/storeShared';
import {
  createPersistentStorageHandle,
  getStorageKeyForStore,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type {
  DocumentPersistentStorageConfig,
  PersistedDocumentData,
  StorageAdapter,
} from './types';
import { validateWithSchema } from './validateWithSchema';

/**
 * Synchronously reads a persisted document from localStorage.
 * Returns the raw persisted data (not yet validated by user schema).
 */
function readDocumentFromLocalStorageSync(
  key: string,
  version: number,
): PersistedDocumentData<unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;

    const entry: unknown = JSON.parse(raw);

    if (
      !entry ||
      typeof entry !== 'object' ||
      !('version' in entry) ||
      !('data' in entry)
    ) {
      return null;
    }

    const typedEntry = __LEGIT_CAST__<
      { version: unknown; data: unknown },
      object
    >(entry);

    if (typedEntry.version !== version) return null;

    const data = typedEntry.data;

    if (!data || typeof data !== 'object' || !('data' in data)) {
      return null;
    }

    return __LEGIT_CAST__<PersistedDocumentData<unknown>, object>(data);
  } catch {
    return null;
  }
}

export type DocumentPersistenceSetup<State extends ValidStoreState> = {
  createInitialState(
    baseState: DocumentStoreState<State>,
  ): DocumentStoreState<State>;
  attach(store: Store<DocumentStoreState<State>>): void;
  preloadPersistentStorage(): Promise<void>;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

export function setupDocumentPersistence<State extends ValidStoreState>(
  config: DocumentPersistentStorageConfig<State> & {
    getSessionKey: () => string | false;
  },
  options: { adapter?: StorageAdapter } = {},
): DocumentPersistenceSetup<State> {
  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const handle = createPersistentStorageHandle<PersistedDocumentData<State>>(
    config,
    { adapter: options.adapter },
  );

  let storeRef: Store<DocumentStoreState<State>> | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let preloadPromise: Promise<void> | null = null;

  function createInitialState(
    baseState: DocumentStoreState<State>,
  ): DocumentStoreState<State> {
    if (
      baseState.status !== 'idle' ||
      baseState.data !== null ||
      baseState.error !== null
    ) {
      return baseState;
    }

    if (backend !== 'localStorage') return baseState;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return baseState;

    const key = getStorageKeyForStore(sessionKey, config.storeName);
    const hasEntry = localStorage.getItem(key) !== null;
    const persisted = readDocumentFromLocalStorageSync(key, version);

    if (!persisted) {
      if (hasEntry) {
        scheduleIdleCleanup(() => localStorage.removeItem(key));
      }
      return baseState;
    }

    const validated = validateWithSchema(config.schema, persisted.data);
    if (validated === null) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return baseState;
    }

    scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));

    return {
      ...baseState,
      data: validated,
      status: 'success',
      refetchOnMount: 'lowPriority',
    };
  }

  async function preloadPersistentStorage(): Promise<void> {
    if (backend !== 'opfs' || !storeRef) return;
    if (preloadPromise) return preloadPromise;

    const currentGeneration = generation;
    preloadPromise = handle
      .load()
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) return;

        const validated = validateWithSchema(config.schema, cached.data);
        if (validated === null) {
          scheduleIdleCleanup(() => void handle.clear());
          return;
        }

        const currentState = storeRef.state;
        if (currentState.status !== 'idle' || currentState.data !== null) {
          return;
        }

        storeRef.setPartialState(
          { data: validated, status: 'success', refetchOnMount: 'lowPriority' },
          { action: 'persistent-storage-hydrate' },
        );
      })
      .finally(() => {
        if (currentGeneration === generation) {
          preloadPromise = null;
        }
      });

    return preloadPromise;
  }

  function attach(store: Store<DocumentStoreState<State>>): void {
    storeRef = store;

    unsubscribe = store.subscribe(({ current }) => {
      if (current.status === 'success' && current.data !== null) {
        const capturedData = current.data;

        handle.scheduleSave(() => {
          const storeData = store.state.data;
          return { data: storeData ?? capturedData };
        });
      }
    });
  }

  function dispose(): void {
    generation++;
    preloadPromise = null;
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    handle.dispose();
  }

  async function clear(): Promise<void> {
    await handle.clear();
  }

  return {
    createInitialState,
    attach,
    preloadPersistentStorage,
    hasAsyncPreload: backend === 'opfs',
    dispose,
    clear,
  };
}
