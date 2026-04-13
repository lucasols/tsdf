import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { type __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import type { Store } from 't-state';
import type {
  TSFDCollectionItem,
  TSFDCollectionState,
} from '../collectionStore/collectionStore';
import { createItemAliasRegistry } from '../utils/itemIdentity';
import type { ValidPayload, ValidStoreState } from '../utils/storeShared';
import {
  ASYNC_STORAGE_MAX_AGE_MS,
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
  ASYNC_NAMESPACE_INDEX_RECORD_KEY,
  getPayloadRecordKey,
} from './asyncStorageShared';
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
  createEvictionComparator,
  createShouldIgnoreItemPredicate,
} from './persistenceUtils';
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
  ):
    | {
        aliasPayloads: ItemPayload[];
        item: TSFDCollectionItem<ItemState, ItemPayload>;
      }
    | undefined;
  resolveItemKey(this: void, itemKey: string): string;
  hasAsyncPreload: boolean;
  dispose(): void;
  clear(): Promise<void>;
};

type ItemEntryMetadata = { al?: unknown[]; p?: unknown };

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
  options: {
    enableItemAliases?: boolean;
    getItemAliasPayloads?: (itemKey: string) => ItemPayload[];
    getItemKey?: (payload: ItemPayload) => string;
  } = {},
): CollectionPersistenceSetup<ItemState, ItemPayload> {
  assertValidPersistentStoreName(config.storeName);

  const version = config.version;
  const maxItems = config.maxItems ?? DEFAULT_MAX_ITEMS;
  const enableItemAliases = options.enableItemAliases === true;
  const resolveItemKey =
    options.getItemKey ?? ((payload: ItemPayload) => getCompositeKey(payload));
  const getItemAliasPayloads = options.getItemAliasPayloads;
  const persistedAliasRegistry = createItemAliasRegistry(resolveItemKey);
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
          config.maxItems,
          DEFAULT_MAX_ITEMS,
          pinnedItemKeys,
        )
      : null;
  const persistentConfig = config;
  const dataSchema = normalizePersistentStorageDataSchema(config.schema);
  const itemStorageValueCodec = {
    serialize: (
      data: PersistedCollectionItemData<ItemState | StorageState>,
    ) => ({ d: data.data, p: data.payload }),
    deserialize: (value: unknown, metadata?: ItemEntryMetadata) =>
      typeof value === 'object' &&
      value !== null &&
      'd' in value &&
      ('p' in value || metadata?.p !== undefined)
        ? parsePersistedCollectionItemData(
            {
              data: value.d,
              payload: 'p' in value ? value.p : metadata?.p,
              aliasPayloads: metadata?.al,
            },
            config.payloadSchema,
            dataSchema,
          )
        : null,
  };
  const asyncItemStorageValueCodec = {
    serialize: (data: PersistedCollectionItemData<ItemState | StorageState>) =>
      data.data,
    deserialize: (value: unknown, metadata?: ItemEntryMetadata) =>
      metadata?.p !== undefined
        ? parsePersistedCollectionItemData(
            { data: value, payload: metadata.p, aliasPayloads: metadata.al },
            config.payloadSchema,
            dataSchema,
          )
        : null,
  };

  const namespace = createPersistentStorageNamespaceHandle<
    PersistedCollectionItemData<ItemState | StorageState>,
    ItemEntryMetadata
  >(
    { ...persistentConfig, entryPrefix: COLLECTION_STORAGE_ENTRY_PREFIX },
    {
      asyncValueCodec: asyncItemStorageValueCodec,
      getManifestMeta: (data) => ({
        p: data.payload,
        ...(data.aliasPayloads?.length ? { al: data.aliasPayloads } : {}),
      }),
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
    if (
      effectiveStaticPolicy?.maxEntries !== undefined &&
      nextEntries.size > effectiveStaticPolicy.maxEntries
    ) {
      const candidateEntries = [...nextEntries.entries()].map(
        ([itemKey, metadata]) => ({
          itemKey,
          lastAccessAt: metadata.lastAccessAt,
          pinned: pinnedItemKeys.has(itemKey),
        }),
      );

      candidateEntries.sort(
        createEvictionComparator(
          [(entry) => entry.pinned],
          (entry) => entry.lastAccessAt,
        ),
      );

      const keptKeys = new Set(
        candidateEntries
          .slice(0, effectiveStaticPolicy.maxEntries)
          .map(({ itemKey }) => itemKey),
      );

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

  function parseAliasPayloads(
    aliasPayloads: unknown[] | undefined,
  ): ItemPayload[] {
    return (
      aliasPayloads?.flatMap((aliasPayload) => {
        const validatedAliasPayload = validateWithSchema(
          config.payloadSchema,
          aliasPayload,
        );
        return validatedAliasPayload === null ? [] : [validatedAliasPayload];
      }) ?? []
    );
  }

  function readManifestAliasPayloads(meta: unknown): ItemPayload[] {
    if (typeof meta !== 'object' || meta === null || !('al' in meta)) {
      return [];
    }

    return Array.isArray(meta.al) ? parseAliasPayloads(meta.al) : [];
  }

  function readPersistedAliasNamespaceMetadata(
    metadata: Record<string, unknown> | null,
  ): void {
    if (!enableItemAliases) return;

    persistedAliasRegistry.clearAll();
    if (!metadata || typeof metadata.al !== 'object' || metadata.al === null) {
      return;
    }

    function toUnknownRecord(value: unknown): Record<string, unknown> | null {
      if (typeof value !== 'object' || value === null) {
        return null;
      }

      return Object.fromEntries(Object.entries(value));
    }

    const aliasEntriesRecord = toUnknownRecord(metadata.al);
    if (aliasEntriesRecord === null) return;

    const aliasPayloadsByCanonicalKey = new Map<string, ItemPayload[]>();

    for (const [aliasItemKey, rawAliasEntry] of Object.entries(
      aliasEntriesRecord,
    )) {
      const aliasEntry = toUnknownRecord(rawAliasEntry);
      if (aliasEntry === null) continue;

      const canonicalItemKey =
        typeof aliasEntry.k === 'string' ? aliasEntry.k : null;
      const aliasPayload =
        'p' in aliasEntry
          ? validateWithSchema(config.payloadSchema, aliasEntry.p)
          : null;

      if (
        canonicalItemKey === null ||
        aliasPayload === null ||
        resolveItemKey(aliasPayload) !== aliasItemKey
      ) {
        continue;
      }

      const existingPayloads =
        aliasPayloadsByCanonicalKey.get(canonicalItemKey) ?? [];
      existingPayloads.push(aliasPayload);
      aliasPayloadsByCanonicalKey.set(canonicalItemKey, existingPayloads);
    }

    for (const [
      canonicalItemKey,
      aliasPayloads,
    ] of aliasPayloadsByCanonicalKey) {
      setPersistedItemAliases(canonicalItemKey, aliasPayloads);
    }
  }

  function buildPersistedAliasNamespaceMetadata(
    aliasEntries: ReadonlyArray<{
      aliasItemKey: string;
      aliasPayload: ItemPayload;
      canonicalItemKey: string;
    }>,
  ): Record<string, unknown> | null {
    if (!enableItemAliases || aliasEntries.length === 0) return null;

    return {
      al: Object.fromEntries(
        [...aliasEntries]
          .sort((left, right) =>
            left.aliasItemKey.localeCompare(right.aliasItemKey),
          )
          .map(({ aliasItemKey, aliasPayload, canonicalItemKey }) => [
            aliasItemKey,
            { k: canonicalItemKey, p: aliasPayload },
          ]),
      ),
    };
  }

  function buildNextPersistedAliasNamespaceMetadata(args: {
    removedItemKeys: Iterable<string>;
    upsertedItems: Iterable<{
      aliasPayloads: readonly ItemPayload[];
      itemKey: string;
    }>;
  }): { metadata: Record<string, unknown> | null; snapshot: string } {
    const aliasEntriesByKey = new Map(
      persistedAliasRegistry
        .getAliasEntries()
        .map((entry) => [entry.aliasItemKey, entry] as const),
    );

    for (const itemKey of args.removedItemKeys) {
      for (const [aliasItemKey, entry] of aliasEntriesByKey) {
        if (entry.canonicalItemKey === itemKey) {
          aliasEntriesByKey.delete(aliasItemKey);
        }
      }
    }

    for (const { itemKey, aliasPayloads } of args.upsertedItems) {
      for (const [aliasItemKey, entry] of aliasEntriesByKey) {
        if (entry.canonicalItemKey === itemKey) {
          aliasEntriesByKey.delete(aliasItemKey);
        }
      }

      for (const aliasPayload of aliasPayloads) {
        const aliasItemKey = resolveItemKey(aliasPayload);
        if (aliasItemKey === itemKey) continue;

        aliasEntriesByKey.set(aliasItemKey, {
          aliasItemKey,
          aliasPayload,
          canonicalItemKey: itemKey,
        });
      }
    }

    const metadata = buildPersistedAliasNamespaceMetadata([
      ...aliasEntriesByKey.values(),
    ]);
    return { metadata, snapshot: JSON.stringify(metadata) };
  }

  function setPersistedItemAliases(
    itemKey: string,
    aliasPayloads: readonly ItemPayload[],
  ): void {
    if (!enableItemAliases) return;
    persistedAliasRegistry.setCanonicalAliases(itemKey, aliasPayloads);
  }

  function clearPersistedItemAliases(itemKey: string): void {
    if (!enableItemAliases) return;
    persistedAliasRegistry.clearCanonicalAliases(itemKey);
  }

  function rebuildLocalPersistedAliasIndex(): void {
    if (!enableItemAliases) return;
    if (localStorageAdapter === null) return;
    if (persistedAliasIndexIsSeeded) return;

    const prefix = getCollectionPrefix();
    if (prefix === false) return;

    persistedAliasRegistry.clearAll();
    const manifestEntries = localStorageAdapter.listManifestEntries(prefix);

    for (const entry of manifestEntries) {
      setPersistedItemAliases(
        entry.entryKey,
        readManifestAliasPayloads(entry.meta),
      );
    }

    persistedAliasIndexIsSeeded = true;
  }

  let persistedAliasIndexIsSeeded = false;
  let asyncAliasIndexPromise: Promise<void> | null = null;
  let persistedAliasNamespaceMetadataSnapshot = 'null';
  async function ensureAsyncPersistedAliasIndex(): Promise<void> {
    if (!enableItemAliases) return;
    if (localStorageAdapter !== null) return;
    if (persistedAliasIndexIsSeeded) return;
    if (asyncAliasIndexPromise !== null) {
      await asyncAliasIndexPromise;
      return;
    }

    asyncAliasIndexPromise = namespace
      .readNamespaceMetadata()
      .then((metadata) => {
        readPersistedAliasNamespaceMetadata(metadata);
        persistedAliasNamespaceMetadataSnapshot = JSON.stringify(metadata);
        persistedAliasIndexIsSeeded = true;
      })
      .finally(() => {
        asyncAliasIndexPromise = null;
      });

    await asyncAliasIndexPromise;
  }

  function rememberHydratedItem(
    itemKey: string,
    persisted: PersistedCollectionItemData<unknown>,
  ): void {
    setPersistedItemAliases(
      itemKey,
      parseAliasPayloads(persisted.aliasPayloads),
    );
    hydratedPersistedKeys.add(itemKey);
    persistedSnapshotByKey.set(itemKey, JSON.stringify(persisted));
    knownPersistedKeys?.add(itemKey);
  }

  function forgetPersistedItem(itemKey: string): void {
    clearPersistedItemAliases(itemKey);
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
  ):
    | {
        aliasPayloads: ItemPayload[];
        item: TSFDCollectionItem<ItemState, ItemPayload>;
      }
    | undefined {
    try {
      const persisted = parsePersistedCollectionItemData(
        JSON.parse(snapshot),
        config.payloadSchema,
        dataSchema,
      );
      const item = persisted
        ? (toCollectionItemState(persisted, dataSchema, shouldIgnoreItem) ??
          undefined)
        : undefined;
      if (!persisted || !item) return undefined;

      return { aliasPayloads: persisted.aliasPayloads ?? [], item };
    } catch {
      return undefined;
    }
  }

  function readRememberedHydratedItem(
    itemKey: string,
  ):
    | {
        aliasPayloads: ItemPayload[];
        item: TSFDCollectionItem<ItemState, ItemPayload>;
      }
    | undefined {
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
  ):
    | {
        aliasPayloads: ItemPayload[];
        item: TSFDCollectionItem<ItemState, ItemPayload>;
      }
    | undefined {
    if (localStorageAdapter === null) return undefined;

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
      forgetPersistedItem(itemKey);
      return undefined;
    }

    const persisted = parsePersistedCollectionItemData(
      cacheEntry.data,
      config.payloadSchema,
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

    const item = toCollectionItemState(persisted, dataSchema, shouldIgnoreItem);
    if (!item) {
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
    return { aliasPayloads: persisted.aliasPayloads ?? [], item };
  }

  function createInitialState(
    baseState: TSFDCollectionState<ItemState, ItemPayload>,
  ): TSFDCollectionState<ItemState, ItemPayload> {
    syncMaintenanceRegistration();
    rebuildLocalPersistedAliasIndex();
    return baseState;
  }

  function readHydratedItem(
    this: void,
    itemKey: string,
  ):
    | {
        aliasPayloads: ItemPayload[];
        item: TSFDCollectionItem<ItemState, ItemPayload>;
      }
    | undefined {
    const resolvedItemKey = persistedAliasRegistry.resolveItemKey(itemKey);
    if (localStorageAdapter !== null) {
      return (
        readRememberedHydratedItem(resolvedItemKey) ??
        readHydratedLocalStorageItem(resolvedItemKey)
      );
    }

    const snapshot = persistedSnapshotByKey.get(resolvedItemKey);
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
    const resolvedItemKey = persistedAliasRegistry.resolveItemKey(itemKey);
    const existingItem = storeRef.state[resolvedItemKey];
    if (existingItem !== undefined) {
      return existingItem !== null;
    }

    if (localStorageAdapter !== null) {
      const validated = readHydratedItem(resolvedItemKey);
      if (!validated) return false;

      const currentItem = storeRef.state[resolvedItemKey];
      if (currentItem !== undefined) {
        return currentItem !== null;
      }

      materializeHydratedItem(resolvedItemKey, validated.item);

      return true;
    }

    await ensureAsyncPersistedAliasIndex();
    const canonicalItemKey =
      persistedAliasRegistry.resolveItemKey(resolvedItemKey);
    const existingPromise = pendingPreloads.get(canonicalItemKey);
    if (existingPromise) return existingPromise;

    const currentGeneration = generation;
    const promise = namespace
      .load(canonicalItemKey, { touch: 'coarse' })
      .then((cached) =>
        resolveAsyncPreloadedItem(canonicalItemKey, cached, currentGeneration),
      )
      .finally(() => {
        if (currentGeneration === generation) {
          pendingPreloads.delete(canonicalItemKey);
        }
      });

    pendingPreloads.set(canonicalItemKey, promise);
    return promise;
  }

  async function preloadItems(itemKeys: string[]): Promise<boolean[]> {
    if (localStorageAdapter !== null || itemKeys.length <= 1) {
      return Promise.all(itemKeys.map((itemKey) => preloadItem(itemKey)));
    }
    if (!storeRef) return itemKeys.map(() => false);
    await ensureAsyncPersistedAliasIndex();

    const resultsByKey = new Map<string, Promise<boolean>>();
    const batchKeys: string[] = [];

    for (const itemKey of [...new Set(itemKeys)]) {
      const resolvedItemKey = persistedAliasRegistry.resolveItemKey(itemKey);
      const existingItem = storeRef.state[resolvedItemKey];
      if (existingItem !== undefined) {
        resultsByKey.set(itemKey, Promise.resolve(existingItem !== null));
        continue;
      }
      const existingPromise = pendingPreloads.get(resolvedItemKey);
      if (existingPromise !== undefined) {
        resultsByKey.set(itemKey, existingPromise);
        continue;
      }

      batchKeys.push(resolvedItemKey);
    }

    if (batchKeys.length > 0) {
      const currentGeneration = generation;
      const uniqueBatchKeys = [...new Set(batchKeys)];
      const batchPromise = namespace
        .loadMany(uniqueBatchKeys, { touch: 'coarse' })
        .then((cachedEntries) => {
          const resolved = new Map<string, boolean>();
          for (const [index, itemKey] of uniqueBatchKeys.entries()) {
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

      for (const itemKey of uniqueBatchKeys) {
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
        (itemKey) =>
          resultsByKey.get(itemKey) ??
          pendingPreloads.get(persistedAliasRegistry.resolveItemKey(itemKey)) ??
          Promise.resolve(false),
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

    const invalidEntries: { itemKey: string }[] = [];
    const validEntries: {
      itemKey: string;
      lastAccessAt: number;
      payload: ItemPayload;
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
        stateEntries.push([itemKey, hydratedItem.item]);
      }
      const persistableStateEntryCount = stateEntries.filter(
        ([, item]) => item?.data && !shouldIgnoreItem(item.payload),
      ).length;
      const shouldTrackAsyncOverflow =
        localStorageAdapter === null &&
        (config.maxItems !== undefined ||
          (knownPersistedKeys?.size ?? 0) > maxItems ||
          hydratedPersistedKeys.size > maxItems ||
          persistableStateEntryCount > maxItems);
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

        const aliasPayloads =
          getItemAliasPayloads?.(itemKey) ??
          persistedAliasRegistry.getAliasPayloads(itemKey);
        const nextValue = {
          data: converted.value,
          payload: item.payload,
          ...(aliasPayloads.length > 0 ? { aliasPayloads } : {}),
        };
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

      const asyncAliasNamespaceUpdate =
        localStorageAdapter === null && enableItemAliases
          ? buildNextPersistedAliasNamespaceMetadata({
              removedItemKeys: pendingRemoves,
              upsertedItems: [...pendingUpserts.entries()].map(
                ([itemKey, entry]) => ({
                  aliasPayloads: parseAliasPayloads(entry.value.aliasPayloads),
                  itemKey,
                }),
              ),
            })
          : null;
      const nextAliasNamespaceMetadata =
        asyncAliasNamespaceUpdate !== null &&
        asyncAliasNamespaceUpdate.snapshot !==
          persistedAliasNamespaceMetadataSnapshot
          ? asyncAliasNamespaceUpdate.metadata
          : undefined;

      await namespace.commit({
        ...(nextAliasNamespaceMetadata !== undefined
          ? { namespaceMetadata: nextAliasNamespaceMetadata }
          : {}),
        removes: [...pendingRemoves],
        staticPolicy: persistedStaticPolicy,
        upserts: [...pendingUpserts.entries()].map(([key, entry]) => ({
          data: entry.value,
          key,
        })),
      });

      if (asyncAliasNamespaceUpdate?.snapshot !== undefined) {
        persistedAliasNamespaceMetadataSnapshot =
          asyncAliasNamespaceUpdate.snapshot;
      }

      for (const itemKey of pendingRemoves) {
        forgetPersistedItem(itemKey);
      }
      for (const [itemKey, entry] of pendingUpserts.entries()) {
        rememberHydratedItem(itemKey, entry.value);
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
    rebuildLocalPersistedAliasIndex();
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
    persistedAliasIndexIsSeeded = false;
    asyncAliasIndexPromise = null;
    persistedAliasNamespaceMetadataSnapshot = 'null';
    persistedAliasRegistry.clearAll();
    hydratedPersistedKeys.clear();
    knownPersistedKeys = null;
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
    persistedAliasIndexIsSeeded = false;
    asyncAliasIndexPromise = null;
    persistedAliasNamespaceMetadataSnapshot = 'null';
    persistedAliasRegistry.clearAll();
    persistedSnapshotByKey.clear();
    hydratedPersistedKeys.clear();
    await namespace.clear();
  }

  return {
    createInitialState,
    attach,
    maybeHydrateItems,
    preloadItems,
    getHydratedItemKeys: () => [...hydratedPersistedKeys],
    readHydratedItem,
    resolveItemKey: (itemKey) =>
      enableItemAliases
        ? persistedAliasRegistry.resolveItemKey(itemKey)
        : itemKey,
    hasAsyncPreload: localStorageAdapter === null,
    dispose,
    clear,
  };
}
