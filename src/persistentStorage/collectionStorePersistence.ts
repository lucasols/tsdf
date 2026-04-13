import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { type __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  ASYNC_STORAGE_MAX_AGE_MS,
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
import { createCompactLocalStorageEntry } from './compactLocalStorageEntry';
import { isManagedLocalStorageEntryOfflineProtected } from './localStorageMetadata';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import type {
  AnyOfflineOperationDefinition,
  CollectionOfflineEntityRef,
} from './offline/types';
import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedCollectionItemData,
  parsePersistedStoreData,
  type NormalizedPersistentStorageDataSchema,
  type ParsedPersistedCollectionItemData,
} from './parsePersistedData';
import {
  createShouldIgnoreItemPredicate,
  keepEntriesWithinByteBudget,
  serializeJsonForStorage,
  createTimedKeySet,
} from './persistenceUtils';
import { getDefaultMaxBytesForScope } from './persistentStorageDefaults';
import {
  assertValidPersistentStoreName,
  createPersistentStorageNamespaceHandle,
  getLocalStorageAdapter,
  isOfflineNetworkModeActiveSync,
  getStoragePrefixForStoreNamespace,
  listAllPersistentStorageNamespaceMetadata,
  readManifestPayloadMeta,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
  scheduleAsyncStorageMaintenance,
  scheduleLocalStorageMaintenance,
  scheduleLocalStorageRemoval,
} from './persistentStorageManager';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { COLLECTION_STORAGE_ENTRY_PREFIX } from './storageEntryPrefixes';
import type {
  AsyncStorageDriver,
  AsyncStorageNamespaceScope,
  PersistedCollectionItemData,
  ResolvedCollectionPersistentStorageConfig,
} from './types';
import { validateWithSchema } from './validateWithSchema';

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
  const validated = parsePersistedStoreData(persisted.data, dataSchema);
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
  config: ResolvedCollectionPersistentStorageConfig<
    ItemState,
    ItemPayload,
    StorageState,
    TOfflineOperations
  >,
  options: { getItemKey?: (payload: ItemPayload) => string } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  assertValidPersistentStoreName(config.storeName);

  const version = config.version;
  const defaultMaxBytes = getDefaultMaxBytesForScope({
    adapter: config.adapter,
    scopeKind: 'collection.item',
  });
  const maxBytes = config.maxBytes ?? defaultMaxBytes;
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
  const asyncStorageAdapter =
    storageAdapter === 'local-sync' ? null : storageAdapter;
  const persistedStaticPolicy =
    localStorageAdapter === null
      ? buildPersistedStaticPolicy(
          config.maxBytes,
          defaultMaxBytes,
          pinnedItemKeys,
        )
      : null;
  const persistentConfig = config;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);
  const itemStorageValueCodec = {
    serialize: (
      data: PersistedCollectionItemData<ItemState | StorageState>,
    ) => ({ d: data.data, p: data.payload }),
    deserialize: (value: unknown, metadata?: { p?: unknown }) =>
      typeof value === 'object' &&
      value !== null &&
      'd' in value &&
      ('p' in value || metadata?.p !== undefined)
        ? parsePersistedCollectionItemData(
            { data: value.d, payload: 'p' in value ? value.p : metadata?.p },
            config.payloadSchema,
            dataSchema,
          )
        : null,
  };
  const asyncItemStorageValueCodec = {
    serialize: (data: PersistedCollectionItemData<ItemState | StorageState>) =>
      data.data,
    deserialize: (value: unknown, metadata?: { p?: unknown }) =>
      metadata?.p !== undefined
        ? parsePersistedCollectionItemData(
            { data: value, payload: metadata.p },
            config.payloadSchema,
            dataSchema,
          )
        : null,
  };

  const namespace = createPersistentStorageNamespaceHandle<
    PersistedCollectionItemData<ItemState | StorageState>,
    { p?: unknown }
  >(
    { ...persistentConfig, entryPrefix: COLLECTION_STORAGE_ENTRY_PREFIX },
    {
      asyncValueCodec: asyncItemStorageValueCodec,
      getManifestMeta: (data) => ({ p: data.payload }),
      valueCodec: itemStorageValueCodec,
    },
  );
  function getAsyncNamespaceScope():
    | (AsyncStorageNamespaceScope & { kind: 'collection.item' })
    | null {
    if (asyncStorageAdapter === null) return null;
    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return null;

    return { kind: 'collection.item', sessionKey, storeName: config.storeName };
  }

  function estimateAsyncEntrySizeBytes(args: {
    itemKey: string;
    lastAccessAt: number;
    protectedKeysSnapshotSet?: Set<string> | null;
    value: PersistedCollectionItemData<unknown>;
    currentCustomMetadata?: Record<string, unknown>;
  }): number {
    const asyncNamespaceScope = getAsyncNamespaceScope();
    if (asyncNamespaceScope === null) {
      return JSON.stringify(args.value).length;
    }

    const serializedValue = serializeJsonForStorage(args.value.data);
    const customMetadata = mergeManagedAsyncStorageCustomMetadata({
      currentCustomMetadata: args.currentCustomMetadata,
      key: args.itemKey,
      nextCustomMetadata: { p: args.value.payload },
      protectedKeysSnapshotSet: args.protectedKeysSnapshotSet,
      scope: asyncNamespaceScope,
    });

    return estimateManagedAsyncStorageEntrySizeBytes({
      customMetadata,
      lastAccessAt: args.lastAccessAt,
      serializedValue: serializedValue.rawValue,
      version: version ?? 1,
    });
  }

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressedPersistedStateFlushes = 0;
  const pendingPreloads = new Map<string, Promise<boolean>>();
  const persistedSnapshotByKey = new Map<string, string>();
  const persistedSizeBytesByKey = new Map<string, number>();
  const hydratedPersistedKeys = new Set<string>();
  const syncHydrationMissCache = createTimedKeySet();
  let knownPersistedKeys: Set<string> | null = null;
  let maintenanceManifestKey: string | null = null;

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
    const discoveredScope = args.discoveredScopes.find(
      ({ scope }) => scope.kind === 'collection.item',
    );
    if (discoveredScope === undefined) {
      return { scopePlans: [], storeDeletePlans: [] };
    }

    const { scope } = discoveredScope;
    const indexState = await readAsyncStorageNamespaceIndexStateUsingDriver(
      args.driver,
      scope,
      discoveredScope.knownRecordKeys,
    );

    if (!indexState.valid || indexState.entries === null) {
      return { scopePlans: [], storeDeletePlans: [] };
    }

    const deleteKeys = new Set<string>();
    const nextEntries = new Map(indexState.entries);
    let indexChanged = false;
    const staticPolicyChanged =
      JSON.stringify(indexState.staticPolicy) !==
      JSON.stringify(persistedStaticPolicy);

    for (const [key, metadata] of indexState.entries) {
      const payload = validateWithSchema(
        config.payloadSchema,
        readManifestPayloadMeta(metadata.customMetadata),
      );
      if (payload === null || shouldIgnoreItem(payload)) {
        deleteKeys.add(getPayloadRecordKey(key));
        nextEntries.delete(key);
        indexChanged = true;
      }
    }

    const effectiveStaticPolicy =
      persistedStaticPolicy ?? indexState.staticPolicy;
    if (effectiveStaticPolicy?.maxBytes !== undefined) {
      const protectedItemKeys = getProtectedKeysFromMetadata(
        [...nextEntries.entries()].map(([key, metadata]) => ({
          customMetadata: metadata.customMetadata,
          key,
        })),
      );
      const candidateEntries = [...nextEntries.entries()].map(
        ([itemKey, metadata]) => ({
          itemKey,
          lastAccessAt: metadata.lastAccessAt,
          protected: protectedItemKeys.has(itemKey),
          sizeBytes: rememberPersistedMetadataSize(itemKey, metadata.sizeBytes),
        }),
      );
      const keptKeys = keepEntriesWithinByteBudget({
        entries: candidateEntries,
        getKey: (entry) => entry.itemKey,
        getLastAccessAt: (entry) => entry.lastAccessAt,
        getSizeBytes: (entry) => entry.sizeBytes,
        isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
        isProtected: (entry) => entry.protected,
        maxBytes: effectiveStaticPolicy.maxBytes,
      });

      for (const { itemKey } of candidateEntries) {
        if (keptKeys.has(itemKey)) continue;
        deleteKeys.add(getPayloadRecordKey(itemKey));
        nextEntries.delete(itemKey);
        indexChanged = true;
      }
    }

    if (!indexChanged && !staticPolicyChanged) {
      return { scopePlans: [], storeDeletePlans: [] };
    }

    if (nextEntries.size === 0) {
      deleteKeys.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    }

    return {
      scopePlans: [
        {
          deleteKeys: [...deleteKeys],
          persistEntries: nextEntries.size > 0 ? nextEntries : null,
          persistStaticPolicy:
            nextEntries.size > 0 ? persistedStaticPolicy : undefined,
          scope,
        } satisfies AsyncStartupCleanupScopePlan,
      ],
      storeDeletePlans: [],
    };
  }

  async function ensureKnownPersistedKeys(): Promise<Set<string>> {
    if (knownPersistedKeys !== null) return knownPersistedKeys;

    knownPersistedKeys = new Set(await namespace.listKeys());
    return knownPersistedKeys;
  }

  function rememberPersistedMetadataSize(
    itemKey: string,
    sizeBytes: number | undefined,
  ): number {
    const resolvedSizeBytes = sizeBytes ?? persistedSizeBytesByKey.get(itemKey);
    if (resolvedSizeBytes !== undefined) {
      persistedSizeBytesByKey.set(itemKey, resolvedSizeBytes);
      return resolvedSizeBytes;
    }

    return 0;
  }

  function getLocalStorageEntrySizeBytes(
    value: PersistedCollectionItemData<unknown>,
  ): number {
    return serializeJsonForStorage(
      createCompactLocalStorageEntry(
        { d: value.data, p: value.payload },
        version,
      ),
    ).sizeBytes;
  }

  function getKnownPersistedBytes(
    itemKeys: ReadonlySet<string> | null,
  ): number | null {
    if (itemKeys === null) return null;

    let totalBytes = 0;
    for (const itemKey of itemKeys) {
      const sizeBytes = persistedSizeBytesByKey.get(itemKey);
      if (sizeBytes === undefined) return null;
      totalBytes += sizeBytes;
    }

    return totalBytes;
  }

  function rememberHydratedItem(
    itemKey: string,
    persisted: PersistedCollectionItemData<unknown>,
  ): void {
    hydratedPersistedKeys.add(itemKey);
    syncHydrationMissCache.clear(itemKey);
    const snapshot = JSON.stringify(persisted);
    persistedSnapshotByKey.set(itemKey, snapshot);
    if (localStorageAdapter !== null) {
      persistedSizeBytesByKey.set(
        itemKey,
        getLocalStorageEntrySizeBytes(persisted),
      );
    } else {
      persistedSizeBytesByKey.set(
        itemKey,
        estimateAsyncEntrySizeBytes({
          itemKey,
          lastAccessAt: Date.now(),
          value: persisted,
        }),
      );
    }
    knownPersistedKeys?.add(itemKey);
  }

  function forgetPersistedItem(itemKey: string): void {
    hydratedPersistedKeys.delete(itemKey);
    persistedSnapshotByKey.delete(itemKey);
    persistedSizeBytesByKey.delete(itemKey);
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
        dataSchema,
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
    if (syncHydrationMissCache.has(itemKey)) return undefined;

    const sessionKey = config.getSessionKey();
    if (sessionKey === false) return undefined;

    const prefix = getCollectionPrefix();
    if (prefix === false) return undefined;

    const storageKey = `${prefix}${itemKey}`;
    const cacheEntry = readStorageEntryFromLocalStorageSync<
      PersistedCollectionItemData<unknown>
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
      syncHydrationMissCache.remember(itemKey);
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const persisted = parsePersistedCollectionItemData(
      cacheEntry.data,
      config.payloadSchema,
      dataSchema,
    );
    if (!persisted) {
      syncHydrationMissCache.remember(itemKey);
      scheduleLocalStorageRemoval(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      });
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const item = toCollectionItemState(persisted, dataSchema, shouldIgnoreItem);
    if (!item) {
      syncHydrationMissCache.remember(itemKey);
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
    return item;
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

  function resolveAsyncPreloadedItem(
    itemKey: string,
    cached: PersistedCollectionItemData<ItemState | StorageState> | null,
    currentGeneration: number,
  ): boolean {
    if (currentGeneration !== generation || !storeRef) {
      return false;
    }
    if (!cached) {
      forgetPersistedItem(itemKey);
      return false;
    }

    const persisted = parsePersistedCollectionItemData(
      cached,
      config.payloadSchema,
      dataSchema,
    );
    if (!persisted) {
      forgetPersistedItem(itemKey);
      void namespace.remove(itemKey).catch(() => {});
      return false;
    }

    const validated = toCollectionItemState(
      persisted,
      dataSchema,
      shouldIgnoreItem,
    );

    if (!validated) {
      forgetPersistedItem(itemKey);
      void namespace.remove(itemKey).catch(() => {});
      return false;
    }

    rememberHydratedItem(itemKey, cached);

    if (storeRef.state[itemKey] !== undefined) {
      return storeRef.state[itemKey] !== null;
    }

    materializeHydratedItem(itemKey, validated);

    return true;
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
      .load(itemKey, { touch: 'coarse' })
      .then((cached) =>
        resolveAsyncPreloadedItem(itemKey, cached, currentGeneration),
      )
      .finally(() => {
        if (currentGeneration === generation) {
          pendingPreloads.delete(itemKey);
        }
      });

    pendingPreloads.set(itemKey, promise);
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
      const existingItem = storeRef.state[itemKey];
      if (existingItem !== undefined) {
        resultsByKey.set(itemKey, Promise.resolve(existingItem !== null));
        continue;
      }
      const existingPromise = pendingPreloads.get(itemKey);
      if (existingPromise !== undefined) {
        resultsByKey.set(itemKey, existingPromise);
        continue;
      }

      batchKeys.push(itemKey);
    }

    if (batchKeys.length > 0) {
      const currentGeneration = generation;
      const batchPromise = namespace
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
              pendingPreloads.delete(itemKey);
            }
          });
        pendingPreloads.set(itemKey, itemPromise);
        resultsByKey.set(itemKey, itemPromise);
      }
    }

    return Promise.all(
      itemKeys.map(
        (itemKey) => resultsByKey.get(itemKey) ?? Promise.resolve(false),
      ),
    );
  }

  async function maybeHydrateItems(itemKeys: string[]): Promise<boolean[]> {
    return preloadItems(itemKeys);
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

      const metadataEntriesWithPayload = metadataEntries.map((entry) => ({
        itemKey: entry.entryKey,
        lastAccessAt: entry.lastAccessAt,
        sizeBytes: rememberPersistedMetadataSize(
          entry.entryKey,
          entry.sizeBytes,
        ),
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
        ({ itemKey, lastAccessAt, payload, sizeBytes }) =>
          payload === null
            ? false
            : { itemKey, lastAccessAt, payload, sizeBytes },
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

      const keptKeys = keepEntriesWithinByteBudget({
        entries: filteredEntries,
        getKey: (entry) => entry.itemKey,
        getLastAccessAt: (entry) => entry.lastAccessAt,
        getSizeBytes: (entry) => entry.sizeBytes,
        isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
        isProtected: (entry) => protectedItemKeys.has(entry.itemKey),
        maxBytes,
      });

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

    const metadataEntries = await listAllPersistentStorageNamespaceMetadata(
      namespace,
      { order: 'lru-desc' },
    );
    if (metadataEntries.length === 0) return;
    const protectedItemKeys = getProtectedKeysFromMetadata(metadataEntries);

    const invalidEntries: { itemKey: string }[] = [];
    const validEntries: {
      itemKey: string;
      lastAccessAt: number;
      payload: ItemPayload;
      sizeBytes: number;
    }[] = [];

    for (const entry of metadataEntries) {
      const payload = validateWithSchema(
        config.payloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );

      if (payload === null) {
        invalidEntries.push({ itemKey: entry.key });
      } else {
        validEntries.push({
          itemKey: entry.key,
          lastAccessAt: entry.lastAccessAt,
          payload,
          sizeBytes: rememberPersistedMetadataSize(entry.key, entry.sizeBytes),
        });
      }
    }

    if (invalidEntries.length > 0) {
      await Promise.all(
        invalidEntries.map(({ itemKey }) => namespace.remove(itemKey)),
      );
    }

    const ignoredEntries = validEntries.filter(({ payload }) =>
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

    const filteredEntries = validEntries.filter(
      ({ payload }) => !shouldIgnoreItem(payload),
    );

    const keptKeys = keepEntriesWithinByteBudget({
      entries: filteredEntries,
      getKey: (entry) => entry.itemKey,
      getLastAccessAt: (entry) => entry.lastAccessAt,
      getSizeBytes: (entry) => entry.sizeBytes,
      isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
      isProtected: (entry) => protectedItemKeys.has(entry.itemKey),
      maxBytes,
    });

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

      if (
        localStorageAdapter !== null &&
        hydratedPersistedKeys.size === 0 &&
        !Object.values(state).some(
          (item) =>
            item?.data !== null &&
            item?.data !== undefined &&
            !shouldIgnoreItem(item.payload),
        )
      ) {
        return;
      }

      const nextPersistedKeys = new Set<string>();
      const pendingRemoves = new Set<string>();
      const pendingUpserts = new Map<
        string,
        {
          snapshot: string;
          sizeBytes: number;
          value: PersistedCollectionItemData<ItemState | StorageState>;
        }
      >();
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
      const knownPersistedBytes = getKnownPersistedBytes(knownPersistedKeys);
      const shouldTrackAsyncOverflow =
        localStorageAdapter === null &&
        (knownPersistedBytes === null || knownPersistedBytes > maxBytes);
      const previousOverflowMetadataEntries =
        knownPersistedKeys === null && shouldTrackAsyncOverflow
          ? await listAllPersistentStorageNamespaceMetadata(namespace, {
              order: 'lru-desc',
            })
          : null;
      const previousPersistedKeys =
        knownPersistedKeys !== null
          ? new Set(knownPersistedKeys)
          : previousOverflowMetadataEntries !== null
            ? new Set(previousOverflowMetadataEntries.map((entry) => entry.key))
            : localStorageAdapter !== null ||
                shouldTrackAsyncOverflow ||
                stateEntries.some(([itemKey, item]) => {
                  if (hydratedPersistedKeys.has(itemKey)) return false;
                  return !item?.data || shouldIgnoreItem(item.payload);
                })
              ? new Set(await ensureKnownPersistedKeys())
              : null;
      const previousKnownLocalPersistedKeys =
        previousPersistedKeys ?? new Set(hydratedPersistedKeys);

      for (const [itemKey, item] of stateEntries) {
        if (!item?.data) {
          if (
            previousKnownLocalPersistedKeys.has(itemKey) &&
            hydratedPersistedKeys.has(itemKey)
          ) {
            pendingRemoves.add(itemKey);
          }
          continue;
        }

        if (shouldIgnoreItem(item.payload)) {
          if (previousKnownLocalPersistedKeys.has(itemKey)) {
            pendingRemoves.add(itemKey);
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
          previousKnownLocalPersistedKeys.has(itemKey)
        ) {
          continue;
        }

        pendingUpserts.set(itemKey, {
          snapshot: nextSnapshot,
          sizeBytes:
            localStorageAdapter === null
              ? estimateAsyncEntrySizeBytes({
                  itemKey,
                  lastAccessAt: Date.now(),
                  value: nextValue,
                })
              : getLocalStorageEntrySizeBytes(nextValue),
          value: nextValue,
        });
      }

      for (const itemKey of previousKnownLocalPersistedKeys) {
        if (nextPersistedKeys.has(itemKey)) continue;
        if (!hydratedPersistedKeys.has(itemKey)) continue;

        pendingRemoves.add(itemKey);
      }

      let optimizedOverflow = false;
      if (
        localStorageAdapter === null &&
        !hasIgnoreItemFilter &&
        previousPersistedKeys !== null
      ) {
        const sessionKey = config.getSessionKey();
        if (sessionKey !== false) {
          const commitTimestamp = Date.now();
          const metadataEntries =
            previousOverflowMetadataEntries ??
            (await listAllPersistentStorageNamespaceMetadata(namespace, {
              order: 'lru-desc',
            }));
          const metadataByKey = new Map(
            metadataEntries.map((entry) => [entry.key, entry] as const),
          );
          const protectedItemKeys =
            getProtectedKeysFromMetadata(metadataEntries);
          const protectedRefs = getSessionProtectedKeysSnapshot(sessionKey);
          const candidateEntries: Array<{
            itemKey: string;
            lastAccessAt: number;
            protected: boolean;
            sizeBytes: number;
          }> = [];

          for (const entry of metadataEntries) {
            if (
              pendingRemoves.has(entry.key) ||
              pendingUpserts.has(entry.key)
            ) {
              continue;
            }

            const payload = validateWithSchema(
              config.payloadSchema,
              readManifestPayloadMeta(entry.customMetadata),
            );
            if (payload === null) {
              pendingRemoves.add(entry.key);
              nextPersistedKeys.delete(entry.key);
              continue;
            }

            candidateEntries.push({
              itemKey: entry.key,
              lastAccessAt: entry.lastAccessAt,
              protected: protectedItemKeys.has(entry.key),
              sizeBytes: rememberPersistedMetadataSize(
                entry.key,
                entry.sizeBytes,
              ),
            });
          }

          for (const [itemKey, pendingUpsert] of pendingUpserts.entries()) {
            pendingUpsert.sizeBytes = estimateAsyncEntrySizeBytes({
              itemKey,
              lastAccessAt: commitTimestamp,
              protectedKeysSnapshotSet: protectedRefs,
              value: pendingUpsert.value,
              currentCustomMetadata: metadataByKey.get(itemKey)?.customMetadata,
            });
            candidateEntries.push({
              itemKey,
              lastAccessAt: commitTimestamp,
              protected:
                protectedItemKeys.has(itemKey) ||
                protectedRefs?.has(
                  serializeProtectedRef({
                    key: itemKey,
                    kind: 'collection.item',
                    sessionKey,
                    storeName: config.storeName,
                  }),
                ) === true,
              sizeBytes: pendingUpsert.sizeBytes,
            });
          }

          for (const entry of candidateEntries) {
            if (entry.protected) continue;
            if (
              commitTimestamp - entry.lastAccessAt <=
              ASYNC_STORAGE_MAX_AGE_MS
            ) {
              continue;
            }

            pendingUpserts.delete(entry.itemKey);
            if (metadataByKey.has(entry.itemKey)) {
              pendingRemoves.add(entry.itemKey);
            }
          }

          const remainingCandidates = candidateEntries.filter(
            ({ itemKey }) => !pendingRemoves.has(itemKey),
          );

          const keptKeys = keepEntriesWithinByteBudget({
            entries: remainingCandidates,
            getKey: (entry) => entry.itemKey,
            getLastAccessAt: (entry) => entry.lastAccessAt,
            getSizeBytes: (entry) => entry.sizeBytes,
            isPinned: (entry) => pinnedItemKeys.has(entry.itemKey),
            isProtected: (entry) => entry.protected,
            maxBytes,
          });
          if (keptKeys.size !== remainingCandidates.length) {
            for (const { itemKey } of remainingCandidates) {
              if (keptKeys.has(itemKey)) continue;

              pendingUpserts.delete(itemKey);
              if (metadataByKey.has(itemKey)) {
                pendingRemoves.add(itemKey);
              }
            }

            optimizedOverflow = true;
          }
        }
      }

      await namespace.commit({
        removes: [...pendingRemoves],
        staticPolicy: persistedStaticPolicy,
        upserts: [...pendingUpserts.entries()].map(([key, entry]) => ({
          data: entry.value,
          key,
        })),
      });

      for (const itemKey of pendingRemoves) {
        forgetPersistedItem(itemKey);
      }
      for (const [itemKey, entry] of pendingUpserts.entries()) {
        persistedSnapshotByKey.set(itemKey, entry.snapshot);
        persistedSizeBytesByKey.set(itemKey, entry.sizeBytes);
        hydratedPersistedKeys.add(itemKey);
        syncHydrationMissCache.clear(itemKey);
      }
      if (previousPersistedKeys !== null) {
        knownPersistedKeys = new Set(previousPersistedKeys);
        for (const itemKey of pendingRemoves) {
          knownPersistedKeys.delete(itemKey);
        }
        for (const itemKey of pendingUpserts.keys()) {
          knownPersistedKeys.add(itemKey);
        }
      } else {
        knownPersistedKeys = null;
      }

      if (localStorageAdapter !== null && maintenanceManifestKey !== null) {
        const nextKnownPersistedBytes =
          getKnownPersistedBytes(knownPersistedKeys);
        if (
          hasIgnoreItemFilter ||
          nextKnownPersistedBytes === null ||
          nextKnownPersistedBytes > maxBytes
        ) {
          scheduleLocalStorageMaintenance({
            forceManifestKeys: [maintenanceManifestKey],
          });
        }
        return;
      }

      const sessionKey = config.getSessionKey();
      if (sessionKey !== false && localStorageAdapter === null) {
        const nextKnownPersistedBytes =
          getKnownPersistedBytes(knownPersistedKeys);
        if (
          hasIgnoreItemFilter ||
          (!optimizedOverflow &&
            (nextKnownPersistedBytes === null ||
              nextKnownPersistedBytes > maxBytes))
        ) {
          scheduleAsyncStorageMaintenance(
            `collection:${sessionKey}:${config.storeName}`,
            evictStoredItems,
          );
        }
      }
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
    pendingPreloads.clear();
    hydratedPersistedKeys.clear();
    syncHydrationMissCache.clearAll();
    knownPersistedKeys = null;
    persistedSizeBytesByKey.clear();
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
    persistedSizeBytesByKey.clear();
    hydratedPersistedKeys.clear();
    syncHydrationMissCache.clearAll();
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
