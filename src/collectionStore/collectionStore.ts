import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { useCallback } from 'react';
import { Result, type Result as ResultType } from 't-result';
import { Store } from 't-state';
import { createLruCacheRuntime } from '../cacheLimits/lruCacheRuntime';
import {
  CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS,
  createIdleThrottledScheduler,
} from '../cacheLimits/scheduleIdleThrottled';
import { useListItem as useListItemBase } from '../hooks/useListItem';
import { useListItemIsDeleted as useListItemIsDeletedBase } from '../hooks/useListItemIsDeleted';
import { useListItemIsLoading as useListItemIsLoadingBase } from '../hooks/useListItemIsLoading';
import {
  wrapGetSessionKeyForTest,
  wrapOfflineOperationsForTimeline,
} from '../internal/offlineTestInstrumentation';
import type {
  TestOfflineTimelineEvent,
  TestSessionKeyChangedEvent,
} from '../internal/testTimelineTypes';
import { setupCollectionPersistence } from '../persistentStorage/collectionStorePersistence';
import {
  type OfflineAwareMutationController,
  type OfflineMutationResult,
  runHybridOfflineMutation,
} from '../persistentStorage/offline/mutationRuntime';
import {
  captureOfflineOverlayEntries,
  rebindOfflineOverlayEntries,
} from '../persistentStorage/offline/overlayStoreLifecycle';
import {
  useOfflineStoreEntities,
  useOfflineStoreResolutions,
} from '../persistentStorage/offline/sessionCoordinator';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  offlineSessionUnavailableError,
} from '../persistentStorage/offline/storeController';
import {
  offlineItemEntityRefSchema,
  OfflineResolutionConflictParseError,
  type AnyOfflineOperationDefinition,
  type CollectionOfflineEntityRef,
  type OfflineMutationInput,
  type ParsedOfflineResolutionConflictResultForOperation,
  type OfflineResolutionRecordForOperation,
  type OfflineResolutionActionForOperation,
} from '../persistentStorage/offline/types';
import type { OfflineMutationUploadsInput } from '../persistentStorage/offlineUploadTypes';
import { createProtectedStorageKey } from '../persistentStorage/persistentStorageManager';
import type {
  CollectionPersistentStorageConfig,
  PersistentStoragePreloadResult,
  ResolvedCollectionPersistentStorageConfig,
} from '../persistentStorage/types';
import {
  BatchRequest,
  FetchContext,
  FetchType,
  getAutoIncrementId,
  RequestScheduler,
  RequestSchedulerEventData,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
import {
  registerStoreWithManager,
  resolveStoreManagerOfflineSession,
  type StoreManager,
  validateStoreManagerSessionConsistency,
} from '../storeManager';
import {
  type BrowserTabsPriorityTimings,
  type BrowserTabsTabStatusMessage,
} from '../utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  isBrowserTabsSyncVersionNewer,
  toBrowserTabsSyncVersion,
  type BrowserTabsMessageMeta,
  type BrowserTabsSyncVersion,
  type BrowserTabsTransportFactory,
  type SnapshotConsistency,
} from '../utils/browserTabsSync';
import {
  createItemAliasRegistry,
  normalizeResolvedItemIdentity,
  type ResolveItemIdentity,
} from '../utils/itemIdentity';
import {
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from '../utils/performMutation';
import { createStoreFocusLifecycle } from '../utils/storeFocusLifecycle';
import {
  AbortedStoreError,
  DEFAULT_BATCH_KEY,
  fetchTypePriority,
  type MutationSkipped,
  NotFoundStoreError,
  StoreFetchError,
  StoreMutationError,
  toStoreMutationError,
  TimeoutStoreError,
  TSDFStatus,
  ValidPayload,
  ValidStoreState,
  type StoreError,
} from '../utils/storeShared';
import { createCollectionCacheLimits } from './collectionCacheLimits';
import { executeBatchFetch as executeBatchFetchBase } from './executeBatchFetch';
import { useItem as useItemBase, UseItemOptions } from './useItem';
import {
  useMultipleItems as useMultipleItemsBase,
  UseMultipleItemsOptions,
} from './useMultipleItems';

export type CollectionItemStatus = TSDFStatus;

export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  data: ItemState | null;
  error: StoreError | null;
  status: CollectionItemStatus;
  payload: ItemPayload;
  refetchOnMount: false | FetchType;
  wasLoaded: boolean;
};

export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload> | null>;

export type TSFDUseCollectionItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  data: Selected;
  status: CollectionItemStatus | 'idle' | 'deleted';
  payload: ItemPayload | undefined;
  error: StoreError | null;
  itemStateKey: string;
  isLoading: boolean;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
  queryMetadata: QueryMetadata;
};

export type CollectionUseMultipleItemsQuery<
  ItemPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  payload: ItemPayload;
  queryMetadata?: QueryMetadata;
  omitPayload?: boolean;
  /** Only loads the data if it is not already loaded and skip any other refetches */
  disableRefetches?: boolean;
  disableRefetchOnMount?: boolean;
  returnIdleStatus?: boolean;
  returnRefetchingStatus?: boolean;
  isOffScreen?: boolean;
};

export type OnCollectionItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  itemState: ItemState;
  payload: ItemPayload;
  priority: FetchType;
}) => void;

export type CollectionInitialStateItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = { payload: ItemPayload; data: ItemState };

export type CollectionStoreStoreEvents<ItemPayload extends ValidPayload> = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number; items: ItemPayload[] };
  /** Emitted when a mutation completes or fails */
  mutationEnd: { mutationId: number; items: ItemPayload[]; success: boolean };
  /** Emitted when an offline temp item is reconciled to its final payload. */
  tempEntityReconciled: { tempId: ItemPayload; finalPayload: ItemPayload };
};

export type CollectionStateCleanup<ItemPayload extends ValidPayload> = {
  reason: 'cacheLimitEviction';
  itemKeys: string[];
  payloads: ItemPayload[];
};

export type CollectionBrowserTabsMessage<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> =
  | (BrowserTabsMessageMeta & BrowserTabsTabStatusMessage)
  | (BrowserTabsMessageMeta & {
      kind: 'collection-item-snapshot';
      itemKey: string;
      aliasPayloads?: ItemPayload[];
      consistency: SnapshotConsistency;
      item: TSFDCollectionItem<ItemState, ItemPayload> | null;
    })
  | (BrowserTabsMessageMeta & {
      kind: 'fetch-start';
      targetKey: string;
      requestIds: string[];
      startedAt: number;
    })
  | (BrowserTabsMessageMeta & {
      kind: 'fetch-success';
      targetKey: string;
      requestIds: string[];
      startedAt: number;
      duration: number;
    });

type CollectionItemSnapshotMessage<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Extract<
  CollectionBrowserTabsMessage<ItemState, ItemPayload>,
  { kind: 'collection-item-snapshot' }
>;

type InternalCollectionOfflineOperations<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<
  string,
  AnyOfflineOperationDefinition & {
    getEntityRefs: (ctx: {
      input: __LEGIT_ANY__;
    }) => CollectionOfflineEntityRef<ItemPayload>[];
  }
> &
  ([ItemState | ItemPayload] extends [never] ? never : unknown);

type CollectionOfflineOperationsConfig<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = InternalCollectionOfflineOperations<ItemState, ItemPayload> | null;

const EMPTY_COLLECTION_OFFLINE_OPERATIONS = {};

export type CollectionStoreOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
  StorageState = unknown,
