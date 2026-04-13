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
  estimateManagedAsyncStorageEntrySizeBytes,
  getProtectedKeysFromMetadata,
  mergeManagedAsyncStorageCustomMetadata,
  readAsyncStorageNamespaceIndexStateUsingDriver,
  registerAsyncStartupStoreCleanup,
  serializeProtectedRef,
  unregisterAsyncStartupStoreCleanup,
  type AsyncStartupCleanupScopePlan,
  type AsyncStartupCleanupStoreDeletePlan,
} from './asyncStorageAdapter';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getPayloadRecordKey,
} from './asyncStorageShared';
import {
  createCompactListQueryLocalStorageEntry,
  parseCompactListQueryLocalStorageEntry,
} from './compactListQueryLocalStorageEntry';
import { createCompactLocalStorageEntry } from './compactLocalStorageEntry';
import { isManagedLocalStorageEntryOfflineProtected } from './localStorageMetadata';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import type {
  AnyOfflineOperationDefinition,
  ListQueryOfflineEntityRef,
} from './offline/types';
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
  createShouldIgnoreItemPredicate,
  getSerializedStringSize,
  keepEntriesWithinByteBudget,
  serializeJsonForStorage,
  createTimedKeySet,
} from './persistenceUtils';
import { getDefaultMaxBytesForScope } from './persistentStorageDefaults';
import {
  assertValidPersistentStoreName,
  createPersistentStorageNamespaceHandle,
  getLocalStorageAdapter,
  getLocalStorageMaxAgeMs,
  isOfflineNetworkModeActiveSync,
  getStoragePrefixForStoreNamespace,
  listAllPersistentStorageNamespaceMetadata,
  listPersistentStorageNamespaceMetadataByFilter,
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
  sizeBytes: number;
};

type ManagedQueryEntriesByKey = Map<string, ManagedQueryEntry>;
type EntryNamespaceMetadata = { h?: true; p?: unknown };
type ItemEntryNamespaceMetadata = EntryNamespaceMetadata & {
  f?: string[];
  g?: unknown;
};

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

