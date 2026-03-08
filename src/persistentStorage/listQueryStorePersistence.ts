import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
} from '../listQueryStore/types';
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
  ListQueryPersistentStorageConfig,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageAdapter,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_MAX_QUERIES = 100;
const SAVE_DEBOUNCE_MS = 1000;

function createShouldIgnoreItemPredicate<ItemPayload extends ValidPayload>(
  ignoreItems:
    | ListQueryPersistentStorageConfig<never, never, ItemPayload>['ignoreItems']
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

function toItemState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  persisted: PersistedListQueryItemData<unknown>,
  config: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  >,
  shouldIgnorePersistedItem: (payload: unknown) => boolean,
): {
  item: ItemState;
  itemQuery: TSDFItemQuery<ItemPayload>;
  loadedFields: string[];
} | null {
  const validated = validateWithSchema(config.schema, persisted.data);
  if (validated === null) return null;

  if (shouldIgnorePersistedItem(persisted.payload)) return null;

  const payload = __LEGIT_CAST__<ItemPayload, unknown>(persisted.payload);

  const loadedFields = Array.isArray(persisted.loadedFields)
    ? Array.from(new Set(persisted.loadedFields)).sort()
    : Object.keys(validated).sort();

  return {
    item: validated,
    itemQuery: {
      error: null,
      payload,
      refetchOnMount: 'lowPriority',
      status: 'success',
      wasLoaded: true,
    },
    loadedFields,
  };
}

function defineLazyLocalStorageItem<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  itemKey: string,
  storageKey: string,
  version: number,
  config: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  >,
  shouldIgnorePersistedItem: (payload: unknown) => boolean,
): void {
  function readItemFromLocalStorage():
    | ItemState
    | TSDFItemQuery<ItemPayload>
    | undefined {
    const cacheEntry = readStorageEntryFromLocalStorageSync<
      PersistedListQueryItemData<unknown>
    >(storageKey, version);

    if (!cacheEntry) {
      Object.defineProperty(state.items, itemKey, {
        configurable: true,
        enumerable: false,
        value: undefined,
        writable: true,
      });
      Object.defineProperty(state.itemQueries, itemKey, {
        configurable: true,
        enumerable: false,
        value: undefined,
        writable: true,
      });
      delete state.itemLoadedFields[itemKey];
      return undefined;
    }

    const itemState = toItemState<ItemState, QueryPayload, ItemPayload>(
      cacheEntry.data,
      config,
      shouldIgnorePersistedItem,
    );

    if (!itemState) {
      scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
      Object.defineProperty(state.items, itemKey, {
        configurable: true,
        enumerable: false,
        value: undefined,
        writable: true,
      });
      Object.defineProperty(state.itemQueries, itemKey, {
        configurable: true,
        enumerable: false,
        value: undefined,
        writable: true,
      });
      delete state.itemLoadedFields[itemKey];
      return undefined;
    }

    scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

    Object.defineProperty(state.items, itemKey, {
      configurable: true,
      enumerable: true,
      value: itemState.item,
      writable: true,
    });
    Object.defineProperty(state.itemQueries, itemKey, {
      configurable: true,
      enumerable: true,
      value: itemState.itemQuery,
      writable: true,
    });
    state.itemLoadedFields[itemKey] = itemState.loadedFields;

    return itemState.item;
  }

  Object.defineProperty(state.items, itemKey, {
    configurable: true,
    enumerable: false,
    get: readItemFromLocalStorage,
  });
  Object.defineProperty(state.itemQueries, itemKey, {
    configurable: true,
    enumerable: false,
    get() {
      readItemFromLocalStorage();
      return state.itemQueries[itemKey];
    },
  });
}

