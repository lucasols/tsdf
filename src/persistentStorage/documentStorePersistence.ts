import type { Store } from 't-state';
import type { DocumentStoreState } from '../documentStore';
import type { ValidStoreState } from '../utils/storeShared';
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
} from './types';
import { validateWithSchema } from './validateWithSchema';

function readDocumentFromLocalStorageSync(
  key: string,
  version: number,
): { persisted: PersistedDocumentData<unknown> | null; foundEntry: boolean } {
  const foundEntry = localStorage.getItem(key) !== null;
  const entry =
    readStorageEntryFromLocalStorageSync<PersistedDocumentData<unknown>>(
      key,
      version,
    );
  if (!entry) return { persisted: null, foundEntry };

  const persisted = entry.data;
  return {
    persisted,
    foundEntry,
  };
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

export function setupDocumentPersistence<State extends ValidStoreState>(
  config: DocumentPersistentStorageConfig<State> & {
    getSessionKey: () => string | false;
  },
): DocumentPersistenceSetup<State> {
  const version = config.version ?? 1;
  const storageAdapter = config.adapter;
  const persistentConfig = config;
  const handle =
    createPersistentStorageHandle<PersistedDocumentData<State>>(
      persistentConfig,
    );

  let storeRef: Store<DocumentStoreState<State>> | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let preloadPromise: Promise<void> | null = null;

  function hydrateFromLocalStorage(): void {
    if (!storeRef) return;

    const currentState = storeRef.state;
    if (currentState.status !== 'idle' || currentState.data !== null) return;

    const sessionKey = persistentConfig.getSessionKey();
    if (sessionKey === false) return;

    const key = getStorageKeyForStore(
      sessionKey,
      persistentConfig.storeName,
    );
    const { persisted, foundEntry } = readDocumentFromLocalStorageSync(
      key,
      version,
    );

    if (!persisted) {
      if (foundEntry) {
        scheduleIdleCleanup(() => void handle.clear());
      }
      return;
    }

    const validated = validateWithSchema(
      persistentConfig.schema,
      persisted.data,
    );
    if (validated === null) {
      scheduleIdleCleanup(() => void handle.clear());
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

    if (storageAdapter.kind !== 'sync') return baseState;

    const sessionKey = persistentConfig.getSessionKey();
    if (sessionKey === false) return baseState;

    const key = getStorageKeyForStore(
      sessionKey,
      persistentConfig.storeName,
    );
    const { persisted, foundEntry } = readDocumentFromLocalStorageSync(
      key,
      version,
    );

    if (!persisted) {
      if (foundEntry) {
        scheduleIdleCleanup(() => void handle.clear());
      }
      return baseState;
    }

    const validated = validateWithSchema(
      persistentConfig.schema,
      persisted.data,
    );
    if (validated === null) {
      scheduleIdleCleanup(() => void handle.clear());
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
    if (storageAdapter.kind === 'sync' || !storeRef) return;
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

  async function maybeHydrateFromStorage(): Promise<void> {
    if (storageAdapter.kind === 'sync') {
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
    maybeHydrateFromStorage,
    preloadPersistentStorage,
    hasAsyncPreload: storageAdapter.kind === 'async',
    dispose,
    clear,
  };
}
