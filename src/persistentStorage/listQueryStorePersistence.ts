import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { type __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';

import type {
  TSDFItemQuery,
  TSFDListQuery,
  TSFDListQueryState,
} from '../listQueryStore/types';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  buildPersistedStaticPolicy,
  getProtectedKeysFromMetadata,
  readAsyncStorageNamespaceIndexStateUsingDriver,
  registerAsyncStartupStoreCleanup,
  serializeProtectedRef,
  unregisterAsyncStartupStoreCleanup,
  type AsyncStartupCleanupScopePlan,
  type AsyncStartupCleanupStoreDeletePlan,
} from './asyncStorageAdapter';
import {
  createCompactListQueryLocalStorageEntry,
  parseCompactListQueryLocalStorageEntry,
} from './compactListQueryLocalStorageEntry';
import { isManagedLocalStorageEntryOfflineProtected } from './localStorageMetadata';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import type {
  AnyOfflineOperationDefinition,
  ListQueryOfflineEntityRef,
} from './offline/types';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getPayloadRecordKey,
} from './opfsFileNaming';
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
  isOfflineNetworkModeActiveSync,
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
  AsyncStorageDriver,
  AsyncStorageNamespaceScope,
  PersistedListQueryData,
  PersistedListQueryItemData,
  ResolvedListQueryPersistentStorageConfig,
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
type EntryNamespaceMetadata = { p?: unknown };

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
  config: ResolvedListQueryPersistentStorageConfig<
    ItemState,
    QueryPayload,
    ItemPayload,
    StorageState,
    TOfflineOperations
  >,
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
  const asyncStorageAdapter =
    storageAdapter === 'local-sync' ? null : storageAdapter;
  const persistedItemStaticPolicy =
    localStorageAdapter === null
      ? buildPersistedStaticPolicy(
          config.maxItems,
          DEFAULT_MAX_ITEMS,
          pinnedItemKeys,
        )
      : null;
  const persistedQueryStaticPolicy =
    localStorageAdapter === null
      ? buildPersistedStaticPolicy(
          config.maxQueries,
          DEFAULT_MAX_QUERIES,
          pinnedQueryKeys,
        )
      : null;
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
        ? parsePersistedListQueryItemData(
            {
              data: value.d,
              payload: value.p,
              ...('lf' in value && Array.isArray(value.lf)
                ? { loadedFields: value.lf }
                : {}),
            },
            config.itemPayloadSchema,
            dataSchema,
          )
        : null,
  };
  const queryStorageValueCodec = {
    serialize: (data: PersistedListQueryData) => ({
      i: data.items,
      ...(data.hasMore ? { h: true } : {}),
    }),
    deserialize: (value: unknown, metadata?: EntryNamespaceMetadata) =>
      typeof value === 'object' &&
      value !== null &&
      'i' in value &&
      Array.isArray(value.i)
        ? parsePersistedListQueryData(
            {
              payload: metadata?.p,
              items: value.i,
              hasMore: 'h' in value && value.h === true,
            },
            config.queryPayloadSchema,
          )
        : null,
  };

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState | StorageState>,
    EntryNamespaceMetadata
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX },
    {
      getManifestMeta: (data) => ({ p: data.payload }),
      valueCodec: itemStorageValueCodec,
    },
  );
  const queryNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryData,
    EntryNamespaceMetadata
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX },
    {
      valueCodec: queryStorageValueCodec,
      getManifestMeta: (data) => ({ p: data.payload }),
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
  let knownPersistedItemKeys: Set<string> | null = null;
  let knownPersistedQueryKeys: Set<string> | null = null;
  let maintenanceCallbackKey: string | null = null;

  function isOfflineNetworkActive(): boolean {
    return isOfflineNetworkModeActiveSync(
      config.offline?.session.getConfig().network,
    );
  }

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
        const existingOfflineProtected =
          parseCompactListQueryLocalStorageEntry(
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

  async function runMaintenance(): Promise<void> {
    const { keptQueryKeys, managedQueryEntriesByKey } =
      await evictStoredQueries();
    await evictStoredItems(keptQueryKeys, managedQueryEntriesByKey);
  }

  async function planAsyncStartupCleanup(args: {
    discoveredScopes: Array<{
      knownRecordKeys: string[] | null;
      scope: AsyncStorageNamespaceScope;
    }>;
    driver: AsyncStorageDriver;
    now: number;
  }): Promise<{
    scopePlans: AsyncStartupCleanupScopePlan[];
    storeDeletePlans: AsyncStartupCleanupStoreDeletePlan[];
  }> {
    const discoveredItemScope = args.discoveredScopes.find(
      ({ scope }) => scope.kind === 'listQuery.item',
    );
    const discoveredQueryScope = args.discoveredScopes.find(
      ({ scope }) => scope.kind === 'listQuery.query',
    );
    const [queryIndexState, itemIndexState] = await Promise.all([
      discoveredQueryScope === undefined
        ? Promise.resolve(null)
        : readAsyncStorageNamespaceIndexStateUsingDriver(
            args.driver,
            discoveredQueryScope.scope,
            discoveredQueryScope.knownRecordKeys,
          ),
      discoveredItemScope === undefined
        ? Promise.resolve(null)
        : readAsyncStorageNamespaceIndexStateUsingDriver(
            args.driver,
            discoveredItemScope.scope,
            discoveredItemScope.knownRecordKeys,
          ),
    ]);
    let queryScopePlan: AsyncStartupCleanupScopePlan | null = null;

    if (discoveredQueryScope !== undefined && queryIndexState !== null) {
      const { scope } = discoveredQueryScope;
      const indexState = queryIndexState;

      if (indexState.valid && indexState.entries !== null) {
        const nextEntries = new Map(indexState.entries);
        const deleteKeys = new Set<string>();
        let indexChanged = false;

        for (const [key, metadata] of indexState.entries) {
          const payload = validateWithSchema(
            config.queryPayloadSchema,
            readManifestPayloadMeta(metadata.customMetadata),
          );
          if (payload === null) {
            deleteKeys.add(getPayloadRecordKey(key));
            nextEntries.delete(key);
            indexChanged = true;
          }
        }

        if (indexChanged) {
          if (nextEntries.size === 0) {
            deleteKeys.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
          }

          queryScopePlan = {
            deleteKeys: [...deleteKeys],
            persistEntries: nextEntries.size > 0 ? nextEntries : null,
            persistStaticPolicy:
              nextEntries.size > 0 ? indexState.staticPolicy : undefined,
            scope,
          };
        }
      }
    }

    let itemScopePlan: AsyncStartupCleanupScopePlan | null = null;
    if (discoveredItemScope !== undefined && itemIndexState !== null) {
      const { scope } = discoveredItemScope;
      const indexState = itemIndexState;

      if (indexState.valid && indexState.entries !== null) {
        const nextEntries = new Map(indexState.entries);
        const deleteKeys = new Set<string>();
        let indexChanged = false;

        for (const [key, metadata] of indexState.entries) {
          const payload = validateWithSchema(
            config.itemPayloadSchema,
            readManifestPayloadMeta(metadata.customMetadata),
          );
          if (payload === null || shouldIgnoreItem(payload)) {
            deleteKeys.add(getPayloadRecordKey(key));
            nextEntries.delete(key);
            indexChanged = true;
          }
        }

        if (indexChanged) {
          if (nextEntries.size === 0) {
            deleteKeys.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
          }

          itemScopePlan = {
            deleteKeys: [...deleteKeys],
            persistEntries: nextEntries.size > 0 ? nextEntries : null,
            persistStaticPolicy:
              nextEntries.size > 0 ? indexState.staticPolicy : undefined,
            scope,
          };
        }
      }
    }

    const scopePlans = filterAndMap(
      [queryScopePlan, itemScopePlan],
      (plan) => plan ?? false,
    );

    return { scopePlans, storeDeletePlans: [] };
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
      runMaintenance,
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
        dataSchema,
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
    >(
      storageKey,
      version,
      {
        allowExpiredRead: isOfflineNetworkActive(),
        metadata: 'namespace',
        namespacePrefix: prefix,
      },
      itemStorageValueCodec,
    );

    if (!cacheEntry) {
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const persisted = parsePersistedListQueryItemData(
      cacheEntry.data,
      config.itemPayloadSchema,
      dataSchema,
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

  function readHydratedLocalStorageQuery(
    queryKey: string,
  ): ParsedPersistedListQueryData<QueryPayload> | undefined {
    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false || localStorageAdapter === null) {
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const rawEntry = localStorageAdapter.readRaw(storageKey);
    if (rawEntry === null) {
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const entry = parseCompactListQueryLocalStorageEntry(rawEntry);
    if (entry === null || entry.version !== version) {
      // If the raw key exists but didn't parse or match the expected version,
      // clean it up and let later reads check storage again if needed.
      scheduleLocalStorageRemoval(storageKey, undefined);
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

  function resolveAsyncPreloadedItem(
    itemKey: string,
    cached: PersistedListQueryItemData<ItemState | StorageState> | null,
    currentGeneration: number,
  ): boolean {
    if (currentGeneration !== generation || !storeRef) {
      return false;
    }
    if (!cached) {
      forgetPersistedItem(itemKey);
      return false;
    }

    const persisted = parsePersistedListQueryItemData(
      cached,
      config.itemPayloadSchema,
      dataSchema,
    );
    if (!persisted) {
      forgetPersistedItem(itemKey);
      void itemNamespace.remove(itemKey).catch(() => {});
      return false;
    }

    const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);
    if (!itemState) {
      forgetPersistedItem(itemKey);
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
      .then((cached) =>
        resolveAsyncPreloadedItem(itemKey, cached, currentGeneration),
      )
      .finally(() => {
        if (currentGeneration === generation) {
          pendingItemPreloads.delete(itemKey);
        }
      });

    pendingItemPreloads.set(itemKey, promise);
    return promise;
  }

  async function preloadItems(itemKeys: string[]): Promise<boolean[]> {
    if (localStorageAdapter !== null || itemKeys.length <= 1) {
      return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
    }
    if (!storeRef) return itemKeys.map(() => false);

    const resultsByKey = new Map<string, Promise<boolean>>();
    const batchKeys: string[] = [];

    for (const itemKey of [...new Set(itemKeys)]) {
      const existingItemQuery = storeRef.state.itemQueries[itemKey];
      const existingItem = storeRef.state.items[itemKey];
      const existingLoadedFields = storeRef.state.itemLoadedFields[itemKey];
      if (
        existingItemQuery !== undefined &&
        existingItem !== undefined &&
        existingLoadedFields !== undefined
      ) {
        resultsByKey.set(itemKey, Promise.resolve(existingItemQuery !== null));
        continue;
      }
      if (existingItemQuery === null) {
        resultsByKey.set(itemKey, Promise.resolve(false));
        continue;
      }

      const existingPromise = pendingItemPreloads.get(itemKey);
      if (existingPromise !== undefined) {
        resultsByKey.set(itemKey, existingPromise);
        continue;
      }

      batchKeys.push(itemKey);
    }

    if (batchKeys.length > 0) {
      const currentGeneration = generation;
      const batchPromise = itemNamespace
        .loadMany(batchKeys, { touch: 'coarse' })
        .then((cachedEntries) => {
          const resolved = new Map<string, boolean>();
          for (const [index, itemKey] of batchKeys.entries()) {
            resolved.set(
              itemKey,
              resolveAsyncPreloadedItem(
                itemKey,
                cachedEntries[index] ?? null,
                currentGeneration,
              ),
            );
          }
          return resolved;
        });

      for (const itemKey of batchKeys) {
        const itemPromise = batchPromise
          .then((resolved) => resolved.get(itemKey) ?? false)
          .finally(() => {
            if (currentGeneration === generation) {
              pendingItemPreloads.delete(itemKey);
            }
          });
        pendingItemPreloads.set(itemKey, itemPromise);
        resultsByKey.set(itemKey, itemPromise);
      }
    }

    return Promise.all(
      itemKeys.map(
        (itemKey) => resultsByKey.get(itemKey) ?? Promise.resolve(false),
      ),
    );
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
    return preloadItems(itemKeys);
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
      const skipOfflineExpirationMaintenance = isOfflineNetworkActive();
      const expiredQueryKeys = filterAndMap(
        [...managedQueryEntries.values()],
        ({ queryKey, lastAccessAt, offlineProtected }) => {
          if (skipOfflineExpirationMaintenance) return false;
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

    const invalidQueryKeys: string[] = [];
    const validEntries: Array<{
      queryKey: string;
      payload: unknown;
      lastAccessAt: number;
    }> = [];

    for (const entry of metadataEntries) {
      const payload = validateWithSchema(
        config.queryPayloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );

      if (payload === null) {
        invalidQueryKeys.push(entry.key);
      } else {
        validEntries.push({
          queryKey: entry.key,
          payload,
          lastAccessAt: entry.lastAccessAt,
        });
      }
    }

    if (invalidQueryKeys.length > 0) {
      await Promise.all(
        invalidQueryKeys.map((queryKey) => queryNamespace.remove(queryKey)),
      );
    }

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
      }
    }

    knownPersistedQueryKeys = keptQueryKeys;

    return { keptQueryKeys, managedQueryEntriesByKey: null };
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
          ],
          (e) => e.lastAccessAt,
        ),
      );

      const keptItemKeys = new Set(
        persistedItemEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
      );
      const evictedItemKeys = new Set<string>();

      await Promise.all(
        persistedItemEntries
          .filter(({ itemKey }) => !keptItemKeys.has(itemKey))
          .map(({ itemKey }) => {
            evictedItemKeys.add(itemKey);
            return itemNamespace.remove(itemKey);
          }),
      );
      for (const { itemKey } of persistedItemEntries) {
        if (!keptItemKeys.has(itemKey)) {
          forgetPersistedItem(itemKey);
        }
      }

      knownPersistedItemKeys = keptItemKeys;

      if (evictedItemKeys.size === 0 || keptQueryKeys.size === 0) return;

      const queryEntries: ManagedQueryEntry[] = managedQueryEntriesByKey
        ? [...managedQueryEntriesByKey.values()].filter(({ queryKey }) =>
            keptQueryKeys.has(queryKey),
          )
        : filterAndMap([...keptQueryKeys], (queryKey) => {
            const entry = readLocalStorageQueryEntry(queryKey);
            if (!entry) {
              forgetPersistedQuery(queryKey);
              keptQueryKeys.delete(queryKey);
              return false;
            }

            return entry;
          });

      await Promise.all(
        queryEntries.map(async (queryData) => {
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

          await saveLocalStorageQueryEntry(queryData.queryKey, {
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

    const invalidItemKeys: string[] = [];
    const validItemEntries: Array<{
      itemKey: string;
      lastAccessAt: number;
      payload: ItemPayload;
    }> = [];

    for (const entry of itemMetadataEntries) {
      const payload = validateWithSchema(
        config.itemPayloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );

      if (payload === null) {
        invalidItemKeys.push(entry.key);
      } else {
        validItemEntries.push({
          itemKey: entry.key,
          lastAccessAt: entry.lastAccessAt,
          payload,
        });
      }
    }

    if (invalidItemKeys.length > 0) {
      await Promise.all(
        invalidItemKeys.map((itemKey) => itemNamespace.remove(itemKey)),
      );
    }

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
  }

  async function flushPersistedState(): Promise<void> {
    if (!storeRef) return;

    const state = storeRef.state;
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
    const shouldTrackAsyncItemOverflow =
      localStorageAdapter === null &&
      (config.maxItems !== undefined ||
        (knownPersistedItemKeys?.size ?? 0) > maxItems ||
        hydratedPersistedItemKeys.size > maxItems ||
        itemEntries.length > maxItems);
    const shouldTrackAsyncQueryOverflow =
      localStorageAdapter === null &&
      (config.maxQueries !== undefined ||
        (knownPersistedQueryKeys?.size ?? 0) > maxQueries ||
        hydratedPersistedQueryKeys.size > maxQueries ||
        queryEntries.length > maxQueries);
    const previousItemOverflowMetadataEntries =
      knownPersistedItemKeys === null && shouldTrackAsyncItemOverflow
        ? await listAllPersistentStorageNamespaceMetadata(itemNamespace, {
            order: 'lru-desc',
          })
        : null;
    const previousQueryOverflowMetadataEntries =
      knownPersistedQueryKeys === null && shouldTrackAsyncQueryOverflow
        ? await listAllPersistentStorageNamespaceMetadata(queryNamespace, {
            order: 'lru-desc',
          })
        : null;
    const previousItemKeys =
      knownPersistedItemKeys !== null
        ? new Set(knownPersistedItemKeys)
        : previousItemOverflowMetadataEntries !== null
          ? new Set(
              previousItemOverflowMetadataEntries.map((entry) => entry.key),
            )
          : localStorageAdapter !== null ||
              shouldTrackAsyncItemOverflow ||
              itemEntries.some(([itemKey, item]) => {
                if (hydratedPersistedItemKeys.has(itemKey)) return false;
                const itemQuery = state.itemQueries[itemKey];

                return (
                  item === null ||
                  itemQuery == null ||
                  shouldIgnoreItem(itemQuery.payload)
                );
              })
            ? new Set(await ensureKnownPersistedItemKeys())
            : null;
    const previousQueryKeys =
      knownPersistedQueryKeys !== null
        ? new Set(knownPersistedQueryKeys)
        : previousQueryOverflowMetadataEntries !== null
          ? new Set(
              previousQueryOverflowMetadataEntries.map((entry) => entry.key),
            )
          : localStorageAdapter !== null || shouldTrackAsyncQueryOverflow
            ? new Set(await ensureKnownPersistedQueryKeys())
            : null;
    const previousKnownLocalItemKeys =
      previousItemKeys ?? new Set(hydratedPersistedItemKeys);
    const previousKnownLocalQueryKeys =
      previousQueryKeys ?? new Set(hydratedPersistedQueryKeys);

    if (localStorageAdapter !== null || hasIgnoreItemFilter) {
      const tasks: Promise<void>[] = [];
      const nextItemKeys = new Set<string>();
      const nextQueryKeys = new Set<string>();
      const removedItemKeys = new Set<string>();
      const removedQueryKeys = new Set<string>();
      const queryReferencedItemKeys = new Set<string>();
      const persistedQueryItemKeys = new Set<string>();

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
          const item = hasItemInState
            ? state.items[itemKey]
            : hydratedItem?.item;
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
          previousKnownLocalQueryKeys.has(queryKey)
        ) {
          continue;
        }

        querySnapshotByKey.set(queryKey, nextSnapshot);
        hydratedPersistedQueryKeys.add(queryKey);
        tasks.push(saveLocalStorageQueryEntry(queryKey, nextValue));
      }

      for (const queryKey of previousKnownLocalQueryKeys) {
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
          if (previousKnownLocalItemKeys.has(itemKey)) {
            tasks.push(itemNamespace.remove(itemKey));
            forgetPersistedItem(itemKey);
            removedItemKeys.add(itemKey);
          }
          continue;
        }

        if (shouldIgnoreItem(itemQuery.payload)) {
          if (previousKnownLocalItemKeys.has(itemKey)) {
            tasks.push(itemNamespace.remove(itemKey));
            forgetPersistedItem(itemKey);
            removedItemKeys.add(itemKey);
          }
          continue;
        }

        const isQueryReferenced = queryReferencedItemKeys.has(itemKey);
        if (isQueryReferenced && !persistedQueryItemKeys.has(itemKey)) {
          if (previousKnownLocalItemKeys.has(itemKey)) {
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
          previousKnownLocalItemKeys.has(itemKey)
        ) {
          continue;
        }

        itemSnapshotByKey.set(itemKey, nextSnapshot);
        hydratedPersistedItemKeys.add(itemKey);
        tasks.push(itemNamespace.save(itemKey, nextValue));
      }

      for (const itemKey of previousKnownLocalItemKeys) {
        if (nextItemKeys.has(itemKey)) continue;
        if (!hydratedPersistedItemKeys.has(itemKey)) continue;

        tasks.push(itemNamespace.remove(itemKey));
        forgetPersistedItem(itemKey);
        removedItemKeys.add(itemKey);
      }

      await Promise.all(tasks);

      if (previousItemKeys !== null) {
        knownPersistedItemKeys = new Set(previousItemKeys);
        for (const itemKey of removedItemKeys) {
          knownPersistedItemKeys.delete(itemKey);
        }
        for (const itemKey of nextItemKeys) {
          knownPersistedItemKeys.add(itemKey);
        }
      } else {
        knownPersistedItemKeys = null;
      }
      if (previousQueryKeys !== null) {
        knownPersistedQueryKeys = new Set(previousQueryKeys);
        for (const queryKey of removedQueryKeys) {
          knownPersistedQueryKeys.delete(queryKey);
        }
        for (const queryKey of nextQueryKeys) {
          knownPersistedQueryKeys.add(queryKey);
        }
      } else {
        knownPersistedQueryKeys = null;
      }

      if (localStorageAdapter !== null) {
        if (
          maintenanceCallbackKey !== null &&
          (hasIgnoreItemFilter ||
            (knownPersistedItemKeys !== null &&
              knownPersistedItemKeys.size > maxItems) ||
            (knownPersistedQueryKeys !== null &&
              knownPersistedQueryKeys.size > maxQueries))
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
          (knownPersistedItemKeys !== null &&
            knownPersistedItemKeys.size > maxItems) ||
          (knownPersistedQueryKeys !== null &&
            knownPersistedQueryKeys.size > maxQueries)
        ) {
          scheduleAsyncStorageMaintenance(
            `list-query:${sessionKey}:${config.storeName}`,
            runMaintenance,
          );
        }
      }
      return;
    }

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return;

    const protectedRefs = getSessionProtectedKeysSnapshot(sessionKey);
    const finalQueryDataByKey = new Map<string, PersistedListQueryData>();
    const queryReferencedItemKeys = new Set<string>();
    const finalPersistedQueryKeys = new Set(previousKnownLocalQueryKeys);

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

        return item != null && itemQuery != null;
      });

      const limitedQuery = limitPersistedQueryItems(
        filteredItems,
        query.hasMore,
        maxQuerySize,
      );
      const nextValue = {
        payload: query.payload,
        items: limitedQuery.itemKeys,
        hasMore: limitedQuery.hasMore,
      };

      finalQueryDataByKey.set(queryKey, nextValue);
      for (const itemKey of filteredItems) {
        queryReferencedItemKeys.add(itemKey);
      }
      finalPersistedQueryKeys.add(queryKey);
    }

    for (const queryKey of previousKnownLocalQueryKeys) {
      if (finalQueryDataByKey.has(queryKey)) continue;
      if (!hydratedPersistedQueryKeys.has(queryKey)) continue;
      finalPersistedQueryKeys.delete(queryKey);
    }

    if (
      previousQueryKeys !== null &&
      finalPersistedQueryKeys.size > maxQueries
    ) {
      const commitTimestamp = Date.now();
      const metadataEntries =
        previousQueryOverflowMetadataEntries ??
        (await listAllPersistentStorageNamespaceMetadata(queryNamespace, {
          order: 'lru-desc',
        }));
      const protectedQueryKeys = getProtectedKeysFromMetadata(metadataEntries);
      const candidateEntries: Array<{
        lastAccessAt: number;
        offlineProtected: boolean;
        queryKey: string;
      }> = [];

      for (const entry of metadataEntries) {
        if (!finalPersistedQueryKeys.has(entry.key)) continue;
        if (finalQueryDataByKey.has(entry.key)) continue;

        const payload = validateWithSchema(
          config.queryPayloadSchema,
          readManifestPayloadMeta(entry.customMetadata),
        );
        if (payload === null) {
          finalPersistedQueryKeys.delete(entry.key);
          continue;
        }

        candidateEntries.push({
          lastAccessAt: entry.lastAccessAt,
          offlineProtected: protectedQueryKeys.has(entry.key),
          queryKey: entry.key,
        });
      }

      for (const [queryKey] of finalQueryDataByKey) {
        candidateEntries.push({
          lastAccessAt: commitTimestamp,
          offlineProtected:
            protectedQueryKeys.has(queryKey) ||
            protectedRefs?.has(
              serializeProtectedRef({
                key: queryKey,
                kind: 'listQuery.query',
                sessionKey,
                storeName: config.storeName,
              }),
            ) === true,
          queryKey,
        });
      }

      candidateEntries.sort(
        createEvictionComparator(
          [
            (entry) => entry.offlineProtected,
            (entry) => pinnedQueryKeys.has(entry.queryKey),
          ],
          (entry) => entry.lastAccessAt,
        ),
      );

      finalPersistedQueryKeys.clear();
      for (const { queryKey } of candidateEntries.slice(0, maxQueries)) {
        finalPersistedQueryKeys.add(queryKey);
      }

      const evictedQueryKeys: string[] = [];
      for (const queryKey of finalQueryDataByKey.keys()) {
        if (!finalPersistedQueryKeys.has(queryKey)) {
          evictedQueryKeys.push(queryKey);
        }
      }
      for (const queryKey of evictedQueryKeys) {
        finalQueryDataByKey.delete(queryKey);
      }
    }

    const persistedQueryItemKeys = new Set<string>();
    for (const queryData of finalQueryDataByKey.values()) {
      for (const itemKey of queryData.items) {
        persistedQueryItemKeys.add(itemKey);
      }
    }

    const finalItemDataByKey = new Map<
      string,
      PersistedListQueryItemData<ItemState | StorageState>
    >();
    const finalPersistedItemKeys = new Set(previousKnownLocalItemKeys);

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
        if (previousKnownLocalItemKeys.has(itemKey)) {
          finalPersistedItemKeys.delete(itemKey);
        }
        continue;
      }

      const isQueryReferenced = queryReferencedItemKeys.has(itemKey);
      if (isQueryReferenced && !persistedQueryItemKeys.has(itemKey)) {
        if (previousKnownLocalItemKeys.has(itemKey)) {
          finalPersistedItemKeys.delete(itemKey);
        }
        continue;
      }

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
      finalItemDataByKey.set(itemKey, nextValue);
      finalPersistedItemKeys.add(itemKey);
    }

    for (const itemKey of previousKnownLocalItemKeys) {
      if (finalItemDataByKey.has(itemKey)) continue;
      if (!hydratedPersistedItemKeys.has(itemKey)) continue;
      finalPersistedItemKeys.delete(itemKey);
    }

    if (previousItemKeys !== null && finalPersistedItemKeys.size > maxItems) {
      const metadataEntries =
        previousItemOverflowMetadataEntries ??
        (await listAllPersistentStorageNamespaceMetadata(itemNamespace, {
          order: 'lru-desc',
        }));
      const commitTimestamp = Date.now();
      const metadataByKey = new Map(
        metadataEntries.map((entry) => [entry.key, entry] as const),
      );
      const protectedItemKeys = getProtectedKeysFromMetadata(metadataEntries);
      const candidateEntries: Array<{
        itemKey: string;
        lastAccessAt: number;
        offlineProtected: boolean;
      }> = [];

      for (const entry of metadataEntries) {
        if (!finalPersistedItemKeys.has(entry.key)) continue;
        if (finalItemDataByKey.has(entry.key)) continue;

        const payload = validateWithSchema(
          config.itemPayloadSchema,
          readManifestPayloadMeta(entry.customMetadata),
        );
        if (payload === null) {
          finalPersistedItemKeys.delete(entry.key);
          continue;
        }

        candidateEntries.push({
          itemKey: entry.key,
          lastAccessAt: entry.lastAccessAt,
          offlineProtected: protectedItemKeys.has(entry.key),
        });
      }

      for (const [itemKey] of finalItemDataByKey) {
        const existingMetadata = metadataByKey.get(itemKey);
        candidateEntries.push({
          itemKey,
          lastAccessAt: existingMetadata?.lastAccessAt ?? commitTimestamp,
          offlineProtected:
            protectedItemKeys.has(itemKey) ||
            protectedRefs?.has(
              serializeProtectedRef({
                key: itemKey,
                kind: 'listQuery.item',
                sessionKey,
                storeName: config.storeName,
              }),
            ) === true,
        });
      }

      let nonProtectedCount = 0;
      for (const entry of candidateEntries) {
        if (!entry.offlineProtected) nonProtectedCount++;
      }
      const needsEviction =
        candidateEntries.length > maxItems && nonProtectedCount > maxItems;
      if (needsEviction) {
        candidateEntries.sort(
          createEvictionComparator(
            [
              (entry) => entry.offlineProtected,
              (entry) => pinnedItemKeys.has(entry.itemKey),
            ],
            (entry) => entry.lastAccessAt,
          ),
        );
      }
      const keptItemKeys = new Set(
        (needsEviction
          ? candidateEntries.slice(0, maxItems)
          : candidateEntries
        ).map(({ itemKey }) => itemKey),
      );

      finalPersistedItemKeys.clear();
      for (const itemKey of keptItemKeys) {
        finalPersistedItemKeys.add(itemKey);
      }

      const evictedItemKeys: string[] = [];
      for (const itemKey of finalItemDataByKey.keys()) {
        if (!finalPersistedItemKeys.has(itemKey)) {
          evictedItemKeys.push(itemKey);
        }
      }
      for (const itemKey of evictedItemKeys) {
        finalItemDataByKey.delete(itemKey);
      }
    }

    const removedQueryKeys = [...previousKnownLocalQueryKeys].filter(
      (queryKey) => !finalPersistedQueryKeys.has(queryKey),
    );
    const removedItemKeys = [...previousKnownLocalItemKeys].filter(
      (itemKey) => !finalPersistedItemKeys.has(itemKey),
    );
    const queryUpserts = new Map<
      string,
      { snapshot: string; value: PersistedListQueryData }
    >();
    const itemUpserts = new Map<
      string,
      {
        snapshot: string;
        value: PersistedListQueryItemData<ItemState | StorageState>;
      }
    >();

    for (const [queryKey, value] of finalQueryDataByKey) {
      if (!finalPersistedQueryKeys.has(queryKey)) continue;

      const snapshot = JSON.stringify(value);
      const existingSnapshot = querySnapshotByKey.get(queryKey);
      if (
        existingSnapshot === snapshot &&
        previousKnownLocalQueryKeys.has(queryKey)
      ) {
        continue;
      }

      queryUpserts.set(queryKey, { snapshot, value });
    }

    for (const [itemKey, value] of finalItemDataByKey) {
      if (!finalPersistedItemKeys.has(itemKey)) continue;

      const snapshot = JSON.stringify(value);
      const existingSnapshot = itemSnapshotByKey.get(itemKey);
      if (
        existingSnapshot === snapshot &&
        previousKnownLocalItemKeys.has(itemKey)
      ) {
        continue;
      }

      itemUpserts.set(itemKey, { snapshot, value });
    }

    const commitTasks: Promise<void>[] = [];
    if (removedQueryKeys.length > 0 || queryUpserts.size > 0) {
      commitTasks.push(
        queryNamespace.commit({
          removes: removedQueryKeys,
          staticPolicy: persistedQueryStaticPolicy,
          upserts: Array.from(queryUpserts, ([key, entry]) => ({
            data: entry.value,
            key,
          })),
        }),
      );
    }
    if (removedItemKeys.length > 0 || itemUpserts.size > 0) {
      commitTasks.push(
        itemNamespace.commit({
          removes: removedItemKeys,
          staticPolicy: persistedItemStaticPolicy,
          upserts: Array.from(itemUpserts, ([key, entry]) => ({
            data: entry.value,
            key,
          })),
        }),
      );
    }
    await Promise.all(commitTasks);

    for (const queryKey of removedQueryKeys) {
      forgetPersistedQuery(queryKey);
    }
    for (const [queryKey, entry] of queryUpserts) {
      querySnapshotByKey.set(queryKey, entry.snapshot);
      hydratedPersistedQueryKeys.add(queryKey);
    }
    for (const itemKey of removedItemKeys) {
      forgetPersistedItem(itemKey);
    }
    for (const [itemKey, entry] of itemUpserts) {
      itemSnapshotByKey.set(itemKey, entry.snapshot);
      hydratedPersistedItemKeys.add(itemKey);
    }

    knownPersistedQueryKeys =
      previousQueryKeys !== null ? new Set(finalPersistedQueryKeys) : null;
    knownPersistedItemKeys =
      previousItemKeys !== null ? new Set(finalPersistedItemKeys) : null;

    if (
      (knownPersistedItemKeys !== null &&
        knownPersistedItemKeys.size > maxItems) ||
      (knownPersistedQueryKeys !== null &&
        knownPersistedQueryKeys.size > maxQueries)
    ) {
      scheduleAsyncStorageMaintenance(
        `list-query:${sessionKey}:${config.storeName}`,
        runMaintenance,
      );
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
    if (localStorageAdapter === null && asyncStorageAdapter !== null) {
      const sessionKey = config.getSessionKey();
      if (sessionKey !== false) {
        registerAsyncStartupStoreCleanup(
          asyncStorageAdapter,
          sessionKey,
          config.storeName,
          planAsyncStartupCleanup,
        );
      }
    }
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
    if (localStorageAdapter === null && asyncStorageAdapter !== null) {
      const sessionKey = config.getSessionKey();
      if (sessionKey !== false) {
        unregisterAsyncStartupStoreCleanup(
          asyncStorageAdapter,
          sessionKey,
          config.storeName,
        );
      }
    }
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
