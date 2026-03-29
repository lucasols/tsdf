import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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

const documentStorageValueCodec = {
  serialize: (data: PersistedDocumentData<unknown>) => ({ d: data.data }),
  deserialize: (value: unknown) =>
    typeof value === 'object' && value !== null && 'd' in value
      ? parsePersistedDocumentData({ data: value.d })
      : null,
};

function readDocumentFromLocalStorageSync(
  key: string,
  version: number | undefined,
): { persisted: PersistedDocumentData<unknown> | null; foundEntry: boolean } {
  const entry = readStorageEntryFromLocalStorageSync<
    PersistedDocumentData<unknown>
  >(key, version, { metadata: 'single' }, documentStorageValueCodec);
  if (!entry) return { persisted: null, foundEntry: false };

  return { persisted: entry.data, foundEntry: true };
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

  const version = config.version;
  const storageAdapter = config.adapter;
  const localStorageAdapter = getLocalStorageAdapter(storageAdapter);
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);
  const handle = createPersistentStorageHandle<
    PersistedDocumentData<State | StorageState>
  >(config, {
    valueCodec: {
      serialize: (data) => ({ d: data.data }),
      deserialize: (value) =>
        typeof value === 'object' && value !== null && 'd' in value
          ? (() => {
              const parsed = parsePersistedDocumentData({ data: value.d });
              return parsed
                ? {
                    data: __LEGIT_CAST__<State | StorageState, unknown>(
                      parsed.data,
                    ),
                  }
                : null;
            })()
          : null,
    },
  });

  let storeRef: Store<DocumentStoreState<State>> | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let preloadPromise: Promise<void> | null = null;
  let syncHydrationMissKnown = false;

  function hydrateFromLocalStorage(): void {
    if (!storeRef) return;
    if (localStorageAdapter === null) return;

    const initialState = storeRef.state;
    if (initialState.status !== 'idle' || initialState.data !== null) return;
    if (syncHydrationMissKnown) return;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const key = getStorageKeyForStore(sessionKey, config.storeName);
    const { persisted, foundEntry } = readDocumentFromLocalStorageSync(
      key,
      version,
    );

    if (!persisted) {
      syncHydrationMissKnown = true;
      if (foundEntry) {
        scheduleIdleCleanup(() => void handle.clear());
      }
      return;
    }

    const validated = parsePersistedStoreData(persisted.data, dataSchema);
    if (validated === null) {
      syncHydrationMissKnown = true;
      scheduleIdleCleanup(() => void handle.clear());
      return;
    }

    syncHydrationMissKnown = false;
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
      syncHydrationMissKnown = true;
      if (foundEntry) {
        scheduleIdleCleanup(() => void handle.clear());
      }
      return baseState;
    }

    const validated = parsePersistedStoreData(persisted.data, dataSchema);
    if (validated === null) {
      syncHydrationMissKnown = true;
      scheduleIdleCleanup(() => void handle.clear());
      return baseState;
    }

    syncHydrationMissKnown = false;
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

    const currentState = storeRef.state;
    if (currentState.status !== 'idle' || currentState.data !== null) return;

    const currentGeneration = generation;
    preloadPromise = handle
      .load({ touch: 'coarse' })
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) return;

        const validated = parsePersistedStoreData(cached.data, dataSchema);
        if (validated === null) {
          void handle.clear().catch(() => {});
          return;
        }

        const liveState = storeRef.state;
        if (liveState.status !== 'idle' || liveState.data !== null) {
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
    syncHydrationMissKnown = false;
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
