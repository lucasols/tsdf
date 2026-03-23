import type { Store } from 't-state';
import type { DocumentStoreState } from '../documentStore';
import type { AnyOfflineOperationDefinition } from './offline/types';
import type { ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  finalizePersistedStoreData,
  normalizePersistentStorageDataSchema,
  parsePersistedDocumentData,
  validatePersistedStoreData,
} from './parsePersistedData';
import {
  assertValidPersistentStoreName,
  createPersistentStorageHandle,
  getLocalStorageAdapter,
  getStorageKeyForStore,
  readRawStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type {
  DocumentPersistentStorageConfig,
  PersistedDocumentData,
  StorageCacheEntry,
} from './types';
import { resolveVersionedPersistedData } from './versionedPersistence';

type DocumentPersistenceOfflineOperations<State extends ValidStoreState> =
  | (Record<string, AnyOfflineOperationDefinition> &
      ([State] extends [never] ? never : unknown))
  | null;

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

  const version = config.version;
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

  function discardPersistedDocument(): void {
    scheduleIdleCleanup(() => void handle.clear());
  }

  function resolveHydratedDocument(
    entry: StorageCacheEntry<PersistedDocumentData<unknown>> | null,
  ): {
    persisted: PersistedDocumentData<State | StorageState>;
    data: State;
  } | null {
    if (entry === null) return null;

    const versioned = resolveVersionedPersistedData({
      persistedData: entry.data,
      fromVersion: entry.version,
      targetVersion: version,
      migrate: config.migrate,
      parseCurrentPersistedData: parsePersistedDocumentData,
    });
    if (versioned === null) return null;

    const persistedData = validatePersistedStoreData(
      versioned.persisted.data,
      dataSchema,
    );
    if (persistedData === null) return null;

    const persisted: PersistedDocumentData<State | StorageState> = {
      data: persistedData,
    };

    if (versioned.wasMigrated) {
      void handle.saveNow(persisted);
    }

    const hydratedData = finalizePersistedStoreData(persistedData, dataSchema);
    if (hydratedData === null) return null;

    return { persisted, data: hydratedData };
  }

  function hydrateFromLocalStorage(): void {
    if (!storeRef) return;
    if (localStorageAdapter === null) return;

    const currentState = storeRef.state;
    if (currentState.status !== 'idle' || currentState.data !== null) return;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const key = getStorageKeyForStore(sessionKey, config.storeName);
    const entry = readRawStorageEntryFromLocalStorageSync<
      PersistedDocumentData<unknown>
    >(key, { metadata: 'single' });
    const hydrated = resolveHydratedDocument(entry);

    if (!hydrated) {
      if (entry !== null) {
        discardPersistedDocument();
      }
      return;
    }

    scheduleIdleCleanup(() =>
      refreshLocalStorageTimestamp(key, { metadata: 'single' }),
    );

    storeRef.setPartialState(
      { data: hydrated.data, status: 'success', refetchOnMount: 'lowPriority' },
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
    const entry = readRawStorageEntryFromLocalStorageSync<
      PersistedDocumentData<unknown>
    >(key, { metadata: 'single' });
    const hydrated = resolveHydratedDocument(entry);

    if (!hydrated) {
      if (entry !== null) {
        discardPersistedDocument();
      }
      return baseState;
    }

    scheduleIdleCleanup(() =>
      refreshLocalStorageTimestamp(key, { metadata: 'single' }),
    );

    return {
      ...baseState,
      data: hydrated.data,
      status: 'success',
      refetchOnMount: 'lowPriority',
    };
  }

  async function preloadPersistentStorage(): Promise<void> {
    if (localStorageAdapter !== null || !storeRef) return;
    if (preloadPromise) return preloadPromise;

    const currentGeneration = generation;
    preloadPromise = handle
      .readEntry()
      .then((entry) => {
        if (!entry || currentGeneration !== generation || !storeRef) return;

        const hydrated = resolveHydratedDocument(entry);
        if (hydrated === null) {
          discardPersistedDocument();
          return;
        }

        const currentState = storeRef.state;
        if (currentState.status !== 'idle' || currentState.data !== null) {
          return;
        }

        storeRef.setPartialState(
          {
            data: hydrated.data,
            status: 'success',
            refetchOnMount: 'lowPriority',
          },
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
