import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
} from '../listQueryStore/types';
import {
  createCompactListQueryLocalStorageEntry,
  parseCompactListQueryLocalStorageEntry,
} from './compactListQueryLocalStorageEntry';
import type {
  AnyOfflineOperationDefinition,
  ListQueryOfflineEntityRef,
} from './offline/types';
import { hasOwnEntry } from '../utils/hasOwnEntry';
import { readOwnMaterializedValue } from '../utils/readOwnMaterializedValue';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedListQueryData,
  parsePersistedListQueryItemData,
  parsePersistedStoreData,
  type NormalizedPersistentStorageDataSchema,
  type ParsedPersistedListQueryData,
  type ParsedPersistedListQueryItemData,
} from './parsePersistedData';
import {
  assertValidPersistentStoreName,
  createPersistentStorageNamespaceHandle,
  getLocalStorageMaxAgeMs,
  getLocalStorageAdapter,
  mergeLocalStorageOfflineProtection,
  recordLocalStorageTouch,
  getStoragePrefixForStoreNamespace,
  readManifestPayloadMeta,
  readProtectedStorageKeys,
  scheduleLocalStorageRemoval,
  scheduleLocalStorageMaintenance,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
  touchLocalStorageKeyWithThrottle,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import {
  LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX,
  LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX,
} from './storageEntryPrefixes';
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

type ListQueryPersistenceOfflineOperations<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
> =
  | (Record<
      string,
      AnyOfflineOperationDefinition & {
        getEntityRefs: (ctx: {
          input: __LEGIT_ANY__;
        }) => ListQueryOfflineEntityRef<ItemPayload>[];
      }
    > &
      ([ItemState | QueryPayload | ItemPayload] extends [never]
        ? never
        : unknown))
  | null;

type ManagedQueryEntry = {
  hasMore: boolean;
  items: string[];
  lastAccessAt: number;
  offlineProtected: boolean;
  payload: unknown;
  queryKey: string;
};

type ManagedQueryEntriesByKey = Map<string, ManagedQueryEntry>;

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

function materializeRecordEntry<Value>(
  record: Record<string, Value>,
  key: string,
  value: Value,
): Record<string, Value> {
  return { ...record, [key]: value };
}

function materializeListQueryItemState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  itemKey: string,
  itemState: {
    item: ItemState;
    itemQuery: TSDFItemQuery<ItemPayload>;
    loadedFields: string[];
  },
): TSFDListQueryState<ItemState, QueryPayload, ItemPayload> {
  return {
    ...state,
    items: materializeRecordEntry(state.items, itemKey, itemState.item),
    itemQueries: materializeRecordEntry(
      state.itemQueries,
      itemKey,
      itemState.itemQuery,
    ),
    itemLoadedFields: materializeRecordEntry(
      state.itemLoadedFields,
      itemKey,
      itemState.loadedFields,
    ),
  };
}

