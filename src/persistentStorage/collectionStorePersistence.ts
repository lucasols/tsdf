import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type {
  AnyOfflineOperationDefinition,
  CollectionOfflineEntityRef,
} from './offline/types';
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
  getLocalStorageAdapter,
  getStoragePrefixForStoreNamespace,
  readManifestPayloadMeta,
  readProtectedStorageKeys,
  scheduleLocalStorageRemoval,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { COLLECTION_STORAGE_ENTRY_PREFIX } from './storageEntryPrefixes';
import type {
  CollectionPersistentStorageConfig,
  PersistedCollectionItemData,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 50;
const SAVE_DEBOUNCE_MS = 1000;

type CollectionPersistenceOfflineOperations<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> =
  | (Record<
      string,
      AnyOfflineOperationDefinition & {
        getEntityRefs: (ctx: {
          input: __LEGIT_ANY__;
        }) => CollectionOfflineEntityRef<ItemPayload>[];
      }
    > &
      ([ItemState | ItemPayload] extends [never] ? never : unknown))
  | null;

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
  onHydrated: (
    itemKey: string,
    persisted: PersistedCollectionItemData<unknown>,
  ) => void,
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

      const persisted = parsePersistedCollectionItemData(
        cacheEntry.data,
        payloadSchema,
      );
      if (!persisted) {
        scheduleLocalStorageRemoval(storageKey);
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
        scheduleLocalStorageRemoval(storageKey);
        Object.defineProperty(state, itemKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));
      onHydrated(itemKey, cacheEntry.data);

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
  TOfflineOperations extends CollectionPersistenceOfflineOperations<
    ItemState,
    ItemPayload
  > = null,
  StorageState = unknown,
>(
  config: CollectionPersistentStorageConfig<
    ItemState,
    ItemPayload,
    StorageState,
    TOfflineOperations
  > & { getSessionKey: () => string | false },
  options: { getItemKey?: (payload: ItemPayload) => string } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  const version = config.version ?? 1;
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
  const storageAdapter = config.adapter;
  const localStorageAdapter = getLocalStorageAdapter(storageAdapter);
  const persistentConfig = config;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);

  const namespace = createPersistentStorageNamespaceHandle<
    PersistedCollectionItemData<ItemState | StorageState>
  >(
    { ...persistentConfig, entryPrefix: COLLECTION_STORAGE_ENTRY_PREFIX },
    { getManifestMeta: (data) => ({ payload: data.payload }) },
  );

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const pendingPreloads = new Map<string, Promise<boolean>>();
  const persistedSnapshotByKey = new Map<string, string>();
  const hydratedPersistedKeys = new Set<string>();
  let knownPersistedKeys: Set<string> | null = null;
  let maintenanceRootKey: string | null = null;

  function clearSaveTimer(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function getCollectionPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    return getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      COLLECTION_STORAGE_ENTRY_PREFIX,
    );
  }

  function syncMaintenanceRegistration(): void {
    if (localStorageAdapter === null) return;

    const prefix = getCollectionPrefix();
    if (prefix === false) return;

    const nextRootKey = localStorageAdapter.getRootKeyForPrefix(prefix);
    if (maintenanceRootKey === nextRootKey) return;

    if (maintenanceRootKey !== null) {
      localStorageAdapter.unregisterMaintenanceCallback(maintenanceRootKey);
    }

    maintenanceRootKey = nextRootKey;
    localStorageAdapter.registerMaintenanceCallback(
      maintenanceRootKey,
      evictStoredItems,
    );
  }

  async function ensureKnownPersistedKeys(): Promise<Set<string>> {
    if (knownPersistedKeys !== null) return knownPersistedKeys;

    knownPersistedKeys = new Set(await namespace.listKeys());
    return knownPersistedKeys;
  }

  function createInitialState(
    baseState: TSFDCollectionState<ItemState, ItemPayload>,
  ): TSFDCollectionState<ItemState, ItemPayload> {
    if (localStorageAdapter === null) return baseState;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return baseState;

    const prefix = getCollectionPrefix();
    if (prefix === false) return baseState;
    syncMaintenanceRegistration();

    const initialState = { ...baseState };

    for (const storageKey of localStorageAdapter.listKeys(prefix)) {
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
        (hydratedItemKey, persisted) => {
          hydratedPersistedKeys.add(hydratedItemKey);
          persistedSnapshotByKey.set(
            hydratedItemKey,
            JSON.stringify(persisted),
          );
        },
      );
    }

    return initialState;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (!storeRef) return false;
    if (storeRef.state[itemKey] !== undefined)
      return storeRef.state[itemKey] !== null;

    if (localStorageAdapter !== null) {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return false;

      const storageKey = `${getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        COLLECTION_STORAGE_ENTRY_PREFIX,
      )}${itemKey}`;
      const cacheEntry = readStorageEntryFromLocalStorageSync<
        PersistedCollectionItemData<unknown>
      >(storageKey, version);

      if (!cacheEntry) return false;

      const persisted = parsePersistedCollectionItemData(
        cacheEntry.data,
        config.payloadSchema,
      );
      if (!persisted) {
        scheduleLocalStorageRemoval(storageKey);
        return false;
      }

      const validated = toCollectionItemState(
        persisted,
        dataSchema,
        shouldIgnoreItem,
      );

      if (!validated) {
        scheduleLocalStorageRemoval(storageKey);
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));
      hydratedPersistedKeys.add(itemKey);
      persistedSnapshotByKey.set(itemKey, JSON.stringify(cacheEntry.data));

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

        hydratedPersistedKeys.add(itemKey);
        persistedSnapshotByKey.set(itemKey, JSON.stringify(cached));

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
    if (localStorageAdapter !== null) return itemKeys.map(() => false);
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function maybeHydrateItems(itemKeys: string[]): Promise<boolean[]> {
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function evictStoredItems(): Promise<void> {
    syncMaintenanceRegistration();
    const sessionKey = config.getSessionKey();
    const prefix = getCollectionPrefix();
    if (sessionKey === false || prefix === false) return;
    const protectedStorageKeys = await readProtectedStorageKeys(
      storageAdapter,
      sessionKey,
    );
    const protectedItemKeys = new Set(
      [...protectedStorageKeys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    );

    if (localStorageAdapter !== null) {
      const metadataEntries = localStorageAdapter.listEntryMetadata(prefix);
      if (metadataEntries.length === 0) return;

      if (
        !hasIgnoreItemFilter &&
        metadataEntries.filter(
          (entry) => !protectedItemKeys.has(entry.entryKey),
        ).length <= maxItems
      ) {
        return;
      }

      const metadataEntriesWithPayload = metadataEntries.map((entry) => ({
        itemKey: entry.entryKey,
        lastAccessAt: entry.lastAccessAt,
        payload: validateWithSchema(
          config.payloadSchema,
          readManifestPayloadMeta(entry.meta),
        ),
      }));

      const invalidEntries = filterAndMap(
        metadataEntriesWithPayload,
        ({ itemKey, payload }) => (payload === null ? { itemKey } : false),
      );
      if (invalidEntries.length > 0) {
        await Promise.all(
          invalidEntries.map(({ itemKey }) => namespace.remove(itemKey)),
        );
      }

      const persistedEntries = filterAndMap(
        metadataEntriesWithPayload,
        ({ itemKey, lastAccessAt, payload }) =>
          payload === null ? false : { itemKey, lastAccessAt, payload },
      );

      const filteredEntries = persistedEntries.filter(
        ({ payload }) => !shouldIgnoreItem(payload),
      );

      const ignoredEntries = persistedEntries.filter(({ payload }) =>
        shouldIgnoreItem(payload),
      );

      if (ignoredEntries.length > 0) {
        await Promise.all(
          ignoredEntries.map(({ itemKey }) => namespace.remove(itemKey)),
        );
        for (const { itemKey } of ignoredEntries) {
          persistedSnapshotByKey.delete(itemKey);
        }
      }

      if (filteredEntries.length <= maxItems) {
        knownPersistedKeys = new Set(
          filteredEntries.map(({ itemKey }) => itemKey),
        );
        return;
      }

      filteredEntries.sort((a, b) => {
        const aProtected = protectedItemKeys.has(a.itemKey);
        const bProtected = protectedItemKeys.has(b.itemKey);

        if (aProtected && !bProtected) return -1;
        if (!aProtected && bProtected) return 1;

        const aPinned = pinnedItemKeys.has(a.itemKey);
        const bPinned = pinnedItemKeys.has(b.itemKey);

        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;

        return b.lastAccessAt - a.lastAccessAt;
      });

      const keptKeys = new Set(
        filteredEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
      );

      await Promise.all(
        filteredEntries
          .filter(({ itemKey }) => !keptKeys.has(itemKey))
          .map(({ itemKey }) => namespace.remove(itemKey)),
      );
      for (const { itemKey } of filteredEntries) {
        if (!keptKeys.has(itemKey)) {
          persistedSnapshotByKey.delete(itemKey);
        }
      }

      knownPersistedKeys = new Set(
        filteredEntries
          .filter(({ itemKey }) => keptKeys.has(itemKey))
          .map(({ itemKey }) => itemKey),
      );
      return;
    }

    const keys = await namespace.listKeys();
    if (keys.length === 0) return;
    if (
      !hasIgnoreItemFilter &&
      keys.filter((key) => !protectedItemKeys.has(key)).length <= maxItems
    ) {
      return;
    }

    const entries = await Promise.all(
      keys.map(async (itemKey) => ({
        itemKey,
        entry: await namespace.readEntry(itemKey),
        lastAccessAt: undefined,
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
        ? { itemKey, lastAccessAt: entry.timestamp, persisted }
        : false;
    });

    const ignoredEntries = validEntries.filter(({ persisted }) =>
      shouldIgnoreItem(persisted.payload),
    );

    if (ignoredEntries.length > 0) {
      await Promise.all(
        ignoredEntries.map(({ itemKey }) => namespace.remove(itemKey)),
      );
      for (const { itemKey } of ignoredEntries) {
        persistedSnapshotByKey.delete(itemKey);
      }
    }

    const filteredEntries = validEntries.filter(
      ({ persisted }) => !shouldIgnoreItem(persisted.payload),
    );

    if (filteredEntries.length <= maxItems) {
      knownPersistedKeys = new Set(
        filteredEntries.map(({ itemKey }) => itemKey),
      );
      return;
    }

    filteredEntries.sort((a, b) => {
      const aProtected = protectedItemKeys.has(a.itemKey);
      const bProtected = protectedItemKeys.has(b.itemKey);

      if (aProtected && !bProtected) return -1;
      if (!aProtected && bProtected) return 1;

      const aPinned = pinnedItemKeys.has(a.itemKey);
      const bPinned = pinnedItemKeys.has(b.itemKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return b.lastAccessAt - a.lastAccessAt;
    });

    const keptKeys = new Set(
      filteredEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
    );

    await Promise.all(
      filteredEntries
        .filter(({ itemKey }) => !keptKeys.has(itemKey))
        .map(({ itemKey }) => namespace.remove(itemKey)),
    );
    for (const { itemKey } of filteredEntries) {
      if (!keptKeys.has(itemKey)) {
        persistedSnapshotByKey.delete(itemKey);
      }
    }

    knownPersistedKeys = new Set(
      filteredEntries
        .filter(({ itemKey }) => keptKeys.has(itemKey))
        .map(({ itemKey }) => itemKey),
    );
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    const state = storeRef.state;
    const tasks: Promise<void>[] = [];
    const nextPersistedKeys = new Set<string>();
    const previousPersistedKeys = await ensureKnownPersistedKeys();
    const removedKeys = new Set<string>();
    syncMaintenanceRegistration();

    for (const [itemKey, item] of Object.entries(state)) {
      if (!item?.data) {
        if (
          previousPersistedKeys.has(itemKey) &&
          hydratedPersistedKeys.has(itemKey)
        ) {
          tasks.push(namespace.remove(itemKey));
          persistedSnapshotByKey.delete(itemKey);
          hydratedPersistedKeys.delete(itemKey);
          removedKeys.add(itemKey);
        }
        continue;
      }

      if (shouldIgnoreItem(item.payload)) {
        if (previousPersistedKeys.has(itemKey)) {
          tasks.push(namespace.remove(itemKey));
          persistedSnapshotByKey.delete(itemKey);
          hydratedPersistedKeys.delete(itemKey);
          removedKeys.add(itemKey);
        }
        continue;
      }

      nextPersistedKeys.add(itemKey);
      const converted = convertStoreDataForPersistence(item.data, dataSchema);
      if (!converted.ok) {
        config.onPersistentStorageError?.(converted.error);
        continue;
      }

      const nextValue = { data: converted.value, payload: item.payload };
      const nextSnapshot = JSON.stringify(nextValue);

      if (
        persistedSnapshotByKey.get(itemKey) === nextSnapshot &&
        previousPersistedKeys.has(itemKey)
      ) {
        continue;
      }

      persistedSnapshotByKey.set(itemKey, nextSnapshot);
      hydratedPersistedKeys.add(itemKey);
      tasks.push(namespace.save(itemKey, nextValue));
    }

    for (const itemKey of previousPersistedKeys) {
      if (nextPersistedKeys.has(itemKey)) continue;
      if (!hydratedPersistedKeys.has(itemKey)) continue;

      tasks.push(namespace.remove(itemKey));
      persistedSnapshotByKey.delete(itemKey);
      hydratedPersistedKeys.delete(itemKey);
      removedKeys.add(itemKey);
    }

    await Promise.all(tasks);
    knownPersistedKeys = new Set(previousPersistedKeys);
    for (const itemKey of removedKeys) {
      knownPersistedKeys.delete(itemKey);
    }
    for (const itemKey of nextPersistedKeys) {
      knownPersistedKeys.add(itemKey);
    }

    if (localStorageAdapter !== null && maintenanceRootKey !== null) {
      const needsMaintenance =
        hasIgnoreItemFilter || knownPersistedKeys.size > maxItems;
      if (needsMaintenance) {
        await localStorageAdapter.runMaintenance([maintenanceRootKey]);
      }
      return;
    }

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
    syncMaintenanceRegistration();
    storeRef = store;
    unsubscribe = store.subscribe(() => {
      schedulePersistedStateFlush();
    });
  }

  function dispose(): void {
    generation++;
    pendingPreloads.clear();
    hydratedPersistedKeys.clear();
    knownPersistedKeys = null;
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    if (localStorageAdapter !== null && maintenanceRootKey !== null) {
      localStorageAdapter.unregisterMaintenanceCallback(maintenanceRootKey);
      maintenanceRootKey = null;
    }
    namespace.dispose();
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    knownPersistedKeys = null;
    persistedSnapshotByKey.clear();
    hydratedPersistedKeys.clear();
    await namespace.clear();
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    preloadItems,
    hasAsyncPreload: localStorageAdapter === null,
    dispose,
    clear,
  };
}
