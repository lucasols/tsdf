import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  rc_array,
  rc_boolean,
  rc_object,
  rc_string,
  rc_unknown,
} from 'runcheck';
import type { Store } from 't-state';
import type {
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
} from '../listQueryStore/types';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  getManagedLocalStorageRootKeyForPrefix,
  readManagedLocalStorageManifestEntriesByPrefix,
  registerManagedLocalStorageMaintenanceCallback,
  runManagedLocalStorageMaintenance,
  setManagedLocalStorageRootNeedsMaintenance,
  unregisterManagedLocalStorageMaintenanceCallback,
} from './localStorageMetadata';
import {
  createPersistentStorageNamespaceHandle,
  getStoragePrefixForStoreNamespace,
  listLocalStorageKeysSync,
  readProtectedStorageKeys,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { localPersistentStorage } from './storageAdapter';
import type {
  ListQueryPersistentStorageConfig,
  PersistedListQueryData,
  PersistedListQueryItemData,
} from './types';
import { validateWithSchema } from './validateWithSchema';

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_MAX_QUERIES = 100;
const DEFAULT_MAX_QUERY_SIZE = 100;
const SAVE_DEBOUNCE_MS = 1000;

const listQueryItemManifestMetaSchema = rc_object({
  payload: rc_unknown.optionalKey(),
});

const listQueryQueryManifestMetaSchema = rc_object({
  payload: rc_unknown.optionalKey(),
  items: rc_array(rc_string).withFallback([]).optionalKey(),
  hasMore: rc_boolean.withFallback(false).optionalKey(),
});

function readManifestPayload(meta: unknown): unknown {
  return listQueryItemManifestMetaSchema.parse(meta).unwrapOrNull()?.payload;
}

type QueryManifestMeta = {
  payload: unknown;
  items: string[];
  hasMore: boolean;
};

function readQueryManifestMeta(meta: unknown): QueryManifestMeta {
  const parsed = listQueryQueryManifestMetaSchema.parse(meta).unwrapOrNull();
  if (!parsed) {
    return { payload: undefined, items: [], hasMore: false };
  }

  return {
    payload: parsed.payload,
    items: parsed.items ?? [],
    hasMore: parsed.hasMore === true,
  };
}

type ManagedQueryEntry = QueryManifestMeta & {
  queryKey: string;
  lastAccessAt: number;
};

type ManagedQueryEntriesByKey = Map<string, ManagedQueryEntry>;

function readManagedQueryEntriesByKey(
  enabled: boolean,
  queryPrefix: string | null | false,
): ManagedQueryEntriesByKey | null {
  if (!enabled || !queryPrefix) return null;

  return new Map(
    readManagedLocalStorageManifestEntriesByPrefix(queryPrefix).map((entry) => {
      const queryMeta = readQueryManifestMeta(entry.meta);

      return [
        entry.entryKey,
        {
          queryKey: entry.entryKey,
          lastAccessAt: entry.lastAccessAt,
          ...queryMeta,
        },
      ];
    }),
  );
}

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
  onHydrated: (
    itemKey: string,
    persisted: PersistedListQueryItemData<unknown>,
  ) => void,
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
    onHydrated(itemKey, cacheEntry.data);

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
  onHydrated: (queryKey: string, persisted: PersistedListQueryData) => void,
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
      onHydrated(queryKey, cacheEntry.data);

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
    getItemKey?: (payload: ItemPayload) => string;
    getQueryKey?: (payload: QueryPayload) => string;
  } = {},
): ListQueryPersistenceSetup<ItemState, QueryPayload, ItemPayload> {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  const version = config.version ?? 1;
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
  const storageAdapter = config.adapter;
  const usesManagedLocalStorage = storageAdapter === localPersistentStorage;
  const persistentConfig = config;

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState>
  >(
    { ...persistentConfig, entryPrefix: 'listQuery.item' },
    {
      getManifestMeta: (data) => ({ payload: data.payload }),
    },
  );
  const queryNamespace =
    createPersistentStorageNamespaceHandle<PersistedListQueryData>(
      { ...persistentConfig, entryPrefix: 'listQuery.query' },
      {
        getManifestMeta: (data) => ({
          payload: data.payload,
          items: data.items,
          hasMore: data.hasMore,
        }),
      },
    );

  let storeRef: Store<State> | null = null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const pendingItemPreloads = new Map<string, Promise<boolean>>();
  const pendingQueryPreloads = new Map<string, Promise<boolean>>();
  const itemSnapshotByKey = new Map<string, string>();
  const querySnapshotByKey = new Map<string, string>();
  const hydratedPersistedItemKeys = new Set<string>();
  const hydratedPersistedQueryKeys = new Set<string>();
  let knownPersistedItemKeys: Set<string> | null = null;
  let knownPersistedQueryKeys: Set<string> | null = null;
  let maintenanceRootKey: string | null = null;

  function clearSaveTimer(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function getItemPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    return getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      'listQuery.item',
    );
  }

  function getQueryPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    return getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      'listQuery.query',
    );
  }

  function syncMaintenanceRegistration(): void {
    if (!usesManagedLocalStorage) return;

    const queryPrefix = getQueryPrefix();
    if (queryPrefix === false) return;

    const nextRootKey = getManagedLocalStorageRootKeyForPrefix(queryPrefix);
    if (maintenanceRootKey === nextRootKey) return;

    if (maintenanceRootKey !== null) {
      unregisterManagedLocalStorageMaintenanceCallback(maintenanceRootKey);
    }

    maintenanceRootKey = nextRootKey;
    registerManagedLocalStorageMaintenanceCallback(
      maintenanceRootKey,
      async () => {
        const { keptQueryKeys, managedQueryEntriesByKey } =
          await evictStoredQueries();
        await evictStoredItems(keptQueryKeys, managedQueryEntriesByKey);
      },
    );
  }

  async function ensureKnownPersistedItemKeys(): Promise<Set<string>> {
    if (knownPersistedItemKeys !== null) return knownPersistedItemKeys;

    knownPersistedItemKeys = new Set(await itemNamespace.listKeys());
    return knownPersistedItemKeys;
  }

  async function ensureKnownPersistedQueryKeys(): Promise<Set<string>> {
    if (knownPersistedQueryKeys !== null) return knownPersistedQueryKeys;

    knownPersistedQueryKeys = new Set(await queryNamespace.listKeys());
    return knownPersistedQueryKeys;
  }

  function createInitialState(baseState: State): State {
    if (storageAdapter.kind !== 'sync') return baseState;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return baseState;

    const itemPrefix = getItemPrefix();
    const queryPrefix = getQueryPrefix();
    if (itemPrefix === false || queryPrefix === false) return baseState;
    syncMaintenanceRegistration();

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
        (hydratedItemKey, persisted) => {
          hydratedPersistedItemKeys.add(hydratedItemKey);
          itemSnapshotByKey.set(hydratedItemKey, JSON.stringify(persisted));
        },
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
        (hydratedQueryKey, persisted) => {
          hydratedPersistedQueryKeys.add(hydratedQueryKey);
          querySnapshotByKey.set(hydratedQueryKey, JSON.stringify(persisted));
        },
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

    if (storageAdapter.kind === 'sync') {
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
        cacheEntry.data,
        config,
        shouldIgnorePersistedItem,
      );
      if (!itemState) {
        scheduleIdleCleanup(() => localStorage.removeItem(storageKey));
        return false;
      }

      scheduleIdleCleanup(() => refreshLocalStorageTimestamp(storageKey));
      hydratedPersistedItemKeys.add(itemKey);
      itemSnapshotByKey.set(itemKey, JSON.stringify(cacheEntry.data));

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

        const itemState = toItemState<ItemState, QueryPayload, ItemPayload>(
          cached,
          config,
          shouldIgnorePersistedItem,
        );
        if (!itemState) {
          scheduleIdleCleanup(() => void itemNamespace.remove(itemKey));
          return false;
        }

        hydratedPersistedItemKeys.add(itemKey);
        itemSnapshotByKey.set(itemKey, JSON.stringify(cached));

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
    if (storageAdapter.kind === 'sync') return itemKeys.map(() => false);
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function preloadQuery(queryKey: string): Promise<boolean> {
    if (!storeRef) return false;
    if (storeRef.state.queries[queryKey] !== undefined) {
      return true;
    }

    if (storageAdapter.kind === 'sync') {
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
      hydratedPersistedQueryKeys.add(queryKey);
      querySnapshotByKey.set(queryKey, JSON.stringify(cacheEntry.data));

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
        hydratedPersistedQueryKeys.add(queryKey);
        querySnapshotByKey.set(queryKey, JSON.stringify(cached));

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
        const limitedQuery = limitPersistedQueryItems(
          filteredItemKeys,
          cached.hasMore,
          maxQuerySize,
        );

        activeStore.produceState(
          (draft) => {
            if (draft.queries[queryKey] === undefined) {
              draft.queries[queryKey] = {
                error: null,
                hasMore: limitedQuery.hasMore,
                items: limitedQuery.itemKeys,
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
    if (storageAdapter.kind === 'sync') return queryKeys.map(() => false);
    return Promise.all(queryKeys.map((queryKey) => preloadQuery(queryKey)));
  }

  async function maybeHydrateItems(itemKeys: string[]): Promise<boolean[]> {
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function maybeHydrateQueries(queryKeys: string[]): Promise<boolean[]> {
    return Promise.all(queryKeys.map((queryKey) => preloadQuery(queryKey)));
  }

  async function evictStoredQueries(): Promise<{
    keptQueryKeys: Set<string>;
    managedQueryEntriesByKey: ManagedQueryEntriesByKey | null;
  }> {
    syncMaintenanceRegistration();
    const sessionKey = config.getSessionKey();
    const protectedStorageKeys =
      sessionKey !== false
        ? await readProtectedStorageKeys(storageAdapter, sessionKey)
        : new Set<string>();
    const queryPrefix =
      sessionKey === false
        ? null
        : getStoragePrefixForStoreNamespace(
            sessionKey,
            config.storeName,
            'listQuery.query',
          );
    const protectedQueryKeys =
      queryPrefix === null
        ? new Set<string>()
        : new Set(
            [...protectedStorageKeys]
              .filter((key) => key.startsWith(queryPrefix))
              .map((key) => key.slice(queryPrefix.length)),
          );
    const managedQueryEntriesByKey = readManagedQueryEntriesByKey(
      usesManagedLocalStorage,
      queryPrefix,
    );
    const validEntries: Array<{
      queryKey: string;
      payload: unknown;
      items: string[];
      hasMore: boolean;
      lastAccessAt: number;
    }> = managedQueryEntriesByKey
      ? [...managedQueryEntriesByKey.values()]
      : filterAndMap(
            await Promise.all(
              (await queryNamespace.listKeys()).map(async (queryKey) => ({
                queryKey,
                entry: await queryNamespace.readEntry(queryKey),
              })),
            ),
            ({ queryKey, entry }) => {
              return entry
                ? {
                    queryKey,
                    payload: entry.data.payload,
                    items: entry.data.items,
                    hasMore: entry.data.hasMore,
                    lastAccessAt: entry.timestamp,
                  }
                : false;
            },
          );

    validEntries.sort((a, b) => {
      const aProtected = protectedQueryKeys.has(a.queryKey);
      const bProtected = protectedQueryKeys.has(b.queryKey);

      if (aProtected && !bProtected) return -1;
      if (!aProtected && bProtected) return 1;

      const aPinned = pinnedQueryKeys.has(a.queryKey);
      const bPinned = pinnedQueryKeys.has(b.queryKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      return b.lastAccessAt - a.lastAccessAt;
    });

    const keptQueryKeys = new Set(
      validEntries.slice(0, maxQueries).map(({ queryKey }) => queryKey),
    );

    await Promise.all(
      validEntries
        .filter(({ queryKey }) => !keptQueryKeys.has(queryKey))
        .map(({ queryKey }) => queryNamespace.remove(queryKey)),
    );

    for (const { queryKey } of validEntries) {
      if (!keptQueryKeys.has(queryKey)) {
        querySnapshotByKey.delete(queryKey);
      }
    }

    knownPersistedQueryKeys = keptQueryKeys;

    return { keptQueryKeys, managedQueryEntriesByKey };
  }

  async function evictStoredItems(
    keptQueryKeys: Set<string>,
    managedQueryEntriesByKey: ManagedQueryEntriesByKey | null,
  ): Promise<void> {
    syncMaintenanceRegistration();
    const sessionKey = config.getSessionKey();
    const protectedStorageKeys =
      sessionKey !== false
        ? await readProtectedStorageKeys(storageAdapter, sessionKey)
        : new Set<string>();
    const itemPrefix =
      sessionKey === false
        ? null
        : getStoragePrefixForStoreNamespace(
            sessionKey,
            config.storeName,
            'listQuery.item',
          );
    const queryPrefix = getQueryPrefix();
    const protectedItemKeys =
      itemPrefix === null
        ? new Set<string>()
        : new Set(
            [...protectedStorageKeys]
              .filter((key) => key.startsWith(itemPrefix))
              .map((key) => key.slice(itemPrefix.length)),
          );
    const referencedItems = new Set<string>();
    const queryEntriesByKey =
      managedQueryEntriesByKey ??
      readManagedQueryEntriesByKey(usesManagedLocalStorage, queryPrefix);
    const queryEntries: Array<{ items: string[] }> = queryEntriesByKey
      ? [...queryEntriesByKey.values()]
          .filter(({ queryKey }) => keptQueryKeys.has(queryKey))
          .map(({ items }) => ({ items }))
      : filterAndMap(
            await Promise.all(
              [...keptQueryKeys].map(async (queryKey) => ({
                queryKey,
                entry: await queryNamespace.readEntry(queryKey),
              })),
            ),
            ({ entry }) => {
              return entry ? { items: entry.data.items } : false;
            },
          );

    for (const entry of queryEntries) {
      const itemKeys = entry.items;

      for (const itemKey of itemKeys) {
        referencedItems.add(itemKey);
      }
    }

    const itemKeys = await itemNamespace.listKeys();
    if (!hasIgnoreItemFilter && itemKeys.length <= maxItems) return;
    const validItemEntries: Array<{
      itemKey: string;
      payload: unknown;
      lastAccessAt: number;
    }> =
      usesManagedLocalStorage && itemPrefix !== null
        ? readManagedLocalStorageManifestEntriesByPrefix(itemPrefix).map(
            (entry) => ({
              itemKey: entry.entryKey,
              payload: readManifestPayload(entry.meta),
              lastAccessAt: entry.lastAccessAt,
            }),
          )
        : filterAndMap(
            await Promise.all(
              itemKeys.map(async (itemKey) => ({
                itemKey,
                entry: await itemNamespace.readEntry(itemKey),
              })),
            ),
            ({ itemKey, entry }) => {
              return entry
                ? {
                    itemKey,
                    payload: entry.data.payload,
                    lastAccessAt: entry.timestamp,
                  }
                : false;
            },
          );

    const ignoredItemEntries = validItemEntries.filter(({ payload }) =>
      shouldIgnorePersistedItem(payload),
    );

    if (ignoredItemEntries.length > 0) {
      await Promise.all(
        ignoredItemEntries.map(({ itemKey }) => itemNamespace.remove(itemKey)),
      );
      for (const { itemKey } of ignoredItemEntries) {
        itemSnapshotByKey.delete(itemKey);
      }
    }

    const persistedItemEntries = validItemEntries.filter(
      ({ payload }) => !shouldIgnorePersistedItem(payload),
    );

    persistedItemEntries.sort((a, b) => {
      const aProtected = protectedItemKeys.has(a.itemKey);
      const bProtected = protectedItemKeys.has(b.itemKey);

      if (aProtected && !bProtected) return -1;
      if (!aProtected && bProtected) return 1;

      const aPinned = pinnedItemKeys.has(a.itemKey);
      const bPinned = pinnedItemKeys.has(b.itemKey);

      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;

      const aReferenced = referencedItems.has(a.itemKey);
      const bReferenced = referencedItems.has(b.itemKey);

      if (aReferenced && !bReferenced) return -1;
      if (!aReferenced && bReferenced) return 1;

      return b.lastAccessAt - a.lastAccessAt;
    });

    const keptItemKeys = new Set(
      persistedItemEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
    );

    await Promise.all(
      persistedItemEntries
        .filter(({ itemKey }) => !keptItemKeys.has(itemKey))
        .map(({ itemKey }) => itemNamespace.remove(itemKey)),
    );
    for (const { itemKey } of persistedItemEntries) {
      if (!keptItemKeys.has(itemKey)) {
        itemSnapshotByKey.delete(itemKey);
      }
    }

    knownPersistedItemKeys = keptItemKeys;

    await Promise.all(
      [...keptQueryKeys].map(async (queryKey) => {
        const queryData =
          queryEntriesByKey?.get(queryKey) ?? (await queryNamespace.load(queryKey));
        if (!queryData) return;

        const filteredItems = queryData.items.filter((itemKey) =>
          keptItemKeys.has(itemKey),
        );
        const limitedQuery = limitPersistedQueryItems(
          filteredItems,
          queryData.hasMore,
          maxQuerySize,
        );

        if (
          limitedQuery.itemKeys.length === queryData.items.length &&
          limitedQuery.hasMore === queryData.hasMore
        ) {
          return;
        }

        await queryNamespace.save(queryKey, {
          ...queryData,
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
    const previousItemKeys = await ensureKnownPersistedItemKeys();
    const previousQueryKeys = await ensureKnownPersistedQueryKeys();
    const nextItemKeys = new Set<string>();
    const nextQueryKeys = new Set<string>();
    const removedItemKeys = new Set<string>();
    const removedQueryKeys = new Set<string>();
    const queryReferencedItemKeys = new Set<string>();
    const persistedQueryItemKeys = new Set<string>();
    syncMaintenanceRegistration();

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

      nextQueryKeys.add(queryKey);
      const nextValue = {
        payload: query.payload,
        items: limitedQuery.itemKeys,
        hasMore: limitedQuery.hasMore,
      };
      const nextSnapshot = JSON.stringify(nextValue);
      if (
        querySnapshotByKey.get(queryKey) === nextSnapshot &&
        previousQueryKeys.has(queryKey)
      ) {
        continue;
      }

      querySnapshotByKey.set(queryKey, nextSnapshot);
      hydratedPersistedQueryKeys.add(queryKey);
      tasks.push(queryNamespace.save(queryKey, nextValue));
    }

    for (const queryKey of previousQueryKeys) {
      if (nextQueryKeys.has(queryKey)) continue;
      if (!hydratedPersistedQueryKeys.has(queryKey)) continue;

      tasks.push(queryNamespace.remove(queryKey));
      querySnapshotByKey.delete(queryKey);
      hydratedPersistedQueryKeys.delete(queryKey);
      removedQueryKeys.add(queryKey);
    }

    for (const [itemKey, item] of Object.entries(state.items)) {
      const itemQuery = state.itemQueries[itemKey];

      if (item === null || itemQuery === null || itemQuery === undefined) {
        if (
          previousItemKeys.has(itemKey) &&
          hydratedPersistedItemKeys.has(itemKey)
        ) {
          tasks.push(itemNamespace.remove(itemKey));
          itemSnapshotByKey.delete(itemKey);
          hydratedPersistedItemKeys.delete(itemKey);
          removedItemKeys.add(itemKey);
        }
        continue;
      }

      if (shouldIgnoreItem(itemQuery.payload)) {
        if (
          previousItemKeys.has(itemKey) &&
          hydratedPersistedItemKeys.has(itemKey)
        ) {
          tasks.push(itemNamespace.remove(itemKey));
          itemSnapshotByKey.delete(itemKey);
          hydratedPersistedItemKeys.delete(itemKey);
          removedItemKeys.add(itemKey);
        }
        continue;
      }

      const isQueryReferenced = queryReferencedItemKeys.has(itemKey);
      if (isQueryReferenced && !persistedQueryItemKeys.has(itemKey)) {
        if (
          previousItemKeys.has(itemKey) &&
          hydratedPersistedItemKeys.has(itemKey)
        ) {
          tasks.push(itemNamespace.remove(itemKey));
          itemSnapshotByKey.delete(itemKey);
          hydratedPersistedItemKeys.delete(itemKey);
          removedItemKeys.add(itemKey);
        }
        continue;
      }

      nextItemKeys.add(itemKey);
      const nextValue = {
        data: item,
        payload: itemQuery.payload,
        loadedFields: state.itemLoadedFields[itemKey],
      };
      const nextSnapshot = JSON.stringify(nextValue);
      if (
        itemSnapshotByKey.get(itemKey) === nextSnapshot &&
        previousItemKeys.has(itemKey)
      ) {
        continue;
      }

      itemSnapshotByKey.set(itemKey, nextSnapshot);
      hydratedPersistedItemKeys.add(itemKey);
      tasks.push(itemNamespace.save(itemKey, nextValue));
    }

    for (const itemKey of previousItemKeys) {
      if (nextItemKeys.has(itemKey)) continue;
      if (!hydratedPersistedItemKeys.has(itemKey)) continue;

      tasks.push(itemNamespace.remove(itemKey));
      itemSnapshotByKey.delete(itemKey);
      hydratedPersistedItemKeys.delete(itemKey);
      removedItemKeys.add(itemKey);
    }

    await Promise.all(tasks);
    knownPersistedItemKeys = new Set(previousItemKeys);
    for (const itemKey of removedItemKeys) {
      knownPersistedItemKeys.delete(itemKey);
    }
    for (const itemKey of nextItemKeys) {
      knownPersistedItemKeys.add(itemKey);
    }
    knownPersistedQueryKeys = new Set(previousQueryKeys);
    for (const queryKey of removedQueryKeys) {
      knownPersistedQueryKeys.delete(queryKey);
    }
    for (const queryKey of nextQueryKeys) {
      knownPersistedQueryKeys.add(queryKey);
    }

    if (usesManagedLocalStorage && maintenanceRootKey !== null) {
      const needsMaintenance =
        hasIgnoreItemFilter ||
        knownPersistedItemKeys.size > maxItems ||
        knownPersistedQueryKeys.size > maxQueries;
      setManagedLocalStorageRootNeedsMaintenance(
        maintenanceRootKey,
        needsMaintenance,
      );
      if (needsMaintenance) {
        await runManagedLocalStorageMaintenance();
      }
      return;
    }

    const { keptQueryKeys, managedQueryEntriesByKey } =
      await evictStoredQueries();
    await evictStoredItems(keptQueryKeys, managedQueryEntriesByKey);
  }

  function schedulePersistedStateFlush(): void {
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPersistedState();
    }, SAVE_DEBOUNCE_MS);
  }

  function attach(store: Store<State>): void {
    syncMaintenanceRegistration();
    storeRef = store;
    unsubscribe = store.subscribe(() => {
      schedulePersistedStateFlush();
    });
  }

  function dispose(): void {
    generation++;
    pendingItemPreloads.clear();
    pendingQueryPreloads.clear();
    hydratedPersistedItemKeys.clear();
    hydratedPersistedQueryKeys.clear();
    knownPersistedItemKeys = null;
    knownPersistedQueryKeys = null;
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    if (maintenanceRootKey !== null) {
      unregisterManagedLocalStorageMaintenanceCallback(maintenanceRootKey);
      maintenanceRootKey = null;
    }
    itemNamespace.dispose();
    queryNamespace.dispose();
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    knownPersistedItemKeys = null;
    knownPersistedQueryKeys = null;
    itemSnapshotByKey.clear();
    querySnapshotByKey.clear();
    hydratedPersistedItemKeys.clear();
    hydratedPersistedQueryKeys.clear();
    await Promise.all([itemNamespace.clear(), queryNamespace.clear()]);
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    maybeHydrateQueries,
    preloadItems,
    preloadQueries,
    hasAsyncPreload: storageAdapter.kind === 'async',
    dispose,
    clear,
  };
}
