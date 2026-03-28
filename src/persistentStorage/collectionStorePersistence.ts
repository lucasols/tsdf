import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import {
  __LEGIT_CAST__,
  type __LEGIT_ANY__,
} from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import type {
  AnyOfflineOperationDefinition,
  CollectionOfflineEntityRef,
} from './offline/types';
import { getSessionProtectedKeysSnapshot } from './offline/sessionProtectionRegistry';
import { isManagedLocalStorageEntryOfflineProtected } from './localStorageMetadata';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  convertStoreDataForPersistence,
  normalizePersistentStorageDataSchema,
  parsePersistedCollectionItemData,
  parsePersistedStoreData,
  type NormalizedPersistentStorageDataSchema,
  type ParsedPersistedCollectionItemData,
} from './parsePersistedData';
import {
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  METADATA_RECORD_PREFIX,
  PAYLOAD_RECORD_PREFIX,
  getPayloadRecordKey,
} from './opfsFileNaming';
import {
  assertValidPersistentStoreName,
  createPersistentStorageNamespaceHandle,
  getLocalStorageAdapter,
  getStoragePrefixForStoreNamespace,
  listAllPersistentStorageNamespaceMetadata,
  readManifestPayloadMeta,
  scheduleAsyncStorageMaintenance,
  scheduleLocalStorageRemoval,
  scheduleLocalStorageMaintenance,
  readStorageEntryFromLocalStorageSync,
  refreshLocalStorageTimestamp,
} from './persistentStorageManager';
import {
  createShouldIgnoreItemPredicate,
  createEvictionComparator,
} from './persistenceUtils';
import { scheduleIdleCleanup } from './scheduleIdleCleanup';
import { COLLECTION_STORAGE_ENTRY_PREFIX } from './storageEntryPrefixes';
import type {
  AsyncStorageDriver,
  AsyncStorageNamespaceScope,
  CollectionPersistentStorageConfig,
  PersistedCollectionItemData,
} from './types';
import { validateWithSchema } from './validateWithSchema';
import {
  ASYNC_STORAGE_MAX_AGE_MS,
  isOfflineProtectedMetadata,
  readAsyncStorageNamespaceIndexStateUsingDriver,
  registerAsyncStartupStoreCleanup,
  getProtectedKeysFromMetadata,
  serializeProtectedRef,
  unregisterAsyncStartupStoreCleanup,
  type AsyncStartupCleanupScopePlan,
  type AsyncStartupCleanupStoreDeletePlan,
} from './asyncStorageAdapter';

