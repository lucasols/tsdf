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
import { isManagedLocalStorageEntryOfflineProtected } from './localStorageMetadata';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  finalizePersistedStoreData,
  normalizePersistentStorageDataSchema,
  parsePersistedCollectionItemData,
  validatePersistedStoreData,
  type NormalizedPersistentStorageDataSchema,
  type ParsedPersistedCollectionItemData,
} from './parsePersistedData';
import {
  assertValidPersistentStoreName,
  createPersistentStorageNamespaceHandle,
  getLocalStorageAdapter,
  getStoragePrefixForStoreNamespace,
  readManifestPayloadMeta,
  readProtectedStorageKeys,
  scheduleLocalStorageRemoval,
  scheduleLocalStorageMaintenance,
  readRawStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import {
  createShouldIgnoreItemPredicate,
  createEvictionComparator,
} from './persistenceUtils';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { COLLECTION_STORAGE_ENTRY_PREFIX } from './storageEntryPrefixes';
import type {
  CollectionPersistentStorageConfig,
  PersistedCollectionItemData,
} from './types';
import { validateWithSchema } from './validateWithSchema';
import { resolveVersionedPersistedData } from './versionedPersistence';

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

function toCollectionItemState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  StorageState = unknown,
>(
  persisted: ParsedPersistedCollectionItemData<ItemPayload>,
  dataSchema: NormalizedPersistentStorageDataSchema<ItemState, StorageState>,
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
): TSFDCollectionItem<ItemState, ItemPayload> | null {
  const validatedPersistedData = validatePersistedStoreData(
    persisted.data,
    dataSchema,
  );
  if (validatedPersistedData === null) return null;

  const validated = finalizePersistedStoreData(
    validatedPersistedData,
    dataSchema,
  );
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
  getHydratedItemKeys(this: void): string[];
  readHydratedItem(
    this: void,
    itemKey: string,
  ): TSFDCollectionItem<ItemState, ItemPayload> | undefined;
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
  assertValidPersistentStoreName(config.storeName);

  const version = config.version;
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
    { getManifestMeta: (data) => ({ p: data.payload }) },
  );

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressedPersistedStateFlushes = 0;
  const pendingPreloads = new Map<string, Promise<boolean>>();
  const persistedSnapshotByKey = new Map<string, string>();
  const hydratedPersistedKeys = new Set<string>();
  let knownPersistedKeys: Set<string> | null = null;
  let maintenanceManifestKey: string | null = null;

  function resolveHydratedPersistedItem(args: {
    itemKey: string;
    entryData: unknown;
    entryVersion: number | undefined;
    rewriteMigrated: (
      persisted: PersistedCollectionItemData<ItemState | StorageState>,
    ) => void;
  }): {
    item: TSFDCollectionItem<ItemState, ItemPayload>;
    persisted: PersistedCollectionItemData<ItemState | StorageState> & {
      payload: ItemPayload;
    };
  } | null {
    const versioned = resolveVersionedPersistedData({
      persistedData: args.entryData,
      fromVersion: args.entryVersion,
      targetVersion: version,
      migrate: config.migrate,
      parseCurrentPersistedData: (value) =>
        parsePersistedCollectionItemData(value, config.payloadSchema),
    });
    if (versioned === null) return null;

    const validatedPersistedData = validatePersistedStoreData(
      versioned.persisted.data,
      dataSchema,
    );
    if (validatedPersistedData === null) return null;

    const persisted: PersistedCollectionItemData<ItemState | StorageState> & {
      payload: ItemPayload;
    } = { data: validatedPersistedData, payload: versioned.persisted.payload };

    if (versioned.wasMigrated) {
      args.rewriteMigrated(persisted);
    }

    const item = toCollectionItemState(
      { ...versioned.persisted, data: validatedPersistedData },
      dataSchema,
      shouldIgnoreItem,
    );
    if (item === null) return null;

    return { item, persisted };
  }

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

    const nextManifestKey = localStorageAdapter.getManifestKeyForPrefix(prefix);
    if (maintenanceManifestKey === nextManifestKey) return;

    if (maintenanceManifestKey !== null) {
      localStorageAdapter.unregisterMaintenanceCallback(maintenanceManifestKey);
    }

    maintenanceManifestKey = nextManifestKey;
    localStorageAdapter.registerMaintenanceCallback(
      maintenanceManifestKey,
      evictStoredItems,
    );
  }

  async function ensureKnownPersistedKeys(): Promise<Set<string>> {
    if (knownPersistedKeys !== null) return knownPersistedKeys;

    knownPersistedKeys = new Set(await namespace.listKeys());
    return knownPersistedKeys;
  }

  function rememberHydratedItem(
    itemKey: string,
    persisted: PersistedCollectionItemData<unknown>,
  ): void {
    hydratedPersistedKeys.add(itemKey);
    persistedSnapshotByKey.set(itemKey, JSON.stringify(persisted));
    knownPersistedKeys?.add(itemKey);
  }

  function forgetPersistedItem(itemKey: string): void {
    hydratedPersistedKeys.delete(itemKey);
    persistedSnapshotByKey.delete(itemKey);
    knownPersistedKeys?.delete(itemKey);
  }

  function materializeHydratedItem(
    itemKey: string,
    item: TSFDCollectionItem<ItemState, ItemPayload>,
  ): void {
    if (!storeRef) return;

    suppressedPersistedStateFlushes++;
    storeRef.produceState((draft) => {
      draft[itemKey] = item;
    });
  }

  function parseHydratedItemSnapshot(
    snapshot: string,
  ): TSFDCollectionItem<ItemState, ItemPayload> | undefined {
    try {
      const persisted = parsePersistedCollectionItemData(
        JSON.parse(snapshot),
        config.payloadSchema,
      );
      return persisted
        ? (toCollectionItemState(persisted, dataSchema, shouldIgnoreItem) ??
            undefined)
        : undefined;
    } catch {
      return undefined;
    }
  }

  function readRememberedHydratedItem(
    itemKey: string,
  ): TSFDCollectionItem<ItemState, ItemPayload> | undefined {
    const snapshot = persistedSnapshotByKey.get(itemKey);
    if (!snapshot) return undefined;

    const item = parseHydratedItemSnapshot(snapshot);
    if (!item) {
      forgetPersistedItem(itemKey);
    }

    return item;
  }

  function readHydratedLocalStorageItem(
    itemKey: string,
  ): TSFDCollectionItem<ItemState, ItemPayload> | undefined {
    if (localStorageAdapter === null) return undefined;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return undefined;

    const prefix = getCollectionPrefix();
    if (prefix === false) return undefined;

    const storageKey = `${prefix}${itemKey}`;
    const cacheEntry = readRawStorageEntryFromLocalStorageSync<
      PersistedCollectionItemData<unknown>
    >(storageKey, { metadata: 'namespace', namespacePrefix: prefix });

    if (!cacheEntry) {
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const resolved = resolveHydratedPersistedItem({
      itemKey,
      entryData: cacheEntry.data,
      entryVersion: cacheEntry.version,
      rewriteMigrated: (persisted) => {
        void namespace.save(itemKey, persisted);
      },
    });
    if (!resolved) {
      scheduleLocalStorageRemoval(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      });
      forgetPersistedItem(itemKey);
      return undefined;
    }

    scheduleIdleCleanup(() =>
      refreshLocalStorageTimestamp(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      }),
    );
    rememberHydratedItem(itemKey, resolved.persisted);
    return resolved.item;
  }

  function createInitialState(
    baseState: TSFDCollectionState<ItemState, ItemPayload>,
  ): TSFDCollectionState<ItemState, ItemPayload> {
    syncMaintenanceRegistration();
    return baseState;
  }

  function readHydratedItem(
    this: void,
    itemKey: string,
  ): TSFDCollectionItem<ItemState, ItemPayload> | undefined {
    if (localStorageAdapter !== null) {
      return (
        readRememberedHydratedItem(itemKey) ??
        readHydratedLocalStorageItem(itemKey)
      );
    }

    const snapshot = persistedSnapshotByKey.get(itemKey);
    return snapshot ? parseHydratedItemSnapshot(snapshot) : undefined;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (!storeRef) return false;
    const existingItem = storeRef.state[itemKey];
    if (existingItem !== undefined) {
      return existingItem !== null;
    }

    if (localStorageAdapter !== null) {
      const validated = readHydratedItem(itemKey);
      if (!validated) return false;

      const currentItem = storeRef.state[itemKey];
      if (currentItem !== undefined) {
        return currentItem !== null;
      }

      materializeHydratedItem(itemKey, validated);

      return true;
    }

    const existingPromise = pendingPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = namespace
      .readEntry(itemKey)
      .then((entry) => {
        if (!entry || currentGeneration !== generation || !storeRef) {
          return false;
        }

        const resolved = resolveHydratedPersistedItem({
          itemKey,
          entryData: entry.data,
          entryVersion: entry.version,
          rewriteMigrated: (persisted) => {
            void namespace.save(itemKey, persisted);
          },
        });
        if (!resolved) {
          scheduleIdleCleanup(() => void namespace.remove(itemKey));
          return false;
        }

        rememberHydratedItem(itemKey, resolved.persisted);

        if (storeRef.state[itemKey] !== undefined) {
          return storeRef.state[itemKey] !== null;
        }

        materializeHydratedItem(itemKey, resolved.item);

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

    if (localStorageAdapter !== null) {
      const metadataEntries = localStorageAdapter.listManifestEntries(prefix);
      if (metadataEntries.length === 0) return;
      const protectedItemKeys = new Set(
        metadataEntries.flatMap((entry) =>
          isManagedLocalStorageEntryOfflineProtected(entry.meta)
            ? [entry.entryKey]
            : [],
        ),
      );

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
          forgetPersistedItem(itemKey);
        }
      }

      if (filteredEntries.length <= maxItems) {
        knownPersistedKeys = new Set(
          filteredEntries.map(({ itemKey }) => itemKey),
        );
        return;
      }

      filteredEntries.sort(
        createEvictionComparator(
          [
            (e) => protectedItemKeys.has(e.itemKey),
            (e) => pinnedItemKeys.has(e.itemKey),
          ],
          (e) => e.lastAccessAt,
        ),
      );

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
          forgetPersistedItem(itemKey);
        }
      }

      knownPersistedKeys = new Set(
        filteredEntries
          .filter(({ itemKey }) => keptKeys.has(itemKey))
          .map(({ itemKey }) => itemKey),
      );
      return;
    }

    const protectedStorageKeys = await readProtectedStorageKeys(
      storageAdapter,
      sessionKey,
    );
    const protectedItemKeys = new Set(
      [...protectedStorageKeys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    );

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

      return resolveHydratedPersistedItem({
        itemKey,
        entryData: entry.data,
        entryVersion: entry.version,
        rewriteMigrated: (persisted) => {
          void namespace.save(itemKey, persisted);
        },
      })
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

      const resolved = resolveHydratedPersistedItem({
        itemKey,
        entryData: entry.data,
        entryVersion: entry.version,
        rewriteMigrated: (persisted) => {
          void namespace.save(itemKey, persisted);
        },
      });
      if (!resolved) return false;

      return {
        itemKey,
        lastAccessAt: entry.timestamp,
        persisted: resolved.persisted,
      };
    });

    const ignoredEntries = validEntries.filter(({ persisted }) =>
      shouldIgnoreItem(persisted.payload),
    );

    if (ignoredEntries.length > 0) {
      await Promise.all(
        ignoredEntries.map(({ itemKey }) => namespace.remove(itemKey)),
      );
      for (const { itemKey } of ignoredEntries) {
        forgetPersistedItem(itemKey);
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

    filteredEntries.sort(
      createEvictionComparator(
        [
          (e) => protectedItemKeys.has(e.itemKey),
          (e) => pinnedItemKeys.has(e.itemKey),
        ],
        (e) => e.lastAccessAt,
      ),
    );

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
        forgetPersistedItem(itemKey);
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

    async function flushState(): Promise<void> {
      const state = storeRef?.state;
      if (!state) return;

      const tasks: Promise<void>[] = [];
      const nextPersistedKeys = new Set<string>();
      const previousPersistedKeys = await ensureKnownPersistedKeys();
      const removedKeys = new Set<string>();
      syncMaintenanceRegistration();
      const stateEntries: Array<
        [string, TSFDCollectionItem<ItemState, ItemPayload> | null]
      > = [];
      for (const itemKey of Object.keys(state)) {
        const item = state[itemKey];
        if (item === undefined) continue;
        stateEntries.push([itemKey, item]);
      }
      const knownStateKeys = new Set(stateEntries.map(([itemKey]) => itemKey));
      for (const itemKey of hydratedPersistedKeys) {
        if (knownStateKeys.has(itemKey)) continue;
        const hydratedItem = readHydratedItem(itemKey);
        if (hydratedItem === undefined) continue;
        stateEntries.push([itemKey, hydratedItem]);
      }

      for (const [itemKey, item] of stateEntries) {
        if (!item?.data) {
          if (
            previousPersistedKeys.has(itemKey) &&
            hydratedPersistedKeys.has(itemKey)
          ) {
            tasks.push(namespace.remove(itemKey));
            forgetPersistedItem(itemKey);
            removedKeys.add(itemKey);
          }
          continue;
        }

        if (shouldIgnoreItem(item.payload)) {
          if (previousPersistedKeys.has(itemKey)) {
            tasks.push(namespace.remove(itemKey));
            forgetPersistedItem(itemKey);
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
        forgetPersistedItem(itemKey);
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

      if (localStorageAdapter !== null && maintenanceManifestKey !== null) {
        const needsMaintenance =
          hasIgnoreItemFilter || knownPersistedKeys.size > maxItems;
        if (needsMaintenance) {
          scheduleLocalStorageMaintenance({
            forceManifestKeys: [maintenanceManifestKey],
          });
        }
        return;
      }

      await evictStoredItems();
    }

    if (localStorageAdapter !== null) {
      await localStorageAdapter.runLocked(flushState);
      return;
    }

    await flushState();
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
      if (suppressedPersistedStateFlushes > 0) {
        suppressedPersistedStateFlushes--;
        return;
      }

      schedulePersistedStateFlush();
    });
  }

  function dispose(): void {
    generation++;
    pendingPreloads.clear();
    hydratedPersistedKeys.clear();
    knownPersistedKeys = null;
    suppressedPersistedStateFlushes = 0;
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    if (localStorageAdapter !== null && maintenanceManifestKey !== null) {
      localStorageAdapter.unregisterMaintenanceCallback(maintenanceManifestKey);
      maintenanceManifestKey = null;
    }
    namespace.dispose();
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    knownPersistedKeys = null;
    suppressedPersistedStateFlushes = 0;
    persistedSnapshotByKey.clear();
    hydratedPersistedKeys.clear();
    await namespace.clear();
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    preloadItems,
    getHydratedItemKeys: () => [...hydratedPersistedKeys],
    readHydratedItem,
    hasAsyncPreload: localStorageAdapter === null,
    dispose,
    clear,
  };
}
