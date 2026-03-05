import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type { DocumentStoreState } from '../documentStore';
import type { FetchType } from '../requestScheduler';
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
  /** Initial state from synchronous localStorage read. Null if not available. */
  initialState: {
    data: State;
    status: 'success';
    refetchOnMount: FetchType;
  } | null;
  /** Attach to the store to enable async hydration and save subscriptions. */
  attach(
    store: Store<DocumentStoreState<State>>,
    invalidateData: (priority: FetchType) => void,
  ): void;
  /** Dispose subscriptions and cancel pending saves. */
  dispose(): void;
  /** Clear persisted data. */
  clear(): Promise<void>;
};

/**
 * Sets up persistent storage for a DocumentStore.
 *
 * For localStorage backend, provides synchronous initial state.
 * For OPFS backend, performs async hydration after store creation.
 */
export function setupDocumentPersistence<State extends ValidStoreState>(
  config: DocumentPersistentStorageConfig<State> & {
    getSessionKey: () => string | false;
  },
  options: {
    adapter?: StorageAdapter;
  } = {},
): DocumentPersistenceSetup<State> {
  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';

  const handle = createPersistentStorageHandle<PersistedDocumentData<State>>(
    config,
    { adapter: options.adapter },
  );

  // Synchronous initial state (localStorage only)
  let initialState: DocumentPersistenceSetup<State>['initialState'] = null;

  if (backend === 'localStorage') {
    const sessionKey = config.getSessionKey();

    if (sessionKey !== false) {
      const key = getStorageKeyForStore(sessionKey, config.storeName);
      const hasEntry = localStorage.getItem(key) !== null;
      const persisted = readDocumentFromLocalStorageSync(key, version);

      if (persisted) {
        const validated = validateWithSchema(config.schema, persisted.data);

        if (validated !== null) {
          initialState = {
            data: validated,
            status: 'success',
            refetchOnMount: 'lowPriority',
          };
          scheduleIdleCleanup(() => refreshLocalStorageTimestamp(key));
        } else {
          scheduleIdleCleanup(() => localStorage.removeItem(key));
        }
      } else if (hasEntry) {
        scheduleIdleCleanup(() => localStorage.removeItem(key));
      }
    }
  }

  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  function attach(
    store: Store<DocumentStoreState<State>>,
    invalidateData: (priority: FetchType) => void,
  ): void {
    // Async hydration for OPFS
    if (backend === 'opfs') {
      void handle.load().then((cached) => {
        if (!cached || disposed) return;

        const validated = validateWithSchema(config.schema, cached.data);
        if (validated === null) {
          scheduleIdleCleanup(() => void handle.clear());
          return;
        }

        // Only hydrate if store is still idle with no data
        const currentState = store.state;
        if (currentState.status !== 'idle' || currentState.data !== null)
          return;

        store.setPartialState(
          {
            data: validated,
            status: 'success',
            refetchOnMount: 'lowPriority',
          },
          { action: 'persistent-storage-hydrate' },
        );

        invalidateData('lowPriority');
      });
    }

    // Subscribe to state changes for saving
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
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    handle.dispose();
  }

  async function clear(): Promise<void> {
    await handle.clear();
  }

  return { initialState, attach, dispose, clear };
}