const DEFAULT_MAX_ITEMS = 50;
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
  config: CollectionPersistentStorageConfig<
    ItemState,
    ItemPayload,
    StorageState,
    TOfflineOperations
  > & { getSessionKey: () => string | false },
  options: { getItemKey?: (payload: ItemPayload) => string } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  assertValidPersistentStoreName(config.storeName);

  const version = config.version;
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
  const hasIgnoreItemFilter = config.ignoreItems !== undefined;
  const storageAdapter = config.adapter;
  const localStorageAdapter = getLocalStorageAdapter(storageAdapter);
  const asyncStorageAdapter =
    storageAdapter === 'local-sync' ? null : storageAdapter;
  const persistentConfig = config;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);
  const itemStorageValueCodec = {
    serialize: (
      data: PersistedCollectionItemData<ItemState | StorageState>,
    ) => ({ d: data.data, p: data.payload }),
    deserialize: (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'd' in value &&
      'p' in value
        ? (() => {
            const parsed = parsePersistedCollectionItemData(
              { data: value.d, payload: value.p },
              config.payloadSchema,
            );
            return parsed
              ? {
                  data: __LEGIT_CAST__<ItemState | StorageState, unknown>(
                    parsed.data,
                  ),
                  payload: parsed.payload,
                }
              : null;
          })()
        : null,
  };

  const namespace = createPersistentStorageNamespaceHandle<
    PersistedCollectionItemData<ItemState | StorageState>,
    { p?: unknown }
  >(
    { ...persistentConfig, entryPrefix: COLLECTION_STORAGE_ENTRY_PREFIX },
    {
      getManifestMeta: (data) => ({ p: data.payload }),
      valueCodec: itemStorageValueCodec,
    },
  );

  let storeRef: Store<TSFDCollectionState<ItemState, ItemPayload>> | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let suppressedPersistedStateFlushes = 0;
  const pendingPreloads = new Map<string, Promise<boolean>>();
  const persistedSnapshotByKey = new Map<string, string>();
  const hydratedPersistedKeys = new Set<string>();
  const knownMissingPersistedKeys = new Set<string>();
  let knownPersistedKeys: Set<string> | null = null;
  let maintenanceManifestKey: string | null = null;

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
    const rawKeys =
      discoveredScope.knownRecordKeys ?? (await args.driver.listKeys(scope));
    const uniqueDeleteKeys = new Set<string>();
    const indexState = await readAsyncStorageNamespaceIndexStateUsingDriver(
      args.driver,
      scope,
      rawKeys,
    );

    if (!indexState.valid || indexState.entries === null) {
      const keysToRemove = rawKeys.filter(
        (key) => key !== ASYNC_NAMESPACE_INDEX_RECORD_KEY || indexState.exists,
      );
      if (keysToRemove.length === 0) {
        return { scopePlans: [], storeDeletePlans: [] };
      }

      return {
        scopePlans: [{ deleteKeys: keysToRemove, persistEntries: null, scope }],
        storeDeletePlans: [
          {
            representativeScope: scope,
            removedKeysByScope: [{ keys: keysToRemove, scope }],
          },
        ],
      };
    }

    const payloadKeys = new Set<string>();
    const rawKeysToRemove: string[] = [];
    const legacyMetadataRecordKeys: string[] = [];
    for (const key of rawKeys) {
      if (key.startsWith(PAYLOAD_RECORD_PREFIX)) {
        payloadKeys.add(key.slice(PAYLOAD_RECORD_PREFIX.length));
      } else if (key.startsWith(METADATA_RECORD_PREFIX)) {
        legacyMetadataRecordKeys.push(key);
      } else if (key !== ASYNC_NAMESPACE_INDEX_RECORD_KEY) {
        rawKeysToRemove.push(key);
      }
    }

    for (const key of rawKeysToRemove) {
      uniqueDeleteKeys.add(key);
    }
    for (const key of legacyMetadataRecordKeys) {
      uniqueDeleteKeys.add(key);
    }

    const protectedRefs = getSessionProtectedKeysSnapshot(scope.sessionKey);
    const nextEntries = new Map(indexState.entries);
    const remainingEntries: Array<{
      itemKey: string;
      lastAccessAt: number;
      protected: boolean;
    }> = [];

    for (const [key, metadata] of indexState.entries) {
      const isProtected =
        isOfflineProtectedMetadata(metadata.customMetadata) ||
        protectedRefs?.has(serializeProtectedRef({ ...scope, key })) === true;

      if (!payloadKeys.has(key)) {
        nextEntries.delete(key);
        continue;
      }

      const payload = validateWithSchema(
        config.payloadSchema,
        readManifestPayloadMeta(metadata.customMetadata),
      );
      if (payload === null || shouldIgnoreItem(payload)) {
        uniqueDeleteKeys.add(getPayloadRecordKey(key));
        nextEntries.delete(key);
        continue;
      }

      if (
        !isProtected &&
        args.now - metadata.lastAccessAt > ASYNC_STORAGE_MAX_AGE_MS
      ) {
        uniqueDeleteKeys.add(getPayloadRecordKey(key));
        nextEntries.delete(key);
        continue;
      }

      remainingEntries.push({
        itemKey: key,
        lastAccessAt: metadata.lastAccessAt,
        protected: isProtected,
      });
    }

    for (const payloadKey of payloadKeys) {
      if (!indexState.entries.has(payloadKey)) {
        uniqueDeleteKeys.add(getPayloadRecordKey(payloadKey));
      }
    }

    const unprotectedCount = remainingEntries.filter(
      ({ protected: isProtected }) => !isProtected,
    ).length;
    const needsEviction =
      remainingEntries.length > maxItems &&
      (hasIgnoreItemFilter || unprotectedCount > maxItems);

    if (needsEviction) {
      remainingEntries.sort(
        createEvictionComparator(
          [
            (entry) => entry.protected,
            (entry) => pinnedItemKeys.has(entry.itemKey),
          ],
          (entry) => entry.lastAccessAt,
        ),
      );

      const keptKeys = new Set(
        remainingEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
      );
      for (const { itemKey } of remainingEntries) {
        if (keptKeys.has(itemKey)) continue;
        uniqueDeleteKeys.add(getPayloadRecordKey(itemKey));
        nextEntries.delete(itemKey);
      }
    }

    const indexChanged =
      nextEntries.size !== indexState.entries.size ||
      rawKeysToRemove.length > 0 ||
      legacyMetadataRecordKeys.length > 0;
    if (indexChanged && nextEntries.size === 0) {
      uniqueDeleteKeys.add(ASYNC_NAMESPACE_INDEX_RECORD_KEY);
    }

    const deleteKeys = [...uniqueDeleteKeys];
    const scopePlan =
      deleteKeys.length > 0 || (indexChanged && nextEntries.size > 0)
        ? [
            {
              deleteKeys,
              persistEntries:
                indexChanged && nextEntries.size > 0 ? nextEntries : null,
              scope,
            } satisfies AsyncStartupCleanupScopePlan,
          ]
        : [];

    const storeDeletePlans =
      deleteKeys.includes(ASYNC_NAMESPACE_INDEX_RECORD_KEY) &&
      nextEntries.size === 0
        ? [
            {
              representativeScope: scope,
              removedKeysByScope: [{ keys: deleteKeys, scope }],
            } satisfies AsyncStartupCleanupStoreDeletePlan,
          ]
        : [];

    return { scopePlans: scopePlan, storeDeletePlans };
  }

  async function ensureKnownPersistedKeys(): Promise<Set<string>> {
    if (knownPersistedKeys !== null) return knownPersistedKeys;

    knownPersistedKeys = new Set(await namespace.listKeys());
    return knownPersistedKeys;
  }

  function rememberHydratedItem(
    itemKey: string,
    persisted: PersistedCollectionItemData<unknown>,
  ): void {
    hydratedPersistedKeys.add(itemKey);
    knownMissingPersistedKeys.delete(itemKey);
    persistedSnapshotByKey.set(itemKey, JSON.stringify(persisted));
    knownPersistedKeys?.add(itemKey);
  }

  function forgetPersistedItem(itemKey: string): void {
    hydratedPersistedKeys.delete(itemKey);
    persistedSnapshotByKey.delete(itemKey);
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
    if (knownMissingPersistedKeys.has(itemKey)) return undefined;

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
      { metadata: 'namespace', namespacePrefix: prefix },
      itemStorageValueCodec,
    );

    if (!cacheEntry) {
      knownMissingPersistedKeys.add(itemKey);
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const item = toCollectionItemState(
      __LEGIT_CAST__<
        ParsedPersistedCollectionItemData<ItemPayload>,
        PersistedCollectionItemData<unknown>
      >(cacheEntry.data),
      dataSchema,
      shouldIgnoreItem,
    );
    if (!item) {
      scheduleLocalStorageRemoval(storageKey, {
        metadata: 'namespace',
        namespacePrefix: prefix,
      });
      knownMissingPersistedKeys.add(itemKey);
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
      .then((cached) => {
        if (!cached || currentGeneration !== generation || !storeRef) {
          return false;
        }

        const persisted = parsePersistedCollectionItemData(
          cached,
          config.payloadSchema,
        );
        if (!persisted) {
          void namespace.remove(itemKey).catch(() => {});
          return false;
        }

        const validated = toCollectionItemState(
          persisted,
          dataSchema,
          shouldIgnoreItem,
        );

        if (!validated) {
          void namespace.remove(itemKey).catch(() => {});
          return false;
        }

        rememberHydratedItem(itemKey, cached);

        if (storeRef.state[itemKey] !== undefined) {
          return storeRef.state[itemKey] !== null;
        }

        materializeHydratedItem(itemKey, validated);

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
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
  }

  async function maybeHydrateItems(itemKeys: string[]): Promise<boolean[]> {
    return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
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

      if (
        !hasIgnoreItemFilter &&
        metadataEntries.filter(
          (entry) => !protectedItemKeys.has(entry.entryKey),
        ).length <= maxItems
      ) {
        return;
      }

      const metadataEntriesWithPayload = metadataEntries.map((entry) => ({
        itemKey: entry.entryKey,
        lastAccessAt: entry.lastAccessAt,
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
        ({ itemKey, lastAccessAt, payload }) =>
          payload === null ? false : { itemKey, lastAccessAt, payload },
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

      if (filteredEntries.length <= maxItems) {
        knownPersistedKeys = new Set(
          filteredEntries.map(({ itemKey }) => itemKey),
        );
        return;
      }

      filteredEntries.sort(
        createEvictionComparator(
          [
            (e) => protectedItemKeys.has(e.itemKey),
            (e) => pinnedItemKeys.has(e.itemKey),
          ],
          (e) => e.lastAccessAt,
        ),
      );

      const keptKeys = new Set(
        filteredEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
      );

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

    const invalidEntries = filterAndMap(metadataEntries, (entry) => {
      const payload = validateWithSchema(
        config.payloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );

      return payload === null ? { itemKey: entry.key } : false;
    });

    if (invalidEntries.length > 0) {
      await Promise.all(
        invalidEntries.map(({ itemKey }) => namespace.remove(itemKey)),
      );
    }

    const validEntries = filterAndMap(metadataEntries, (entry) => {
      const payload = validateWithSchema(
        config.payloadSchema,
        readManifestPayloadMeta(entry.customMetadata),
      );
      if (payload === null) return false;

      return { itemKey: entry.key, lastAccessAt: entry.lastAccessAt, payload };
    });

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

    if (
      !hasIgnoreItemFilter &&
      filteredEntries.filter(({ itemKey }) => !protectedItemKeys.has(itemKey))
        .length <= maxItems
    ) {
      knownPersistedKeys = new Set(
        filteredEntries.map(({ itemKey }) => itemKey),
      );
      return;
    }

    if (filteredEntries.length <= maxItems) {
      knownPersistedKeys = new Set(
        filteredEntries.map(({ itemKey }) => itemKey),
      );
      return;
    }

    filteredEntries.sort(
      createEvictionComparator(
        [
          (e) => protectedItemKeys.has(e.itemKey),
          (e) => pinnedItemKeys.has(e.itemKey),
        ],
        (e) => e.lastAccessAt,
      ),
    );

    const keptKeys = new Set(
      filteredEntries.slice(0, maxItems).map(({ itemKey }) => itemKey),
    );

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
      const previousOverflowMetadataEntries =
        knownPersistedKeys === null &&
        localStorageAdapter === null &&
        config.maxItems !== undefined
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
                config.maxItems !== undefined ||
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
        previousPersistedKeys !== null &&
        previousPersistedKeys.size - pendingRemoves.size + pendingUpserts.size >
          maxItems
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
            });
          }

          for (const itemKey of pendingUpserts.keys()) {
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

          if (remainingCandidates.length > maxItems) {
            remainingCandidates.sort(
              createEvictionComparator(
                [
                  (entry) => entry.protected,
                  (entry) => pinnedItemKeys.has(entry.itemKey),
                ],
                (entry) => entry.lastAccessAt,
              ),
            );

            const keptKeys = new Set(
              remainingCandidates
                .slice(0, maxItems)
                .map(({ itemKey }) => itemKey),
            );

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
        hydratedPersistedKeys.add(itemKey);
        knownMissingPersistedKeys.delete(itemKey);
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
        if (
          hasIgnoreItemFilter ||
          (knownPersistedKeys !== null && knownPersistedKeys.size > maxItems)
        ) {
          scheduleLocalStorageMaintenance({
            forceManifestKeys: [maintenanceManifestKey],
          });
        }
        return;
      }

      const sessionKey = config.getSessionKey();
      if (sessionKey !== false && localStorageAdapter === null) {
        if (
          hasIgnoreItemFilter ||
          (!optimizedOverflow &&
            knownPersistedKeys !== null &&
            knownPersistedKeys.size > maxItems)
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
    if (
      localStorageAdapter === null &&
      asyncStorageAdapter !== null &&
      config.maxItems !== undefined
    ) {
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
    knownMissingPersistedKeys.clear();
    knownPersistedKeys = null;
    suppressedPersistedStateFlushes = 0;
    clearSaveTimer();
    unsubscribe?.();
    unsubscribe = null;
    storeRef = null;
    if (
      localStorageAdapter === null &&
      asyncStorageAdapter !== null &&
      config.maxItems !== undefined
    ) {
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
    hydratedPersistedKeys.clear();
    knownMissingPersistedKeys.clear();
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