function materializeListQueryQueryState<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
>(
  state: TSFDListQueryState<ItemState, QueryPayload, ItemPayload>,
  queryKey: string,
  query: TSFDListQuery<QueryPayload>,
): TSFDListQueryState<ItemState, QueryPayload, ItemPayload> {
  return {
    ...state,
    queries: materializeRecordEntry(state.queries, queryKey, query),
  };
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
  getHydratedItemKeys(this: void): string[];
  getHydratedQueryKeys(this: void): string[];
  readHydratedItem(
    this: void,
    itemKey: string,
  ):
    | {
        item: ItemState;
        itemQuery: TSDFItemQuery<ItemPayload>;
        loadedFields: string[];
      }
    | undefined;
  readHydratedQuery(
    this: void,
    queryKey: string,
  ): TSFDListQuery<QueryPayload> | undefined;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

export function setupListQueryPersistence<
  ItemState extends ValidStoreState,
  QueryPayload extends ValidPayload,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends ListQueryPersistenceOfflineOperations<
    ItemState,
    QueryPayload,
    ItemPayload
  > = null,
  StorageState = unknown,
>(
  config: ListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload,
    StorageState,
    TOfflineOperations
  > & { getSessionKey: () => string | false },
  options: {
    getItemKey?: (payload: ItemPayload) => string;
    getQueryKey?: (payload: QueryPayload) => string;
  } = {},
): ListQueryPersistenceSetup<ItemState, QueryPayload, ItemPayload> {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  assertValidPersistentStoreName(config.storeName);

  const version = config.version;
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
  const storageAdapter = config.adapter;
  const localStorageAdapter = getLocalStorageAdapter(storageAdapter);
  const persistentConfig = config;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState | StorageState>
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX },
    { getManifestMeta: (data) => ({ p: data.payload }) },
  );
  const queryNamespace =
    createPersistentStorageNamespaceHandle<PersistedListQueryData>({
      ...persistentConfig,
      entryPrefix: LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX,
    });

  let storeRef: Store<State> | null = null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressedPersistedStateFlushes = 0;
  const pendingItemPreloads = new Map<string, Promise<boolean>>();
  const pendingQueryPreloads = new Map<string, Promise<boolean>>();
  const itemSnapshotByKey = new Map<string, string>();
  const querySnapshotByKey = new Map<string, string>();
  const hydratedPersistedItemKeys = new Set<string>();
  const hydratedPersistedQueryKeys = new Set<string>();
  let knownPersistedItemKeys: Set<string> | null = null;
  let knownPersistedQueryKeys: Set<string> | null = null;
  let maintenanceCallbackKey: string | null = null;

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
      LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX,
    );
  }

  function getQueryPrefix(): string | false {
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return false;

    return getStoragePrefixForStoreNamespace(
      sessionKey,
      config.storeName,
      LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX,
    );
  }

  function getLocalStorageQueryStorageKey(queryKey: string): string | false {
    const prefix = getQueryPrefix();
    if (prefix === false) return false;

    return `${prefix}${queryKey}`;
  }

  function readLocalStorageQueryEntry(
    queryKey: string,
  ): ManagedQueryEntry | undefined {
    if (localStorageAdapter === null) return undefined;

    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false) return undefined;

    const entry = parseCompactListQueryLocalStorageEntry(
      localStorageAdapter.readRaw(storageKey),
    );
    if (entry === null || entry.version !== version) {
      return undefined;
    }

    return {
      queryKey,
      payload: entry.payload,
      items: entry.items,
      hasMore: entry.hasMore,
      lastAccessAt: entry.lastAccessAt,
      offlineProtected: entry.offlineProtected,
    };
  }

  function scanLocalStorageQueryEntries(): {
    entriesByKey: ManagedQueryEntriesByKey;
    invalidQueryKeys: string[];
  } | null {
    if (localStorageAdapter === null) return null;

    const queryPrefix = getQueryPrefix();
    if (queryPrefix === false) return null;

    const entriesByKey: ManagedQueryEntriesByKey = new Map();
    const invalidQueryKeys: string[] = [];

    for (const storageKey of localStorageAdapter.listRawKeys(queryPrefix)) {
      const queryKey = storageKey.slice(queryPrefix.length);
      const entry = readLocalStorageQueryEntry(queryKey);
      if (!entry) {
        invalidQueryKeys.push(queryKey);
        continue;
      }

      entriesByKey.set(queryKey, entry);
    }

    return { entriesByKey, invalidQueryKeys };
  }

  async function saveLocalStorageQueryEntry(
    queryKey: string,
    data: PersistedListQueryData,
  ): Promise<void> {
    if (localStorageAdapter === null) {
      await queryNamespace.save(queryKey, data);
      return;
    }

    const sessionKey = config.getSessionKey();
    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (sessionKey === false || storageKey === false) return;

    const timestamp = Date.now();

    try {
      await localStorageAdapter.runLocked(() => {
        const offlineProtected = mergeLocalStorageOfflineProtection(
          sessionKey,
          storageKey,
          parseCompactListQueryLocalStorageEntry(
            localStorageAdapter.readRaw(storageKey),
          )?.offlineProtected === true,
        );

        localStorageAdapter.write(
          storageKey,
          createCompactListQueryLocalStorageEntry({
            lastAccessAt: timestamp,
            offlineProtected,
            payload: data.payload,
            items: data.items,
            hasMore: data.hasMore,
            version,
          }),
        );
        recordLocalStorageTouch(storageKey, timestamp);
      });
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  async function removeLocalStorageQueryEntry(queryKey: string): Promise<void> {
    if (localStorageAdapter === null) {
      await queryNamespace.remove(queryKey);
      return;
    }

    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false) return;

    try {
      await localStorageAdapter.runLocked(() => {
        localStorageAdapter.remove(storageKey);
      });
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  async function clearLocalStorageQueries(): Promise<void> {
    if (localStorageAdapter === null) {
      await queryNamespace.clear();
      return;
    }

    const queryPrefix = getQueryPrefix();
    if (queryPrefix === false) return;

    try {
      await localStorageAdapter.runLocked(() => {
        for (const storageKey of localStorageAdapter.listRawKeys(queryPrefix)) {
          localStorageAdapter.remove(storageKey);
        }
      });
    } catch (error) {
      config.onPersistentStorageError?.(error);
    }
  }

  async function touchLocalStorageQueryEntry(queryKey: string): Promise<void> {
    if (localStorageAdapter === null) return;

    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false) return;

    await touchLocalStorageKeyWithThrottle(storageKey, () => {
      const entry = readLocalStorageQueryEntry(queryKey);
      if (!entry) return false;

      localStorageAdapter.write(
        storageKey,
        createCompactListQueryLocalStorageEntry({
          lastAccessAt: Date.now(),
          offlineProtected: entry.offlineProtected,
          payload: entry.payload,
          items: entry.items,
          hasMore: entry.hasMore,
          version,
        }),
      );

      return true;
    });
  }

  async function runSyncMaintenance(): Promise<void> {
    const { keptQueryKeys, managedQueryEntriesByKey } =
      await evictStoredQueries();
    await evictStoredItems(keptQueryKeys, managedQueryEntriesByKey);
  }

  function syncMaintenanceRegistration(): void {
    if (localStorageAdapter === null) return;

    const itemPrefix = getItemPrefix();
    if (itemPrefix === false) return;

    const nextCallbackKey =
      localStorageAdapter.getManifestKeyForPrefix(itemPrefix);
    if (maintenanceCallbackKey === nextCallbackKey) return;

    if (maintenanceCallbackKey !== null) {
      localStorageAdapter.unregisterMaintenanceCallback(maintenanceCallbackKey);
    }

    maintenanceCallbackKey = nextCallbackKey;
    localStorageAdapter.registerMaintenanceCallback(
      maintenanceCallbackKey,
      runSyncMaintenance,
    );
  }

  async function ensureKnownPersistedItemKeys(): Promise<Set<string>> {
    if (knownPersistedItemKeys !== null) return knownPersistedItemKeys;

    knownPersistedItemKeys = new Set(await itemNamespace.listKeys());
    return knownPersistedItemKeys;
  }

  async function ensureKnownPersistedQueryKeys(): Promise<Set<string>> {
    if (knownPersistedQueryKeys !== null) return knownPersistedQueryKeys;

    knownPersistedQueryKeys = new Set(
      localStorageAdapter !== null
        ? [...(scanLocalStorageQueryEntries()?.entriesByKey.keys() ?? [])]
        : await queryNamespace.listKeys(),
    );
    return knownPersistedQueryKeys;
  }

  function rememberHydratedItem(
    itemKey: string,
    persisted: PersistedListQueryItemData<unknown>,
  ): void {
    hydratedPersistedItemKeys.add(itemKey);
    itemSnapshotByKey.set(itemKey, JSON.stringify(persisted));
    knownPersistedItemKeys?.add(itemKey);
  }

  function rememberHydratedQuery(
    queryKey: string,
    persisted: PersistedListQueryData,
  ): void {
    hydratedPersistedQueryKeys.add(queryKey);
    querySnapshotByKey.set(queryKey, JSON.stringify(persisted));
    knownPersistedQueryKeys?.add(queryKey);
  }

  function forgetPersistedItem(itemKey: string): void {
    hydratedPersistedItemKeys.delete(itemKey);
    itemSnapshotByKey.delete(itemKey);
    knownPersistedItemKeys?.delete(itemKey);
  }

  function forgetPersistedQuery(queryKey: string): void {
    hydratedPersistedQueryKeys.delete(queryKey);
    querySnapshotByKey.delete(queryKey);
    knownPersistedQueryKeys?.delete(queryKey);
  }

  function materializeHydratedItemState(
    itemKey: string,
    itemState: {
      item: ItemState;
      itemQuery: TSDFItemQuery<ItemPayload>;
      loadedFields: string[];
    },
  ): void {
    if (!storeRef) return;

    suppressedPersistedStateFlushes++;
    storeRef.setState(
      materializeListQueryItemState(storeRef.state, itemKey, itemState),
    );
  }

  function materializeHydratedQueryState(
    queryKey: string,
    query: TSFDListQuery<QueryPayload>,
  ): void {
    if (!storeRef) return;

    suppressedPersistedStateFlushes++;
    storeRef.setState(
      materializeListQueryQueryState(storeRef.state, queryKey, query),
    );
  }

  function parseHydratedItemSnapshot(
    snapshot: string,
  ):
    | {
        item: ItemState;
        itemQuery: TSDFItemQuery<ItemPayload>;
        loadedFields: string[];
      }
    | undefined {
    try {
      const persisted = parsePersistedListQueryItemData(
        JSON.parse(snapshot),
        config.itemPayloadSchema,
      );
      return persisted
        ? (toItemState(persisted, dataSchema, shouldIgnoreItem) ?? undefined)
        : undefined;
    } catch {
      return undefined;
    }
  }

  function readRememberedHydratedItem(
    itemKey: string,
  ):
    | {
        item: ItemState;
        itemQuery: TSDFItemQuery<ItemPayload>;
        loadedFields: string[];
      }
    | undefined {
    const snapshot = itemSnapshotByKey.get(itemKey);
    if (!snapshot) return undefined;

    const itemState = parseHydratedItemSnapshot(snapshot);
    if (!itemState) {
      forgetPersistedItem(itemKey);
    }

    return itemState;
  }

  function readHydratedLocalStorageItem(
    itemKey: string,
  ):
    | {
        item: ItemState;
        itemQuery: TSDFItemQuery<ItemPayload>;
        loadedFields: string[];
      }
    | undefined {
    if (localStorageAdapter === null) return undefined;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return undefined;

    const prefix = getItemPrefix();
    if (prefix === false) return undefined;

    const storageKey = `${prefix}${itemKey}`;
    const cacheEntry = readStorageEntryFromLocalStorageSync<
      PersistedListQueryItemData<unknown>
    >(storageKey, version, { metadata: 'namespace', namespacePrefix: prefix });

    if (!cacheEntry) {
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const persisted = parsePersistedListQueryItemData(
      cacheEntry.data,
      config.itemPayloadSchema,
    );
    if (!persisted) {
      scheduleLocalStorageRemoval(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      });
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);
    if (!itemState) {
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
    rememberHydratedItem(itemKey, cacheEntry.data);
    return itemState;
  }

  function parseHydratedQuerySnapshot(
    snapshot: string,
  ): ParsedPersistedListQueryData<QueryPayload> | undefined {
    try {
      return (
        parsePersistedListQueryData(
          JSON.parse(snapshot),
          config.queryPayloadSchema,
        ) ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  function readRememberedPersistedQueryData(
    queryKey: string,
  ): ParsedPersistedListQueryData<QueryPayload> | undefined {
    const snapshot = querySnapshotByKey.get(queryKey);
    if (!snapshot) return undefined;

    const persistedQuery = parseHydratedQuerySnapshot(snapshot);
    if (!persistedQuery) {
      forgetPersistedQuery(queryKey);
    }

    return persistedQuery;
  }

  function readPersistedQueryData(
    queryKey: string,
  ): ParsedPersistedListQueryData<QueryPayload> | undefined {
    if (localStorageAdapter !== null) {
      return (
        readRememberedPersistedQueryData(queryKey) ??
        readHydratedLocalStorageQuery(queryKey)
      );
    }

    const snapshot = querySnapshotByKey.get(queryKey);
    return snapshot ? parseHydratedQuerySnapshot(snapshot) : undefined;
  }

  function scheduleLocalStorageQueryRemoval(storageKey: string): void {
    if (localStorageAdapter === null) return;
    const adapter = localStorageAdapter;
    scheduleIdleCleanup(() => {
      void adapter.runLocked(() => {
        adapter.remove(storageKey);
      });
    });
  }

  function readHydratedLocalStorageQuery(
    queryKey: string,
  ): ParsedPersistedListQueryData<QueryPayload> | undefined {
    const entry = readLocalStorageQueryEntry(queryKey);
    if (!entry) {
      // If the raw key exists but didn't parse/match version, clean it up
      const storageKey = getLocalStorageQueryStorageKey(queryKey);
      if (
        storageKey !== false &&
        localStorageAdapter !== null &&
        localStorageAdapter.readRaw(storageKey) !== null
      ) {
        scheduleLocalStorageQueryRemoval(storageKey);
      }
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const persistedQuery = parsePersistedListQueryData(
      { payload: entry.payload, items: entry.items, hasMore: entry.hasMore },
      config.queryPayloadSchema,
    );
    if (!persistedQuery) {
      const storageKey = getLocalStorageQueryStorageKey(queryKey);
      if (storageKey !== false) {
        scheduleLocalStorageQueryRemoval(storageKey);
      }
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    scheduleIdleCleanup(() => {
      void touchLocalStorageQueryEntry(queryKey);
    });
    rememberHydratedQuery(queryKey, {
      payload: persistedQuery.payload,
      items: persistedQuery.items,
      hasMore: persistedQuery.hasMore,
    });
    return persistedQuery;
  }

  function buildHydratedQueryState(
    persistedQuery: ParsedPersistedListQueryData<QueryPayload>,
  ): TSFDListQuery<QueryPayload> {
    const filteredItemKeys = persistedQuery.items.filter((itemKey) => {
      return readHydratedItem(itemKey) !== undefined;
    });
    const limitedQuery = limitPersistedQueryItems(
      filteredItemKeys,
      persistedQuery.hasMore,
      maxQuerySize,
    );

    return {
      error: null,
      hasMore: limitedQuery.hasMore,
      items: limitedQuery.itemKeys,
      payload: persistedQuery.payload,
      refetchOnMount: 'lowPriority',
      status: 'success',
      wasLoaded: true,
    };
  }

  function createInitialState(baseState: State): State {
    syncMaintenanceRegistration();
    return baseState;
  }

  function readHydratedItem(
    this: void,
    itemKey: string,
  ):
    | {
        item: ItemState;
        itemQuery: TSDFItemQuery<ItemPayload>;
        loadedFields: string[];
      }
    | undefined {
    if (localStorageAdapter !== null) {
      return (
        readRememberedHydratedItem(itemKey) ??
        readHydratedLocalStorageItem(itemKey)
      );
    }

    const snapshot = itemSnapshotByKey.get(itemKey);
    return snapshot ? parseHydratedItemSnapshot(snapshot) : undefined;
  }

  function readHydratedQuery(
    this: void,
    queryKey: string,
  ): TSFDListQuery<QueryPayload> | undefined {
    const persistedQuery = readPersistedQueryData(queryKey);
    return persistedQuery ? buildHydratedQueryState(persistedQuery) : undefined;
  }

  async function preloadItem(itemKey: string): Promise<boolean> {
    if (!storeRef) return false;
    const itemQueryEntry = readOwnMaterializedValue(
      storeRef.state.itemQueries,
      itemKey,
    );
    const itemEntry = readOwnMaterializedValue(storeRef.state.items, itemKey);
    const loadedFieldsEntry = readOwnMaterializedValue(
      storeRef.state.itemLoadedFields,
      itemKey,
    );
    if (
      itemQueryEntry.status === 'materialized' &&
      itemEntry.status === 'materialized' &&
      loadedFieldsEntry.status === 'materialized'
    ) {
      return itemQueryEntry.value !== null;
    }
    if (
      itemQueryEntry.status === 'materialized' &&
      itemQueryEntry.value === null
    ) {
      return false;
    }

    if (localStorageAdapter !== null) {
      const itemState =
        readRememberedHydratedItem(itemKey) ?? readHydratedItem(itemKey);
      if (!itemState) return false;

      materializeHydratedItemState(itemKey, itemState);

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

        rememberHydratedItem(itemKey, cached);

        if (storeRef.state.itemQueries[itemKey] !== undefined) {
          return (
            storeRef.state.itemQueries[itemKey] !== null &&
            storeRef.state.items[itemKey] !== undefined
          );
        }

        materializeHydratedItemState(itemKey, itemState);

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
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function preloadQuery(queryKey: string): Promise<boolean> {
    if (!storeRef) return false;
    const queryEntry = readOwnMaterializedValue(
      storeRef.state.queries,
      queryKey,
    );
    if (queryEntry.status === 'materialized') return true;

    if (localStorageAdapter !== null) {
      const persistedQuery =
        readRememberedPersistedQueryData(queryKey) ??
        readPersistedQueryData(queryKey);
      if (!persistedQuery) return false;

      const activeStore = storeRef;

      for (const itemKey of persistedQuery.items) {
        void preloadItem(itemKey);
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

      materializeHydratedQueryState(queryKey, {
        error: null,
        hasMore: limitedQuery.hasMore,
        items: limitedQuery.itemKeys,
        payload: persistedQuery.payload,
        refetchOnMount: 'lowPriority',
        status: 'success',
        wasLoaded: true,
      });

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

        rememberHydratedQuery(queryKey, cached);

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

        suppressedPersistedStateFlushes++;
        activeStore.setState(
          materializeListQueryQueryState(activeStore.state, queryKey, {
            error: null,
            hasMore: limitedQuery.hasMore,
            items: limitedQuery.itemKeys,
            payload: persistedQuery.payload,
            refetchOnMount: 'lowPriority',
            status: 'success',
            wasLoaded: true,
          }),
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
    const scannedQueryEntries =
      localStorageAdapter !== null ? scanLocalStorageQueryEntries() : null;
    const managedQueryEntriesByKey = scannedQueryEntries?.entriesByKey ?? null;

    if (localStorageAdapter !== null && scannedQueryEntries !== null) {
      const managedQueryEntries = scannedQueryEntries.entriesByKey;
      const invalidQueryKeys = scannedQueryEntries.invalidQueryKeys;
      const expiredQueryKeys = filterAndMap(
        [...managedQueryEntries.values()],
        ({ queryKey, lastAccessAt, offlineProtected }) => {
          if (offlineProtected) return false;

          return Date.now() - lastAccessAt > getLocalStorageMaxAgeMs()
            ? { queryKey }
            : false;
        },
      );
      if (invalidQueryKeys.length > 0) {
        await Promise.all(
          invalidQueryKeys.map((queryKey) =>
            removeLocalStorageQueryEntry(queryKey),
          ),
        );
      }
      if (expiredQueryKeys.length > 0) {
        await Promise.all(
          expiredQueryKeys.map(({ queryKey }) =>
            removeLocalStorageQueryEntry(queryKey),
          ),
        );
        for (const { queryKey } of expiredQueryKeys) {
          managedQueryEntries.delete(queryKey);
        }
      }

      const invalidPayloadQueryKeys: string[] = [];
      const filteredEntries = filterAndMap(
        [...managedQueryEntries.values()],
        (entry) => {
          const payload = validateWithSchema(
            config.queryPayloadSchema,
            entry.payload,
          );

          if (payload === null) {
            invalidPayloadQueryKeys.push(entry.queryKey);
            return false;
          }

          return {
            queryKey: entry.queryKey,
            payload,
            items: entry.items,
            hasMore: entry.hasMore,
            lastAccessAt: entry.lastAccessAt,
            offlineProtected: entry.offlineProtected,
          };
        },
      );
      if (invalidPayloadQueryKeys.length > 0) {
        await Promise.all(
          invalidPayloadQueryKeys.map((queryKey) =>
            removeLocalStorageQueryEntry(queryKey),
          ),
        );
      }

      filteredEntries.sort((a, b) => {
        if (a.offlineProtected && !b.offlineProtected) return -1;
        if (!a.offlineProtected && b.offlineProtected) return 1;

        const aPinned = pinnedQueryKeys.has(a.queryKey);
        const bPinned = pinnedQueryKeys.has(b.queryKey);

        if (aPinned && !bPinned) return -1;
        if (!aPinned && bPinned) return 1;

        return b.lastAccessAt - a.lastAccessAt;
      });

      const keptQueryKeys = new Set(
        filteredEntries.slice(0, maxQueries).map(({ queryKey }) => queryKey),
      );

      await Promise.all(
        filteredEntries
          .filter(({ queryKey }) => !keptQueryKeys.has(queryKey))
          .map(({ queryKey }) => removeLocalStorageQueryEntry(queryKey)),
      );

      for (const { queryKey } of filteredEntries) {
        if (!keptQueryKeys.has(queryKey)) {
          forgetPersistedQuery(queryKey);
        }
      }

      knownPersistedQueryKeys = keptQueryKeys;

      return { keptQueryKeys, managedQueryEntriesByKey };
    }

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
            LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX,
          );
    const protectedQueryKeys =
      queryPrefix === null
        ? new Set<string>()
        : new Set(
            [...protectedStorageKeys]
              .filter((key) => key.startsWith(queryPrefix))
              .map((key) => key.slice(queryPrefix.length)),
          );

    const entries = await Promise.all(
      (await queryNamespace.listKeys()).map(async (queryKey) => ({
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
      return persisted
        ? {
            queryKey,
            payload: persisted.payload,
            items: persisted.items,
            hasMore: persisted.hasMore,
            lastAccessAt:
              managedQueryEntriesByKey?.get(queryKey)?.lastAccessAt ??
              entry.timestamp,
          }
        : false;
    });

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
        forgetPersistedQuery(queryKey);
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
            LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX,
          );
    const protectedItemKeys =
      itemPrefix === null
        ? new Set<string>()
        : new Set(
            [...protectedStorageKeys]
              .filter((key) => key.startsWith(itemPrefix))
              .map((key) => key.slice(itemPrefix.length)),
          );
    const referencedItems = new Set<string>();
    const queryEntries: Array<{ items: string[] }> = managedQueryEntriesByKey
      ? [...managedQueryEntriesByKey.values()]
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

    if (localStorageAdapter !== null && itemPrefix !== null) {
      const metadataEntries =
        localStorageAdapter.listManifestEntries(itemPrefix);
      if (!hasIgnoreItemFilter && metadataEntries.length <= maxItems) return;

      const metadataEntriesWithPayload = metadataEntries.map((entry) => ({
        itemKey: entry.entryKey,
        lastAccessAt: entry.lastAccessAt,
        payload: validateWithSchema(
          config.itemPayloadSchema,
          readManifestPayloadMeta(entry.meta),
        ),
      }));

      const invalidItemEntries = filterAndMap(
        metadataEntriesWithPayload,
        ({ itemKey, payload }) => (payload === null ? { itemKey } : false),
      );

      if (invalidItemEntries.length > 0) {
        await Promise.all(
          invalidItemEntries.map(({ itemKey }) =>
            itemNamespace.remove(itemKey),
          ),
        );
      }

      const hydratedItemEntries = filterAndMap(
        metadataEntriesWithPayload,
        ({ itemKey, lastAccessAt, payload }) =>
          payload === null ? false : { itemKey, lastAccessAt, payload },
      );

      const ignoredItemEntries = hydratedItemEntries.filter(({ payload }) =>
        shouldIgnoreItem(payload),
      );

      if (ignoredItemEntries.length > 0) {
        await Promise.all(
          ignoredItemEntries.map(({ itemKey }) =>
            itemNamespace.remove(itemKey),
          ),
        );
        for (const { itemKey } of ignoredItemEntries) {
          forgetPersistedItem(itemKey);
        }
      }

      const persistedItemEntries = hydratedItemEntries.filter(
        ({ payload }) => !shouldIgnoreItem(payload),
      );

      if (!hasIgnoreItemFilter && persistedItemEntries.length <= maxItems) {
        knownPersistedItemKeys = new Set(
          persistedItemEntries.map(({ itemKey }) => itemKey),
        );
        return;
      }

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
          forgetPersistedItem(itemKey);
        }
      }

      knownPersistedItemKeys = keptItemKeys;

      await Promise.all(
        [...keptQueryKeys].map(async (queryKey) => {
          const queryData = managedQueryEntriesByKey?.get(queryKey);
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

          await saveLocalStorageQueryEntry(queryKey, {
            payload: queryData.payload,
            items: limitedQuery.itemKeys,
            hasMore: limitedQuery.hasMore,
          });
        }),
      );
      return;
    }

    const itemKeys = await itemNamespace.listKeys();
    if (!hasIgnoreItemFilter && itemKeys.length <= maxItems) return;
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
        ? { itemKey, lastAccessAt: entry.timestamp, persisted }
        : false;
    });

    const ignoredItemEntries = validItemEntries.filter(({ persisted }) =>
      shouldIgnoreItem(persisted.payload),
    );

    if (ignoredItemEntries.length > 0) {
      await Promise.all(
        ignoredItemEntries.map(({ itemKey }) => itemNamespace.remove(itemKey)),
      );
      for (const { itemKey } of ignoredItemEntries) {
        forgetPersistedItem(itemKey);
      }
    }

    const persistedItemEntries = validItemEntries.filter(
      ({ persisted }) => !shouldIgnoreItem(persisted.payload),
    );

    if (!hasIgnoreItemFilter && persistedItemEntries.length <= maxItems) return;

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
        forgetPersistedItem(itemKey);
      }
    }

    knownPersistedItemKeys = keptItemKeys;

    await Promise.all(
      [...keptQueryKeys].map(async (queryKey) => {
        const queryData =
          managedQueryEntriesByKey?.get(queryKey) ??
          (await queryNamespace.load(queryKey));
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

        await saveLocalStorageQueryEntry(queryKey, {
          payload: queryData.payload,
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
    const queryEntries = Object.entries(state.queries);
    const knownQueryKeys = new Set(queryEntries.map(([queryKey]) => queryKey));
    for (const queryKey of hydratedPersistedQueryKeys) {
      if (knownQueryKeys.has(queryKey)) continue;
      const query = readHydratedQuery(queryKey);
      if (!query) continue;
      queryEntries.push([queryKey, query]);
    }

    const itemEntries: Array<[string, ItemState | null]> = [];
    for (const itemKey of Object.keys(state.items)) {
      const item = state.items[itemKey];
      if (item === undefined) continue;
      itemEntries.push([itemKey, item]);
    }
    const knownItemKeys = new Set(itemEntries.map(([itemKey]) => itemKey));
    for (const itemKey of hydratedPersistedItemKeys) {
      if (knownItemKeys.has(itemKey)) continue;
      const hydratedItem = readHydratedItem(itemKey);
      if (hydratedItem === undefined) continue;
      itemEntries.push([itemKey, hydratedItem.item]);
    }

    for (const [, query] of queryEntries) {
      for (const itemKey of query.items) {
        queryReferencedItemKeys.add(itemKey);
      }
    }

    for (const [queryKey, query] of queryEntries) {
      if (query.status !== 'success' && !query.wasLoaded) continue;

      const filteredItems = query.items.filter((itemKey) => {
        const hasItemInState = hasOwnEntry(state.items, itemKey);
        const hasItemQueryInState = hasOwnEntry(state.itemQueries, itemKey);
        const hydratedItem =
          hasItemInState && hasItemQueryInState
            ? undefined
            : readHydratedItem(itemKey);
        const item = hasItemInState ? state.items[itemKey] : hydratedItem?.item;
        const itemQuery = hasItemQueryInState
          ? state.itemQueries[itemKey]
          : hydratedItem?.itemQuery;

        return (
          item != null &&
          itemQuery != null &&
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
      tasks.push(saveLocalStorageQueryEntry(queryKey, nextValue));
    }

    for (const queryKey of previousQueryKeys) {
      if (nextQueryKeys.has(queryKey)) continue;
      if (!hydratedPersistedQueryKeys.has(queryKey)) {
        continue;
      }

      tasks.push(removeLocalStorageQueryEntry(queryKey));
      forgetPersistedQuery(queryKey);
      removedQueryKeys.add(queryKey);
    }

    for (const [itemKey, item] of itemEntries) {
      const hasItemQueryInState = hasOwnEntry(state.itemQueries, itemKey);
      const hasLoadedFieldsInState = hasOwnEntry(
        state.itemLoadedFields,
        itemKey,
      );
      const hydratedItem =
        hasItemQueryInState && hasLoadedFieldsInState
          ? undefined
          : readHydratedItem(itemKey);
      const itemQuery = hasItemQueryInState
        ? state.itemQueries[itemKey]
        : hydratedItem?.itemQuery;
      const loadedFields = hasLoadedFieldsInState
        ? state.itemLoadedFields[itemKey]
        : hydratedItem?.loadedFields;

      if (item === null || itemQuery == null) {
        if (previousItemKeys.has(itemKey)) {
          tasks.push(itemNamespace.remove(itemKey));
          forgetPersistedItem(itemKey);
          removedItemKeys.add(itemKey);
        }
        continue;
      }

      if (shouldIgnoreItem(itemQuery.payload)) {
        if (previousItemKeys.has(itemKey)) {
          tasks.push(itemNamespace.remove(itemKey));
          forgetPersistedItem(itemKey);
          removedItemKeys.add(itemKey);
        }
        continue;
      }

      const isQueryReferenced = queryReferencedItemKeys.has(itemKey);
      if (isQueryReferenced && !persistedQueryItemKeys.has(itemKey)) {
        if (previousItemKeys.has(itemKey)) {
          tasks.push(itemNamespace.remove(itemKey));
          forgetPersistedItem(itemKey);
          removedItemKeys.add(itemKey);
        }
        continue;
      }

      nextItemKeys.add(itemKey);
      const converted = convertStoreDataForPersistence(item, dataSchema);
      if (!converted.ok) {
        config.onPersistentStorageError?.(converted.error);
        continue;
      }

      const nextValue = {
        data: converted.value,
        payload: itemQuery.payload,
        loadedFields,
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
      forgetPersistedItem(itemKey);
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

    if (localStorageAdapter !== null) {
      const needsMaintenance =
        hasIgnoreItemFilter ||
        knownPersistedItemKeys.size > maxItems ||
        knownPersistedQueryKeys.size > maxQueries;
      if (needsMaintenance && maintenanceCallbackKey !== null) {
        scheduleLocalStorageMaintenance({
          forceManifestKeys: [maintenanceCallbackKey],
        });
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
      if (suppressedPersistedStateFlushes > 0) {
        suppressedPersistedStateFlushes--;
        return;
      }

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
    suppressedPersistedStateFlushes = 0;
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    if (localStorageAdapter !== null && maintenanceCallbackKey !== null) {
      localStorageAdapter.unregisterMaintenanceCallback(maintenanceCallbackKey);
      maintenanceCallbackKey = null;
    }
    itemNamespace.dispose();
    queryNamespace.dispose();
  }

  async function clear(): Promise<void> {
    clearSaveTimer();
    knownPersistedItemKeys = null;
    knownPersistedQueryKeys = null;
    suppressedPersistedStateFlushes = 0;
    itemSnapshotByKey.clear();
    querySnapshotByKey.clear();
    hydratedPersistedItemKeys.clear();
    hydratedPersistedQueryKeys.clear();
    await Promise.all([itemNamespace.clear(), clearLocalStorageQueries()]);
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    maybeHydrateQueries,
    preloadItems,
    preloadQueries,
    getHydratedItemKeys: () => [...hydratedPersistedItemKeys],
    getHydratedQueryKeys: () => [...hydratedPersistedQueryKeys],
    readHydratedItem,
    readHydratedQuery,
    hasAsyncPreload: localStorageAdapter === null,
    dispose,
    clear,
  };
}