function defineLazyLocalStorageQuery<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  queryKey: string,
  storageKey: string,
  version: number,
): void {
  Object.defineProperty(state.queries, queryKey, {
    configurable: true,
    enumerable: false,
    get() {
      const cacheEntry =
        readStorageEntryFromLocalStorageSync<PersistedListQueryData>(
          storageKey,
          version,
        );

      if (!cacheEntry) {
        Object.defineProperty(state.queries, queryKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      const filteredItemKeys = cacheEntry.data.items.filter((itemKey) => {
        void state.itemQueries[itemKey];
        return (
          state.items[itemKey] !== undefined &&
          state.itemQueries[itemKey] !== undefined
        );
      });

      const queryState: TSFDListQuery<QueryPayload> = {
        error: null,
        hasMore: cacheEntry.data.hasMore,
        items: filteredItemKeys,
        payload: __LEGIT_CAST__<QueryPayload, unknown>(cacheEntry.data.payload),
        refetchOnMount: 'lowPriority',
        status: 'success',
        wasLoaded: true,
      };

      Object.defineProperty(state.queries, queryKey, {
        configurable: true,
        enumerable: true,
        value: queryState,
        writable: true,
      });

      return queryState;
    },
  });
}

export type ListQueryPersistenceSetup<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> = {
  createInitialState(
    baseState: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  ): TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;
  attach(
    store: Store<TSFDListQueryState<ItemState, QueryPayload, ItemPayload>>,
  ): void;
  preloadItems(itemKeys: string[]): Promise<boolean[]>;
  preloadQueries(queryKeys: string[]): Promise<boolean[]>;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

export function setupListQueryPersistence<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  config: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  > & {
    getSessionKey: () => string | false;
  },
  options: {
    adapter?: StorageAdapter;
    getItemKey?: (payload: ItemPayload) => string;
    getQueryKey?: (payload: QueryPayload) => string;
  } = {},
): ListQueryPersistenceSetup<ItemState, QueryPayload, ItemPayload> {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  const version = config.version ?? 1;
  const backend = config.backend ?? 'opfs';
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxQueries = config.maxQueries ?? DEFAULT_MAX_QUERIES;
  const resolveItemKey =
    options.getItemKey ?? ((payload: ItemPayload) => getCompositeKey(payload));
  const resolveQueryKey =
    options.getQueryKey ??
    ((payload: QueryPayload) => getCompositeKey(payload));
  const pinnedItemKeys = new Set(
    (config.pinnedItems ?? []).map((payload) => resolveItemKey(payload)),
  );
  const pinnedQueryKeys = new Set(
    (config.pinnedQueries ?? []).map((payload) => resolveQueryKey(payload)),
  );
  const shouldIgnoreItem = createShouldIgnoreItemPredicate(
    config.ignoreItems,
    resolveItemKey,
  );
  const shouldIgnorePersistedItem =
    createShouldIgnorePersistedItemPredicate(shouldIgnoreItem);
  const hasIgnoreItemFilter = config.ignoreItems !== undefined;

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState>
  >(
    {
      ...config,
      entryPrefix: 'listQuery.item',
    },
    { adapter: options.adapter },
  );
  const queryNamespace =
    createPersistentStorageNamespaceHandle<PersistedListQueryData>(
      {
        ...config,
        entryPrefix: 'listQuery.query',
      },
      { adapter: options.adapter },
    );

  let storeRef: Store<State> | null = null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const pendingItemPreloads = new Map<string, Promise<boolean>>();
  const pendingQueryPreloads = new Map<string, Promise<boolean>>();

  function clearSaveTimer(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function createInitialState(baseState: State): State {
    if (backend !== 'localStorage') return baseState;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return baseState;

    const itemPrefix = getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      'listQuery.item',
    );
    const queryPrefix = getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      'listQuery.query',
    );

    const initialState: State = {
      items: { ...baseState.items },
      queries: { ...baseState.queries },
      itemQueries: { ...baseState.itemQueries },
      itemLoadedFields: { ...baseState.itemLoadedFields },
      itemFieldInvalidationFields: { ...baseState.itemFieldInvalidationFields },
    };

    for (const storageKey of listLocalStorageKeysSync(itemPrefix)) {
      const itemKey = storageKey.slice(itemPrefix.length);
      if (
        itemKey in initialState.items ||
        itemKey in initialState.itemQueries
      ) {
        continue;
      }

      defineLazyLocalStorageItem(
        initialState,
        itemKey,
        storageKey,
        version,
        config,
        shouldIgnorePersistedItem,
      );
    }

    for (const storageKey of listLocalStorageKeysSync(queryPrefix)) {
      const queryKey = storageKey.slice(queryPrefix.length);
      if (queryKey in initialState.queries) continue;

      defineLazyLocalStorageQuery(initialState, queryKey, storageKey, version);
    }

    return initialState;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (backend !== 'opfs' || !storeRef) return false;
    if (storeRef.state.itemQueries[itemKey] !== undefined) {
      return (
        storeRef.state.itemQueries[itemKey] !== null &&
        storeRef.state.items[itemKey] !== undefined
      );
    }

    const existingPromise = pendingItemPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = itemNamespace
      .load(itemKey)
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }

        const itemState = toItemState<ItemState, QueryPayload, ItemPayload>(
          cached,
          config,
          shouldIgnorePersistedItem,
        );
        if (!itemState) {
          scheduleIdleCleanup(() => void itemNamespace.remove(itemKey));
          return false;
        }

        if (storeRef.state.itemQueries[itemKey] !== undefined) {
          return (
            storeRef.state.itemQueries[itemKey] !== null &&
            storeRef.state.items[itemKey] !== undefined
          );
        }

        storeRef.produceState(
          (draft) => {
            if (draft.itemQueries[itemKey] === undefined) {
              draft.items[itemKey] = itemState.item;
              draft.itemQueries[itemKey] = itemState.itemQuery;
              draft.itemLoadedFields[itemKey] = itemState.loadedFields;
            }
          },
          { action: 'persistent-storage-hydrate' },
        );

        return true;
      })
      .finally(() => {
        if (currentGeneration === generation) {
          pendingItemPreloads.delete(itemKey);
        }
      });

    pendingItemPreloads.set(itemKey, promise);
    return promise;
  }

  async function preloadItems(itemKeys: string[]): Promise<boolean[]> {
    if (backend !== 'opfs') return itemKeys.map(() => false);
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function preloadQuery(queryKey: string): Promise<boolean> {
    if (backend !== 'opfs' || !storeRef) return false;
    if (storeRef.state.queries[queryKey] !== undefined) {
      return true;
    }

    const existingPromise = pendingQueryPreloads.get(queryKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = queryNamespace
      .load(queryKey)
      .then(async (cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }
        const activeStore = storeRef;

        await preloadItems(cached.items);
        if (currentGeneration !== generation || activeStore !== storeRef) {
          return false;
        }
        if (activeStore.state.queries[queryKey] !== undefined) {
          return true;
        }

        const filteredItemKeys = cached.items.filter((itemKey) => {
          return (
            activeStore.state.items[itemKey] !== undefined &&
            activeStore.state.itemQueries[itemKey] !== undefined
          );
        });

        activeStore.produceState(
          (draft) => {
            if (draft.queries[queryKey] === undefined) {
              draft.queries[queryKey] = {
                error: null,
                hasMore: cached.hasMore,
                items: filteredItemKeys,
                payload: __LEGIT_CAST__<QueryPayload, unknown>(cached.payload),
                refetchOnMount: 'lowPriority',
                status: 'success',
                wasLoaded: true,
              };
            }
          },
          { action: 'persistent-storage-hydrate' },
        );

        return true;
      })
      .finally(() => {
        if (currentGeneration === generation) {
          pendingQueryPreloads.delete(queryKey);
        }
      });

    pendingQueryPreloads.set(queryKey, promise);
    return promise;
  }

  async function preloadQueries(queryKeys: string[]): Promise<boolean[]> {
    if (backend !== 'opfs') return queryKeys.map(() => false);
    return Promise.all(queryKeys.map((queryKey) => preloadQuery(queryKey)));
  }

  async function evictStoredQueries(): Promise<Set<string>> {
    const queryKeys = await queryNamespace.listKeys();
    const entries = await Promise.all(
      queryKeys.map(async (queryKey) => ({
        queryKey,
        entry: await queryNamespace.readEntry(queryKey),
      })),
    );

    const validEntries = filterAndMap(entries, ({ queryKey, entry }) => {
      return entry ? { queryKey, entry } : false;
    });

    validEntries.sort((a, b) => {
      const aPinned = pinnedQueryKeys.has(a.queryKey);
      const bPinned = pinnedQueryKeys.has(b.queryKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return b.entry.timestamp - a.entry.timestamp;
    });

    const keptQueryKeys = new Set(
      validEntries.slice(0, maxQueries).map(({ queryKey }) => queryKey),
    );

    await Promise.all(
      validEntries
        .filter(({ queryKey }) => !keptQueryKeys.has(queryKey))
        .map(({ queryKey }) => queryNamespace.remove(queryKey)),
    );

    return keptQueryKeys;
  }

  async function evictStoredItems(keptQueryKeys: Set<string>): Promise<void> {
    const queryEntries = await Promise.all(
      [...keptQueryKeys].map(async (queryKey) => ({
        queryKey,
        entry: await queryNamespace.readEntry(queryKey),
      })),
    );

    const referencedItems = new Set<string>();
    for (const { entry } of queryEntries) {
      if (!entry) continue;

      for (const itemKey of entry.data.items) {
        referencedItems.add(itemKey);
      }
    }

    const itemKeys = await itemNamespace.listKeys();
    if (!hasIgnoreItemFilter && itemKeys.length <= maxItems) return;
    const itemEntries = await Promise.all(
      itemKeys.map(async (itemKey) => ({
        itemKey,
        entry: await itemNamespace.readEntry(itemKey),
      })),
    );

    const validItemEntries = filterAndMap(itemEntries, ({ itemKey, entry }) => {
      return entry ? { itemKey, entry } : false;
    });

    const ignoredItemEntries = validItemEntries.filter(({ entry }) =>
      shouldIgnorePersistedItem(entry.data.payload),
    );

    if (ignoredItemEntries.length > 0) {
      await Promise.all(
        ignoredItemEntries.map(({ itemKey }) => itemNamespace.remove(itemKey)),
      );
    }

    const persistedItemEntries = validItemEntries.filter(
      ({ entry }) => !shouldIgnorePersistedItem(entry.data.payload),
    );

    persistedItemEntries.sort((a, b) => {
      const aReferenced = referencedItems.has(a.itemKey);
      const bReferenced = referencedItems.has(b.itemKey);

      if (aReferenced && !bReferenced) return -1;
      if (!aReferenced && bReferenced) return 1;

      const aPinned = pinnedItemKeys.has(a.itemKey);
      const bPinned = pinnedItemKeys.has(b.itemKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return b.entry.timestamp - a.entry.timestamp;
    });

    const keptItemKeys = new Set(
      persistedItemEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
    );

    await Promise.all(
      persistedItemEntries
        .filter(({ itemKey }) => !keptItemKeys.has(itemKey))
        .map(({ itemKey }) => itemNamespace.remove(itemKey)),
    );

    await Promise.all(
      [...keptQueryKeys].map(async (queryKey) => {
        const entry = await queryNamespace.load(queryKey);
        if (!entry) return;

        const filteredItems = entry.items.filter((itemKey) =>
          keptItemKeys.has(itemKey),
        );

        if (filteredItems.length === entry.items.length) return;

        await queryNamespace.save(queryKey, {
          ...entry,
          items: filteredItems,
        });
      }),
    );
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    const state = storeRef.state;
    const tasks: Promise<void>[] = [];
    const persistedItemKeys = new Set<string>();

    for (const [itemKey, item] of Object.entries(state.items)) {
      const itemQuery = state.itemQueries[itemKey];

      if (item === null || itemQuery === null || itemQuery === undefined) {
        tasks.push(itemNamespace.remove(itemKey));
        continue;
      }

      if (shouldIgnoreItem(itemQuery.payload)) {
        tasks.push(itemNamespace.remove(itemKey));
        continue;
      }

      persistedItemKeys.add(itemKey);

      tasks.push(
        itemNamespace.save(itemKey, {
          data: item,
          payload: itemQuery.payload,
          loadedFields: state.itemLoadedFields[itemKey],
        }),
      );
    }

    for (const [queryKey, query] of Object.entries(state.queries)) {
      if (query.status !== 'success' && !query.wasLoaded) continue;

      tasks.push(
        queryNamespace.save(queryKey, {
          payload: query.payload,
          items: query.items.filter((itemKey) =>
            persistedItemKeys.has(itemKey),
          ),
          hasMore: query.hasMore,
        }),
      );
    }

    await Promise.all(tasks);
    const keptQueryKeys = await evictStoredQueries();
    await evictStoredItems(keptQueryKeys);
  }

  function schedulePersistedStateFlush(): void {
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPersistedState();
    }, SAVE_DEBOUNCE_MS);
  }

  function attach(store: Store<State>): void {
    storeRef = store;
    unsubscribe = store.subscribe(() => {
      schedulePersistedStateFlush();
    });
  }

  function dispose(): void {
    generation++;
    pendingItemPreloads.clear();
    pendingQueryPreloads.clear();
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    itemNamespace.dispose();
    queryNamespace.dispose();
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    await Promise.all([itemNamespace.clear(), queryNamespace.clear()]);
  }

  return {
    createInitialState,
    attach,
    preloadItems,
    preloadQueries,
    hasAsyncPreload: backend === 'opfs',
    dispose,
    clear,
  };
}
