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
  createProtectedStorageRef,
  getStoragePrefixForStoreNamespace,
  listLocalStorageKeysSync,
  listProtectedLocalStorageNamespaceKeys,
  openAsyncStorageNamespace,
  readLocalStorageNamespaceEntries,
  readAllAsyncStorageMetadata,
  readStorageEntryFromLocalStorageSync,
  readProtectedStorageKeys,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { createStorageAdapter, isAsyncStorageAdapter } from './storageAdapter';
import type {
  AsyncStorageEntryMetadata,
  ListQueryPersistentStorageConfig,
  PersistedListQueryData,
  PersistedListQueryItemData,
  StorageAdapter,
  StorageCacheEntry,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_MAX_QUERIES = 100;
const DEFAULT_MAX_QUERY_SIZE = 100;
const SAVE_DEBOUNCE_MS = 1000;

type PersistedListQueryItemValue<ItemState> = {
  data: ItemState;
  loadedFields?: string[];
};

type PersistedListQueryItemMetadata = { payload: unknown };

type PersistedListQueryValue = Record<string, never>;

type PersistedListQueryMetadata = {
  payload: unknown;
  items: string[];
  hasMore: boolean;
};

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

function arraysEqual(
  left: string[] | undefined,
  right: string[] | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function toItemState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  value: PersistedListQueryItemValue<unknown>,
  metadata: PersistedListQueryItemMetadata,
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
  const validated = validateWithSchema(config.schema, value.data);
  if (validated === null) return null;
  if (shouldIgnorePersistedItem(metadata.payload)) return null;

  const loadedFields = Array.isArray(value.loadedFields)
    ? Array.from(new Set(value.loadedFields)).sort()
    : Object.keys(validated).sort();

  return {
    item: validated,
    itemQuery: {
      error: null,
      payload: __LEGIT_CAST__<ItemPayload, unknown>(metadata.payload),
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
      {
        data: cacheEntry.data.data,
        loadedFields: cacheEntry.data.loadedFields,
      },
      { payload: cacheEntry.data.payload },
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
  maxQuerySize: number,
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
      const limitedQuery = limitPersistedQueryItems(
        filteredItemKeys,
        cacheEntry.data.hasMore,
        maxQuerySize,
      );

      const queryState: TSFDListQuery<QueryPayload> = {
        error: null,
        hasMore: limitedQuery.hasMore,
        items: limitedQuery.itemKeys,
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

function samePersistedQueryProjection<QueryPayload extends ValidPayload>(
  current: TSFDListQuery<QueryPayload> | undefined,
  previous: TSFDListQuery<QueryPayload> | undefined,
): boolean {
  const currentEligible =
    !!current && (current.status === 'success' || current.wasLoaded);
  const previousEligible =
    !!previous && (previous.status === 'success' || previous.wasLoaded);

  if (currentEligible !== previousEligible) return false;
  if (!currentEligible && !previousEligible) return true;

  return (
    current?.payload === previous?.payload &&
    current?.items === previous?.items &&
    current?.hasMore === previous?.hasMore
  );
}

function buildReferenceIndexes<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  shouldIgnoreItem: (payload: ItemPayload) => boolean,
  maxQuerySize: number,
): {
  rawQueryRefCount: Map<string, number>;
  persistedQueryRefCount: Map<string, number>;
} {
  const rawQueryRefCount = new Map<string, number>();
  const persistedQueryRefCount = new Map<string, number>();

  for (const query of Object.values(state.queries)) {
    for (const itemKey of query.items) {
      rawQueryRefCount.set(itemKey, (rawQueryRefCount.get(itemKey) ?? 0) + 1);
    }

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
    const limited = limitPersistedQueryItems(
      filteredItems,
      query.hasMore,
      maxQuerySize,
    );
    for (const itemKey of limited.itemKeys) {
      persistedQueryRefCount.set(
        itemKey,
        (persistedQueryRefCount.get(itemKey) ?? 0) + 1,
      );
    }
  }

  return { rawQueryRefCount, persistedQueryRefCount };
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
>(
  config: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload
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
  const shouldIgnorePersistedItem =
    createShouldIgnorePersistedItemPredicate(shouldIgnoreItem);
  const hasIgnoreItemFilter = config.ignoreItems !== undefined;
  const storageAdapter = options.adapter ?? createStorageAdapter(backend);
  const itemNamespace = openAsyncStorageNamespace<
    PersistedListQueryItemValue<ItemState>,
    PersistedListQueryItemMetadata
  >({ ...config, kind: 'listQuery.item' }, { adapter: storageAdapter });
  const queryNamespace = openAsyncStorageNamespace<
    PersistedListQueryValue,
    PersistedListQueryMetadata
  >({ ...config, kind: 'listQuery.query' }, { adapter: storageAdapter });

  let storeRef: Store<State> | null = null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressDirtyTracking = 0;
  let lastSnapshot: State | null = null;
  const pendingItemPreloads = new Map<string, Promise<boolean>>();
  const pendingQueryPreloads = new Map<string, Promise<boolean>>();
  const dirtyItemKeys = new Set<string>();
  const dirtyQueryKeys = new Set<string>();
  const deletedItemKeys = new Set<string>();
  const deletedQueryKeys = new Set<string>();

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

      defineLazyLocalStorageQuery(
        initialState,
        queryKey,
        storageKey,
        version,
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
      const cacheEntry = readStorageEntryFromLocalStorageSync<
        PersistedListQueryItemData<unknown>
      >(storageKey, version);
      if (!cacheEntry) return false;

      const itemState = toItemState<ItemState, QueryPayload, ItemPayload>(
        {
          data: cacheEntry.data.data,
          loadedFields: cacheEntry.data.loadedFields,
        },
        { payload: cacheEntry.data.payload },
        config,
        shouldIgnorePersistedItem,
      );
      if (!itemState) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));

      suppressDirtyTracking++;
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
      suppressDirtyTracking--;

      return true;
    }

    if (!itemNamespace) return false;

    const existingPromise = pendingItemPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = itemNamespace
      .get(itemKey, { touch: 'coarse' })
      .then(async (cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }
        if (cached.metadata.version !== version) {
          await itemNamespace.commit({ removes: [itemKey] });
          return false;
        }

        const itemState = toItemState<ItemState, QueryPayload, ItemPayload>(
          cached.value,
          { payload: cached.metadata.payload },
          config,
          shouldIgnorePersistedItem,
        );
        if (!itemState) {
          await itemNamespace.commit({ removes: [itemKey] });
          return false;
        }

        if (storeRef.state.itemQueries[itemKey] !== undefined) {
          return (
            storeRef.state.itemQueries[itemKey] !== null &&
            storeRef.state.items[itemKey] !== undefined
          );
        }

        suppressDirtyTracking++;
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
        suppressDirtyTracking--;

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
      const cacheEntry =
        readStorageEntryFromLocalStorageSync<PersistedListQueryData>(
          storageKey,
          version,
        );
      if (!cacheEntry) return false;

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));
      const activeStore = storeRef;
      await Promise.all(
        cacheEntry.data.items.map((itemKey) => preloadItem(itemKey)),
      );
      const filteredItemKeys = cacheEntry.data.items.filter((itemKey) => {
        return (
          activeStore.state.items[itemKey] !== undefined &&
          activeStore.state.itemQueries[itemKey] !== undefined
        );
      });
      const limitedQuery = limitPersistedQueryItems(
        filteredItemKeys,
        cacheEntry.data.hasMore,
        maxQuerySize,
      );

      suppressDirtyTracking++;
      activeStore.produceState(
        (draft) => {
          if (draft.queries[queryKey] === undefined) {
            draft.queries[queryKey] = {
              error: null,
              hasMore: limitedQuery.hasMore,
              items: limitedQuery.itemKeys,
              payload: __LEGIT_CAST__<QueryPayload, unknown>(
                cacheEntry.data.payload,
              ),
              refetchOnMount: 'lowPriority',
              status: 'success',
              wasLoaded: true,
            };
          }
        },
        { action: 'persistent-storage-hydrate' },
      );
      suppressDirtyTracking--;

      return true;
    }

    if (!queryNamespace) return false;

    const existingPromise = pendingQueryPreloads.get(queryKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = queryNamespace
      .get(queryKey, { touch: 'coarse' })
      .then(async (cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }
        if (cached.metadata.version !== version) {
          await queryNamespace.commit({ removes: [queryKey] });
          return false;
        }

        const activeStore = storeRef;
        await preloadItems(cached.metadata.items);
        if (currentGeneration !== generation || activeStore !== storeRef) {
          return false;
        }
        if (activeStore.state.queries[queryKey] !== undefined) {
          return true;
        }

        const filteredItemKeys = cached.metadata.items.filter((itemKey) => {
          return (
            activeStore.state.items[itemKey] !== undefined &&
            activeStore.state.itemQueries[itemKey] !== undefined
          );
        });
        const limitedQuery = limitPersistedQueryItems(
          filteredItemKeys,
          cached.metadata.hasMore,
          maxQuerySize,
        );

        suppressDirtyTracking++;
        activeStore.produceState(
          (draft) => {
            if (draft.queries[queryKey] === undefined) {
              draft.queries[queryKey] = {
                error: null,
                hasMore: limitedQuery.hasMore,
                items: limitedQuery.itemKeys,
                payload: __LEGIT_CAST__<QueryPayload, unknown>(
                  cached.metadata.payload,
                ),
                refetchOnMount: 'lowPriority',
                status: 'success',
                wasLoaded: true,
              };
            }
          },
          { action: 'persistent-storage-hydrate' },
        );
        suppressDirtyTracking--;

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
    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return new Set<string>();

      const queryPrefix = getStoragePrefixForStoreNamespace(
        sessionKey,
        config.storeName,
        'listQuery.query',
      );
      const protectedStorageKeys = await readProtectedStorageKeys(
        storageAdapter,
        sessionKey,
      );
      const protectedQueryKeys = listProtectedLocalStorageNamespaceKeys(
        protectedStorageKeys,
        queryPrefix,
      );
      const entries = readLocalStorageNamespaceEntries<PersistedListQueryData>(
        queryPrefix,
        version,
      ).map(({ key, entry }) => ({ queryKey: key, entry }));

      entries.sort((left, right) => {
        const leftProtected = protectedQueryKeys.has(left.queryKey);
        const rightProtected = protectedQueryKeys.has(right.queryKey);
        if (leftProtected !== rightProtected) {
          return leftProtected ? -1 : 1;
        }

        const leftPinned = pinnedQueryKeys.has(left.queryKey);
        const rightPinned = pinnedQueryKeys.has(right.queryKey);
        if (leftPinned !== rightPinned) {
          return leftPinned ? -1 : 1;
        }

        return right.entry.timestamp - left.entry.timestamp;
      });

      const keptQueryKeys = new Set(
        entries.slice(0, maxQueries).map(({ queryKey }) => queryKey),
      );

      for (const { queryKey } of entries) {
        if (!keptQueryKeys.has(queryKey)) {
          localStorage.removeItem(`${queryPrefix}${queryKey}`);
        }
      }

      return keptQueryKeys;
    }

    if (!queryNamespace) return new Set<string>();

    const sessionKey = config.getSessionKey();
    const protectedStorageKeys =
      sessionKey !== false
        ? await readProtectedStorageKeys(storageAdapter, sessionKey)
        : new Set<string>();
    const isProtectedQueryKey =
      sessionKey === false
        ? (_key_: string) => false
        : (key: string) =>
            protectedStorageKeys.has(
              createProtectedStorageRef({
                sessionKey,
                storeName: config.storeName,
                kind: 'listQuery.query',
                key,
              }),
            );
    const metadataEntries = await readAllAsyncStorageMetadata(queryNamespace, {
      order: 'lru-desc',
    });
    const validEntries = metadataEntries.filter(
      (entry): entry is AsyncStorageEntryMetadata<PersistedListQueryMetadata> =>
        entry.version === version,
    );

    validEntries.sort((left, right) => {
      const leftProtected = isProtectedQueryKey(left.key);
      const rightProtected = isProtectedQueryKey(right.key);
      if (leftProtected !== rightProtected) {
        return leftProtected ? -1 : 1;
      }

      const leftPinned = pinnedQueryKeys.has(left.key);
      const rightPinned = pinnedQueryKeys.has(right.key);
      if (leftPinned !== rightPinned) {
        return leftPinned ? -1 : 1;
      }

      return right.lastAccessAt - left.lastAccessAt;
    });

    const keptQueryKeys = new Set(
      validEntries.slice(0, maxQueries).map((entry) => entry.key),
    );
    const removals = validEntries
      .filter((entry) => !keptQueryKeys.has(entry.key))
      .map((entry) => entry.key);
    if (removals.length > 0) {
      await queryNamespace.commit({ removes: removals });
    }

    return keptQueryKeys;
  }

  async function evictStoredItems(keptQueryKeys: Set<string>): Promise<void> {
    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;

      const protectedStorageKeys = await readProtectedStorageKeys(
        storageAdapter,
        sessionKey,
      );
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
      const protectedItemKeys = listProtectedLocalStorageNamespaceKeys(
        protectedStorageKeys,
        itemPrefix,
      );
      const queryEntries = filterAndMap(
        [...keptQueryKeys].map((queryKey) => {
          const entry =
            readStorageEntryFromLocalStorageSync<PersistedListQueryData>(
              `${queryPrefix}${queryKey}`,
              version,
            );
          return entry ? { queryKey, entry } : false;
        }),
        (entry) => entry,
      );

      const referencedItems = new Set<string>();
      for (const { entry } of queryEntries) {
        for (const itemKey of entry.data.items) {
          referencedItems.add(itemKey);
        }
      }

      const itemEntries = readLocalStorageNamespaceEntries<
        PersistedListQueryItemData<unknown>
      >(itemPrefix, version).map(({ key, entry }) => ({ itemKey: key, entry }));
      if (!hasIgnoreItemFilter && itemEntries.length <= maxItems) {
        return;
      }
      const ignoredEntries = itemEntries.filter(({ entry }) =>
        shouldIgnorePersistedItem(entry.data.payload),
      );

      for (const { itemKey } of ignoredEntries) {
        localStorage.removeItem(`${itemPrefix}${itemKey}`);
      }

      const persistedEntries = itemEntries.filter(
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

        const leftReferenced = referencedItems.has(left.itemKey);
        const rightReferenced = referencedItems.has(right.itemKey);
        if (leftReferenced !== rightReferenced) {
          return leftReferenced ? -1 : 1;
        }

        return right.entry.timestamp - left.entry.timestamp;
      });

      const keptItemKeys = new Set(
        persistedEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
      );

      for (const { itemKey } of persistedEntries) {
        if (!keptItemKeys.has(itemKey)) {
          localStorage.removeItem(`${itemPrefix}${itemKey}`);
        }
      }

      for (const { queryKey, entry } of queryEntries) {
        const filteredItems = entry.data.items.filter((itemKey) =>
          keptItemKeys.has(itemKey),
        );
        const limitedQuery = limitPersistedQueryItems(
          filteredItems,
          entry.data.hasMore,
          maxQuerySize,
        );
        if (
          limitedQuery.itemKeys.length === entry.data.items.length &&
          limitedQuery.hasMore === entry.data.hasMore
        ) {
          continue;
        }

        localStorage.setItem(
          `${queryPrefix}${queryKey}`,
          JSON.stringify({
            data: {
              payload: entry.data.payload,
              items: limitedQuery.itemKeys,
              hasMore: limitedQuery.hasMore,
            },
            timestamp: Date.now(),
            version,
          } satisfies StorageCacheEntry<PersistedListQueryData>),
        );
      }

      return;
    }

    if (!itemNamespace || !queryNamespace) return;

    const sessionKey = config.getSessionKey();
    const protectedStorageKeys =
      sessionKey !== false
        ? await readProtectedStorageKeys(storageAdapter, sessionKey)
        : new Set<string>();
    const isProtectedItemKey =
      sessionKey === false
        ? (_key_: string) => false
        : (key: string) =>
            protectedStorageKeys.has(
              createProtectedStorageRef({
                sessionKey,
                storeName: config.storeName,
                kind: 'listQuery.item',
                key,
              }),
            );
    const keptQueryMetadata = (
      await readAllAsyncStorageMetadata(queryNamespace, { order: 'key' })
    ).filter(
      (entry): entry is AsyncStorageEntryMetadata<PersistedListQueryMetadata> =>
        entry.version === version && keptQueryKeys.has(entry.key),
    );

    const referencedItems = new Set<string>();
    for (const entry of keptQueryMetadata) {
      for (const itemKey of entry.items) {
        referencedItems.add(itemKey);
      }
    }

    const metadataEntries = await readAllAsyncStorageMetadata(itemNamespace, {
      order: 'lru-desc',
    });
    const validEntries = metadataEntries.filter(
      (
        entry,
      ): entry is AsyncStorageEntryMetadata<PersistedListQueryItemMetadata> =>
        entry.version === version,
    );

    const ignoredKeys = validEntries
      .filter((entry) => shouldIgnorePersistedItem(entry.payload))
      .map((entry) => entry.key);
    if (ignoredKeys.length > 0) {
      await itemNamespace.commit({ removes: ignoredKeys });
    }

    const persistedEntries = validEntries.filter(
      (entry) => !shouldIgnorePersistedItem(entry.payload),
    );
    if (!hasIgnoreItemFilter && persistedEntries.length <= maxItems) {
      return;
    }

    persistedEntries.sort((left, right) => {
      const leftProtected = isProtectedItemKey(left.key);
      const rightProtected = isProtectedItemKey(right.key);
      if (leftProtected !== rightProtected) {
        return leftProtected ? -1 : 1;
      }

      const leftPinned = pinnedItemKeys.has(left.key);
      const rightPinned = pinnedItemKeys.has(right.key);
      if (leftPinned !== rightPinned) {
        return leftPinned ? -1 : 1;
      }

      const leftReferenced = referencedItems.has(left.key);
      const rightReferenced = referencedItems.has(right.key);
      if (leftReferenced !== rightReferenced) {
        return leftReferenced ? -1 : 1;
      }

      return right.lastAccessAt - left.lastAccessAt;
    });

    const keptItemKeys = new Set(
      persistedEntries.slice(0, maxItems).map((entry) => entry.key),
    );
    const removals = persistedEntries
      .filter((entry) => !keptItemKeys.has(entry.key))
      .map((entry) => entry.key);
    if (removals.length > 0) {
      await itemNamespace.commit({ removes: removals });
    }

    const queryUpdates: Array<{
      key: string;
      value: PersistedListQueryValue;
      metadata: PersistedListQueryMetadata;
      version: number;
    }> = [];
    for (const queryEntry of keptQueryMetadata) {
      const filteredItems = queryEntry.items.filter((itemKey) =>
        keptItemKeys.has(itemKey),
      );
      const limitedQuery = limitPersistedQueryItems(
        filteredItems,
        queryEntry.hasMore,
        maxQuerySize,
      );
      if (
        limitedQuery.itemKeys.length === queryEntry.items.length &&
        limitedQuery.hasMore === queryEntry.hasMore
      ) {
        continue;
      }

      queryUpdates.push({
        key: queryEntry.key,
        value: {},
        version,
        metadata: {
          payload: queryEntry.payload,
          items: limitedQuery.itemKeys,
          hasMore: limitedQuery.hasMore,
        },
      });
    }

    if (queryUpdates.length > 0) {
      await queryNamespace.commit({ upserts: queryUpdates });
    }
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    const state = storeRef.state;

    if (backend === 'localStorage') {
      const sessionKey = config.getSessionKey();
      if (sessionKey === false) return;

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
      const tasks: Promise<void>[] = [];
      const queryReferencedItemKeys = new Set<string>();
      const persistedQueryItemKeys = new Set<string>();

      for (const query of Object.values(state.queries)) {
        for (const itemKey of query.items) {
          queryReferencedItemKeys.add(itemKey);
        }
      }

      for (const [queryKey, query] of Object.entries(state.queries)) {
        const storageKey = `${queryPrefix}${queryKey}`;

        if (!query || (query.status !== 'success' && !query.wasLoaded)) {
          tasks.push(Promise.resolve(localStorage.removeItem(storageKey)));
          continue;
        }

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
          Promise.resolve(
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                data: {
                  payload: query.payload,
                  items: limitedQuery.itemKeys,
                  hasMore: limitedQuery.hasMore,
                },
                timestamp: Date.now(),
                version,
              } satisfies StorageCacheEntry<PersistedListQueryData>),
            ),
          ),
        );
      }

      for (const [itemKey, item] of Object.entries(state.items)) {
        const itemQuery = state.itemQueries[itemKey];
        const storageKey = `${itemPrefix}${itemKey}`;

        if (
          item === null ||
          item === undefined ||
          itemQuery === null ||
          itemQuery === undefined
        ) {
          tasks.push(Promise.resolve(localStorage.removeItem(storageKey)));
          continue;
        }
        if (shouldIgnoreItem(itemQuery.payload)) {
          tasks.push(Promise.resolve(localStorage.removeItem(storageKey)));
          continue;
        }
        if (
          queryReferencedItemKeys.has(itemKey) &&
          !persistedQueryItemKeys.has(itemKey)
        ) {
          tasks.push(Promise.resolve(localStorage.removeItem(storageKey)));
          continue;
        }

        tasks.push(
          Promise.resolve(
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                data: {
                  data: item,
                  payload: itemQuery.payload,
                  loadedFields: state.itemLoadedFields[itemKey],
                },
                timestamp: Date.now(),
                version,
              } satisfies StorageCacheEntry<
                PersistedListQueryItemData<ItemState>
              >),
            ),
          ),
        );
      }

      for (const queryKey of deletedQueryKeys) {
        tasks.push(
          Promise.resolve(localStorage.removeItem(`${queryPrefix}${queryKey}`)),
        );
      }

      for (const itemKey of deletedItemKeys) {
        tasks.push(
          Promise.resolve(localStorage.removeItem(`${itemPrefix}${itemKey}`)),
        );
      }

      dirtyItemKeys.clear();
      dirtyQueryKeys.clear();
      deletedItemKeys.clear();
      deletedQueryKeys.clear();
      await Promise.all(tasks);
      const keptQueryKeys = await evictStoredQueries();
      await evictStoredItems(keptQueryKeys);
      return;
    }

    if (!itemNamespace || !queryNamespace) return;

    const { rawQueryRefCount, persistedQueryRefCount } = buildReferenceIndexes(
      state,
      shouldIgnoreItem,
      maxQuerySize,
    );
    const queryKeysToFlush = new Set([...dirtyQueryKeys, ...deletedQueryKeys]);
    const itemKeysToFlush = new Set([...dirtyItemKeys, ...deletedItemKeys]);
    const queryUpserts: Array<{
      key: string;
      value: PersistedListQueryValue;
      version: number;
      metadata: PersistedListQueryMetadata;
    }> = [];
    const itemUpserts: Array<{
      key: string;
      value: PersistedListQueryItemValue<ItemState>;
      version: number;
      metadata: PersistedListQueryItemMetadata;
    }> = [];
    const queryRemoves = new Set<string>(deletedQueryKeys);
    const itemRemoves = new Set<string>(deletedItemKeys);

    dirtyItemKeys.clear();
    dirtyQueryKeys.clear();
    deletedItemKeys.clear();
    deletedQueryKeys.clear();

    for (const queryKey of queryKeysToFlush) {
      const query = state.queries[queryKey];
      if (!query || (query.status !== 'success' && !query.wasLoaded)) {
        queryRemoves.add(queryKey);
        continue;
      }

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
      queryRemoves.delete(queryKey);
      queryUpserts.push({
        key: queryKey,
        value: {},
        version,
        metadata: {
          payload: query.payload,
          items: limitedQuery.itemKeys,
          hasMore: limitedQuery.hasMore,
        },
      });
    }

    for (const itemKey of itemKeysToFlush) {
      const item = state.items[itemKey];
      const itemQuery = state.itemQueries[itemKey];

      if (
        item === null ||
        item === undefined ||
        itemQuery === null ||
        itemQuery === undefined
      ) {
        itemRemoves.add(itemKey);
        continue;
      }
      if (shouldIgnoreItem(itemQuery.payload)) {
        itemRemoves.add(itemKey);
        continue;
      }
      if (
        (rawQueryRefCount.get(itemKey) ?? 0) > 0 &&
        (persistedQueryRefCount.get(itemKey) ?? 0) === 0
      ) {
        itemRemoves.add(itemKey);
        continue;
      }

      itemRemoves.delete(itemKey);
      itemUpserts.push({
        key: itemKey,
        value: { data: item, loadedFields: state.itemLoadedFields[itemKey] },
        version,
        metadata: { payload: itemQuery.payload },
      });
    }

    await Promise.all([
      queryNamespace.commit({
        upserts: queryUpserts,
        removes: [...queryRemoves],
      }),
      itemNamespace.commit({ upserts: itemUpserts, removes: [...itemRemoves] }),
    ]);
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
      if (!previous) {
        schedulePersistedStateFlush();
        return;
      }

      const queryKeys = new Set([
        ...Object.keys(previous.queries),
        ...Object.keys(current.queries),
      ]);
      for (const queryKey of queryKeys) {
        const previousQuery = previous.queries[queryKey];
        const currentQuery = current.queries[queryKey];
        if (samePersistedQueryProjection(currentQuery, previousQuery)) {
          continue;
        }

        dirtyQueryKeys.add(queryKey);
        if (!currentQuery) {
          deletedQueryKeys.add(queryKey);
        } else {
          deletedQueryKeys.delete(queryKey);
        }

        for (const itemKey of previousQuery?.items ?? []) {
          dirtyItemKeys.add(itemKey);
        }
        for (const itemKey of currentQuery?.items ?? []) {
          dirtyItemKeys.add(itemKey);
        }
      }

      const itemKeys = new Set([
        ...Object.keys(previous.items),
        ...Object.keys(current.items),
        ...Object.keys(previous.itemQueries),
        ...Object.keys(current.itemQueries),
      ]);
      for (const itemKey of itemKeys) {
        if (
          current.items[itemKey] === previous.items[itemKey] &&
          current.itemQueries[itemKey] === previous.itemQueries[itemKey] &&
          arraysEqual(
            current.itemLoadedFields[itemKey],
            previous.itemLoadedFields[itemKey],
          )
        ) {
          continue;
        }

        dirtyItemKeys.add(itemKey);
        if (
          current.items[itemKey] === null ||
          current.itemQueries[itemKey] === null ||
          current.itemQueries[itemKey] === undefined
        ) {
          deletedItemKeys.add(itemKey);
        } else {
          deletedItemKeys.delete(itemKey);
        }
      }

      if (
        dirtyItemKeys.size > 0 ||
        dirtyQueryKeys.size > 0 ||
        deletedItemKeys.size > 0 ||
        deletedQueryKeys.size > 0
      ) {
        schedulePersistedStateFlush();
      }
    });
  }

  function dispose(): void {
    generation++;
    pendingItemPreloads.clear();
    pendingQueryPreloads.clear();
    dirtyItemKeys.clear();
    dirtyQueryKeys.clear();
    deletedItemKeys.clear();
    deletedQueryKeys.clear();
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

      for (const key of listLocalStorageKeysSync(itemPrefix)) {
        localStorage.removeItem(key);
      }
      for (const key of listLocalStorageKeysSync(queryPrefix)) {
        localStorage.removeItem(key);
      }
      return;
    }

    await Promise.all([itemNamespace?.clear(), queryNamespace?.clear()]);
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    maybeHydrateQueries,
    preloadItems,
    preloadQueries,
    hasAsyncPreload:
      backend === 'opfs' && isAsyncStorageAdapter(storageAdapter),
    dispose,
    clear,
  };
}
