import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  createPersistentStorageNamespaceHandle,
  getStoragePrefixForStoreNamespace,
  listLocalStorageKeysSync,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import type {
  CollectionPersistentStorageConfig,
  PersistedCollectionItemData,
  StorageAdapter,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 50;
const SAVE_DEBOUNCE_MS = 1000;

function toCollectionItemState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  persisted: PersistedCollectionItemData<unknown>,
  config: CollectionPersistentStorageConfig<ItemState>,
): TSFDCollectionItem<ItemState, ItemPayload> | null {
  const validated = validateWithSchema(config.schema, persisted.data);
  if (validated === null) return null;

  return {
    data: validated,
    error: null,
    payload: __LEGIT_CAST__<ItemPayload, unknown>(persisted.payload),
    refetchOnMount: 'lowPriority',
    status: 'success',
    wasLoaded: true,
  };
}

function defineLazyLocalStorageItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  state: TSFDCollectionState<ItemState, ItemPayload>,
  itemKey: string,
  storageKey: string,
  version: number,
  config: CollectionPersistentStorageConfig<ItemState>,
): void {
  Object.defineProperty(state, itemKey, {
    configurable: true,
    enumerable: false,
    get() {
      const cacheEntry = readStorageEntryFromLocalStorageSync<
        PersistedCollectionItemData<unknown>
      >(storageKey, version);

      if (!cacheEntry) {
        Object.defineProperty(state, itemKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      const item = toCollectionItemState<ItemState, ItemPayload>(
        cacheEntry.data,
        config,
      );

      if (!item) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        Object.defineProperty(state, itemKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      Object.defineProperty(state, itemKey, {
        configurable: true,
        enumerable: true,
        value: item,
        writable: true,
      });

      return item;
    },
  });
}

export type CollectionPersistenceSetup<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  createInitialState(
    baseState: TSFDCollectionState<ItemState, ItemPayload>,
  ): TSFDCollectionState<ItemState, ItemPayload>;
  attach(store: Store<TSFDCollectionState<ItemState, ItemPayload>>): void;
  preloadItems(itemKeys: string[]): Promise<void>;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

export function setupCollectionPersistence<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  config: CollectionPersistentStorageConfig<ItemState> & {
    getSessionKey: () => string | false;
  },
  options: {
    adapter?: StorageAdapter;
  } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const pinnedItems = new Set(config.pinnedItems ?? []);

  const namespace = createPersistentStorageNamespaceHandle<
    PersistedCollectionItemData<ItemState>
  >(
    {
      ...config,
      entryPrefix: 'collection.item',
    },
    { adapter: options.adapter },
  );

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const pendingPreloads = new Map<string, Promise<void>>();

  function clearSaveTimer(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function createInitialState(
    baseState: TSFDCollectionState<ItemState, ItemPayload>,
  ): TSFDCollectionState<ItemState, ItemPayload> {
    if (backend !== 'localStorage') return baseState;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return baseState;

    const prefix = getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      'collection.item',
    );

    const initialState = { ...baseState };

    for (const storageKey of listLocalStorageKeysSync(prefix)) {
      const itemKey = storageKey.slice(prefix.length);
      if (itemKey in initialState) continue;

      defineLazyLocalStorageItem(
        initialState,
        itemKey,
        storageKey,
        version,
        config,
      );
    }

    return initialState;
  }

  async function preloadItem(itemKey: string): Promise<void> {
    if (backend !== 'opfs' || !storeRef) return;
    if (storeRef.state[itemKey] !== undefined) return;

    const existingPromise = pendingPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = namespace
      .load(itemKey)
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) return;

        const validated = toCollectionItemState<ItemState, ItemPayload>(
          cached,
          config,
        );

        if (!validated) {
          scheduleIdleCleanup(() => void namespace.remove(itemKey));
          return;
        }

        if (storeRef.state[itemKey] !== undefined) return;

        storeRef.produceState(
          (draft) => {
            if (draft[itemKey] === undefined) {
              draft[itemKey] = validated;
            }
          },
          { action: 'persistent-storage-hydrate' },
        );
      })
      .finally(() => {
        if (currentGeneration === generation) {
          pendingPreloads.delete(itemKey);
        }
      });

    pendingPreloads.set(itemKey, promise);
    return promise;
  }

  async function preloadItems(itemKeys: string[]): Promise<void> {
    if (backend !== 'opfs') return;
    await Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function evictStoredItems(): Promise<void> {
    const keys = await namespace.listKeys();
    if (keys.length <= maxItems) return;

    const entries = await Promise.all(
      keys.map(async (itemKey) => ({
        itemKey,
        entry: await namespace.readEntry(itemKey),
      })),
    );

    const validEntries = filterAndMap(entries, ({ itemKey, entry }) => {
      return entry ? { itemKey, entry } : false;
    });

    if (validEntries.length <= maxItems) return;

    validEntries.sort((a, b) => {
      const aPinned = pinnedItems.has(a.itemKey);
      const bPinned = pinnedItems.has(b.itemKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return b.entry.timestamp - a.entry.timestamp;
    });

    const keptKeys = new Set(
      validEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
    );

    await Promise.all(
      validEntries
        .filter(({ itemKey }) => !keptKeys.has(itemKey))
        .map(({ itemKey }) => namespace.remove(itemKey)),
    );
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    const state = storeRef.state;
    const tasks: Promise<void>[] = [];

    for (const [itemKey, item] of Object.entries(state)) {
      if (!item?.data) {
        tasks.push(namespace.remove(itemKey));
        continue;
      }

      tasks.push(
        namespace.save(itemKey, {
          data: item.data,
          payload: item.payload,
        }),
      );
    }

    await Promise.all(tasks);
    await evictStoredItems();
  }

  function schedulePersistedStateFlush(): void {
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPersistedState();
    }, SAVE_DEBOUNCE_MS);
  }

  function attach(
    store: Store<TSFDCollectionState<ItemState, ItemPayload>>,
  ): void {
    storeRef = store;
    unsubscribe = store.subscribe(() => {
      schedulePersistedStateFlush();
    });
  }

  function dispose(): void {
    generation++;
    pendingPreloads.clear();
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    namespace.dispose();
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    await namespace.clear();
  }

  return {
    createInitialState,
    attach,
    preloadItems,
    hasAsyncPreload: backend === 'opfs',
    dispose,
    clear,
  };
}
