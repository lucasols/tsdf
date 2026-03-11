import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  createProtectedStorageRef,
  getStoragePrefixForStoreNamespace,
  listLocalStorageKeysSync,
  listProtectedLocalStorageNamespaceKeys,
  openAsyncStorageNamespace,
  readLocalStorageNamespaceEntries,
  readAllAsyncStorageMetadata,
  readProtectedStorageKeys,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { isAsyncStorageAdapter, createStorageAdapter } from './storageAdapter';
import type {
  AsyncStorageEntryMetadata,
  CollectionPersistentStorageConfig,
  StorageAdapter,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 50;
const SAVE_DEBOUNCE_MS = 1000;

type PersistedCollectionItemValue<ItemState> = { data: ItemState };

type CollectionItemMetadata = { payload: unknown };

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

function createShouldIgnorePersistedItemPredicate<
  ItemPayload extends ValidPayload,
>(
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
): (payload: unknown) => boolean {
  return (payload) => {
    try {
      return shouldIgnoreItem(__LEGIT_CAST__<ItemPayload, unknown>(payload));
    } catch {
      return false;
    }
  };
}

function toCollectionItemState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  value: PersistedCollectionItemValue<unknown>,
  metadata: CollectionItemMetadata,
  config: CollectionPersistentStorageConfig<ItemState, ItemPayload>,
  shouldIgnorePersistedItem: (payload: unknown) => boolean,
): TSFDCollectionItem<ItemState, ItemPayload> | null {
  const validated = validateWithSchema(config.schema, value.data);
  if (validated === null) return null;
  if (shouldIgnorePersistedItem(metadata.payload)) return null;

  return {
    data: validated,
    error: null,
    payload: __LEGIT_CAST__<ItemPayload, unknown>(metadata.payload),
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
  config: CollectionPersistentStorageConfig<ItemState, ItemPayload>,
  shouldIgnorePersistedItem: (payload: unknown) => boolean,
): void {
  Object.defineProperty(state, itemKey, {
    configurable: true,
    enumerable: false,
    get() {
      const cacheEntry = readStorageEntryFromLocalStorageSync<{
        data: unknown;
        payload: unknown;
      }>(storageKey, version);

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
        { data: cacheEntry.data.data },
        { payload: cacheEntry.data.payload },
        config,
        shouldIgnorePersistedItem,
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

function samePersistedProjection<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
>(
  left: TSFDCollectionItem<ItemState, ItemPayload> | null | undefined,
  right: TSFDCollectionItem<ItemState, ItemPayload> | null | undefined,
): boolean {
  const leftPresent = left !== undefined && left !== null && left.data !== null;
  const rightPresent =
    right !== undefined && right !== null && right.data !== null;

  if (leftPresent !== rightPresent) return false;
  if (!leftPresent && !rightPresent) {
    return left === right;
  }

  return left?.data === right?.data && left?.payload === right?.payload;
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
>(
  config: CollectionPersistentStorageConfig<ItemState, ItemPayload> & {
    getSessionKey: () => string | false;
  },
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
  const shouldIgnorePersistedItem =
    createShouldIgnorePersistedItemPredicate(shouldIgnoreItem);
  const hasIgnoreItemFilter = config.ignoreItems !== undefined;
  const storageAdapter = options.adapter ?? createStorageAdapter(backend);
  const asyncNamespace = openAsyncStorageNamespace<
    PersistedCollectionItemValue<ItemState>,
    CollectionItemMetadata
  >({ ...config, kind: 'collection.item' }, { adapter: storageAdapter });

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressDirtyTracking = 0;
  const pendingPreloads = new Map<string, Promise<boolean>>();
  const dirtyItemKeys = new Set<string>();
  const deletedItemKeys = new Set<string>();
  let lastSnapshot: TSFDCollectionState<ItemState, ItemPayload> | null = null;

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
        shouldIgnorePersistedItem,
      );
    }

    return initialState;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (!storeRef) return false;
    if (storeRef.state[itemKey] !== undefined) {
      return storeRef.state[itemKey] !== null;
    }

    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return false;

      const storageKey = `${getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'collection.item',
      )}${itemKey}`;
      const cacheEntry = readStorageEntryFromLocalStorageSync<{
        data: unknown;
        payload: unknown;
      }>(storageKey, version);
      if (!cacheEntry) return false;

      const validated = toCollectionItemState<ItemState, ItemPayload>(
        { data: cacheEntry.data.data },
        { payload: cacheEntry.data.payload },
        config,
        shouldIgnorePersistedItem,
      );
      if (!validated) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      suppressDirtyTracking++;
      storeRef.produceState(
        (draft) => {
          if (draft[itemKey] === undefined) {
            draft[itemKey] = validated;
          }
        },
        { action: 'persistent-storage-hydrate' },
      );
      suppressDirtyTracking--;

      return true;
    }

    if (!asyncNamespace) return false;

    const existingPromise = pendingPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = asyncNamespace
      .get(itemKey, { touch: 'coarse' })
      .then(async (cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }
        if (cached.metadata.version !== version) {
          await asyncNamespace.commit({ removes: [itemKey] });
          return false;
        }

        const validated = toCollectionItemState<ItemState, ItemPayload>(
          cached.value,
          { payload: cached.metadata.payload },
          config,
          shouldIgnorePersistedItem,
        );
        if (!validated) {
          await asyncNamespace.commit({ removes: [itemKey] });
          return false;
        }

        if (storeRef.state[itemKey] !== undefined) {
          return storeRef.state[itemKey] !== null;
        }

        suppressDirtyTracking++;
        storeRef.produceState(
          (draft) => {
            if (draft[itemKey] === undefined) {
              draft[itemKey] = validated;
            }
          },
          { action: 'persistent-storage-hydrate' },
        );
        suppressDirtyTracking--;

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
    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;

      const prefix = getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'collection.item',
      );
      const protectedStorageKeys = await readProtectedStorageKeys(
        storageAdapter,
        sessionKey,
      );
      const protectedItemKeys = listProtectedLocalStorageNamespaceKeys(
        protectedStorageKeys,
        prefix,
      );
      const entries = readLocalStorageNamespaceEntries<{
        data: unknown;
        payload: unknown;
      }>(prefix, version).map(({ key, entry }) => ({ itemKey: key, entry }));
      if (!hasIgnoreItemFilter && entries.length <= maxItems) {
        return;
      }

      const ignoredEntries = entries.filter(({ entry }) =>
        shouldIgnorePersistedItem(entry.data.payload),
      );

      for (const { itemKey } of ignoredEntries) {
        localStorage.removeItem(`${prefix}${itemKey}`);
      }

      const persistedEntries = entries.filter(
        ({ entry }) => !shouldIgnorePersistedItem(entry.data.payload),
      );
      persistedEntries.sort((left, right) => {
        const leftProtected = protectedItemKeys.has(left.itemKey);
        const rightProtected = protectedItemKeys.has(right.itemKey);
        if (leftProtected !== rightProtected) {
          return leftProtected ? -1 : 1;
        }

        const leftPinned = pinnedItemKeys.has(left.itemKey);
        const rightPinned = pinnedItemKeys.has(right.itemKey);
        if (leftPinned !== rightPinned) {
          return leftPinned ? -1 : 1;
        }

        return right.entry.timestamp - left.entry.timestamp;
      });

      for (const { itemKey } of persistedEntries.slice(maxItems)) {
        localStorage.removeItem(`${prefix}${itemKey}`);
      }
      return;
    }

    if (!asyncNamespace) return;

    const sessionKey = config.getSessionKey();
    const protectedStorageKeys =
      sessionKey !== false
        ? await readProtectedStorageKeys(storageAdapter, sessionKey)
        : new Set<string>();
    const isProtectedKey =
      sessionKey === false
        ? (_key_: string) => false
        : (key: string) =>
            protectedStorageKeys.has(
              createProtectedStorageRef({
                sessionKey,
                storeName: config.storeName,
                kind: 'collection.item',
                key,
              }),
            );
    const metadataEntries = await readAllAsyncStorageMetadata(asyncNamespace, {
      order: 'lru-desc',
    });

    const validEntries = metadataEntries.filter(
      (entry): entry is AsyncStorageEntryMetadata<CollectionItemMetadata> =>
        entry.version === version,
    );

    const ignoredKeys = validEntries
      .filter((entry) => shouldIgnorePersistedItem(entry.payload))
      .map((entry) => entry.key);
    if (ignoredKeys.length > 0) {
      await asyncNamespace.commit({ removes: ignoredKeys });
    }

    const keptCandidates = validEntries.filter(
      (entry) => !shouldIgnorePersistedItem(entry.payload),
    );
    if (
      !hasIgnoreItemFilter &&
      keptCandidates.filter((entry) => !isProtectedKey(entry.key)).length <=
        maxItems
    ) {
      return;
    }

    keptCandidates.sort((left, right) => {
      const leftProtected = isProtectedKey(left.key);
      const rightProtected = isProtectedKey(right.key);

      if (leftProtected !== rightProtected) {
        return leftProtected ? -1 : 1;
      }

      const leftPinned = pinnedItemKeys.has(left.key);
      const rightPinned = pinnedItemKeys.has(right.key);
      if (leftPinned !== rightPinned) {
        return leftPinned ? -1 : 1;
      }

      return right.lastAccessAt - left.lastAccessAt;
    });

    const keptKeys = new Set(
      keptCandidates.slice(0, maxItems).map((entry) => entry.key),
    );
    const removals = keptCandidates
      .filter((entry) => !keptKeys.has(entry.key))
      .map((entry) => entry.key);
    if (removals.length > 0) {
      await asyncNamespace.commit({ removes: removals });
    }
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;
      const prefix = getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'collection.item',
      );
      const tasks: Promise<void>[] = [];

      for (const [itemKey, item] of Object.entries(storeRef.state)) {
        const storageKey = `${prefix}${itemKey}`;
        if (!item?.data || shouldIgnoreItem(item.payload)) {
          tasks.push(Promise.resolve(localStorage.removeItem(storageKey)));
          continue;
        }

        tasks.push(
          Promise.resolve(
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                data: { data: item.data, payload: item.payload },
                timestamp: Date.now(),
                version,
              }),
            ),
          ),
        );
      }

      for (const itemKey of deletedItemKeys) {
        const item = storeRef.state[itemKey];
        const storageKey = `${prefix}${itemKey}`;

        if (!item?.data || shouldIgnoreItem(item.payload)) {
          tasks.push(Promise.resolve(localStorage.removeItem(storageKey)));
        }
      }

      dirtyItemKeys.clear();
      deletedItemKeys.clear();
      await Promise.all(tasks);
      await evictStoredItems();
      return;
    }

    if (!asyncNamespace) return;

    const upserts: Array<{
      key: string;
      value: PersistedCollectionItemValue<ItemState>;
      version: number;
      metadata: CollectionItemMetadata;
    }> = [];
    const removes = new Set<string>(deletedItemKeys);
    const keysToFlush = new Set([...dirtyItemKeys, ...deletedItemKeys]);

    dirtyItemKeys.clear();
    deletedItemKeys.clear();

    for (const itemKey of keysToFlush) {
      const item = storeRef.state[itemKey];
      if (!item?.data || shouldIgnoreItem(item.payload)) {
        removes.add(itemKey);
        continue;
      }

      removes.delete(itemKey);
      upserts.push({
        key: itemKey,
        value: { data: item.data },
        version,
        metadata: { payload: item.payload },
      });
    }

    await asyncNamespace.commit({ upserts, removes: [...removes] });
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
    if (backend === 'localStorage') {
      unsubscribe = store.subscribe(() => {
        schedulePersistedStateFlush();
      });
      return;
    }

    lastSnapshot = store.state;
    unsubscribe = store.subscribe(({ current }) => {
      if (suppressDirtyTracking > 0) {
        lastSnapshot = current;
        return;
      }

      const previous = lastSnapshot;
      lastSnapshot = current;
      const allKeys = new Set([
        ...Object.keys(previous ?? {}),
        ...Object.keys(current),
      ]);

      for (const itemKey of allKeys) {
        if (
          previous &&
          samePersistedProjection(previous[itemKey], current[itemKey])
        ) {
          continue;
        }

        dirtyItemKeys.add(itemKey);
        if (!current[itemKey]?.data) {
          deletedItemKeys.add(itemKey);
        } else {
          deletedItemKeys.delete(itemKey);
        }
      }

      if (dirtyItemKeys.size > 0 || deletedItemKeys.size > 0) {
        schedulePersistedStateFlush();
      }
    });
  }

  function dispose(): void {
    generation++;
    pendingPreloads.clear();
    dirtyItemKeys.clear();
    deletedItemKeys.clear();
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    lastSnapshot = null;
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;
      const prefix = getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'collection.item',
      );
      for (const key of listLocalStorageKeysSync(prefix)) {
        localStorage.removeItem(key);
      }
      return;
    }

    await asyncNamespace?.clear();
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    preloadItems,
    hasAsyncPreload:
      backend === 'opfs' && isAsyncStorageAdapter(storageAdapter),
    dispose,
    clear,
  };
}
