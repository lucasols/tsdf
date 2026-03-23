import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import {
  __LEGIT_CAST__,
  type __LEGIT_ANY__,
} from '@ls-stack/utils/saferTyping';
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
import { isManagedLocalStorageEntryOfflineProtected } from './localStorageMetadata';
import type {
  AnyOfflineOperationDefinition,
  ListQueryOfflineEntityRef,
} from './offline/types';

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
  createEvictionComparator,
  createShouldIgnoreItemPredicate,
} from './persistenceUtils';
import {
  assertValidPersistentStoreName,
  createPersistentStorageNamespaceHandle,
  getLocalStorageAdapter,
  getLocalStorageMaxAgeMs,
  getStoragePrefixForStoreNamespace,
  listAllPersistentStorageNamespaceMetadata,
  mergeLocalStorageOfflineProtection,
  readManifestPayloadMeta,
  readStorageEntryFromLocalStorageSync,
  recordLocalStorageTouch,
  refreshLocalStorageTimestamp,
  scheduleAsyncStorageMaintenance,
  scheduleLocalStorageMaintenance,
  scheduleLocalStorageRemoval,
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
import { getProtectedKeysFromMetadata } from './asyncStorageAdapter';

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
type ItemNamespaceMetadata = { p?: unknown };
type QueryNamespaceMetadata = { h?: boolean; i?: string[]; p?: unknown };

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
  const itemStorageValueCodec = {
    serialize: (
      data: PersistedListQueryItemData<ItemState | StorageState>,
    ) => ({
      d: data.data,
      p: data.payload,
      ...(data.loadedFields !== undefined ? { lf: data.loadedFields } : {}),
    }),
    deserialize: (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'd' in value &&
      'p' in value
        ? (() => {
            const parsed = parsePersistedListQueryItemData(
              {
                data: value.d,
                payload: value.p,
                ...('lf' in value && Array.isArray(value.lf)
                  ? { loadedFields: value.lf }
                  : {}),
              },
              config.itemPayloadSchema,
            );
            return parsed
              ? {
                  data: __LEGIT_CAST__<ItemState | StorageState, unknown>(
                    parsed.data,
                  ),
                  payload: parsed.payload,
                  ...(parsed.loadedFields
                    ? { loadedFields: parsed.loadedFields }
                    : {}),
                }
              : null;
          })()
        : null,
  };
  const queryStorageValueCodec = {
    serialize: (data: PersistedListQueryData) => ({
      p: data.payload,
      i: data.items,
      ...(data.hasMore ? { h: true } : {}),
    }),
    deserialize: (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'p' in value &&
      'i' in value &&
      Array.isArray(value.i)
        ? parsePersistedListQueryData(
            {
              payload: value.p,
              items: value.i,
              hasMore: 'h' in value && value.h === true,
            },
            config.queryPayloadSchema,
          )
        : null,
  };

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState | StorageState>,
    ItemNamespaceMetadata
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX },
    {
      getManifestMeta: (data) => ({ p: data.payload }),
      valueCodec: itemStorageValueCodec,
    },
  );
  const queryNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryData,
    QueryNamespaceMetadata
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX },
    {
      valueCodec: queryStorageValueCodec,
      getManifestMeta: (data) => ({
        p: data.payload,
        i: data.items,
        ...(data.hasMore ? { h: true } : {}),
      }),
    },
  );

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
  const knownMissingPersistedItemKeys = new Set<string>();
  const knownMissingPersistedQueryKeys = new Set<string>();
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
        const existingOfflineProtected = knownMissingPersistedQueryKeys.has(
          queryKey,
        )
          ? false
          : parseCompactListQueryLocalStorageEntry(
              localStorageAdapter.readRaw(storageKey),
            )?.offlineProtected === true;
        const offlineProtected = mergeLocalStorageOfflineProtection(
          sessionKey,
          storageKey,
          existingOfflineProtected,
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
    knownMissingPersistedItemKeys.delete(itemKey);
    itemSnapshotByKey.set(itemKey, JSON.stringify(persisted));
    knownPersistedItemKeys?.add(itemKey);
  }

  function rememberHydratedQuery(
    queryKey: string,
    persisted: PersistedListQueryData,
  ): void {
    hydratedPersistedQueryKeys.add(queryKey);
    knownMissingPersistedQueryKeys.delete(queryKey);
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
    storeRef.produceState((draft) => {
      draft.items[itemKey] = itemState.item;
      draft.itemQueries[itemKey] = itemState.itemQuery;
      draft.itemLoadedFields[itemKey] = itemState.loadedFields;
    });
  }

  function materializeHydratedQueryState(
    queryKey: string,
    query: TSFDListQuery<QueryPayload>,
  ): void {
    if (!storeRef) return;

    suppressedPersistedStateFlushes++;
    storeRef.produceState((draft) => {
      draft.queries[queryKey] = query;
    });
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
    if (knownMissingPersistedItemKeys.has(itemKey)) return undefined;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return undefined;

    const prefix = getItemPrefix();
    if (prefix === false) return undefined;

    const storageKey = `${prefix}${itemKey}`;
    const cacheEntry = readStorageEntryFromLocalStorageSync<
      PersistedListQueryItemData<unknown>
    >(
      storageKey,
      version,
      { metadata: 'namespace', namespacePrefix: prefix },
      itemStorageValueCodec,
    );

    if (!cacheEntry) {
      knownMissingPersistedItemKeys.add(itemKey);
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const itemState = toItemState(
      __LEGIT_CAST__<
        ParsedPersistedListQueryItemData<ItemPayload>,
        PersistedListQueryItemData<unknown>
      >(cacheEntry.data),
      dataSchema,
      shouldIgnoreItem,
    );
    if (!itemState) {
      scheduleLocalStorageRemoval(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      });
      knownMissingPersistedItemKeys.add(itemKey);
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

  function readHydratedLocalStorageQuery(
    queryKey: string,
  ): ParsedPersistedListQueryData<QueryPayload> | undefined {
    if (knownMissingPersistedQueryKeys.has(queryKey)) return undefined;

    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false || localStorageAdapter === null) {
      knownMissingPersistedQueryKeys.add(queryKey);
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const rawEntry = localStorageAdapter.readRaw(storageKey);
    if (rawEntry === null) {
      knownMissingPersistedQueryKeys.add(queryKey);
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const entry = parseCompactListQueryLocalStorageEntry(rawEntry);
    if (entry === null || entry.version !== version) {
      // If the raw key exists but didn't parse or match the expected version,
      // clean it up without rereading the same missing entry again.
      scheduleLocalStorageRemoval(storageKey, undefined);
      knownMissingPersistedQueryKeys.add(queryKey);
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const persistedQuery = parsePersistedListQueryData(
      { payload: entry.payload, items: entry.items, hasMore: entry.hasMore },
      config.queryPayloadSchema,
    );
    if (!persistedQuery) {
      const invalidStorageKey = getLocalStorageQueryStorageKey(queryKey);
      if (invalidStorageKey !== false) {
        scheduleLocalStorageRemoval(invalidStorageKey, undefined);
      }
      knownMissingPersistedQueryKeys.add(queryKey);
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
    const existingItemQuery = storeRef.state.itemQueries[itemKey];
    const existingItem = storeRef.state.items[itemKey];
    const existingLoadedFields = storeRef.state.itemLoadedFields[itemKey];
    if (
      existingItemQuery !== undefined &&
      existingItem !== undefined &&
      existingLoadedFields !== undefined
    ) {
      return existingItemQuery !== null;
    }
    if (existingItemQuery === null) return false;

    if (localStorageAdapter !== null) {
      const itemState = readHydratedItem(itemKey);
      if (!itemState) return false;

      materializeHydratedItemState(itemKey, itemState);

      return true;
    }

    const existingPromise = pendingItemPreloads.get(itemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = itemNamespace
      .load(itemKey, { touch: 'coarse' })
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }

        const persisted = parsePersistedListQueryItemData(
          cached,
          config.itemPayloadSchema,
        );
        if (!persisted) {
          void itemNamespace.remove(itemKey).catch(() => {});
          return false;
        }

        const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);
        if (!itemState) {
          void itemNamespace.remove(itemKey).catch(() => {});
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
    if (storeRef.state.queries[queryKey] !== undefined) return true;

    if (localStorageAdapter !== null) {
      const persistedQuery = readPersistedQueryData(queryKey);
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
      .load(queryKey, { touch: 'coarse' })
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
          void queryNamespace.remove(queryKey).catch(() => {});
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
        activeStore.setState({
          ...activeStore.state,
          queries: {
            ...activeStore.state.queries,
            [queryKey]: {
              error: null,
              hasMore: limitedQuery.hasMore,
              items: limitedQuery.itemKeys,
              payload: persistedQuery.payload,
              refetchOnMount: 'lowPriority',
              status: 'success',
              wasLoaded: true,
            },
          },
        });

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

      filteredEntries.sort(
        createEvictionComparator(
          [(e) => e.offlineProtected, (e) => pinnedQueryKeys.has(e.queryKey)],
          (e) => e.lastAccessAt,
        ),
      );

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

    const metadataEntries = await listAllPersistentStorageNamespaceMetadata(
      queryNamespace,
      { order: 'lru-desc' },
    );
    const protectedQueryKeys = getProtectedKeysFromMetadata(metadataEntries);
    const managedAsyncQueryEntriesByKey: ManagedQueryEntriesByKey = new Map();

    const invalidEntries = filterAndMap(metadataEntries, (entry) => {
      const payload = validateWithSchema(
        config.queryPayloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );
      const items = entry.customMetadata.i;

      return payload === null || !Array.isArray(items)
        ? { queryKey: entry.key }
        : false;
    });

    if (invalidEntries.length > 0) {
      await Promise.all(
        invalidEntries.map(({ queryKey }) => queryNamespace.remove(queryKey)),
      );
    }

    const validEntries = filterAndMap(metadataEntries, (entry) => {
      const payload = validateWithSchema(
        config.queryPayloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );
      const items = entry.customMetadata.i;
      if (payload === null || !Array.isArray(items)) return false;

      return {
        queryKey: entry.key,
        payload,
        items,
        hasMore: entry.customMetadata.h === true,
        lastAccessAt: entry.lastAccessAt,
      };
    });

    validEntries.sort(
      createEvictionComparator(
        [
          (e) => protectedQueryKeys.has(e.queryKey),
          (e) => pinnedQueryKeys.has(e.queryKey),
        ],
        (e) => e.lastAccessAt,
      ),
    );

    const keptQueryKeys = new Set(
      validEntries.slice(0, maxQueries).map(({ queryKey }) => queryKey),
    );

    await Promise.all(
      validEntries
        .filter(({ queryKey }) => !keptQueryKeys.has(queryKey))
        .map(({ queryKey }) => queryNamespace.remove(queryKey)),
    );

    for (const entry of validEntries) {
      const { queryKey } = entry;
      if (!keptQueryKeys.has(queryKey)) {
        forgetPersistedQuery(queryKey);
        continue;
      }

      managedAsyncQueryEntriesByKey.set(queryKey, {
        queryKey,
        payload: entry.payload,
        items: entry.items,
        hasMore: entry.hasMore,
        lastAccessAt: entry.lastAccessAt,
        offlineProtected: protectedQueryKeys.has(queryKey),
      });
    }

    knownPersistedQueryKeys = keptQueryKeys;

    return {
      keptQueryKeys,
      managedQueryEntriesByKey: managedAsyncQueryEntriesByKey,
    };
  }

  async function evictStoredItems(
    keptQueryKeys: Set<string>,
    managedQueryEntriesByKey: ManagedQueryEntriesByKey | null,
  ): Promise<void> {
    syncMaintenanceRegistration();
    const sessionKey = config.getSessionKey();
    const itemPrefix =
      sessionKey === false
        ? null
        : getStoragePrefixForStoreNamespace(
            sessionKey,
            config.storeName,
            LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX,
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
      const protectedItemKeys = new Set(
        metadataEntries.flatMap((entry) =>
          isManagedLocalStorageEntryOfflineProtected(entry.meta)
            ? [entry.entryKey]
            : [],
        ),
      );
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

      persistedItemEntries.sort(
        createEvictionComparator(
          [
            (e) => protectedItemKeys.has(e.itemKey),
            (e) => pinnedItemKeys.has(e.itemKey),
            (e) => referencedItems.has(e.itemKey),
          ],
          (e) => e.lastAccessAt,
        ),
      );

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

    const itemMetadataEntries = await listAllPersistentStorageNamespaceMetadata(
      itemNamespace,
      { order: 'lru-desc' },
    );
    const protectedItemKeys = getProtectedKeysFromMetadata(itemMetadataEntries);
    if (
      !hasIgnoreItemFilter &&
      itemMetadataEntries.filter(
        ({ key: itemKey }) => !protectedItemKeys.has(itemKey),
      ).length <= maxItems
    ) {
      knownPersistedItemKeys = new Set(
        itemMetadataEntries.map(({ key }) => key),
      );
      return;
    }

    const invalidItemEntries = filterAndMap(itemMetadataEntries, (entry) => {
      const payload = validateWithSchema(
        config.itemPayloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );
      return payload === null ? { itemKey: entry.key } : false;
    });

    if (invalidItemEntries.length > 0) {
      await Promise.all(
        invalidItemEntries.map(({ itemKey }) => itemNamespace.remove(itemKey)),
      );
    }

    const validItemEntries = filterAndMap(itemMetadataEntries, (entry) => {
      const payload = validateWithSchema(
        config.itemPayloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );
      if (payload === null) return false;

      return { itemKey: entry.key, lastAccessAt: entry.lastAccessAt, payload };
    });

    const ignoredItemEntries = validItemEntries.filter(({ payload }) =>
      shouldIgnoreItem(payload),
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
      ({ payload }) => !shouldIgnoreItem(payload),
    );

    if (!hasIgnoreItemFilter && persistedItemEntries.length <= maxItems) {
      knownPersistedItemKeys = new Set(
        persistedItemEntries.map(({ itemKey }) => itemKey),
      );
      return;
    }

    persistedItemEntries.sort(
      createEvictionComparator(
        [
          (e) => protectedItemKeys.has(e.itemKey),
          (e) => pinnedItemKeys.has(e.itemKey),
          (e) => referencedItems.has(e.itemKey),
        ],
        (e) => e.lastAccessAt,
      ),
    );

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
        const hasItemInState = Object.hasOwn(state.items, itemKey);
        const hasItemQueryInState = Object.hasOwn(state.itemQueries, itemKey);
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
      tasks.push(
        saveLocalStorageQueryEntry(queryKey, nextValue).then(() => {
          knownMissingPersistedQueryKeys.delete(queryKey);
        }),
      );
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
      const hasItemQueryInState = Object.hasOwn(state.itemQueries, itemKey);
      const hasLoadedFieldsInState = Object.hasOwn(
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
      knownMissingPersistedItemKeys.delete(itemKey);
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
      if (
        maintenanceCallbackKey !== null &&
        (hasIgnoreItemFilter ||
          knownPersistedItemKeys.size > maxItems ||
          knownPersistedQueryKeys.size > maxQueries)
      ) {
        scheduleLocalStorageMaintenance({
          forceManifestKeys: [maintenanceCallbackKey],
        });
      }
      return;
    }

    const sessionKey = config.getSessionKey();
    if (sessionKey !== false) {
      if (
        hasIgnoreItemFilter ||
        knownPersistedItemKeys.size > maxItems ||
        knownPersistedQueryKeys.size > maxQueries
      ) {
        scheduleAsyncStorageMaintenance(
          `list-query:${sessionKey}:${config.storeName}`,
          async () => {
            const { keptQueryKeys, managedQueryEntriesByKey } =
              await evictStoredQueries();
            await evictStoredItems(keptQueryKeys, managedQueryEntriesByKey);
          },
        );
      }
    }
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
    knownMissingPersistedItemKeys.clear();
    knownMissingPersistedQueryKeys.clear();
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
    knownMissingPersistedItemKeys.clear();
    knownMissingPersistedQueryKeys.clear();
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
