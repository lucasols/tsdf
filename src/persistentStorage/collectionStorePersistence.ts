import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  createPersistentStorageHandle,
  getStorageKeyForStore,
} from './persistentStorageManager';
import type {
  CollectionPersistentStorageConfig,
  PersistedCollectionData,
  PersistedCollectionItem,
  StorageAdapter,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 50;

/**
 * Synchronously reads persisted collection data from localStorage.
 */
function readCollectionFromLocalStorageSync(
  key: string,
  version: number,
): PersistedCollectionData<unknown> | null {
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

    if (!data || typeof data !== 'object' || !('items' in data)) {
      return null;
    }

    return __LEGIT_CAST__<PersistedCollectionData<unknown>, object>(data);
  } catch {
    return null;
  }
}

/**
 * Validates and reconstructs collection items from persisted data.
 */
function validatePersistedItems<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  persisted: PersistedCollectionData<unknown>,
  config: CollectionPersistentStorageConfig<ItemState>,
): Record<string, TSFDCollectionItem<ItemState, ItemPayload>> | null {
  const result: Record<string, TSFDCollectionItem<ItemState, ItemPayload>> = {};
  let hasValidItems = false;

  for (const [itemKey, item] of Object.entries(persisted.items)) {
    const validated = validateWithSchema(config.schema, item.data);
    if (validated === null) continue;

    hasValidItems = true;
    result[itemKey] = {
      data: validated,
      error: null,
      status: 'success',
      payload: __LEGIT_CAST__<ItemPayload, unknown>(item.payload),
      refetchOnMount: 'lowPriority',
      wasLoaded: true,
    };
  }

  return hasValidItems ? result : null;
}

/**
 * Applies LRU eviction to collection items before saving.
 * Returns items sorted by: pinned first, then by lastAccessedAt descending,
 * capped at maxItems.
 */
function evictLruItems<State>(
  items: Record<string, PersistedCollectionItem<State>>,
  maxItems: number,
  pinnedItems: Set<string>,
): Record<string, PersistedCollectionItem<State>> {
  const entries = Object.entries(items);

  if (entries.length <= maxItems) return items;

  // Sort: pinned first, then by lastAccessedAt descending
  entries.sort(([keyA, a], [keyB, b]) => {
    const aPinned = pinnedItems.has(keyA);
    const bPinned = pinnedItems.has(keyB);

    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;

    return b.lastAccessedAt - a.lastAccessedAt;
  });

  const kept = entries.slice(0, maxItems);
  const result: Record<string, PersistedCollectionItem<State>> = {};

  for (const [key, value] of kept) {
    result[key] = value;
  }

  return result;
}

export type CollectionPersistenceSetup<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  /** Initial items from synchronous localStorage read. Empty record if not available. */
  initialItems: Record<
    string,
    TSFDCollectionItem<ItemState, ItemPayload>
  > | null;
  /** Attach to the store to enable async hydration and save subscriptions. */
  attach(store: Store<TSFDCollectionState<ItemState, ItemPayload>>): void;
  /** Dispose subscriptions and cancel pending saves. */
  dispose(): void;
  /** Clear persisted data. */
  clear(): Promise<void>;
};

/**
 * Sets up persistent storage for a CollectionStore.
 */
export function setupCollectionPersistence<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  config: CollectionPersistentStorageConfig<ItemState>,
  options: {
    adapter?: StorageAdapter;
  } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const pinnedItems = new Set(config.pinnedItems ?? []);

  const handle = createPersistentStorageHandle<
    PersistedCollectionData<ItemState>
  >(config, { adapter: options.adapter });

  // Synchronous initial state (localStorage only)
  let initialItems: CollectionPersistenceSetup<
    ItemState,
    ItemPayload
  >['initialItems'] = null;

  if (backend === 'localStorage') {
    const sessionKey = config.getSessionKey();

    if (sessionKey !== false) {
      const key = getStorageKeyForStore(sessionKey, config.storeName);
      const persisted = readCollectionFromLocalStorageSync(key, version);

      if (persisted) {
        initialItems = validatePersistedItems<ItemState, ItemPayload>(
          persisted,
          config,
        );
      }
    }
  }

  let unsubscribe: (() => void) | null = null;

  function attach(
    store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  ): void {
    // Async hydration for OPFS
    if (backend === 'opfs') {
      void handle.load().then((cached) => {
        if (!cached) return;

        const currentState = store.state;
        const hasExistingData = Object.keys(currentState).length > 0;
        if (hasExistingData) return;

        const validated = validatePersistedItems<ItemState, ItemPayload>(
          cached,
          config,
        );

        if (!validated) return;

        store.setPartialState(validated, {
          action: 'persistent-storage-hydrate',
        });
      });
    }

    // Subscribe to state changes for saving
    unsubscribe = store.subscribe(({ current }) => {
      handle.scheduleSave(() => {
        const stateToSave = store.state;
        const persistedItems: Record<
          string,
          PersistedCollectionItem<ItemState>
        > = {};

        for (const [itemKey, item] of Object.entries(stateToSave)) {
          if (!item?.data) continue;

          persistedItems[itemKey] = {
            data: item.data,
            payload: item.payload,
            lastAccessedAt: Date.now(),
          };
        }

        const evicted = evictLruItems(persistedItems, maxItems, pinnedItems);

        return { items: evicted };
      });

      // Suppress unused variable warning — current is used by the subscribe API
      void current;
    });
  }

  function dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    handle.dispose();
  }

  async function clear(): Promise<void> {
    await handle.clear();
  }

  return { initialItems, attach, dispose, clear };
}
