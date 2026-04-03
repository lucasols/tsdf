import type { Store } from 't-state';

import type { DocumentStoreState } from '../documentStore';
import type { ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedDocumentData,
  parsePersistedStoreData,
} from './parsePersistedData';
import {
  createPersistentStorageHandle,
  getStorageKeyForStore,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type {
  DocumentPersistentStorageConfig,
  PersistedDocumentData,
  StorageAdapter,
} from './types';

/**
 * Synchronously reads a persisted document from localStorage.
 * Returns the raw persisted data (not yet validated by user schema).
 */
function readDocumentFromLocalStorageSync(
  key: string,
  version: number,
): PersistedDocumentData<unknown> | null {
  const entry = readStorageEntryFromLocalStorageSync(key, version);
  if (!entry) return null;

  return parsePersistedDocumentData(entry.data);
}

export type DocumentPersistenceSetup<State extends ValidStoreState> = {
  createInitialState(
    baseState: DocumentStoreState<State>,
  ): DocumentStoreState<State>;
  attach(store: Store<DocumentStoreState<State>>): void;
  maybeHydrateFromStorage(): Promise<void>;
  preloadPersistentStorage(): Promise<void>;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

export function setupDocumentPersistence<
  State extends ValidStoreState,
  StorageState = unknown,
>(
  config: DocumentPersistentStorageConfig<State, StorageState> & {
    getSessionKey: () => string | false;
  },
  options: { adapter?: StorageAdapter } = {},
): DocumentPersistenceSetup<State> {
  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);
  const handle = createPersistentStorageHandle<
    PersistedDocumentData<State | StorageState>
  >(config, { adapter: options.adapter });

  let storeRef: Store<DocumentStoreState<State>> | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let preloadPromise: Promise<void> | null = null;

  function hydrateFromLocalStorage(): void {
    if (!storeRef) return;

    const currentState = storeRef.state;
    if (currentState.status !== 'idle' || currentState.data !== null) return;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const key = getStorageKeyForStore(sessionKey, config.storeName);
    const hasEntry = localStorage.getItem(key) !== null;
    const persisted = readDocumentFromLocalStorageSync(key, version);

    if (!persisted) {
      if (hasEntry) {
        scheduleIdleCleanup(() => localStorage.removeItem(key));
      }
      return;
    }

    const validated = parsePersistedStoreData(persisted.data, dataSchema);
    if (validated === null) {
      scheduleIdleCleanup(() => localStorage.removeItem(key));
      return;
    }

    scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));

    storeRef.setPartialState(
      { data: validated, status: 'success', refetchOnMount: 'lowPriority' },
      { action: 'persistent-storage-hydrate' },
    );
  }

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

    const validated = parsePersistedStoreData(persisted.data, dataSchema);
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

        const persisted = parsePersistedDocumentData(cached);
        if (!persisted) {
          scheduleIdleCleanup(() => void handle.clear());
          return;
        }

        const validated = parsePersistedStoreData(persisted.data, dataSchema);
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

  async function maybeHydrateFromStorage(): Promise<void> {
    if (backend === 'localStorage') {
      hydrateFromLocalStorage();
      return;
    }

    await preloadPersistentStorage();
  }

  function attach(store: Store<DocumentStoreState<State>>): void {
    storeRef = store;

    unsubscribe = store.subscribe(({ current }) => {
      if (current.status === 'success' && current.data !== null) {
        const capturedData = current.data;

        handle.scheduleSave(() => {
          const storeData = store.state.data;
          const dataToPersist = storeData ?? capturedData;
          const converted = convertStoreDataForPersistence(
            dataToPersist,
            dataSchema,
          );

          if (!converted.ok) {
            throw converted.error;
          }

          return { data: converted.value };
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
    maybeHydrateFromStorage,
    preloadPersistentStorage,
    hasAsyncPreload: backend === 'opfs',
    dispose,
    clear,
  };
}