function readManifestGroupMeta(meta: unknown): string | undefined {
  if (typeof meta !== 'object' || meta === null || !('g' in meta)) {
    return undefined;
  }

  return typeof meta.g === 'string' ? meta.g : undefined;
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
  preloadItemsByDerivedQueryGroup(groupKeys: string[]): Promise<boolean[]>;
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
    getItemDerivedGroup?: (item: ItemState, itemPayload: ItemPayload) => string;
  } = {},
): ListQueryPersistenceSetup<ItemState, QueryPayload, ItemPayload> {
  type State = TSFDListQueryState<ItemState, QueryPayload, ItemPayload>;

  assertValidPersistentStoreName(config.storeName);

  const version = config.version;
  const defaultMaxItemBytes = getDefaultMaxBytesForScope({
    adapter: config.adapter,
    scopeKind: 'listQuery.item',
  });
  const defaultMaxQueryBytes = getDefaultMaxBytesForScope({
    adapter: config.adapter,
    scopeKind: 'listQuery.query',
  });
  const maxItemBytes = config.maxItemBytes ?? defaultMaxItemBytes;
  const maxQueryBytes = config.maxQueryBytes ?? defaultMaxQueryBytes;
  const maxQuerySize = config.maxQuerySize ?? DEFAULT_MAX_QUERY_SIZE;
  const resolveItemKey =
    options.getItemKey ?? ((payload: ItemPayload) => getCompositeKey(payload));
  const resolveQueryKey =
    options.getQueryKey ??
    ((payload: QueryPayload) => getCompositeKey(payload));
  const getItemDerivedGroup = options.getItemDerivedGroup;
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
          config.maxItemBytes,
          defaultMaxItemBytes,
          pinnedItemKeys,
        )
      : null;
  const persistedQueryStaticPolicy =
    localStorageAdapter === null
      ? buildPersistedStaticPolicy(
          config.maxQueryBytes,
          defaultMaxQueryBytes,
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
    deserialize: (value: unknown, metadata?: EntryNamespaceMetadata) =>
      typeof value === 'object' &&
      value !== null &&
      'd' in value &&
      ('p' in value || metadata?.p !== undefined)
        ? parsePersistedListQueryItemData(
            {
              data: value.d,
              payload: 'p' in value ? value.p : metadata?.p,
              ...('lf' in value && Array.isArray(value.lf)
                ? { loadedFields: value.lf }
                : {}),
            },
            config.itemPayloadSchema,
            dataSchema,
          )
        : null,
  };
  const asyncItemStorageValueCodec = {
    serialize: (data: PersistedListQueryItemData<ItemState | StorageState>) =>
      data.data,
    deserialize: (value: unknown, metadata?: ItemEntryNamespaceMetadata) =>
      metadata?.p !== undefined
        ? parsePersistedListQueryItemData(
            {
              data: value,
              payload: metadata.p,
              ...(Array.isArray(metadata.f)
                ? { loadedFields: metadata.f }
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
  const asyncQueryStorageValueCodec = {
    serialize: (data: PersistedListQueryData) => data.items,
    deserialize: (value: unknown, metadata?: EntryNamespaceMetadata) =>
      Array.isArray(value)
        ? parsePersistedListQueryData(
            {
              payload: metadata?.p,
              items: value,
              hasMore: metadata?.h === true,
            },
            config.queryPayloadSchema,
          )
        : null,
  };

  const itemNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryItemData<ItemState | StorageState>,
    ItemEntryNamespaceMetadata
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX },
    {
      asyncValueCodec: asyncItemStorageValueCodec,
      getManifestMeta: (data) => ({
        ...(Array.isArray(data.loadedFields) ? { f: data.loadedFields } : {}),
        p: data.payload,
      }),
      valueCodec: itemStorageValueCodec,
    },
  );
  const queryNamespace = createPersistentStorageNamespaceHandle<
    PersistedListQueryData,
    EntryNamespaceMetadata
  >(
    { ...persistentConfig, entryPrefix: LIST_QUERY_QUERY_STORAGE_ENTRY_PREFIX },
    {
      asyncValueCodec: asyncQueryStorageValueCodec,
      valueCodec: queryStorageValueCodec,
      getManifestMeta: (data) => ({
        ...(data.hasMore ? { h: true as const } : {}),
        p: data.payload,
      }),
    },
  );
  function getAsyncItemNamespaceScope():
    | (AsyncStorageNamespaceScope & { kind: 'listQuery.item' })
    | null {
    if (asyncStorageAdapter === null) return null;
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return { kind: 'listQuery.item', sessionKey, storeName: config.storeName };
  }

  function getAsyncQueryNamespaceScope():
    | (AsyncStorageNamespaceScope & { kind: 'listQuery.query' })
    | null {
    if (asyncStorageAdapter === null) return null;
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return { kind: 'listQuery.query', sessionKey, storeName: config.storeName };
  }

  function estimateAsyncItemEntrySizeBytes(args: {
    currentCustomMetadata?: Record<string, unknown>;
    itemKey: string;
    lastAccessAt: number;
    nextCustomMetadata: ItemEntryNamespaceMetadata;
    protectedKeysSnapshotSet?: Set<string> | null;
    value: PersistedListQueryItemData<unknown>;
  }): number {
    const asyncItemNamespaceScope = getAsyncItemNamespaceScope();
    if (asyncItemNamespaceScope === null) {
      return JSON.stringify(args.value).length;
    }

    const serializedValue = serializeJsonForStorage(args.value.data);
    const customMetadata = mergeManagedAsyncStorageCustomMetadata({
      currentCustomMetadata: args.currentCustomMetadata,
      key: args.itemKey,
      nextCustomMetadata: args.nextCustomMetadata,
      protectedKeysSnapshotSet: args.protectedKeysSnapshotSet,
      scope: asyncItemNamespaceScope,
    });

    return estimateManagedAsyncStorageEntrySizeBytes({
      customMetadata,
      lastAccessAt: args.lastAccessAt,
      serializedValue: serializedValue.rawValue,
      version: version ?? 1,
    });
  }

  function estimateAsyncQueryEntrySizeBytes(args: {
    currentCustomMetadata?: Record<string, unknown>;
    lastAccessAt: number;
    protectedKeysSnapshotSet?: Set<string> | null;
    queryKey: string;
    value: PersistedListQueryData;
  }): number {
    const asyncQueryNamespaceScope = getAsyncQueryNamespaceScope();
    if (asyncQueryNamespaceScope === null) {
      return JSON.stringify(args.value).length;
    }

    const serializedValue = serializeJsonForStorage(args.value.items);
    const customMetadata = mergeManagedAsyncStorageCustomMetadata({
      currentCustomMetadata: args.currentCustomMetadata,
      key: args.queryKey,
      nextCustomMetadata: {
        ...(args.value.hasMore ? { h: true as const } : {}),
        p: args.value.payload,
      },
      protectedKeysSnapshotSet: args.protectedKeysSnapshotSet,
      scope: asyncQueryNamespaceScope,
    });

    return estimateManagedAsyncStorageEntrySizeBytes({
      customMetadata,
      lastAccessAt: args.lastAccessAt,
      serializedValue: serializedValue.rawValue,
      version: version ?? 1,
    });
  }

  let storeRef: Store<State> | null = null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressedPersistedStateFlushes = 0;
  const pendingItemPreloads = new Map<string, Promise<boolean>>();
  const pendingQueryPreloads = new Map<string, Promise<boolean>>();
  const itemSnapshotByKey = new Map<string, string>();
  const querySnapshotByKey = new Map<string, string>();
  const itemSizeBytesByKey = new Map<string, number>();
  const querySizeBytesByKey = new Map<string, number>();
  const hydratedPersistedItemKeys = new Set<string>();
  const hydratedPersistedQueryKeys = new Set<string>();
  const syncHydrationItemMissCache = createTimedKeySet();
  const syncHydrationQueryMissCache = createTimedKeySet();
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

  function getLocalStorageItemEntrySizeBytes(
    value: PersistedListQueryItemData<unknown>,
  ): number {
    return serializeJsonForStorage(
      createCompactLocalStorageEntry(
        {
          d: value.data,
          p: value.payload,
          ...(value.loadedFields !== undefined
            ? { lf: value.loadedFields }
            : {}),
        },
        version,
      ),
    ).sizeBytes;
  }

  function readLocalStorageQueryEntry(
    queryKey: string,
  ): ManagedQueryEntry | undefined {
    if (localStorageAdapter === null) return undefined;

    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false) return undefined;

    const rawEntry = localStorageAdapter.readRaw(storageKey);
    const entry = parseCompactListQueryLocalStorageEntry(rawEntry);
    if (entry === null || entry.version !== version) {
      return undefined;
    }

    const sizeBytes =
      rawEntry === null
        ? 0
        : rememberQueryMetadataSize(
            queryKey,
            getSerializedStringSize(rawEntry),
          );

    return {
      queryKey,
      payload: entry.payload,
      items: entry.items,
      hasMore: entry.hasMore,
      lastAccessAt: entry.lastAccessAt,
      offlineProtected: entry.offlineProtected,
      sizeBytes,
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

        const { sizeBytes } = localStorageAdapter.write(
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
        rememberQueryMetadataSize(queryKey, sizeBytes);
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

      const { sizeBytes } = localStorageAdapter.write(
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
      rememberQueryMetadataSize(queryKey, sizeBytes);

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

  function rememberItemMetadataSize(
    itemKey: string,
    sizeBytes: number | undefined,
  ): number {
    const resolvedSizeBytes = sizeBytes ?? itemSizeBytesByKey.get(itemKey);
    if (resolvedSizeBytes !== undefined) {
      itemSizeBytesByKey.set(itemKey, resolvedSizeBytes);
      return resolvedSizeBytes;
    }

    return 0;
  }

  function rememberQueryMetadataSize(
    queryKey: string,
    sizeBytes: number | undefined,
  ): number {
    const resolvedSizeBytes = sizeBytes ?? querySizeBytesByKey.get(queryKey);
    if (resolvedSizeBytes !== undefined) {
      querySizeBytesByKey.set(queryKey, resolvedSizeBytes);
      return resolvedSizeBytes;
    }

    return 0;
  }

  function getKnownPersistedItemBytes(
    itemKeys: ReadonlySet<string> | null,
  ): number | null {
    if (itemKeys === null) return null;

    let totalBytes = 0;
    for (const itemKey of itemKeys) {
      const sizeBytes = itemSizeBytesByKey.get(itemKey);
      if (sizeBytes === undefined) return null;
      totalBytes += sizeBytes;
    }

    return totalBytes;
  }

  function getKnownPersistedQueryBytes(
    queryKeys: ReadonlySet<string> | null,
  ): number | null {
    if (queryKeys === null) return null;

    let totalBytes = 0;
    for (const queryKey of queryKeys) {
      const sizeBytes = querySizeBytesByKey.get(queryKey);
      if (sizeBytes === undefined) return null;
      totalBytes += sizeBytes;
    }

    return totalBytes;
  }

  function rememberHydratedItem(
    itemKey: string,
    persisted: PersistedListQueryItemData<unknown>,
  ): void {
    hydratedPersistedItemKeys.add(itemKey);
    syncHydrationItemMissCache.clear(itemKey);
    const snapshot = JSON.stringify(persisted);
    itemSnapshotByKey.set(itemKey, snapshot);
    if (localStorageAdapter !== null) {
      itemSizeBytesByKey.set(
        itemKey,
        getLocalStorageItemEntrySizeBytes(persisted),
      );
    } else {
      const nextCustomMetadata: ItemEntryNamespaceMetadata = {
        p: persisted.payload,
      };
      if (getItemDerivedGroup) {
        const parsedPersisted = parsePersistedListQueryItemData(
          persisted,
          config.itemPayloadSchema,
          dataSchema,
        );
        const itemState =
          parsedPersisted === null
            ? null
            : toItemState(parsedPersisted, dataSchema, shouldIgnoreItem);
        if (itemState !== null) {
          nextCustomMetadata.g = getItemDerivedGroup(
            itemState.item,
            itemState.itemQuery.payload,
          );
        }
      }
      itemSizeBytesByKey.set(
        itemKey,
        estimateAsyncItemEntrySizeBytes({
          itemKey,
          lastAccessAt: Date.now(),
          nextCustomMetadata,
          value: persisted,
        }),
      );
    }
    knownPersistedItemKeys?.add(itemKey);
  }

  function rememberHydratedQuery(
    queryKey: string,
    persisted: PersistedListQueryData,
    localSizeBytes?: number,
  ): void {
    hydratedPersistedQueryKeys.add(queryKey);
    syncHydrationQueryMissCache.clear(queryKey);
    const snapshot = JSON.stringify(persisted);
    querySnapshotByKey.set(queryKey, snapshot);
    if (localStorageAdapter !== null) {
      querySizeBytesByKey.set(
        queryKey,
        localSizeBytes ?? getSerializedStringSize(snapshot),
      );
    } else {
      querySizeBytesByKey.set(
        queryKey,
        estimateAsyncQueryEntrySizeBytes({
          lastAccessAt: Date.now(),
          queryKey,
          value: persisted,
        }),
      );
    }
    knownPersistedQueryKeys?.add(queryKey);
  }

  function forgetPersistedItem(itemKey: string): void {
    hydratedPersistedItemKeys.delete(itemKey);
    itemSnapshotByKey.delete(itemKey);
    itemSizeBytesByKey.delete(itemKey);
    knownPersistedItemKeys?.delete(itemKey);
  }

  function forgetPersistedQuery(queryKey: string): void {
    hydratedPersistedQueryKeys.delete(queryKey);
    querySnapshotByKey.delete(queryKey);
    querySizeBytesByKey.delete(queryKey);
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
    if (syncHydrationItemMissCache.has(itemKey)) return undefined;

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
      syncHydrationItemMissCache.remember(itemKey);
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const persisted = parsePersistedListQueryItemData(
      cacheEntry.data,
      config.itemPayloadSchema,
      dataSchema,
    );
    if (!persisted) {
      syncHydrationItemMissCache.remember(itemKey);
      scheduleLocalStorageRemoval(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      });
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const itemState = toItemState(persisted, dataSchema, shouldIgnoreItem);
    if (!itemState) {
      syncHydrationItemMissCache.remember(itemKey);
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
    if (syncHydrationQueryMissCache.has(queryKey)) return undefined;

    const storageKey = getLocalStorageQueryStorageKey(queryKey);
    if (storageKey === false || localStorageAdapter === null) {
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const rawEntry = localStorageAdapter.readRaw(storageKey);
    if (rawEntry === null) {
      syncHydrationQueryMissCache.remember(queryKey);
      forgetPersistedQuery(queryKey);
      return undefined;
    }

    const entry = parseCompactListQueryLocalStorageEntry(rawEntry);
    if (entry === null || entry.version !== version) {
      syncHydrationQueryMissCache.remember(queryKey);
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
      syncHydrationQueryMissCache.remember(queryKey);
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
    rememberHydratedQuery(
      queryKey,
      {
        payload: persistedQuery.payload,
        items: persistedQuery.items,
        hasMore: persistedQuery.hasMore,
      },
      getSerializedStringSize(rawEntry),
    );
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

  async function preloadItemsByDerivedQueryGroup(
    groupKeys: string[],
  ): Promise<boolean[]> {
    if (!getItemDerivedGroup) {
      return groupKeys.map(() => false);
    }

    const resultsByGroupKey = new Map<string, Promise<boolean>>();

    for (const groupKey of [...new Set(groupKeys)]) {
      resultsByGroupKey.set(
        groupKey,
        (async () => {
          const sessionKey = config.getSessionKey();
          if (sessionKey === false) return false;

          let itemKeys: string[];

          if (localStorageAdapter !== null) {
            const itemPrefix = getStoragePrefixForStoreNamespace(
              sessionKey,
              config.storeName,
              LIST_QUERY_ITEM_STORAGE_ENTRY_PREFIX,
            );
            itemKeys = localStorageAdapter
              .listManifestEntries(itemPrefix)
              .flatMap((entry) => {
                const payload = validateWithSchema(
                  config.itemPayloadSchema,
                  readManifestPayloadMeta(entry.meta),
                );
                if (payload === null || shouldIgnoreItem(payload)) {
                  return [];
                }

                return readManifestGroupMeta(entry.meta) === groupKey
                  ? [entry.entryKey]
                  : [];
              });
          } else {
            const metadataEntries =
              await listPersistentStorageNamespaceMetadataByFilter(
                itemNamespace,
                { equals: groupKey, key: 'g', order: 'key' },
              );
            itemKeys = metadataEntries.flatMap((entry) => {
              const payload = validateWithSchema(
                config.itemPayloadSchema,
                readManifestPayloadMeta(entry.customMetadata),
              );
              if (payload === null || shouldIgnoreItem(payload)) {
                return [];
              }

              return [entry.key];
            });
          }

          if (itemKeys.length === 0) return false;

          const results = await preloadItems(itemKeys);
          return results.some(Boolean);
        })(),
      );
    }

    return Promise.all(
      groupKeys.map(
        (groupKey) => resultsByGroupKey.get(groupKey) ?? Promise.resolve(false),
      ),
    );
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
            sizeBytes: entry.sizeBytes,
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

      const keptQueryKeys = keepEntriesWithinByteBudget({
        entries: filteredEntries,
        getKey: (entry) => entry.queryKey,
        getLastAccessAt: (entry) => entry.lastAccessAt,
        getSizeBytes: (entry) => entry.sizeBytes,
        isPinned: (entry) => pinnedQueryKeys.has(entry.queryKey),
        isProtected: (entry) => entry.offlineProtected,
        maxBytes: maxQueryBytes,
      });

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
      sizeBytes: number;
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
          sizeBytes: rememberQueryMetadataSize(entry.key, entry.sizeBytes),
        });
      }
    }

    if (invalidQueryKeys.length > 0) {
      await Promise.all(
        invalidQueryKeys.map((queryKey) => queryNamespace.remove(queryKey)),
      );
    }

    const keptQueryKeys = keepEntriesWithinByteBudget({
      entries: validEntries,
      getKey: (entry) => entry.queryKey,
      getLastAccessAt: (entry) => entry.lastAccessAt,
      getSizeBytes: (entry) => entry.sizeBytes,
      isPinned: (entry) => pinnedQueryKeys.has(entry.queryKey),
      isProtected: (entry) => protectedQueryKeys.has(entry.queryKey),
      maxBytes: maxQueryBytes,
    });

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
      const metadataEntriesWithPayload = metadataEntries.map((entry) => ({
        itemKey: entry.entryKey,
        lastAccessAt: entry.lastAccessAt,
        sizeBytes: rememberItemMetadataSize(entry.entryKey, entry.sizeBytes),
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
        ({ itemKey, lastAccessAt, payload, sizeBytes }) =>
          payload === null
            ? false
            : { itemKey, lastAccessAt, payload, sizeBytes },
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

      const keptItemKeys = keepEntriesWithinByteBudget({
        entries: persistedItemEntries,
        getKey: (entry) => entry.itemKey,
        getLastAccessAt: (entry) => entry.lastAccessAt,
        getSizeBytes: (entry) => entry.sizeBytes,
        isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
        isProtected: (entry) => protectedItemKeys.has(entry.itemKey),
        maxBytes: maxItemBytes,
      });
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

    const invalidItemKeys: string[] = [];
    const validItemEntries: Array<{
      itemKey: string;
      lastAccessAt: number;
      payload: ItemPayload;
      sizeBytes: number;
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
          sizeBytes: rememberItemMetadataSize(entry.key, entry.sizeBytes),
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

    const keptItemKeys = keepEntriesWithinByteBudget({
      entries: persistedItemEntries,
      getKey: (entry) => entry.itemKey,
      getLastAccessAt: (entry) => entry.lastAccessAt,
      getSizeBytes: (entry) => entry.sizeBytes,
      isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
      isProtected: (entry) => protectedItemKeys.has(entry.itemKey),
      maxBytes: maxItemBytes,
    });

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
    const knownPersistedItemBytes = getKnownPersistedItemBytes(
      knownPersistedItemKeys,
    );
    const knownPersistedQueryBytes = getKnownPersistedQueryBytes(
      knownPersistedQueryKeys,
    );
    const shouldTrackAsyncItemOverflow =
      localStorageAdapter === null &&
      (knownPersistedItemBytes === null ||
        knownPersistedItemBytes > maxItemBytes);
    const shouldTrackAsyncQueryOverflow =
      localStorageAdapter === null &&
      (knownPersistedQueryBytes === null ||
        knownPersistedQueryBytes > maxQueryBytes);
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
          : new Set(await ensureKnownPersistedItemKeys());
    const previousQueryKeys =
      knownPersistedQueryKeys !== null
        ? new Set(knownPersistedQueryKeys)
        : previousQueryOverflowMetadataEntries !== null
          ? new Set(
              previousQueryOverflowMetadataEntries.map((entry) => entry.key),
            )
          : new Set(await ensureKnownPersistedQueryKeys());
    const previousKnownLocalItemKeys = previousItemKeys;
    const previousKnownLocalQueryKeys = previousQueryKeys;

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
        if (localStorageAdapter === null) {
          querySizeBytesByKey.set(
            queryKey,
            estimateAsyncQueryEntrySizeBytes({
              lastAccessAt: Date.now(),
              queryKey,
              value: nextValue,
            }),
          );
        }
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
        if (localStorageAdapter === null) {
          itemSizeBytesByKey.set(
            itemKey,
            estimateAsyncItemEntrySizeBytes({
              itemKey,
              lastAccessAt: Date.now(),
              nextCustomMetadata: {
                p: itemQuery.payload,
                ...(getItemDerivedGroup
                  ? { g: getItemDerivedGroup(item, itemQuery.payload) }
                  : {}),
              },
              value: nextValue,
            }),
          );
        } else {
          itemSizeBytesByKey.set(
            itemKey,
            getLocalStorageItemEntrySizeBytes(nextValue),
          );
        }
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
        const nextKnownPersistedItemBytes = getKnownPersistedItemBytes(
          knownPersistedItemKeys,
        );
        const nextKnownPersistedQueryBytes = getKnownPersistedQueryBytes(
          knownPersistedQueryKeys,
        );
        if (
          maintenanceCallbackKey !== null &&
          (hasIgnoreItemFilter ||
            nextKnownPersistedItemBytes === null ||
            nextKnownPersistedQueryBytes === null ||
            nextKnownPersistedItemBytes > maxItemBytes ||
            nextKnownPersistedQueryBytes > maxQueryBytes)
        ) {
          scheduleLocalStorageMaintenance({
            forceManifestKeys: [maintenanceCallbackKey],
          });
        }
        return;
      }

      const sessionKey = config.getSessionKey();
      if (sessionKey !== false) {
        const nextKnownPersistedItemBytes = getKnownPersistedItemBytes(
          knownPersistedItemKeys,
        );
        const nextKnownPersistedQueryBytes = getKnownPersistedQueryBytes(
          knownPersistedQueryKeys,
        );
        if (
          hasIgnoreItemFilter ||
          nextKnownPersistedItemBytes === null ||
          nextKnownPersistedQueryBytes === null ||
          nextKnownPersistedItemBytes > maxItemBytes ||
          nextKnownPersistedQueryBytes > maxQueryBytes
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
    const finalQuerySizeBytesByKey = new Map<string, number>();
    const finalItemSizeBytesByKey = new Map<string, number>();
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

    const commitTimestamp = Date.now();
    const metadataEntries =
      previousQueryOverflowMetadataEntries ??
      (await listAllPersistentStorageNamespaceMetadata(queryNamespace, {
        order: 'lru-desc',
      }));
    const metadataByKey = new Map(
      metadataEntries.map((entry) => [entry.key, entry] as const),
    );
    const protectedQueryKeys = getProtectedKeysFromMetadata(metadataEntries);
    const candidateEntries: Array<{
      lastAccessAt: number;
      offlineProtected: boolean;
      queryKey: string;
      sizeBytes: number;
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
        sizeBytes: rememberQueryMetadataSize(entry.key, entry.sizeBytes),
      });
    }

    for (const [queryKey, queryData] of finalQueryDataByKey) {
      const sizeBytes = estimateAsyncQueryEntrySizeBytes({
        currentCustomMetadata: metadataByKey.get(queryKey)?.customMetadata,
        lastAccessAt: commitTimestamp,
        protectedKeysSnapshotSet: protectedRefs,
        queryKey,
        value: queryData,
      });
      finalQuerySizeBytesByKey.set(queryKey, sizeBytes);
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
        sizeBytes,
      });
    }

    const keptQueryKeys = keepEntriesWithinByteBudget({
      entries: candidateEntries,
      getKey: (entry) => entry.queryKey,
      getLastAccessAt: (entry) => entry.lastAccessAt,
      getSizeBytes: (entry) => entry.sizeBytes,
      isPinned: (entry) => pinnedQueryKeys.has(entry.queryKey),
      isProtected: (entry) => entry.offlineProtected,
      maxBytes: maxQueryBytes,
    });

    finalPersistedQueryKeys.clear();
    for (const queryKey of keptQueryKeys) {
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

    const persistedQueryItemKeys = new Set<string>();
    for (const queryData of finalQueryDataByKey.values()) {
      for (const itemKey of queryData.items) {
        persistedQueryItemKeys.add(itemKey);
      }
    }

    const finalItemDataByKey = new Map<
      string,
      {
        metadata: ItemEntryNamespaceMetadata;
        value: PersistedListQueryItemData<ItemState | StorageState>;
      }
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
      finalItemDataByKey.set(itemKey, {
        metadata: {
          ...(Array.isArray(loadedFields) ? { f: loadedFields } : {}),
          p: itemQuery.payload,
          ...(getItemDerivedGroup
            ? { g: getItemDerivedGroup(item, itemQuery.payload) }
            : {}),
        },
        value: nextValue,
      });
      finalPersistedItemKeys.add(itemKey);
    }

    for (const itemKey of previousKnownLocalItemKeys) {
      if (finalItemDataByKey.has(itemKey)) continue;
      if (!hydratedPersistedItemKeys.has(itemKey)) continue;
      finalPersistedItemKeys.delete(itemKey);
    }

    const itemMetadataEntries =
      previousItemOverflowMetadataEntries ??
      (await listAllPersistentStorageNamespaceMetadata(itemNamespace, {
        order: 'lru-desc',
      }));
    const itemCommitTimestamp = Date.now();
    const itemMetadataByKey = new Map(
      itemMetadataEntries.map((entry) => [entry.key, entry] as const),
    );
    const protectedItemKeys = getProtectedKeysFromMetadata(itemMetadataEntries);
    const itemCandidateEntries: Array<{
      itemKey: string;
      lastAccessAt: number;
      offlineProtected: boolean;
      sizeBytes: number;
    }> = [];

    for (const entry of itemMetadataEntries) {
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

      itemCandidateEntries.push({
        itemKey: entry.key,
        lastAccessAt: entry.lastAccessAt,
        offlineProtected: protectedItemKeys.has(entry.key),
        sizeBytes: rememberItemMetadataSize(entry.key, entry.sizeBytes),
      });
    }

    for (const [itemKey, entry] of finalItemDataByKey) {
      const existingMetadata = itemMetadataByKey.get(itemKey);
      const sizeBytes = estimateAsyncItemEntrySizeBytes({
        currentCustomMetadata: existingMetadata?.customMetadata,
        itemKey,
        lastAccessAt: existingMetadata?.lastAccessAt ?? itemCommitTimestamp,
        nextCustomMetadata: entry.metadata,
        protectedKeysSnapshotSet: protectedRefs,
        value: entry.value,
      });
      finalItemSizeBytesByKey.set(itemKey, sizeBytes);
      itemCandidateEntries.push({
        itemKey,
        lastAccessAt: existingMetadata?.lastAccessAt ?? itemCommitTimestamp,
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
        sizeBytes,
      });
    }

    const keptItemKeys = keepEntriesWithinByteBudget({
      entries: itemCandidateEntries,
      getKey: (entry) => entry.itemKey,
      getLastAccessAt: (entry) => entry.lastAccessAt,
      getSizeBytes: (entry) => entry.sizeBytes,
      isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
      isProtected: (entry) => entry.offlineProtected,
      maxBytes: maxItemBytes,
    });

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

    const removedQueryKeys = [...previousKnownLocalQueryKeys].filter(
      (queryKey) => !finalPersistedQueryKeys.has(queryKey),
    );
    const removedItemKeys = [...previousKnownLocalItemKeys].filter(
      (itemKey) => !finalPersistedItemKeys.has(itemKey),
    );
    const queryUpserts = new Map<
      string,
      { sizeBytes: number; snapshot: string; value: PersistedListQueryData }
    >();
    const itemUpserts = new Map<
      string,
      {
        metadata: ItemEntryNamespaceMetadata;
        sizeBytes: number;
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

      queryUpserts.set(queryKey, {
        sizeBytes:
          finalQuerySizeBytesByKey.get(queryKey) ??
          estimateAsyncQueryEntrySizeBytes({
            lastAccessAt: Date.now(),
            queryKey,
            value,
          }),
        snapshot,
        value,
      });
    }

    for (const [itemKey, entry] of finalItemDataByKey) {
      if (!finalPersistedItemKeys.has(itemKey)) continue;

      const snapshot = JSON.stringify(entry.value);
      const existingSnapshot = itemSnapshotByKey.get(itemKey);
      if (
        existingSnapshot === snapshot &&
        previousKnownLocalItemKeys.has(itemKey)
      ) {
        continue;
      }

      itemUpserts.set(itemKey, {
        metadata: entry.metadata,
        sizeBytes:
          finalItemSizeBytesByKey.get(itemKey) ??
          estimateAsyncItemEntrySizeBytes({
            itemKey,
            lastAccessAt: Date.now(),
            nextCustomMetadata: entry.metadata,
            value: entry.value,
          }),
        snapshot,
        value: entry.value,
      });
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
            metadata: entry.metadata,
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
      querySizeBytesByKey.set(queryKey, entry.sizeBytes);
      hydratedPersistedQueryKeys.add(queryKey);
      syncHydrationQueryMissCache.clear(queryKey);
    }
    for (const itemKey of removedItemKeys) {
      forgetPersistedItem(itemKey);
    }
    for (const [itemKey, entry] of itemUpserts) {
      itemSnapshotByKey.set(itemKey, entry.snapshot);
      itemSizeBytesByKey.set(itemKey, entry.sizeBytes);
      hydratedPersistedItemKeys.add(itemKey);
      syncHydrationItemMissCache.clear(itemKey);
    }

    knownPersistedQueryKeys = new Set(finalPersistedQueryKeys);
    knownPersistedItemKeys = new Set(finalPersistedItemKeys);

    const nextKnownPersistedItemBytes = getKnownPersistedItemBytes(
      knownPersistedItemKeys,
    );
    const nextKnownPersistedQueryBytes = getKnownPersistedQueryBytes(
      knownPersistedQueryKeys,
    );
    if (
      nextKnownPersistedItemBytes === null ||
      nextKnownPersistedQueryBytes === null ||
      nextKnownPersistedItemBytes > maxItemBytes ||
      nextKnownPersistedQueryBytes > maxQueryBytes
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
    syncHydrationItemMissCache.clearAll();
    syncHydrationQueryMissCache.clearAll();
    knownPersistedItemKeys = null;
    knownPersistedQueryKeys = null;
    itemSizeBytesByKey.clear();
    querySizeBytesByKey.clear();
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
    itemSizeBytesByKey.clear();
    querySizeBytesByKey.clear();
    hydratedPersistedItemKeys.clear();
    hydratedPersistedQueryKeys.clear();
    syncHydrationItemMissCache.clearAll();
    syncHydrationQueryMissCache.clearAll();
    await Promise.all([itemNamespace.clear(), clearLocalStorageQueries()]);
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    maybeHydrateQueries,
    preloadItems,
    preloadQueries,
    preloadItemsByDerivedQueryGroup,
    getHydratedItemKeys: () => [...hydratedPersistedItemKeys],
    getHydratedQueryKeys: () => [...hydratedPersistedQueryKeys],
    readHydratedItem,
    readHydratedQuery,
    hasAsyncPreload: localStorageAdapter === null,
    dispose,
    clear,
  };
}
