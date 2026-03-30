import type { Store } from 't-state';

import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';

import type {
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
} from '../listQueryStore/types';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import type {
  ListQueryPersistentStorageConfig,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageAdapter,
} from './types';

import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedListQueryData,
  parsePersistedListQueryItemData,
  parsePersistedStoreData,
  type NormalizedPersistentStorageDataSchema,
  type ParsedPersistedListQueryItemData,
} from './parsePersistedData';
import {
  createPersistentStorageNamespaceHandle,
  getStoragePrefixForStoreNamespace,
  listLocalStorageKeysSync,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_MAX_QUERIES = 100;
const DEFAULT_MAX_QUERY_SIZE = 100;
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

function toItemState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  StorageState = unknown,
>(
  persisted: ParsedPersistedListQueryItemData<ItemPayload>,
  dataSchema: NormalizedPersistentStorageDataSchema<ItemState, StorageState>,
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
): {
  item: ItemState;
  itemQuery: TSDFItemQuery<ItemPayload>;
  loadedFields: string[];
} | null {
  const validated = parsePersistedStoreData(persisted.data, dataSchema);
  if (validated === null) return null;

  if (shouldIgnoreItem(persisted.payload)) return null;

  const loadedFields = Array.isArray(persisted.loadedFields)
    ? Array.from(new Set(persisted.loadedFields)).sort()
    : Object.keys(validated).sort();

  return {
    item: validated,
    itemQuery: {
      error: null,
      payload: persisted.payload,
      refetchOnMount: 'lowPriority',
      status: 'success',
      wasLoaded: true,
    },
    loadedFields,
  };
}

function limitPersistedQueryItems(
  itemKeys: string[],
  hasMore: boolean,
  maxQuerySize: number,
): { itemKeys: string[]; hasMore: boolean } {
  const limitedItemKeys = itemKeys.slice(0, maxQuerySize);

  return {
    itemKeys: limitedItemKeys,
    hasMore: hasMore || limitedItemKeys.length < itemKeys.length,
  };
}

function defineLazyLocalStorageItem<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  StorageState = unknown,
>(
  state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  itemKey: string,
  storageKey: string,
  version: number,
  itemPayloadSchema: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  >['itemPayloadSchema'],
  dataSchema: NormalizedPersistentStorageDataSchema<ItemState, StorageState>,
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
): void {
  function readItemFromLocalStorage():
    | ItemState
    | TSDFItemQuery<ItemPayload>
    | undefined {
    const cacheEntry = readStorageEntryFromLocalStorageSync(
      storageKey,
      version,
    );

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

    const persisted = parsePersistedListQueryItemData(
      cacheEntry.data,
      itemPayloadSchema,
    );
    if (!persisted) {
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

    const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);

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
  queryPayloadSchema: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload
  >['queryPayloadSchema'],
  maxQuerySize: number,
): void {
  Object.defineProperty(state.queries, queryKey, {
    configurable: true,
    enumerable: false,
    get() {
      const cacheEntry = readStorageEntryFromLocalStorageSync(
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

      const persistedQuery = parsePersistedListQueryData(
        cacheEntry.data,
        queryPayloadSchema,
      );
      if (!persistedQuery) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        Object.defineProperty(state.queries, queryKey, {
          configurable: true,
          enumerable: false,
          value: undefined,
          writable: true,
        });
        return undefined;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      const filteredItemKeys = persistedQuery.items.filter((itemKey) => {
        void state.itemQueries[itemKey];
        return (
          state.items[itemKey] !== undefined &&
          state.itemQueries[itemKey] !== undefined
        );
      });
      const limitedQuery = limitPersistedQueryItems(
        filteredItemKeys,
        persistedQuery.hasMore,
        maxQuerySize,
      );

      const queryState: TSFDListQuery<QueryPayload> = {
        error: null,
        hasMore: limitedQuery.hasMore,
        items: limitedQuery.itemKeys,
        payload: persistedQuery.payload,
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
  maybeHydrateItems(itemKeys: string[]): Promise<boolean[]>;
  maybeHydrateQueries(queryKeys: string[]): Promise<boolean[]>;
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
  StorageState = unknown,
>(
  config: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload,
    StorageState
  > & { getSessionKey: () => string | false },
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
  const maxQuerySize = config.maxQuerySize ?? DEFAULT_MAX_QUERY_SIZE;
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
  const hasIgnoreItemFilter = config.ignoreItems !== undefined;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState | StorageState>
  >({ ...config, entryPrefix: 'listQuery.item' }, { adapter: options.adapter });
  const queryNamespace =
    createPersistentStorageNamespaceHandle<PersistedListQueryData>(
      { ...config, entryPrefix: 'listQuery.query' },
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
        config.itemPayloadSchema,
        dataSchema,
        shouldIgnoreItem,
      );
    }

    for (const storageKey of listLocalStorageKeysSync(queryPrefix)) {
      const queryKey = storageKey.slice(queryPrefix.length);
      if (queryKey in initialState.queries) continue;

      defineLazyLocalStorageQuery(
        initialState,
        queryKey,
        storageKey,
        version,
        config.queryPayloadSchema,
        maxQuerySize,
      );
    }

    return initialState;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (!storeRef) return false;
    if (storeRef.state.itemQueries[itemKey] !== undefined) {
      return (
        storeRef.state.itemQueries[itemKey] !== null &&
        storeRef.state.items[itemKey] !== undefined
      );
    }

    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return false;

      const storageKey = `${getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'listQuery.item',
      )}${itemKey}`;
      const cacheEntry = readStorageEntryFromLocalStorageSync(
        storageKey,
        version,
      );

      if (!cacheEntry) return false;

      const persisted = parsePersistedListQueryItemData(
        cacheEntry.data,
        config.itemPayloadSchema,
      );
      if (!persisted) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);
      if (!itemState) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

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

        const persisted = parsePersistedListQueryItemData(
          cached,
          config.itemPayloadSchema,
        );
        if (!persisted) {
          scheduleIdleCleanup(() => void itemNamespace.remove(itemKey));
          return false;
        }

        const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);
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
    if (!storeRef) return false;
    if (storeRef.state.queries[queryKey] !== undefined) {
      return true;
    }

    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return false;

      const storageKey = `${getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'listQuery.query',
      )}${queryKey}`;
      const cacheEntry = readStorageEntryFromLocalStorageSync(
        storageKey,
        version,
      );

      if (!cacheEntry) return false;

      const persistedQuery = parsePersistedListQueryData(
        cacheEntry.data,
        config.queryPayloadSchema,
      );
      if (!persistedQuery) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      const activeStore = storeRef;

      await Promise.all(
        persistedQuery.items.map((itemKey) => preloadItem(itemKey)),
      );

      const filteredItemKeys = persistedQuery.items.filter((itemKey) => {
        return (
          activeStore.state.items[itemKey] !== undefined &&
          activeStore.state.itemQueries[itemKey] !== undefined
        );
      });
      const limitedQuery = limitPersistedQueryItems(
        filteredItemKeys,
        persistedQuery.hasMore,
        maxQuerySize,
      );

      activeStore.produceState(
        (draft) => {
          if (draft.queries[queryKey] === undefined) {
            draft.queries[queryKey] = {
              error: null,
              hasMore: limitedQuery.hasMore,
              items: limitedQuery.itemKeys,
              payload: persistedQuery.payload,
              refetchOnMount: 'lowPriority',
              status: 'success',
              wasLoaded: true,
            };
          }
        },
        { action: 'persistent-storage-hydrate' },
      );

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
        const persistedQuery = parsePersistedListQueryData(
          cached,
          config.queryPayloadSchema,
        );
        if (!persistedQuery) {
          scheduleIdleCleanup(() => void queryNamespace.remove(queryKey));
          return false;
        }

        await preloadItems(persistedQuery.items);
        if (currentGeneration !== generation || activeStore !== storeRef) {
          return false;
        }
        if (activeStore.state.queries[queryKey] !== undefined) {
          return true;
        }

        const filteredItemKeys = persistedQuery.items.filter((itemKey) => {
          return (
            activeStore.state.items[itemKey] !== undefined &&
            activeStore.state.itemQueries[itemKey] !== undefined
          );
        });
        const limitedQuery = limitPersistedQueryItems(
          filteredItemKeys,
          persistedQuery.hasMore,
          maxQuerySize,
        );

        activeStore.produceState(
          (draft) => {
            if (draft.queries[queryKey] === undefined) {
              draft.queries[queryKey] = {
                error: null,
                hasMore: limitedQuery.hasMore,
                items: limitedQuery.itemKeys,
                payload: persistedQuery.payload,
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

  async function maybeHydrateItems(itemKeys: string[]): Promise<boolean[]> {
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function maybeHydrateQueries(queryKeys: string[]): Promise<boolean[]> {
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

    const invalidEntries = filterAndMap(entries, ({ queryKey, entry }) => {
      if (!entry) return false;

      return parsePersistedListQueryData(entry.data, config.queryPayloadSchema)
        ? false
        : { queryKey };
    });

    if (invalidEntries.length > 0) {
      await Promise.all(
        invalidEntries.map(({ queryKey }) => queryNamespace.remove(queryKey)),
      );
    }

    const validEntries = filterAndMap(entries, ({ queryKey, entry }) => {
      if (!entry) return false;

      const persisted = parsePersistedListQueryData(
        entry.data,
        config.queryPayloadSchema,
      );
      return persisted ? { queryKey, entry } : false;
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
    const itemEntries = await Promise.all(
      itemKeys.map(async (itemKey) => ({
        itemKey,
        entry: await itemNamespace.readEntry(itemKey),
      })),
    );

    const invalidItemEntries = filterAndMap(
      itemEntries,
      ({ itemKey, entry }) => {
        if (!entry) return false;

        const persisted = parsePersistedListQueryItemData(
          entry.data,
          config.itemPayloadSchema,
        );

        if (!persisted) return { itemKey };

        return parsePersistedStoreData(persisted.data, dataSchema)
          ? false
          : { itemKey };
      },
    );

    if (invalidItemEntries.length > 0) {
      await Promise.all(
        invalidItemEntries.map(({ itemKey }) => itemNamespace.remove(itemKey)),
      );
    }

    const validItemEntries = filterAndMap(itemEntries, ({ itemKey, entry }) => {
      if (!entry) return false;

      const persisted = parsePersistedListQueryItemData(
        entry.data,
        config.itemPayloadSchema,
      );
      if (!persisted) return false;

      return parsePersistedStoreData(persisted.data, dataSchema)
        ? { itemKey, entry, persisted }
        : false;
    });

    const ignoredItemEntries = validItemEntries.filter(({ persisted }) =>
      shouldIgnoreItem(persisted.payload),
    );

    if (ignoredItemEntries.length > 0) {
      await Promise.all(
        ignoredItemEntries.map(({ itemKey }) => itemNamespace.remove(itemKey)),
      );
    }

    const persistedItemEntries = validItemEntries.filter(
      ({ persisted }) => !shouldIgnoreItem(persisted.payload),
    );

    if (!hasIgnoreItemFilter && persistedItemEntries.length <= maxItems) return;

    persistedItemEntries.sort((a, b) => {
      const aPinned = pinnedItemKeys.has(a.itemKey);
      const bPinned = pinnedItemKeys.has(b.itemKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      const aReferenced = referencedItems.has(a.itemKey);
      const bReferenced = referencedItems.has(b.itemKey);

      if (aReferenced && !bReferenced) return -1;
      if (!aReferenced && bReferenced) return 1;

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
        const limitedQuery = limitPersistedQueryItems(
          filteredItems,
          entry.hasMore,
          maxQuerySize,
        );

        if (
          limitedQuery.itemKeys.length === entry.items.length &&
          limitedQuery.hasMore === entry.hasMore
        ) {
          return;
        }

        await queryNamespace.save(queryKey, {
          ...entry,
          items: limitedQuery.itemKeys,
          hasMore: limitedQuery.hasMore,
        });
      }),
    );
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    const state = storeRef.state;
    const tasks: Promise<void>[] = [];
    const queryReferencedItemKeys = new Set<string>();
    const persistedQueryItemKeys = new Set<string>();

    for (const query of Object.values(state.queries)) {
      for (const itemKey of query.items) {
        queryReferencedItemKeys.add(itemKey);
      }
    }

    for (const [queryKey, query] of Object.entries(state.queries)) {
      if (query.status !== 'success' && !query.wasLoaded) continue;

      const filteredItems = query.items.filter((itemKey) => {
        const item = state.items[itemKey];
        const itemQuery = state.itemQueries[itemKey];

        return (
          item !== null &&
          item !== undefined &&
          itemQuery !== null &&
          itemQuery !== undefined &&
          !shouldIgnoreItem(itemQuery.payload)
        );
      });
      const limitedQuery = limitPersistedQueryItems(
        filteredItems,
        query.hasMore,
        maxQuerySize,
      );

      for (const itemKey of limitedQuery.itemKeys) {
        persistedQueryItemKeys.add(itemKey);
      }

      tasks.push(
        queryNamespace.save(queryKey, {
          payload: query.payload,
          items: limitedQuery.itemKeys,
          hasMore: limitedQuery.hasMore,
        }),
      );
    }

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

      const isQueryReferenced = queryReferencedItemKeys.has(itemKey);
      if (isQueryReferenced && !persistedQueryItemKeys.has(itemKey)) {
        tasks.push(itemNamespace.remove(itemKey));
        continue;
      }

      const converted = convertStoreDataForPersistence(item, dataSchema);
      if (!converted.ok) {
        config.onPersistentStorageError?.(converted.error);
        continue;
      }

      tasks.push(
        itemNamespace.save(itemKey, {
          data: converted.value,
          payload: itemQuery.payload,
          loadedFields: state.itemLoadedFields[itemKey],
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
    maybeHydrateItems,
    maybeHydrateQueries,
    preloadItems,
    preloadQueries,
    hasAsyncPreload: backend === 'opfs',
    dispose,
    clear,
  };
}
