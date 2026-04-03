import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import type { Store } from 't-state';

import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedCollectionItemData,
  parsePersistedStoreData,
  type NormalizedPersistentStorageDataSchema,
  type ParsedPersistedCollectionItemData,
} from './parsePersistedData';
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

const DEFAULT_MAX_ITEMS = 50;
const SAVE_DEBOUNCE_MS = 1000;

function createShouldIgnoreItemPredicate<ItemPayload extends ValidPayload>(
  ignoreItems:
    | CollectionPersistentStorageConfig<never, ItemPayload>['ignoreItems']
    | undefined,
  resolveItemKey: (payload: ItemPayload) => string,
): (payload: ItemPayload) => boolean {
  if (!ignoreItems) return () => false;
  if (typeof ignoreItems === 'function') return ignoreItems;

  const ignoredItemKeys = new Set(ignoreItems.map(resolveItemKey));
  return (payload) => ignoredItemKeys.has(resolveItemKey(payload));
}

function toCollectionItemState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  StorageState = unknown,
>(
  persisted: ParsedPersistedCollectionItemData<ItemPayload>,
  dataSchema: NormalizedPersistentStorageDataSchema<ItemState, StorageState>,
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
): TSFDCollectionItem<ItemState, ItemPayload> | null {
  const validated = parsePersistedStoreData(persisted.data, dataSchema);
  if (validated === null) return null;

  if (shouldIgnoreItem(persisted.payload)) return null;

  return {
    data: validated,
    error: null,
    payload: persisted.payload,
    refetchOnMount: 'lowPriority',
    status: 'success',
    wasLoaded: true,
  };
}

function defineLazyLocalStorageItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  StorageState = unknown,
>(
  state: TSFDCollectionState<ItemState, ItemPayload>,
  itemKey: string,
  storageKey: string,
  version: number,
  payloadSchema: CollectionPersistentStorageConfig<
    ItemState,
    ItemPayload
  >['payloadSchema'],
  dataSchema: NormalizedPersistentStorageDataSchema<ItemState, StorageState>,
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
): void {
  Object.defineProperty(state, itemKey, {
    configurable: true,
    enumerable: false,
    get() {
      const cacheEntry = readStorageEntryFromLocalStorageSync(
        storageKey,
        version,
      );

      if (!cacheEntry) {
        Object.defineProperty(state, itemKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      const persisted = parsePersistedCollectionItemData(
        cacheEntry.data,
        payloadSchema,
      );
      if (!persisted) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        Object.defineProperty(state, itemKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      const item = toCollectionItemState(
        persisted,
        dataSchema,
        shouldIgnoreItem,
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
  maybeHydrateItems(itemKeys: string[]): Promise<boolean[]>;
  preloadItems(itemKeys: string[]): Promise<boolean[]>;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

export function setupCollectionPersistence<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  StorageState = unknown,
>(
  config: CollectionPersistentStorageConfig<
    ItemState,
    ItemPayload,
    StorageState
  > & { getSessionKey: () => string | false },
  options: {
    adapter?: StorageAdapter;
    getItemKey?: (payload: ItemPayload) => string;
  } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const resolveItemKey =
    options.getItemKey ?? ((payload: ItemPayload) => getCompositeKey(payload));
  const pinnedItemKeys = new Set(
    (config.pinnedItems ?? []).map((payload) => resolveItemKey(payload)),
  );
  const shouldIgnoreItem = createShouldIgnoreItemPredicate(
    config.ignoreItems,
    resolveItemKey,
  );
  const hasIgnoreItemFilter = config.ignoreItems !== undefined;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);

  const namespace = createPersistentStorageNamespaceHandle<
    PersistedCollectionItemData<ItemState | StorageState>
  >(
    { ...config, entryPrefix: 'collection.item' },
    { adapter: options.adapter },
  );

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const pendingPreloads = new Map<string, Promise<boolean>>();

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
        config.payloadSchema,
        dataSchema,
        shouldIgnoreItem,
      );
    }

    return initialState;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (!storeRef) return false;
    if (storeRef.state[itemKey] !== undefined)
      return storeRef.state[itemKey] !== null;

    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return false;

      const storageKey = `${getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'collection.item',
      )}${itemKey}`;
      const cacheEntry = readStorageEntryFromLocalStorageSync(
        storageKey,
        version,
      );

      if (!cacheEntry) return false;

      const persisted = parsePersistedCollectionItemData(
        cacheEntry.data,
        config.payloadSchema,
      );
      if (!persisted) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      const validated = toCollectionItemState(
        persisted,
        dataSchema,
        shouldIgnoreItem,
      );

      if (!validated) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      storeRef.produceState(
        (draft) => {
          if (draft[itemKey] === undefined) {
            draft[itemKey] = validated;
          }
        },
        { action: 'persistent-storage-hydrate' },
      );

      return true;
    }

    const existingPromise = pendingPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = namespace
      .load(itemKey)
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }

        const persisted = parsePersistedCollectionItemData(
          cached,
          config.payloadSchema,
        );
        if (!persisted) {
          scheduleIdleCleanup(() => void namespace.remove(itemKey));
          return false;
        }

        const validated = toCollectionItemState(
          persisted,
          dataSchema,
          shouldIgnoreItem,
        );

        if (!validated) {
          scheduleIdleCleanup(() => void namespace.remove(itemKey));
          return false;
        }

        if (storeRef.state[itemKey] !== undefined) {
          return storeRef.state[itemKey] !== null;
        }

        storeRef.produceState(
          (draft) => {
            if (draft[itemKey] === undefined) {
              draft[itemKey] = validated;
            }
          },
          { action: 'persistent-storage-hydrate' },
        );

        return true;
      })
      .finally(() => {
        if (currentGeneration === generation) {
          pendingPreloads.delete(itemKey);
        }
      });

    pendingPreloads.set(itemKey, promise);
    return promise;
  }

  async function preloadItems(itemKeys: string[]): Promise<boolean[]> {
    if (backend !== 'opfs') return itemKeys.map(() => false);
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function maybeHydrateItems(itemKeys: string[]): Promise<boolean[]> {
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function evictStoredItems(): Promise<void> {
    const keys = await namespace.listKeys();
    if (keys.length === 0) return;
    if (!hasIgnoreItemFilter && keys.length <= maxItems) return;

    const entries = await Promise.all(
      keys.map(async (itemKey) => ({
        itemKey,
        entry: await namespace.readEntry(itemKey),
      })),
    );

    const invalidEntries = filterAndMap(entries, ({ itemKey, entry }) => {
      if (!entry) return false;

      const persisted = parsePersistedCollectionItemData(
        entry.data,
        config.payloadSchema,
      );

      if (!persisted) return { itemKey };

      return parsePersistedStoreData(persisted.data, dataSchema)
        ? false
        : { itemKey };
    });

    if (invalidEntries.length > 0) {
      await Promise.all(
        invalidEntries.map(({ itemKey }) => namespace.remove(itemKey)),
      );
    }

    const validEntries = filterAndMap(entries, ({ itemKey, entry }) => {
      if (!entry) return false;

      const persisted = parsePersistedCollectionItemData(
        entry.data,
        config.payloadSchema,
      );
      if (!persisted) return false;

      return parsePersistedStoreData(persisted.data, dataSchema)
        ? { itemKey, entry, persisted }
        : false;
    });

    const ignoredEntries = validEntries.filter(({ persisted }) =>
      shouldIgnoreItem(persisted.payload),
    );

    if (ignoredEntries.length > 0) {
      await Promise.all(
        ignoredEntries.map(({ itemKey }) => namespace.remove(itemKey)),
      );
    }

    const filteredEntries = validEntries.filter(
      ({ persisted }) => !shouldIgnoreItem(persisted.payload),
    );

    if (filteredEntries.length <= maxItems) return;

    filteredEntries.sort((a, b) => {
      const aPinned = pinnedItemKeys.has(a.itemKey);
      const bPinned = pinnedItemKeys.has(b.itemKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return b.entry.timestamp - a.entry.timestamp;
    });

    const keptKeys = new Set(
      filteredEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
    );

    await Promise.all(
      filteredEntries
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

      if (shouldIgnoreItem(item.payload)) {
        tasks.push(namespace.remove(itemKey));
        continue;
      }

      const converted = convertStoreDataForPersistence(item.data, dataSchema);
      if (!converted.ok) {
        config.onPersistentStorageError?.(converted.error);
        continue;
      }

      tasks.push(
        namespace.save(itemKey, {
          data: converted.value,
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
    maybeHydrateItems,
    preloadItems,
    hasAsyncPreload: backend === 'opfs',
    dispose,
    clear,
  };
}