> = {
  debugName?: string;
  /** Stable id shared by the same logical collection store across browser tabs. */
  id: string;
  /** Shared global store manager providing session scoping and error normalization. */
  storeManager: StoreManager;
  fetchFn: (params: ItemPayload, signal: AbortSignal) => Promise<ItemState>;
  /** Optional batch fetch function for fetching multiple items at once */
  batchFetchFn?: (
    payloads: ItemPayload[],
    signal: AbortSignal,
    batchKey: string,
  ) => Promise<Map<ItemPayload, ItemState | Error>>;
  /** Optional function to group batch fetches by key. Return false to fall back to individual fetchFn */
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  /** Max items per batch - triggers immediate fetch when reached */
  maxBatchSize?: number;
  /** Maximum number of cached items kept in memory. Defaults to 5,000. Inactive items are evicted in LRU order, while mounted hook items stay protected. */
  maxItems?: number;
  /** Called when cache-limit eviction removes items from in-memory state. */
  onStateCleanup?: (cleanup: CollectionStateCleanup<ItemPayload>) => void;
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  /** Resolves the canonical payload for a fetched item after the response is known. */
  resolveItemIdentity?: ResolveItemIdentity<ItemState, ItemPayload>;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  mediumPriorityDelayMs?: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  /** Reconnect-specific cooldown. The first reconnect revalidates immediately;
   * additional reconnects within the cooldown are coalesced into one trailing
   * revalidation. Set to `0` to disable this cooldown. */
  transportReconnectCooldownMs?: number;
  onInvalidate?: OnCollectionItemInvalidate<ItemState, ItemPayload>;
  onSchedulerEvent?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  onMutationError?: (
    error: unknown,
    options: { silentErrors?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  usesRealTimeUpdates?: boolean;
  /** Opt-in persistent storage configuration. When provided, cached items are loaded
   * from storage on first read and saved back on successful fetches.
   * Session scoping always reuses this store manager's `getSessionKey`, and the
   * persisted namespace always reuses this store's `id`. */
  persistentStorage?: CollectionPersistentStorageConfig<
    ItemState,
    ItemPayload,
    StorageState,
    TOfflineOperations
  >;
  /** @internal */
  '~test'?: {
    initialRefetchOnMount?: FetchType;
    initialStatus?: CollectionItemStatus;
    initialData?: CollectionInitialStateItem<ItemPayload, ItemState>[];
    initialError?: StoreError;
    initialLastFetchStartTime?: number;
    getWindowIsFocused?: () => boolean;
    onWindowFocus?: (handler: () => void) => () => void;
    onWindowFocusChange?: (handler: () => void) => () => void;
    browserTabsTransportFactory?: BrowserTabsTransportFactory;
    browserTabsPriorityTimings?: BrowserTabsPriorityTimings;
    browserTabsLeadershipTimings?: BrowserTabsPriorityTimings;
    onReceiveRemoteMsg?: (
      message: CollectionBrowserTabsMessage<ItemState, ItemPayload>,
    ) => void;
    onSessionKeyChanged?: (event: TestSessionKeyChangedEvent) => void;
    onOfflineTimelineEvent?: (event: TestOfflineTimelineEvent) => void;
  };
};

export type CollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
> = ReturnType<
  typeof createCollectionStore<ItemState, ItemPayload, TOfflineOperations>
>;

export type CollectionStoreEvents = {
  invalidateData: { priority: FetchType; itemKey: string };
};

export function createCollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
  StorageState = unknown,
>({
  debugName,
  id,
  storeManager,
  fetchFn,
  batchFetchFn,
  getItemsBatchKey,
  maxBatchSize,
  maxItems = 5_000,
  onStateCleanup,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  mediumPriorityDelayMs,
  dynamicRealtimeThrottleMs,
  revalidateOnWindowFocus,
  transportReconnectCooldownMs = 2_000,
  getCollectionItemKey: filterCollectionItemObjKey,
  resolveItemIdentity,
  onInvalidate,
  onSchedulerEvent,
  onMutationError,
  blockWindowClose,
  usesRealTimeUpdates = false,
  persistentStorage: persistentStorageConfig,
  '~test': testOptions,
}: CollectionStoreOptions<
  ItemState,
  ItemPayload,
  TOfflineOperations,
  StorageState
>) {
  type CollectionState = TSFDCollectionState<ItemState, ItemPayload>;
  type CollectionItem = TSFDCollectionItem<ItemState, ItemPayload>;
  type CollectionOfflineOverlay = {
    data: ItemState | null;
    payload?: ItemPayload;
    keepVisibleWhileResolutionRequired?: boolean;
  };
  type ResolvedOfflineOperations = TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;

  let remoteApplyDepth = 0;
  let currentBroadcastConsistency: SnapshotConsistency = 'confirmed';
  const lastCollectionSyncVersions = new Map<string, BrowserTabsSyncVersion>();
  const offlineOverlayStore = new Store<
    Record<string, CollectionOfflineOverlay>
  >({ debugName: `${id}:collection-offline-overlays`, state: () => ({}) });
  offlineOverlayStore.initializeStore();
  let offlineOverlaySessionKey: string | null = null;
  const itemCacheRuntime = createLruCacheRuntime();

  let initialData:
    | CollectionInitialStateItem<ItemPayload, ItemState>[]
    | undefined;
  let initialRefetchOnMount: FetchType | false = false;
  let initialStatus: CollectionItemStatus = 'success';
  let initialError: StoreError | null = null;
  const globalDisableRefetchOnMount = usesRealTimeUpdates;
  const resolvedOfflineSession = resolveStoreManagerOfflineSession({
    storeManager,
    storeName: id,
    usesOfflineStorage: persistentStorageConfig?.offline !== undefined,
  });
  const getSessionKeyBase =
    import.meta.env.TEST && testOptions
      ? wrapGetSessionKeyForTest(
          storeManager.getSessionKey,
          testOptions.onSessionKeyChanged,
        )
      : storeManager.getSessionKey;
  const getSessionKeyForRuntime =
    resolvedOfflineSession === null
      ? getSessionKeyBase
      : () =>
          validateStoreManagerSessionConsistency({
            storeManager,
            storeName: id,
            offlineSession: resolvedOfflineSession,
            getSessionKey: getSessionKeyBase,
          });
  const errorNormalizer = storeManager.errorNormalizer;
  const resolvedOfflineSessionForPersistentStorage =
    persistentStorageConfig?.offline === undefined
      ? undefined
      : (() => {
          if (resolvedOfflineSession === null) {
            throw new Error(
              `[tsdf] Store "${id}" requires an offline session but none was configured on the store manager`,
            );
          }

          return resolvedOfflineSession;
        })();

  // WORKAROUND: The public persistent-storage config intentionally omits the
  // manager-owned offline session, so stores reattach that resolved session at
  // runtime before passing the config to persistence internals.
  const resolvedPersistentStorageConfig: ResolvedCollectionPersistentStorageConfig<
    ItemState,
    ItemPayload,
    StorageState,
    TOfflineOperations
  > | null = persistentStorageConfig
    ? __LEGIT_CAST__<
        ResolvedCollectionPersistentStorageConfig<
          ItemState,
          ItemPayload,
          StorageState,
          TOfflineOperations
        >,
        unknown
      >({
        ...persistentStorageConfig,
        offline: persistentStorageConfig.offline
          ? {
              ...persistentStorageConfig.offline,
              session: resolvedOfflineSessionForPersistentStorage,
            }
          : undefined,
        getSessionKey: getSessionKeyForRuntime,
        storeName: id,
      })
    : null;

  if (import.meta.env.TEST && testOptions) {
    if (testOptions.initialData) {
      initialData = testOptions.initialData;
    }

    if (testOptions.initialRefetchOnMount) {
      initialRefetchOnMount = testOptions.initialRefetchOnMount;
    }

    if (testOptions.initialStatus) {
      initialStatus = testOptions.initialStatus;
    }

    if (testOptions.initialError) {
      initialError = testOptions.initialError;
    }
  }

  function getRawItemKey(params: ItemPayload): string {
    return getCompositeKey(
      filterCollectionItemObjKey ? filterCollectionItemObjKey(params) : params,
    );
  }

  const itemAliasRegistry = createItemAliasRegistry(getRawItemKey);

  // Persistent storage setup
  const persistence = resolvedPersistentStorageConfig
    ? setupCollectionPersistence(resolvedPersistentStorageConfig, {
        enableItemAliases: resolveItemIdentity !== undefined,
        getItemAliasPayloads: (itemKey) =>
          itemAliasRegistry.getAliasPayloads(itemKey),
        getItemKey: getRawItemKey,
      })
    : null;

  function resolveKnownItemKey(itemKey: string): string {
    const persistedItemKey = persistence?.resolveItemKey(itemKey) ?? itemKey;
    return itemAliasRegistry.resolveItemKey(persistedItemKey);
  }

  function getItemKey(params: ItemPayload): string {
    return getRawItemKey(params);
  }

  function getLookupItemKey(params: ItemPayload): string {
    return resolveKnownItemKey(getRawItemKey(params));
  }

  const store = new Store<CollectionState>({
    debugName,
    state: () => {
      const initialState: CollectionState = {};

      if (initialData) {
        for (const item of initialData) {
          const itemKey = getRawItemKey(item.payload);

          initialState[itemKey] = {
            data: item.data,
            error: initialError,
            status: initialStatus,
            payload: item.payload,
            refetchOnMount: initialRefetchOnMount,
            wasLoaded: initialStatus !== 'loading',
          };
        }
      }

      return persistence?.createInitialState(initialState) ?? initialState;
    },
  });

  function clearOfflineOverlays(nextSessionKey: string | null = null): void {
    offlineOverlaySessionKey = nextSessionKey;
    offlineOverlayStore.setState({});
  }

  function rebindOfflineOverlays(
    itemKeyRewrites: readonly {
      previousItemKey: string;
      nextItemKey: string;
    }[],
  ): void {
    rebindOfflineOverlayEntries({
      itemKeyRewrites,
      overlayStore: offlineOverlayStore,
      createReboundOverlay: ({ existingOverlay, nextItemKey }) => ({
        data: existingOverlay.data ?? null,
        payload: store.state[nextItemKey]?.payload ?? existingOverlay.payload,
        keepVisibleWhileResolutionRequired: true,
      }),
    });
  }

  function captureOfflineOverlays(itemKeys: readonly string[]): void {
    captureOfflineOverlayEntries({
      itemKeys,
      overlayStore: offlineOverlayStore,
      createOverlay: (itemKey) => {
        const item = store.state[itemKey];

        return {
          data: item ? klona(item.data) : null,
          payload: item ? klona(item.payload) : undefined,
        };
      },
    });
  }

  function getCanonicalAliasPayloads(
    canonicalItemKey: string,
    extraAliasPayloads: readonly ItemPayload[] = [],
  ): ItemPayload[] {
    const aliasPayloadsByKey = new Map<string, ItemPayload>();

    for (const aliasPayload of [
      ...itemAliasRegistry.getAliasPayloads(canonicalItemKey),
      ...extraAliasPayloads,
    ]) {
      const aliasItemKey = getRawItemKey(aliasPayload);
      if (aliasItemKey === canonicalItemKey) continue;
      if (!aliasPayloadsByKey.has(aliasItemKey)) {
        aliasPayloadsByKey.set(aliasItemKey, aliasPayload);
      }
    }

    return [...aliasPayloadsByKey.values()];
  }

  function setCanonicalItemAliases(
    canonicalItemKey: string,
    aliasPayloads: readonly ItemPayload[],
  ): ItemPayload[] {
    const nextAliasPayloads = getCanonicalAliasPayloads(
      canonicalItemKey,
      aliasPayloads,
    );
    itemAliasRegistry.setCanonicalAliases(canonicalItemKey, nextAliasPayloads);
    return nextAliasPayloads;
  }

  function mergeFetchedCollectionItem(
    preferredItem: CollectionItem,
    existingItem: CollectionItem | null | undefined,
    canonicalPayload: ItemPayload,
  ): CollectionItem {
    return {
      data: preferredItem.data ?? existingItem?.data ?? null,
      error: preferredItem.error ?? existingItem?.error ?? null,
      status: preferredItem.status,
      payload: klona(canonicalPayload),
      refetchOnMount: false,
      wasLoaded: preferredItem.wasLoaded || existingItem?.wasLoaded === true,
    };
  }

  function getResolvedStoredPayload(payload: ItemPayload): ItemPayload {
    const rawItemKey = getRawItemKey(payload);
    const resolvedItemKey = resolveKnownItemKey(rawItemKey);

    if (resolvedItemKey === rawItemKey) return payload;

    return (
      getItemFromStateOrPersistence(resolvedItemKey, {
        materializeSyncState: true,
      })?.payload ?? payload
    );
  }
  const resolvedOfflineConfig = resolvedPersistentStorageConfig?.offline;
  // WORKAROUND: Session-only offline config omits operations, so collection stores normalize that case to an empty registry before passing it through the generic offline controller surface.
  const resolvedOfflineOperations = __LEGIT_CAST__<
    ResolvedOfflineOperations,
    unknown
  >(resolvedOfflineConfig?.operations ?? EMPTY_COLLECTION_OFFLINE_OPERATIONS);

  const offlineOperationsForRuntime =
    import.meta.env.TEST &&
    testOptions?.onOfflineTimelineEvent &&
    resolvedOfflineConfig
      ? wrapOfflineOperationsForTimeline(
          resolvedOfflineOperations,
          testOptions.onOfflineTimelineEvent,
        )
      : resolvedOfflineOperations;

  const offlineController =
    resolvedPersistentStorageConfig && resolvedOfflineConfig
      ? createOfflineStoreController<ResolvedOfflineOperations>({
          storeName: id,
          storeType: 'collection',
          getSessionKey: getSessionKeyForRuntime,
          onPersistentStorageError:
            resolvedPersistentStorageConfig.onPersistentStorageError,
          adapter: resolvedPersistentStorageConfig.adapter,
          offlineSession: resolvedOfflineConfig.session,
          // WORKAROUND: Test-only timeline instrumentation wraps execute handlers at runtime, so the controller input has to be re-narrowed back to the store's resolved operation registry after that transformation.
          operations: __LEGIT_CAST__<ResolvedOfflineOperations, unknown>(
            offlineOperationsForRuntime,
          ),
          storeAdapter: {
            normalizeEntityRefs: (entityRefs) =>
              entityRefs.map((ref) => {
                // Temp entities are queued internally as normalized refs.
                const normalizedRef = offlineItemEntityRefSchema
                  .parse(ref)
                  .unwrapOrNull();
                if (normalizedRef !== null) return normalizedRef;

                return {
                  entityKey: getLookupItemKey(
                    // WORKAROUND: normalizeEntityRefs accepts either normalized refs or raw payloads, and after the ref schema fails the remaining value is treated as the caller's ItemPayload.
                    __LEGIT_CAST__<ItemPayload, unknown>(ref),
                  ),
                  entityKind: 'item' as const,
                };
              }),
            getProtectedCacheKeys: (entityRefs) => {
              const sessionKey = getSessionKeyForRuntime();
              if (sessionKey === false) return [];
              return entityRefs.map((ref) =>
                createProtectedStorageKey({
                  backend:
                    resolvedPersistentStorageConfig.adapter !== 'local-sync'
                      ? 'async'
                      : 'localStorage',
                  sessionKey,
                  storeName: id,
                  kind: 'collection.item',
                  key: ref.entityKey,
                }),
              );
            },
            applyPendingEntity: ({ tempId, pendingEntity }) => {
              if (!pendingEntity || typeof pendingEntity !== 'object') return;
              addItemToState(
                // WORKAROUND: Offline temp ids are stored as generic ValidPayload values, so this collection adapter has to narrow them back to ItemPayload when applying queued entities.
                __LEGIT_CAST__<ItemPayload, ValidPayload>(tempId),
                // WORKAROUND: Pending entity snapshots cross the offline queue as unknown and are rehydrated back to ItemState at this store-specific boundary.
                __LEGIT_CAST__<ItemState, unknown>(pendingEntity),
              );
            },
            rollbackPendingEntity: ({ tempId }) => {
              deleteItemState(
                // WORKAROUND: Offline temp ids are stored as generic ValidPayload values, so this collection adapter has to narrow them back to ItemPayload when removing queued temp entities.
                __LEGIT_CAST__<ItemPayload, ValidPayload>(tempId),
              );
            },
            reconcileTempEntity: ({ tempId, reconciliation }) => {
              const tempPayload =
                // WORKAROUND: Offline temp ids are stored as generic ValidPayload values, so this collection adapter has to narrow them back to ItemPayload when reconciling queued temp entities.
                __LEGIT_CAST__<ItemPayload, ValidPayload>(tempId);
              const currentItem = getItemState(tempPayload);
              const finalData =
                reconciliation.finalData !== undefined
                  ? // WORKAROUND: Reconciliation data is stored as unknown by the shared offline queue and is rehydrated to ItemState by the collection store.
                    __LEGIT_CAST__<ItemState, unknown>(reconciliation.finalData)
                  : (currentItem?.data ?? undefined);
              if (finalData === undefined) return;
              deleteItemState(tempPayload);
              const finalPayload =
                // WORKAROUND: Reconciliation payloads flow through the shared offline controller as ValidPayload and are narrowed back to the collection store's ItemPayload here.
                __LEGIT_CAST__<ItemPayload, ValidPayload>(
                  reconciliation.finalPayload,
                );
              addItemToState(finalPayload, finalData);
              storeEvents.emit('tempEntityReconciled', {
                tempId: tempPayload,
                finalPayload,
              });
            },
            captureQueuedMutationOverlays: ({ entityRefs, sessionKey }) => {
              if (offlineOverlaySessionKey !== sessionKey)
                clearOfflineOverlays(sessionKey);
              captureOfflineOverlays(
                entityRefs.flatMap((ref) => {
                  return ref.entityKind === 'item' ? [ref.entityKey] : [];
                }),
              );
            },
            rebindQueuedMutationOverlays: ({ itemKeyRewrites, sessionKey }) => {
              if (offlineOverlaySessionKey !== sessionKey)
                clearOfflineOverlays(sessionKey);

              rebindOfflineOverlays(itemKeyRewrites);
            },
            syncEntityOverlays: ({ entities, sessionKey }) => {
              if (offlineOverlaySessionKey !== sessionKey)
                clearOfflineOverlays(sessionKey);
              const activeItemKeys = new Set(
                entities
                  .filter((entity) => entity.entityKind === 'item')
                  .map((entity) => entity.entityKey),
              );

              offlineOverlayStore.produceState((draft) => {
                for (const itemKey of Object.keys(draft)) {
                  if (!activeItemKeys.has(itemKey)) {
                    delete draft[itemKey];
                  }
                }
              });
            },
          },
        })
      : null;

  function touchItems(itemKeys: string[]): void {
    itemCacheRuntime.touch(itemKeys, (itemKey) => {
      return store.state[itemKey] !== undefined;
    });
  }

  function touchItemsAndMaybeEnforceLimits(itemKeys: string[]): void {
    touchItems(itemKeys);
    if (shouldScheduleCacheLimitEnforcement()) {
      scheduleCacheLimitEnforcement();
    }
  }

  function registerActiveItems(itemKeys: string[]): () => void {
    if (itemKeys.length === 0) return () => {};

    const unregister = itemCacheRuntime.registerActive(itemKeys);

    return () => {
      unregister();
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
    };
  }

  function shouldScheduleCacheLimitEnforcement(): boolean {
    let cachedItemCount = 0;

    for (const item of Object.values(store.state)) {
      if (item !== null) {
        cachedItemCount++;
        if (cachedItemCount > maxItems) return true;
      }
    }

    return false;
  }

  const getWindowIsFocused = testOptions?.getWindowIsFocused ?? isWindowFocused;

  function runWithoutBroadcast<T>(callback: () => T): T {
    remoteApplyDepth++;
    try {
      return callback();
    } finally {
      remoteApplyDepth--;
    }
  }

  function runWithBroadcastConsistency<T>(
    consistency: SnapshotConsistency,
    callback: () => T,
  ): T {
    const previousConsistency = currentBroadcastConsistency;
    currentBroadcastConsistency = consistency;

    try {
      return callback();
    } finally {
      currentBroadcastConsistency = previousConsistency;
    }
  }

  const events = evtmitter<CollectionStoreEvents>();
  const wrappedDynamicRealtimeThrottleMs = dynamicRealtimeThrottleMs
    ? (lastFetchDuration: number) =>
        dynamicRealtimeThrottleMs({
          lastFetchDuration,
          windowIsNotFocused: !getWindowIsFocused(),
        })
    : undefined;

  const storeEvents = evtmitter<CollectionStoreStoreEvents<ItemPayload>>();

  const useBatchSchedulers = !!batchFetchFn;

  function getItemTargetKey(itemKey: string): string {
    return `item:${itemKey}`;
  }

  function getBatchTargetKey(batchKey: string): string {
    return `batch:${batchKey}`;
  }

  function getBatchKey(payload: ItemPayload): string | false {
    if (!useBatchSchedulers) return false;
    if (!getItemsBatchKey) return DEFAULT_BATCH_KEY;
    return getItemsBatchKey(payload);
  }

  function getAutomaticCoalescingWindowMs(): number {
    return browserTabsPriority.getCoalescingWindowMs(baseCoalescingWindowMs);
  }

  function publishFetchStart(
    targetKey: string,
    requestIds: string[],
    startedAt: number,
  ): void {
    browserTabsSync.publish({
      kind: 'fetch-start',
      targetKey,
      requestIds,
      startedAt,
    });
  }

  function publishFetchSuccess(
    targetKey: string,
    requestIds: string[],
    startedAt: number,
    duration: number,
  ): void {
    browserTabsSync.publish({
      kind: 'fetch-success',
      targetKey,
      requestIds,
      startedAt,
      duration,
    });
  }

  function getInitialRequestStartTime(itemKey: string): number | undefined {
    if (store.state[itemKey] === undefined) return undefined;
    return testOptions?.initialLastFetchStartTime ?? 0;
  }

  function seedBatchSchedulerKnownRequests(
    scheduler: RequestScheduler<ItemPayload>,
    batchKey: string,
  ): void {
    for (const [itemKey, item] of Object.entries(store.state)) {
      if (!item?.payload) continue;
      if (getBatchKey(item.payload) !== batchKey) continue;

      scheduler.setLastFetchStartTimeForRequest(
        itemKey,
        getInitialRequestStartTime(itemKey) ?? 0,
      );
    }
  }

  const batchKeySchedulers = new Map<string, RequestScheduler<ItemPayload>>();

  function getOrCreateBatchKeyScheduler(
    batchKey: string,
  ): RequestScheduler<ItemPayload> {
    let scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) {
      scheduler = new RequestScheduler<ItemPayload>({
        fetchFn: async (
          requests: BatchRequest<ItemPayload>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          publishFetchStart(
            getBatchTargetKey(batchKey),
            requests.map(({ requestId }) => requestId),
            fetchCtx.getStartTime(),
          );

          const results = await executeBatchFetch(requests, fetchCtx, batchKey);
          const successfulRequestIds = requests
            .filter(({ requestId }) => results.get(requestId) === true)
            .map(({ requestId }) => requestId);

          if (successfulRequestIds.length > 0) {
            publishFetchSuccess(
              getBatchTargetKey(batchKey),
              successfulRequestIds,
              fetchCtx.getStartTime(),
              Date.now() - fetchCtx.getStartTime(),
            );
          }

          return results;
        },
        lowPriorityThrottleMs,
        getCoalescingWindowMs: getAutomaticCoalescingWindowMs,
        dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        maxBatchSize,
        on: onSchedulerEvent,
        initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
        usesRealTimeUpdates,
      });
      seedBatchSchedulerKnownRequests(scheduler, batchKey);
      batchKeySchedulers.set(batchKey, scheduler);
    }
    return scheduler;
  }

  // Per-item schedulers used when batch scheduling is disabled for a request.
  const perItemSchedulers = new Map<string, RequestScheduler<ItemPayload>>();

  function getOrCreateItemScheduler(
    itemKey: string,
  ): RequestScheduler<ItemPayload> {
    let itemScheduler = perItemSchedulers.get(itemKey);
    if (!itemScheduler) {
      itemScheduler = new RequestScheduler<ItemPayload>({
        fetchFn: async (
          requests: BatchRequest<ItemPayload>[],
          fetchCtx: FetchContext,
        ): Promise<Map<string, boolean>> => {
          publishFetchStart(
            getItemTargetKey(itemKey),
            requests.map(({ requestId }) => requestId),
            fetchCtx.getStartTime(),
          );

          const results = await executeBatchFetch(requests, fetchCtx);
          const successfulRequestIds = requests
            .filter(({ requestId }) => results.get(requestId) === true)
            .map(({ requestId }) => requestId);

          if (successfulRequestIds.length > 0) {
            publishFetchSuccess(
              getItemTargetKey(itemKey),
              successfulRequestIds,
              fetchCtx.getStartTime(),
              Date.now() - fetchCtx.getStartTime(),
            );
          }

          return results;
        },
        lowPriorityThrottleMs,
        getCoalescingWindowMs: getAutomaticCoalescingWindowMs,
        dynamicRealtimeThrottleMs: wrappedDynamicRealtimeThrottleMs,
        mediumPriorityDelayMs,
        on: onSchedulerEvent,
        initialLastFetchStartTime: testOptions?.initialLastFetchStartTime,
        usesRealTimeUpdates,
      });
      const initialStartTime = getInitialRequestStartTime(itemKey);
      if (initialStartTime !== undefined) {
        itemScheduler.setLastFetchStartTimeForRequest(
          itemKey,
          initialStartTime,
        );
      }
      perItemSchedulers.set(itemKey, itemScheduler);
    }
    return itemScheduler;
  }

  function getScheduler(
    itemKey: string,
    payload: ItemPayload,
  ): RequestScheduler<ItemPayload> {
    if (useBatchSchedulers) {
      if (getItemsBatchKey) {
        const batchKey = getItemsBatchKey(payload);
        if (batchKey !== false) {
          return getOrCreateBatchKeyScheduler(batchKey);
        }
        // batchKey === false → fall through to per-item scheduler
      } else {
        return getOrCreateBatchKeyScheduler(DEFAULT_BATCH_KEY);
      }
    }
    return getOrCreateItemScheduler(itemKey);
  }

  function recordCollectionSyncVersion(
    itemKey: string,
    meta: Pick<BrowserTabsMessageMeta, 'tabId' | 'seq' | 'sentAt'>,
    consistency: SnapshotConsistency,
  ): void {
    lastCollectionSyncVersions.set(
      itemKey,
      toBrowserTabsSyncVersion(meta, consistency),
    );
  }

  function publishItemSnapshot(
    itemKey: string,
    consistency: SnapshotConsistency = currentBroadcastConsistency,
  ): void {
    if (remoteApplyDepth > 0) return;

    const item = store.state[itemKey] ?? null;
    const aliasPayloads =
      item !== null && resolveKnownItemKey(itemKey) === itemKey
        ? itemAliasRegistry.getAliasPayloads(itemKey)
        : [];
    const message = browserTabsSync.publish({
      kind: 'collection-item-snapshot',
      itemKey,
      ...(aliasPayloads.length > 0 ? { aliasPayloads } : {}),
      consistency,
      item,
    });
    if (!message) return;

    recordCollectionSyncVersion(itemKey, message, consistency);
  }

  function getSchedulerForTargetKey(
    targetKey: string,
  ): RequestScheduler<ItemPayload> | null {
    if (targetKey.startsWith('batch:')) {
      const batchKey = targetKey.slice('batch:'.length);
      const existingScheduler = batchKeySchedulers.get(batchKey);
      if (existingScheduler) return existingScheduler;

      const hasKnownItems = Object.values(store.state).some((item) => {
        if (!item?.payload) return false;
        return getBatchKey(item.payload) === batchKey;
      });
      if (!hasKnownItems) return null;

      return getOrCreateBatchKeyScheduler(batchKey);
    }

    const itemKey = targetKey.slice('item:'.length);
    const existingScheduler = perItemSchedulers.get(itemKey);
    if (existingScheduler) return existingScheduler;

    const payload = store.state[itemKey]?.payload;
    if (!payload) return null;

    return getScheduler(itemKey, payload);
  }

  function applyRemoteItemSnapshot(
    message: CollectionItemSnapshotMessage<ItemState, ItemPayload>,
    candidateVersion: BrowserTabsSyncVersion,
  ): void {
    if (message.item !== null) {
      setCanonicalItemAliases(message.itemKey, message.aliasPayloads ?? []);
    } else if (resolveKnownItemKey(message.itemKey) === message.itemKey) {
      itemAliasRegistry.clearCanonicalAliases(message.itemKey);
    }

    const existingItem = store.state[message.itemKey];
    const schedulerPayload = message.item?.payload ?? existingItem?.payload;
    const snapshotItem = message.item;

    if (existingItem === undefined) {
      if (snapshotItem !== null) {
        runWithoutBroadcast(() => {
          store.produceState(
            (draft) => {
              draft[message.itemKey] = {
                data: snapshotItem.data,
                status: 'success',
                error: null,
                payload: snapshotItem.payload,
                refetchOnMount: false,
                wasLoaded: snapshotItem.wasLoaded,
              };
            },
            { action: 'browser-tabs-collection-item-snapshot' },
          );
        });
      }

      lastCollectionSyncVersions.set(message.itemKey, candidateVersion);
      if (snapshotItem !== null) {
        touchItemsAndMaybeEnforceLimits([message.itemKey]);
      }
      return;
    }

    runWithoutBroadcast(() => {
      store.produceState(
        (draft) => {
          draft[message.itemKey] =
            snapshotItem === null
              ? null
              : {
                  data: snapshotItem.data,
                  status: 'success',
                  error: null,
                  payload: snapshotItem.payload,
                  refetchOnMount: false,
                  wasLoaded: snapshotItem.wasLoaded,
                };
        },
        { action: 'browser-tabs-collection-item-snapshot' },
      );

      invalidationWasTriggered.delete(message.itemKey);
    });

    if (message.item === null && schedulerPayload) {
      cleanupItemResources(message.itemKey, schedulerPayload);
    } else if (message.item !== null) {
      touchItemsAndMaybeEnforceLimits([message.itemKey]);
    }

    lastCollectionSyncVersions.set(message.itemKey, candidateVersion);
  }

  function shouldIgnoreConfirmedRemoteCollectionSnapshot(
    message: CollectionItemSnapshotMessage<ItemState, ItemPayload>,
  ): boolean {
    if (message.consistency !== 'confirmed') return false;

    const payload = store.state[message.itemKey]?.payload;
    if (!payload) return false;

    return getScheduler(message.itemKey, payload).isMutationInProgress(
      message.itemKey,
    );
  }

  function handleRemoteMessage(
    message: CollectionBrowserTabsMessage<ItemState, ItemPayload>,
  ): void {
    if (message.kind === 'tab-status') {
      browserTabsPriority.onTabStatusMessage(message.tabId, message);
      return;
    }

    if (message.kind === 'fetch-start') {
      const scheduler = getSchedulerForTargetKey(message.targetKey);
      scheduler?.syncExternalFetchStart(message.requestIds, message.startedAt);
      scheduler?.cancelCoalescingRequests(message.requestIds);
      return;
    }

    if (message.kind === 'fetch-success') {
      getSchedulerForTargetKey(message.targetKey)?.syncExternalFetchSuccess(
        message.requestIds,
        message.startedAt,
        message.duration,
      );
      return;
    }

    const candidateVersion = toBrowserTabsSyncVersion(
      message,
      message.consistency,
    );
    const currentVersion = lastCollectionSyncVersions.get(message.itemKey);

    if (!isBrowserTabsSyncVersionNewer(candidateVersion, currentVersion)) {
      return;
    }

    if (shouldIgnoreConfirmedRemoteCollectionSnapshot(message)) {
      lastCollectionSyncVersions.set(message.itemKey, candidateVersion);
      return;
    }

    if (import.meta.env.TEST) {
      testOptions?.onReceiveRemoteMsg?.(message);
    }

    applyRemoteItemSnapshot(message, candidateVersion);
  }

  const { coordinator: browserTabsSync, priority: browserTabsPriority } =
    createBrowserTabsCoordinatorWithPriority<
      CollectionBrowserTabsMessage<ItemState, ItemPayload>
    >({
      storeType: 'collection',
      storeKey: id,
      getSessionKey: getSessionKeyForRuntime,
      onMessage: handleRemoteMessage,
      onSessionChange() {
        lastCollectionSyncVersions.clear();
        clearOfflineOverlays();
      },
      transportFactory: testOptions?.browserTabsTransportFactory,
      getWindowIsFocused,
      onWindowFocusChange: testOptions?.onWindowFocusChange,
      priorityTimings:
        testOptions?.browserTabsPriorityTimings ??
        testOptions?.browserTabsLeadershipTimings,
    });

  async function executeBatchFetch(
    requests: BatchRequest<ItemPayload>[],
    fetchCtx: FetchContext,
    batchKey?: string,
  ): Promise<Map<string, boolean>> {
    const results = await executeBatchFetchBase(
      requests,
      fetchCtx,
      store,
      fetchFn,
      batchFetchFn,
      errorNormalizer,
      batchKey,
      offlineController,
    );

    const successfulRequests = requests.filter(
      ({ requestId }) => results.get(requestId) === true,
    );
    if (successfulRequests.length > 0) {
      if (resolveItemIdentity === undefined) {
        const successfulItemKeys = successfulRequests.map(
          ({ requestId }) => requestId,
        );
        touchItemsAndMaybeEnforceLimits(successfulItemKeys);
        for (const itemKey of successfulItemKeys) {
          publishItemSnapshot(itemKey, 'confirmed');
        }
        return results;
      }

      const canonicalItemKeys = new Set<string>();
      const removedAliasKeys = new Set<string>();
      const cleanupAliases: { itemKey: string; payload: ItemPayload }[] = [];
      const itemKeyRewrites: {
        previousItemKey: string;
        nextItemKey: string;
      }[] = [];
      const aliasUpdates: {
        canonicalItemKey: string;
        aliasPayloads: ItemPayload[];
        canonicalPayload: ItemPayload;
      }[] = [];

      store.produceState(
        (draft) => {
          for (const { payload, requestId } of successfulRequests) {
            const fetchedItem = draft[requestId];
            if (!fetchedItem?.data) continue;

            const resolvedIdentity = normalizeResolvedItemIdentity({
              data: fetchedItem.data,
              getItemKey: getRawItemKey,
              payload,
              resolveItemIdentity,
              source: 'itemFetch',
            });
            const canonicalItemKey = resolvedIdentity.canonicalItemKey;
            const existingCanonicalItem =
              canonicalItemKey === requestId
                ? fetchedItem
                : draft[canonicalItemKey];

            draft[canonicalItemKey] = mergeFetchedCollectionItem(
              fetchedItem,
              existingCanonicalItem,
              resolvedIdentity.canonicalPayload,
            );
            canonicalItemKeys.add(canonicalItemKey);

            const extraAliasPayloads = [
              ...resolvedIdentity.aliasPayloads,
              ...(existingCanonicalItem &&
              getRawItemKey(existingCanonicalItem.payload) !== canonicalItemKey
                ? [existingCanonicalItem.payload]
                : []),
            ];
            aliasUpdates.push({
              canonicalItemKey,
              aliasPayloads: extraAliasPayloads,
              canonicalPayload: resolvedIdentity.canonicalPayload,
            });

            if (requestId === canonicalItemKey) continue;

            draft[requestId] = null;
            removedAliasKeys.add(requestId);
            cleanupAliases.push({ itemKey: requestId, payload });
            itemKeyRewrites.push({
              previousItemKey: requestId,
              nextItemKey: canonicalItemKey,
            });
          }
        },
        { action: 'canonicalize-item-identity' },
      );

      for (const {
        canonicalItemKey,
        aliasPayloads,
        canonicalPayload,
      } of aliasUpdates) {
        setCanonicalItemAliases(canonicalItemKey, aliasPayloads);
        getScheduler(
          canonicalItemKey,
          canonicalPayload,
        ).setLastFetchStartTimeForRequest(
          canonicalItemKey,
          fetchCtx.getStartTime(),
        );
      }
      if (itemKeyRewrites.length > 0) {
        rebindOfflineOverlays(itemKeyRewrites);
      }

      touchItemsAndMaybeEnforceLimits([...canonicalItemKeys]);
      for (const itemKey of canonicalItemKeys) {
        publishItemSnapshot(itemKey, 'confirmed');
      }
      for (const itemKey of removedAliasKeys) {
        publishItemSnapshot(itemKey, 'confirmed');
      }
      for (const { itemKey, payload } of cleanupAliases) {
        cleanupItemResources(itemKey, payload);
      }
    }

    return results;
  }

  function maybeDisposeBatchScheduler(payload: ItemPayload): void {
    const batchKey = getBatchKey(payload);
    if (batchKey === false) return;

    const scheduler = batchKeySchedulers.get(batchKey);
    if (!scheduler) return;

    const hasRelatedItems = Object.values(store.state).some((item) => {
      if (!item) return false;
      return getBatchKey(item.payload) === batchKey;
    });

    if (!hasRelatedItems) {
      scheduler.reset();
      batchKeySchedulers.delete(batchKey);
    }
  }

  function cleanupItemResources(itemKey: string, payload: ItemPayload): void {
    invalidationWasTriggered.delete(itemKey);
    itemCacheRuntime.clear(itemKey);
    if (
      resolveKnownItemKey(itemKey) === itemKey &&
      store.state[itemKey] == null
    ) {
      itemAliasRegistry.clearCanonicalAliases(itemKey);
    }

    const itemScheduler = perItemSchedulers.get(itemKey);
    if (itemScheduler) {
      itemScheduler.reset();
      perItemSchedulers.delete(itemKey);
    }

    maybeDisposeBatchScheduler(payload);
  }

  function isProtectedFromEviction(
    itemKey: string,
    item: CollectionItem,
  ): boolean {
    if (itemCacheRuntime.isActive(itemKey)) return true;
    const scheduler = getScheduler(itemKey, item.payload);
    if (
      item.status === 'loading' ||
      item.status === 'refetching' ||
      scheduler.getFetchIsInProgress()
    ) {
      return true;
    }

    return scheduler.isMutationInProgress(itemKey);
  }

  type FilterItemsFn = (params: ItemPayload, data: ItemState | null) => boolean;

  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults;
  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload[],
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults[];
  function scheduleFetch(
    fetchType: FetchType,
    payload: ItemPayload | ItemPayload[],
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults | ScheduleFetchResults[] {
    const multiplePayloads = Array.isArray(payload);

    const payloads = multiplePayloads ? payload : [payload];

    const results: ScheduleFetchResults[] = [];

    for (const param of payloads) {
      const requestItemKey = getItemKey(param);
      const lookupItemKey = resolveKnownItemKey(requestItemKey);
      const scheduler = getScheduler(lookupItemKey, param);
      results.push(
        scheduler.scheduleFetch(requestItemKey, fetchType, param, options),
      );
    }

    if (multiplePayloads) return results;

    const firstResult = results[0];
    if (!firstResult) {
      throw new Error('Unexpected empty results array');
    }
    return firstResult;
  }

  function scheduleAutomaticFetch(
    fetchType: FetchType,
    payload: ItemPayload,
  ): void {
    const requestItemKey = getItemKey(payload);
    const lookupItemKey = resolveKnownItemKey(requestItemKey);
    const scheduler = getScheduler(lookupItemKey, payload);
    scheduler.scheduleFetch(requestItemKey, fetchType, payload);
  }

  async function awaitFetch(
    params: ItemPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<
    { data: ItemState; error: null } | { data: null; error: StoreFetchError }
  > {
    const requestItemKey = getItemKey(params);
    const lookupItemKey = resolveKnownItemKey(requestItemKey);
    const scheduler = getScheduler(lookupItemKey, params);

    if (
      persistence?.hasAsyncPreload &&
      !Object.hasOwn(store.state, lookupItemKey)
    ) {
      await persistence.preloadItems([requestItemKey]);
    }

    const result = await scheduler.awaitFetch(requestItemKey, params, options);

    if (result === 'timeout') {
      return { data: null, error: new TimeoutStoreError() };
    }

    if (result === true) {
      return { data: null, error: new AbortedStoreError() };
    }

    let item = getItemFromStateOrPersistence(requestItemKey, {
      materializeSyncState: true,
    });

    if (item?.error?.id === 'offline') {
      const hydratedItem = persistence?.readHydratedItem(requestItemKey);

      if (hydratedItem?.item.data) {
        const resolvedItemKey = resolveKnownItemKey(requestItemKey);
        item = hydratedItem.item;
        store.produceState(
          (draft) => {
            draft[resolvedItemKey] = hydratedItem.item;
          },
          { action: 'persistent-storage-hydrate' },
        );
      }
    }

    if (item?.error) {
      return { data: null, error: new StoreFetchError(item.error, 'fetch') };
    }

    if (!item?.data) {
      return { data: null, error: new NotFoundStoreError() };
    }

    return { data: item.data, error: null };
  }

  function getItemFromStateOrPersistence(
    itemKey: string,
    options: { materializeSyncState?: boolean } = {},
  ): CollectionItem | null | undefined {
    const resolvedItemKey = resolveKnownItemKey(itemKey);
    const item = store.state[resolvedItemKey];
    if (Object.hasOwn(store.state, resolvedItemKey)) return item;
    const hydratedItem = persistence?.readHydratedItem(resolvedItemKey);

    if (
      hydratedItem &&
      options.materializeSyncState &&
      persistence &&
      !persistence.hasAsyncPreload
    ) {
      void persistence.preloadItems([resolvedItemKey]);

      if (Object.hasOwn(store.state, resolvedItemKey)) {
        return store.state[resolvedItemKey];
      }
    }

    return hydratedItem?.item;
  }

  function readHydratedCollectionItem(
    itemKey: string,
  ): CollectionItem | null | undefined {
    return persistence?.readHydratedItem(resolveKnownItemKey(itemKey))?.item;
  }

  function getItemsKeyArray(
    params: ItemPayload[] | FilterItemsFn | ItemPayload,
  ): { itemKey: string; payload: ItemPayload }[] {
    if (Array.isArray(params)) {
      return params.map((p) => ({ itemKey: getLookupItemKey(p), payload: p }));
    } else if (typeof params === 'function') {
      const itemKeys = new Set([
        ...Object.keys(store.state),
        ...(persistence?.getHydratedItemKeys() ?? []),
      ]);

      return filterAndMap([...itemKeys], (itemKey) => {
        const item = getItemFromStateOrPersistence(itemKey, {
          materializeSyncState: true,
        });
        return item && params(item.payload, item.data)
          ? { itemKey, payload: item.payload }
          : false;
      });
    } else {
      return [{ payload: params, itemKey: getLookupItemKey(params) }];
    }
  }

  const invalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemPayload: ItemPayload | ItemPayload[] | FilterItemsFn,
    priority: FetchType = 'highPriority',
  ) {
    const itemsKey = getItemsKeyArray(itemPayload);

    for (const { itemKey } of itemsKey) {
      const item = store.state[itemKey];

      if (!item) continue;

      const currentInvalidationPriority = item.refetchOnMount
        ? fetchTypePriority[item.refetchOnMount]
        : -1;
      const newInvalidationPriority = fetchTypePriority[priority];

      if (currentInvalidationPriority >= newInvalidationPriority) continue;

      store.produceState(
        (draft) => {
          const draftItem = draft[itemKey];
          if (!draftItem) return;

          draftItem.refetchOnMount = priority;
        },
        { action: 'invalidate-data' },
      );

      invalidationWasTriggered.delete(itemKey);
      events.emit('invalidateData', { priority, itemKey });

      if (item.data) {
        onInvalidate?.({
          priority,
          payload: item.payload,
          itemState: item.data,
        });
      }
    }
  }

  function getItemState(
    fetchParam: ItemPayload,
  ): CollectionItem | undefined | null;
  function getItemState(
    fetchParams: ItemPayload[] | FilterItemsFn,
  ): CollectionItem[];
  function getItemState(
    params: ItemPayload | ItemPayload[] | FilterItemsFn,
  ): CollectionItem | CollectionItem[] | undefined | null {
    if (typeof params === 'function') {
      const itemsId = getItemsKeyArray(params);

      return filterAndMap(itemsId, ({ itemKey }) => {
        return getItemFromStateOrPersistence(itemKey) || false;
      });
    }

    if (Array.isArray(params)) {
      const itemKeys = getItemsKeyArray(params);

      return filterAndMap(itemKeys, ({ itemKey }) => {
        return (
          getItemFromStateOrPersistence(itemKey, {
            materializeSyncState: true,
          }) || false
        );
      });
    }

    const itemKey = getLookupItemKey(params);
    return getItemFromStateOrPersistence(itemKey, {
      materializeSyncState: true,
    });
  }

  /**
   * Attempts to hydrate cached items from persistent storage before the first
   * hook read. Returns one result per requested payload.
   */
  async function preloadItemFromStorage(
    params: ItemPayload | ItemPayload[],
  ): Promise<PersistentStoragePreloadResult<ItemPayload>[]> {
    const payloads = Array.isArray(params) ? params : [params];

    if (!persistence) {
      persistentStorageConfig?.onPersistentStorageError?.(
        new Error('Persistent storage preload is not available'),
      );
      return payloads.map((payload) => ({ payload, preloaded: false }));
    }

    const results = await persistence.preloadItems(payloads.map(getItemKey));
    const preloadedItemKeys = payloads.flatMap((payload, index) =>
      results[index] ? [getLookupItemKey(payload)] : [],
    );
    if (preloadedItemKeys.length > 0) {
      touchItemsAndMaybeEnforceLimits(preloadedItemKeys);
    }
    return payloads.map((payload, index) => ({
      payload,
      preloaded: results[index] ?? false,
    }));
  }

  function useMultipleItems<
    Selected = ItemState | null,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    items: CollectionUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
    options: UseMultipleItemsOptions<ItemState, Selected> = {},
  ) {
    const offlineEntities = useOfflineStoreEntities({
      sessionKey: getSessionKeyForRuntime(),
      inactiveScope: id,
      storeName: resolvedPersistentStorageConfig ? id : undefined,
    });
    const offlineOverlaysSelector = useCallback(
      (state: Record<string, CollectionOfflineOverlay>) => {
        return state;
      },
      [],
    );
    const offlineOverlays = offlineOverlayStore.useSelectorRC(
      offlineOverlaysSelector,
    );

    return useMultipleItemsBase<
      ItemState,
      ItemPayload,
      Selected,
      QueryMetadata
    >(
      items,
      options,
      store,
      events,
      getLookupItemKey,
      getItemState,
      persistence ? readHydratedCollectionItem : undefined,
      registerActiveItems,
      touchItems,
      persistence
        ? (payloads) => persistence.maybeHydrateItems(payloads.map(getItemKey))
        : undefined,
      !!persistence && !persistence.hasAsyncPreload,
      scheduleAutomaticFetch,
      invalidationWasTriggered,
      globalDisableRefetchOnMount,
      offlineEntities,
      offlineOverlays,
    );
  }

  function useItem<Selected = ItemState | null>(
    payload: ItemPayload | undefined | false | null,
    options: UseItemOptions<ItemState, Selected> = {},
  ) {
    return useItemBase<ItemState, ItemPayload, Selected>(
      payload,
      options,
      store,
      scheduleFetch,
      useMultipleItems,
    );
  }

  type EndMutation = () => void;

  function startMutation(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
  ): EndMutation {
    const itemKeys = getItemsKeyArray(fetchParams);

    const endMutations: (() => boolean)[] = [];

    for (const { itemKey, payload } of itemKeys) {
      const scheduler = getScheduler(itemKey, payload);
      endMutations.push(scheduler.startMutation(itemKey));
    }

    return () => {
      for (const endMutation of endMutations) {
        endMutation();
      }
    };
  }

  function addItemToState(fetchParams: ItemPayload, data: ItemState) {
    const itemKey = getLookupItemKey(fetchParams);
    const storedPayload = getResolvedStoredPayload(fetchParams);

    store.produceState(
      (draft) => {
        draft[itemKey] = {
          data,
          status: 'success',
          wasLoaded: true,
          refetchOnMount: false,
          error: null,
          payload: klona(storedPayload),
        };
      },
      { action: 'create-item-state' },
    );

    getScheduler(itemKey, fetchParams).setLastFetchStartTimeForRequest(
      itemKey,
      0,
    );
    touchItemsAndMaybeEnforceLimits([itemKey]);
    publishItemSnapshot(itemKey);
  }

  function deleteItemState(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
  ) {
    const itemKeys = getItemsKeyArray(fetchParams);

    store.produceState(
      (draft) => {
        for (const { itemKey } of itemKeys) {
          draft[itemKey] = null;
        }
      },
      { action: 'delete-item-state' },
    );

    for (const { itemKey, payload } of itemKeys) {
      if (resolveKnownItemKey(itemKey) === itemKey) {
        itemAliasRegistry.clearCanonicalAliases(itemKey);
      }
      publishItemSnapshot(itemKey);
      cleanupItemResources(itemKey, payload);
    }
  }

  function updateItemState(
    fetchParams: ItemPayload | ItemPayload[] | FilterItemsFn,
    produceNewData: (
      draftData: ItemState,
      collectionItem: CollectionItem,
    ) => void | ItemState,
    { ifNothingWasUpdated }: { ifNothingWasUpdated?: () => void } = {},
  ): boolean {
    const itemKeys = getItemsKeyArray(fetchParams);

    let someItemWasUpdated: boolean = false;
    const updatedItemKeys = new Set<string>();

    store.batch(() => {
      store.produceState(
        (draft) => {
          for (const { itemKey } of itemKeys) {
            const item = draft[itemKey];

            if (!item?.data) continue;

            someItemWasUpdated = true;
            updatedItemKeys.add(itemKey);

            const originalItem = store.state[itemKey];
            if (!originalItem) continue;

            const result = produceNewData(item.data, originalItem);

            if (result !== undefined) {
              item.data = result;
            }
          }
        },
        { action: 'update-item-state' },
      );

      if (ifNothingWasUpdated && !someItemWasUpdated) {
        ifNothingWasUpdated();
      }
    });

    if (updatedItemKeys.size > 0) {
      touchItemsAndMaybeEnforceLimits([...updatedItemKeys]);
      for (const itemKey of updatedItemKeys) {
        const payload = store.state[itemKey]?.payload;
        if (payload) {
          getScheduler(itemKey, payload).setLastFetchStartTimeForRequest(
            itemKey,
            0,
          );
        }
        publishItemSnapshot(itemKey);
      }
    }

    return someItemWasUpdated;
  }

  type CollectionMutationPayload =
    | ItemPayload
    | ItemPayload[]
    | false
    | undefined
    | null;
  type CollectionMutationPayloadToUse = ItemPayload | ItemPayload[];
  type CollectionMutationRollbackSnapshot = {
    itemKey: string;
    payload: ItemPayload;
    item: TSFDCollectionItem<ItemState, ItemPayload> | null | undefined;
  };

  type CollectionMutationArgs<T> = {
    optimisticUpdate?: (
      payload: CollectionMutationPayloadToUse,
    ) => void | boolean;
    mutation: (payload: CollectionMutationPayloadToUse) => Promise<T>;
    onSuccess?: (
      response: Awaited<T>,
      payload: CollectionMutationPayloadToUse,
    ) => void;
    revalidateOnSuccess?: boolean;
    silentErrors?: boolean;
    debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
  };

  type CollectionOnlineMutationArgs<T> = CollectionMutationArgs<T> & {
    offline?: undefined;
    upload?: undefined;
  };

  type CollectionOfflineMutationArgs<T> = CollectionMutationArgs<T> & {
    /**
     * When provided, the mutation tries the direct request while the session is
     * online, but degrades into durable offline queueing when the session is
     * already offline or the failure is classified as offline/outage. Callers
     * must not assume a successful result always includes the server payload.
     */
    offline: TOfflineOperations extends null
      ? never
      : OfflineMutationInput<Exclude<TOfflineOperations, null>>;
    upload?: OfflineMutationUploadsInput;
  };

  /**
   * Runs a collection mutation for one or more existing item payloads, or for a
   * mutation with no current item target.
   *
   * Pass `null` for create mutations that do not have a pre-generated item id
   * yet. Returns the direct server result when offline replay is not
   * configured for this call.
   */
  async function performMutation<T>(
    payload: CollectionMutationPayload,
    args: CollectionOnlineMutationArgs<T>,
  ): Promise<ResultType<Awaited<T>, StoreMutationError | MutationSkipped>>;
  /**
   * Runs a collection mutation that may fall back to durable offline queueing.
   *
   * Pass `null` for create mutations that do not have a pre-generated item id
   * yet. When the mutation is queued, the result is `{ kind: 'queued' }`
   * instead of the server payload.
   */
  async function performMutation<T>(
    payload: CollectionMutationPayload,
    args: CollectionOfflineMutationArgs<T>,
  ): Promise<
    ResultType<OfflineMutationResult<T>, StoreMutationError | MutationSkipped>
  >;
  async function performMutation<T>(
    payload: CollectionMutationPayload,
    args: CollectionOnlineMutationArgs<T> | CollectionOfflineMutationArgs<T>,
  ): Promise<
    ResultType<
      Awaited<T> | OfflineMutationResult<T>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>(
    payload: CollectionMutationPayload,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      onSuccess,
      debounce: _debounce,
      offline,
      upload,
    }: CollectionOnlineMutationArgs<T> | CollectionOfflineMutationArgs<T>,
  ): Promise<
    ResultType<
      Awaited<T> | OfflineMutationResult<T>,
      StoreMutationError | MutationSkipped
    >
  > {
    const payloadToUse: CollectionMutationPayloadToUse =
      payload === false || payload == null ? [] : payload;
    const affectedItems = Array.isArray(payloadToUse)
      ? payloadToUse
      : [payloadToUse];
    const affectedItemEntries = getItemsKeyArray(payloadToUse);

    if (
      !import.meta.env.PROD &&
      optimisticUpdate &&
      (payload === false || payload == null)
    ) {
      throw new Error(
        'Optimistic collection mutations require a concrete item payload.',
      );
    }

    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(
        toStoreMutationError(offlineSessionUnavailableError, errorNormalizer),
      );
    }

    const mutationId = getAutoIncrementId();
    storeEvents.emit('mutationStart', { mutationId, items: affectedItems });
    const optimisticRollbackSnapshots: CollectionMutationRollbackSnapshot[] =
      optimisticUpdate
        ? affectedItemEntries.map(({ itemKey, payload: itemPayload }) => ({
            itemKey,
            payload: itemPayload,
            item: klona(store.state[itemKey]),
          }))
        : [];

    const directMutation = () => mutation(payloadToUse);

    const result = await performMutationWithLifecycle({
      startMutation: () => startMutation(payloadToUse),
      optimisticUpdate: optimisticUpdate
        ? () =>
            runWithBroadcastConsistency('optimistic', () =>
              optimisticUpdate(payloadToUse),
            )
        : undefined,
      debounce: _debounce,
      blockWindowClose: blockWindowClose ?? undefined,
      mutation: offline
        ? () =>
            runHybridOfflineMutation({
              // WORKAROUND: The controller also supports session-only offline configs with no operation map, but this branch is only reachable when a concrete offline mutation input is present.
              controller: __LEGIT_CAST__<
                OfflineAwareMutationController<
                  Exclude<TOfflineOperations, null>
                > | null,
                unknown
              >(offlineController),
              offline,
              upload,
              directMutation,
            })
        : async () => ({
            kind: 'online' as const,
            data: await directMutation(),
          }),
      onSuccess: (result) => {
        if (revalidateOnSuccess && affectedItems.length > 0) {
          invalidateItem(payloadToUse);
        }

        if (onSuccess && result.kind === 'online') {
          onSuccess(result.data, payloadToUse);
        }
      },
      onError: (exception) => {
        const error = toStoreMutationError(exception, errorNormalizer);

        if (optimisticRollbackSnapshots.length > 0) {
          const restoredItemKeys: string[] = [];

          runWithBroadcastConsistency('confirmed', () => {
            store.produceState(
              (draft) => {
                for (const snapshot of optimisticRollbackSnapshots) {
                  if (snapshot.item === undefined) {
                    delete draft[snapshot.itemKey];
                    continue;
                  }

                  draft[snapshot.itemKey] = snapshot.item;
                }
              },
              { action: 'rollback-mutation-error' },
            );

            for (const snapshot of optimisticRollbackSnapshots) {
              if (snapshot.item) {
                restoredItemKeys.push(snapshot.itemKey);
              } else {
                cleanupItemResources(snapshot.itemKey, snapshot.payload);
              }

              publishItemSnapshot(snapshot.itemKey);
            }
          });

          if (restoredItemKeys.length > 0) {
            touchItemsAndMaybeEnforceLimits(restoredItemKeys);
          }
        }

        if (!silentErrors && onMutationError) {
          onMutationError(exception, { silentErrors });
        }

        return error;
      },
    });

    storeEvents.emit('mutationEnd', {
      mutationId,
      items: affectedItems,
      success: result.ok,
    });

    if (
      import.meta.env.TEST &&
      offline &&
      result.ok &&
      result.value.kind === 'queued'
    ) {
      testOptions?.onOfflineTimelineEvent?.({
        operation: offline.operation,
        phase: 'queued',
      });
    }

    if (!offline && result.ok && result.value.kind === 'online') {
      return Result.ok(result.value.data);
    }

    return result;
  }

  const focusLifecycle = createStoreFocusLifecycle({
    revalidateOnWindowFocus,
    usesRealTimeUpdates,
    transportReconnectCooldownMs,
    getWindowIsFocused,
    onWindowFocus: testOptions?.onWindowFocus ?? onWindowFocusDefault,
    onWindowFocusRevalidate: () => {
      invalidateItem(() => true, 'lowPriority');
    },
    onTransportReconnectRevalidate: () => {
      invalidateItem(() => true, 'realtimeUpdate');
    },
  });

  // Attach persistent storage after store creation
  const { enforceCacheLimits } = createCollectionCacheLimits({
    store,
    maxItems,
    itemCacheRuntime,
    isProtectedFromEviction,
    cleanupItemResources,
    onStateCleanup,
  });

  const cacheLimitEnforcementScheduler = createIdleThrottledScheduler({
    throttleMs: CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS,
    run: enforceCacheLimits,
  });

  function scheduleCacheLimitEnforcement(): void {
    cacheLimitEnforcementScheduler.schedule();
  }

  persistence?.attach(store);
  initializeOfflineStoreController(offlineController);
  if (store.isInitialized) {
    touchItemsAndMaybeEnforceLimits(Object.keys(store.state));
  }

  /**
   * Signals that the real-time transport (e.g. WebSocket) has reconnected after
   * a disconnection. Events may have been missed during the outage, so all
   * items need to be revalidated.
   *
   * - No-op when `usesRealTimeUpdates` is `false`.
   * - If the window is focused, the first reconnect invalidates all items
   *   immediately with `realtimeUpdate` priority.
   * - Additional reconnects within `transportReconnectCooldownMs` are
   *   coalesced into one trailing invalidation.
   * - If the window is **not** focused, reconnect invalidation waits until the
   *   next window focus event.
   */
  function onTransportReconnect(): void {
    if (isDisposed) return;
    focusLifecycle.onTransportReconnect();
  }

  function reset() {
    if (isDisposed) return;
    for (const scheduler of batchKeySchedulers.values()) {
      scheduler.reset();
    }
    batchKeySchedulers.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();

    invalidationWasTriggered.clear();
    lastCollectionSyncVersions.clear();
    itemAliasRegistry.clearAll();
    clearOfflineOverlays();
    itemCacheRuntime.clearAll();
    cacheLimitEnforcementScheduler.cancel();
    browserTabsPriority.reset();

    persistence?.dispose();
    void persistence?.clear();

    store.setState(persistence?.createInitialState({}) ?? {});
    focusLifecycle.reset();
    persistence?.attach(store);
  }

  /** Releases store resources and unregisters the store from its manager. */
  function dispose(): void {
    if (isDisposed) return;

    isDisposed = true;
    unregisterStoreFromManager();

    for (const scheduler of batchKeySchedulers.values()) {
      scheduler.reset();
    }
    batchKeySchedulers.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();

    invalidationWasTriggered.clear();
    lastCollectionSyncVersions.clear();
    itemAliasRegistry.clearAll();
    clearOfflineOverlays();
    itemCacheRuntime.clearAll();
    cacheLimitEnforcementScheduler.cancel();
    browserTabsSync.close();
    browserTabsPriority.close();
    focusLifecycle.dispose();
    persistence?.dispose();
    offlineController?.dispose();
  }

  /** Detects whether a specific item inside a collection item's data is still loading.
   * Useful when a collection item holds a list/record of sub-items and a component
   * displays one that may not be present yet. */
  function useListItemIsLoading(
    payload: ItemPayload,
    {
      itemId,
      selector,
      loadItemFallback,
      ensureIsLoaded,
    }: {
      /** Unique identifier of the sub-item within the collection item */
      itemId: string;
      /** Extracts the sub-item from the collection item data; returning `null`/`undefined` means "not found" */
      selector: (data: ItemState | null) => unknown;
      /** Called after a timeout if the sub-item is still missing and no refetch is in progress. Defaults to `invalidateItem(payload)`. */
      loadItemFallback?: () => void;
      /** If true, forces a high-priority fetch and shows loading until the data is loaded */
      ensureIsLoaded?: boolean;
    },
  ): boolean {
    const item = useItem(payload, {
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = item.data != null;
    const listIsLoading = item.isLoading;
    const isRefetching = item.status === 'refetching';

    return useListItemIsLoadingBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateItem(payload)),
    });
  }

  /** Detects when a specific item inside a collection item's data has been deleted.
   * Only triggers after the sub-item was previously found and then disappears — not
   * during initial loading. */
  function useListItemIsDeleted(
    payload: ItemPayload,
    {
      itemId,
      selector,
      onDelete,
      ensureIsLoaded,
    }: {
      /** Unique identifier of the sub-item within the collection item */
      itemId: string;
      /** Extracts the sub-item from the collection item data; returning `null`/`undefined` means "not found" */
      selector: (data: ItemState | null) => unknown;
      /** Called once when the deletion is detected */
      onDelete?: () => void;
      /** If true, forces a high-priority fetch and shows loading until the data is loaded */
      ensureIsLoaded?: boolean;
    },
  ): boolean {
    const item = useItem(payload, {
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = item.data != null;
    const listIsLoading = item.isLoading;

    return useListItemIsDeletedBase({
      itemId,
      itemExists,
      listIsLoading,
      onDelete,
    });
  }

  /** Combined hook that returns `{ isLoading, isDeleted, data }` for a specific item
   * inside a collection item's data. Composes `useListItemIsLoading` and `useListItemIsDeleted`. */
  function useListItem<Selected>(
    payload: ItemPayload,
    {
      itemId,
      selector,
      loadItemFallback,
      onDelete,
      ensureIsLoaded,
    }: {
      /** Unique identifier of the sub-item within the collection item */
      itemId: string;
      /** Extracts and maps the sub-item from the collection item data */
      selector: (data: ItemState | null) => Selected;
      /** Called after a timeout if the sub-item is still missing. Defaults to `invalidateItem(payload)`. */
      loadItemFallback?: () => void;
      /** Called once when the deletion is detected */
      onDelete?: () => void;
      /** If true, forces a high-priority fetch and shows loading until the data is loaded */
      ensureIsLoaded?: boolean;
    },
  ): { isLoading: boolean; isDeleted: boolean; data: Selected } {
    const item = useItem(payload, {
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = item.data != null;
    const listIsLoading = item.isLoading;
    const isRefetching = item.status === 'refetching';

    return useListItemBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateItem(payload)),
      data: item.data,
      onDelete,
    });
  }

  let isDisposed = false;
  const unregisterStoreFromManager = registerStoreWithManager(storeManager, {
    id,
    reset,
  });

  return {
    store,
    events,
    storeEvents,
    get invalidationWasTriggered() {
      return invalidationWasTriggered;
    },
    scheduleFetch,
    awaitFetch,
    useMultipleItems,
    useItem,
    useListItemIsLoading,
    useListItemIsDeleted,
    useListItem,
    reset,
    dispose,
    preloadItemFromStorage,
    getItemKey,
    getItemState,
    getOfflineEntities: () => offlineController?.getOfflineEntities() ?? [],
    useOfflineEntities: () => {
      return useOfflineStoreEntities({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      });
    },
    useOfflineResolutions: () => {
      return useOfflineStoreResolutions({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      });
    },
    getOfflineResolutions: () =>
      offlineController?.getOfflineResolutions() ?? [],
    parseOfflineResolutionConflict: <
      TName extends keyof ResolvedOfflineOperations & string,
    >(
      resolution: OfflineResolutionRecordForOperation<
        ResolvedOfflineOperations,
        TName
      >,
    ): ParsedOfflineResolutionConflictResultForOperation<
      ResolvedOfflineOperations,
      TName
    > =>
      offlineController?.parseOfflineResolutionConflict(resolution) ??
      Result.err(
        new OfflineResolutionConflictParseError({
          code: 'offline-not-configured',
          operation: resolution.operation,
        }),
      ),
    resolveOfflineResolution: <
      TName extends keyof ResolvedOfflineOperations & string,
    >(
      resolutionId: string,
      operationName: TName,
      resolution: OfflineResolutionActionForOperation<
        ResolvedOfflineOperations,
        TName
      >,
    ) =>
      offlineController?.resolveOfflineResolution(
        resolutionId,
        operationName,
        resolution,
      ),
    startMutation,
    invalidateItem,
    updateItemState,
    addItemToState,
    deleteItemState,
    performMutation,
    onTransportReconnect,
  };
}
