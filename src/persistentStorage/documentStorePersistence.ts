import type { Store } from 't-state';
import type { DocumentStoreState } from '../documentStore';
import type { AnyOfflineOperationDefinition } from './offline/types';
import type { ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedDocumentData,
  parsePersistedStoreData,
} from './parsePersistedData';
import {
  assertValidPersistentStoreName,
  createPersistentStorageHandle,
  getLocalStorageAdapter,
  getStorageKeyForStore,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type {
  DocumentPersistentStorageConfig,
  PersistedDocumentData,
} from './types';

type DocumentPersistenceOfflineOperations<State extends ValidStoreState> =
  | (Record<string, AnyOfflineOperationDefinition> &
      ([State] extends [never] ? never : unknown))
  | null;

function readDocumentFromLocalStorageSync(
  key: string,
  version: number,
): { persisted: PersistedDocumentData<unknown> | null; foundEntry: boolean } {
  const entry = readStorageEntryFromLocalStorageSync<
    PersistedDocumentData<unknown>
  >(key, version, { metadata: 'single' });
  if (!entry) return { persisted: null, foundEntry: false };

  const persisted = parsePersistedDocumentData(entry.data);
  return { persisted, foundEntry: true };
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
  TOfflineOperations extends DocumentPersistenceOfflineOperations<State> = null,
  StorageState = unknown,
>(
  config: DocumentPersistentStorageConfig<
    State,
    StorageState,
    TOfflineOperations
  > & { getSessionKey: () => string | false },
): DocumentPersistenceSetup<State> {
  assertValidPersistentStoreName(config.storeName);

  const version = config.version ?? 1;
  const storageAdapter = config.adapter;
  const localStorageAdapter = getLocalStorageAdapter(storageAdapter);
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);
  const handle =
    createPersistentStorageHandle<PersistedDocumentData<State | StorageState>>(
      config,
    );

  let storeRef: Store<DocumentStoreState<State>> | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let preloadPromise: Promise<void> | null = null;

  function hydrateFromLocalStorage(): void {
    if (!storeRef) return;
    if (localStorageAdapter === null) return;

    const currentState = storeRef.state;
    if (currentState.status !== 'idle' || currentState.data !== null) return;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const key = getStorageKeyForStore(sessionKey, config.storeName);
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

    const validated = parsePersistedStoreData(persisted.data, dataSchema);
    if (validated === null) {
      scheduleIdleCleanup(() => void handle.clear());
      return;
    }

    scheduleIdleCleanup(() =>
      refreshLocalStorageTimestamp(key, { metadata: 'single' }),
    );

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

    if (localStorageAdapter === null) return baseState;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return baseState;

    const key = getStorageKeyForStore(sessionKey, config.storeName);
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

    const validated = parsePersistedStoreData(persisted.data, dataSchema);
    if (validated === null) {
      scheduleIdleCleanup(() => void handle.clear());
      return baseState;
    }

    scheduleIdleCleanup(() =>
      refreshLocalStorageTimestamp(key, { metadata: 'single' }),
    );

    return {
      ...baseState,
      data: validated,
      status: 'success',
      refetchOnMount: 'lowPriority',
    };
  }

  async function preloadPersistentStorage(): Promise<void> {
    if (localStorageAdapter !== null || !storeRef) return;
    if (preloadPromise) return preloadPromise;

    const currentGeneration = generation;
    preloadPromise = handle
      .load()
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) return;

        const validated = parsePersistedStoreData(cached.data, dataSchema);
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
    if (localStorageAdapter !== null) {
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
    hasAsyncPreload: localStorageAdapter === null,
    dispose,
    clear,
  };
}
