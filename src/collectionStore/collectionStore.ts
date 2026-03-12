import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { klona } from 'klona/json';
import { Result, unknownToError, type Result as ResultType } from 't-result';
import { Store } from 't-state';
import { createLruCacheRuntime } from '../cacheLimits/lruCacheRuntime';
import { createIdleThrottledScheduler } from '../cacheLimits/scheduleIdleThrottled';
import { useListItem as useListItemBase } from '../hooks/useListItem';
import { useListItemIsDeleted as useListItemIsDeletedBase } from '../hooks/useListItemIsDeleted';
import { useListItemIsLoading as useListItemIsLoadingBase } from '../hooks/useListItemIsLoading';
import { setupCollectionPersistence } from '../persistentStorage/collectionStorePersistence';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  offlineSessionUnavailableError,
} from '../persistentStorage/offline/storeController';
import {
  createOfflineEntityLookup,
  getIsPendingOfflineSync,
} from '../persistentStorage/offline/entityMetadata';
import { useOfflineStoreEntities } from '../persistentStorage/offline/sessionCoordinator';
import type {
  CollectionOfflineOperationDefinition,
  OfflineMutationDescriptor,
} from '../persistentStorage/offline/types';
import { createProtectedStorageKey } from '../persistentStorage/persistentStorageManager';
import type {
  CollectionPersistentStorageConfig,
  PersistentStoragePreloadResult,
} from '../persistentStorage/types';
import {
  BatchRequest,
  FetchContext,
  FetchType,
  getAutoIncrementId,
  RequestScheduler,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from '../requestScheduler';
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
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from '../utils/performMutation';
import { createStoreFocusLifecycle } from '../utils/storeFocusLifecycle';
import {
  fetchTypePriority,
  StoreFetchError,
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
  isPendingOfflineSync: boolean;
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

type CollectionMutationTouchedItem<ItemPayload extends ValidPayload> =
  | { payload: ItemPayload }
  | { payload?: undefined };

export type CollectionStoreStoreEvents<ItemPayload extends ValidPayload> = {
  /** Emitted when a mutation begins executing */
  mutationStart: {
    mutationId: number;
  } & CollectionMutationTouchedItem<ItemPayload>;
  /** Emitted when a mutation completes or fails */
  mutationEnd: {
    mutationId: number;
    success: boolean;
  } & CollectionMutationTouchedItem<ItemPayload>;
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
  CollectionOfflineOperationDefinition<
    ItemState,
    ItemPayload,
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    __LEGIT_ANY__,
    __LEGIT_ANY__
  >
>;

export type CollectionStoreOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends InternalCollectionOfflineOperations<
    ItemState,
    ItemPayload
  > = InternalCollectionOfflineOperations<ItemState, ItemPayload>,
  StorageState = unknown,
> = {
  debugName?: string;
  /** Stable id shared by the same logical collection store across browser tabs. */
  id: string;
  /**
   * Returns the current authenticated session / tenant key used to scope
   * browser-tabs sync. Return `false` to disable browser-tabs sync when no
   * account is loaded.
   */
  getSessionKey: () => string | false;
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
  errorNormalizer: (exception: Error) => StoreError;
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
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { silentErrors?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  usesRealTimeUpdates?: boolean;
  /** Opt-in persistent storage configuration. When provided, cached items are loaded
   * from storage on first read and saved back on successful fetches.
   * Session scoping always reuses this store's `getSessionKey`. */
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
  };
};

export type CollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends InternalCollectionOfflineOperations<
    ItemState,
    ItemPayload
  > = InternalCollectionOfflineOperations<ItemState, ItemPayload>,
> = ReturnType<
  typeof createCollectionStore<ItemState, ItemPayload, TOfflineOperations>
>;

type CollectionStoreEvents = {
  invalidateData: { priority: FetchType; itemKey: string };
};

const CACHE_LIMIT_ENFORCEMENT_THROTTLE_MS = 60 * 60 * 1000;

export function createCollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends InternalCollectionOfflineOperations<
    ItemState,
    ItemPayload
  > = InternalCollectionOfflineOperations<ItemState, ItemPayload>,
  StorageState = unknown,
>({
  debugName,
  id,
  getSessionKey,
  fetchFn,
  batchFetchFn,
  getItemsBatchKey,
  maxBatchSize,
  maxItems = 5_000,
  onStateCleanup,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  errorNormalizer,
  mediumPriorityDelayMs,
  dynamicRealtimeThrottleMs,
  revalidateOnWindowFocus,
  transportReconnectCooldownMs = 2_000,
  getCollectionItemKey: filterCollectionItemObjKey,
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

  let remoteApplyDepth = 0;
  let currentBroadcastConsistency: SnapshotConsistency = 'confirmed';
  const lastCollectionSyncVersions = new Map<string, BrowserTabsSyncVersion>();
  const itemCacheRuntime = createLruCacheRuntime();

  let initialData:
    | CollectionInitialStateItem<ItemPayload, ItemState>[]
    | undefined;
  let initialRefetchOnMount: FetchType | false = false;
  let initialStatus: CollectionItemStatus = 'success';
  let initialError: StoreError | null = null;
  const globalDisableRefetchOnMount = usesRealTimeUpdates;

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

  // Persistent storage setup
  const persistence = persistentStorageConfig
    ? setupCollectionPersistence(
        { ...persistentStorageConfig, getSessionKey },
        { getItemKey },
      )
    : null;

  const store = new Store<CollectionState>({
    debugName,
    state: () => {
      const initialState: CollectionState = {};

      if (initialData) {
        for (const item of initialData) {
          const itemKey = getItemKey(item.payload);

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

  function getItemKey(params: ItemPayload): string {
    return getCompositeKey(
      filterCollectionItemObjKey ? filterCollectionItemObjKey(params) : params,
    );
  }

  const offlineController = persistentStorageConfig?.offlineMode
    ? createOfflineStoreController({
        storeName: persistentStorageConfig.storeName,
        storeType: 'collection',
        getSessionKey,
        onPersistentStorageError:
          persistentStorageConfig.onPersistentStorageError,
        adapter: persistentStorageConfig.adapter,
        offlineMode: persistentStorageConfig.offlineMode,
        storeAdapter: {
          normalizeEntityRefs: (entityRefs) =>
            entityRefs.map((ref) => {
              if (
                typeof ref === 'object' &&
                ref !== null &&
                'entityKey' in ref &&
                'entityKind' in ref
              ) {
                return __LEGIT_CAST__<
                  {
                    entityKey: string;
                    entityKind: 'document' | 'item' | 'query';
                  },
                  unknown
                >(ref);
              }

              return {
                entityKey: getItemKey(
                  __LEGIT_CAST__<ItemPayload, unknown>(ref),
                ),
                entityKind: 'item' as const,
              };
            }),
          getProtectedCacheKeys: (entityRefs) => {
            const sessionKey = getSessionKey();
            if (sessionKey === false) return [];
            return entityRefs.map((ref) =>
              createProtectedStorageKey({
                sessionKey,
                storeName: persistentStorageConfig.storeName,
                kind: 'collection.item',
                key: ref.entityKey,
              }),
            );
          },
          applyPendingEntity: ({ tempId, pendingEntity }) => {
            if (!pendingEntity || typeof pendingEntity !== 'object') return;
            addItemToState(
              __LEGIT_CAST__<ItemPayload, string>(tempId),
              __LEGIT_CAST__<ItemState, unknown>(pendingEntity),
            );
          },
          reconcileTempEntity: ({ tempId, reconciliation }) => {
            const currentItem = getItemState(
              __LEGIT_CAST__<ItemPayload, string>(tempId),
            );
            const finalData =
              reconciliation.finalData !== undefined
                ? __LEGIT_CAST__<ItemState, unknown>(reconciliation.finalData)
                : (currentItem?.data ?? undefined);
            if (finalData === undefined) return;
            deleteItemState(__LEGIT_CAST__<ItemPayload, string>(tempId));
            addItemToState(
              __LEGIT_CAST__<ItemPayload, ValidPayload>(
                reconciliation.finalPayload,
              ),
              finalData,
            );
          },
        },
      })
    : null;

  function touchItems(itemKeys: string[]): void {
    itemCacheRuntime.touch(itemKeys, (itemKey) => {
      return store.state[itemKey] !== undefined;
    });
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
    if (!getItemsBatchKey) return '__default__';
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

  // Per-item schedulers for backward compatibility (when batchFetchFn is NOT provided)
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
        return getOrCreateBatchKeyScheduler('__default__');
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
    const message = browserTabsSync.publish({
      kind: 'collection-item-snapshot',
      itemKey,
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
        touchItems([message.itemKey]);
        if (shouldScheduleCacheLimitEnforcement()) {
          scheduleCacheLimitEnforcement();
        }
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
      touchItems([message.itemKey]);
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
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
      getSessionKey,
      onMessage: handleRemoteMessage,
      onSessionChange() {
        lastCollectionSyncVersions.clear();
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
      touchItems(successfulRequests.map(({ requestId }) => requestId));
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
      for (const { requestId } of successfulRequests) {
        publishItemSnapshot(requestId, 'confirmed');
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
      const itemKey = getItemKey(param);
      const scheduler = getScheduler(itemKey, param);
      results.push(scheduler.scheduleFetch(itemKey, fetchType, param, options));
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
    const itemKey = getItemKey(payload);
    const scheduler = getScheduler(itemKey, payload);
    scheduler.scheduleFetch(itemKey, fetchType, payload);
  }

  async function awaitFetch(
    params: ItemPayload,
    options: { timeoutMs?: number } = {},
  ): Promise<
    { data: ItemState; error: null } | { data: null; error: StoreFetchError }
  > {
    const itemId = getItemKey(params);
    const scheduler = getScheduler(itemId, params);

    const result = await scheduler.awaitFetch(itemId, params, options);

    if (result === 'timeout') {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 408, id: 'timeout', message: 'Timeout' },
          'timeout',
        ),
      };
    }

    if (result === true) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 408, id: 'aborted', message: 'Aborted' },
          'aborted',
        ),
      };
    }

    const item = store.state[itemId];

    if (item?.error) {
      return { data: null, error: new StoreFetchError(item.error, 'fetch') };
    }

    if (!item?.data) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 404, id: 'not-found', message: 'Not found' },
          'fetch',
        ),
      };
    }

    return { data: item.data, error: null };
  }

  function getItemsKeyArray(
    params: ItemPayload[] | FilterItemsFn | ItemPayload,
  ): { itemKey: string; payload: ItemPayload }[] {
    const items = store.state;

    if (Array.isArray(params)) {
      return params.map((p) => ({ itemKey: getItemKey(p), payload: p }));
    } else if (typeof params === 'function') {
      return filterAndMap(Object.entries(items), ([itemKey, item]) => {
        return item && params(item.payload, item.data)
          ? { itemKey, payload: item.payload }
          : false;
      });
    } else {
      return [{ payload: params, itemKey: getItemKey(params) }];
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
        return store.state[itemKey] || false;
      });
    }

    if (Array.isArray(params)) {
      const itemKeys = params.map((payload) => ({
        itemKey: getItemKey(payload),
        payload,
      }));

      return filterAndMap(itemKeys, ({ itemKey }) => {
        return store.state[itemKey] || false;
      });
    }

    const itemKey = getItemKey(params);
    return store.state[itemKey];
  }

  /**
   * Attempts to hydrate cached items from persistent storage before the first
   * hook read. Returns one result per requested payload.
   */
  async function preloadItemFromStorage(
    params: ItemPayload | ItemPayload[],
  ): Promise<PersistentStoragePreloadResult<ItemPayload>[]> {
    const payloads = Array.isArray(params) ? params : [params];

    if (!persistence?.hasAsyncPreload) {
      persistentStorageConfig?.onPersistentStorageError?.(
        new Error('Async preload is not available'),
      );
      return payloads.map((payload) => ({ payload, preloaded: false }));
    }

    const results = await persistence.preloadItems(
      payloads.map((payload) => getItemKey(payload)),
    );
    const preloadedItemKeys = payloads.flatMap((payload, index) =>
      results[index] ? [getItemKey(payload)] : [],
    );
    if (preloadedItemKeys.length > 0) {
      touchItems(preloadedItemKeys);
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
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
    const result = useMultipleItemsBase<
      ItemState,
      ItemPayload,
      Selected,
      QueryMetadata
    >(
      items,
      options,
      store,
      events,
      getItemKey,
      getItemState,
      registerActiveItems,
      touchItems,
      persistence
        ? (payloads) =>
            persistence.maybeHydrateItems(
              payloads.map((payload) => getItemKey(payload)),
            )
        : undefined,
      scheduleAutomaticFetch,
      invalidationWasTriggered,
      globalDisableRefetchOnMount,
    );

    const offlineEntities = useOfflineStoreEntities({
      sessionKey: getSessionKey(),
      inactiveScope: id,
      storeName: persistentStorageConfig?.storeName,
    });
    const offlineEntitiesByKey = createOfflineEntityLookup(offlineEntities);

    return result.map((itemResult) => ({
      ...itemResult,
      isPendingOfflineSync: getIsPendingOfflineSync(
        offlineEntitiesByKey.get(itemResult.itemStateKey),
      ),
    }));
  }

  function useItem<Selected = ItemState | null>(
    payload: ItemPayload | undefined | false | null,
    options: UseItemOptions<ItemState, Selected> = {},
  ) {
    const result = useItemBase<ItemState, ItemPayload, Selected>(
      payload,
      options,
      store,
      scheduleFetch,
      useMultipleItems,
    );

    const offlineEntities = useOfflineStoreEntities({
      sessionKey: getSessionKey(),
      inactiveScope: id,
      storeName: persistentStorageConfig?.storeName,
    });

    return {
      ...result,
      isPendingOfflineSync: getIsPendingOfflineSync(
        offlineEntities.find(
          (entity) => entity.entityKey === result.itemStateKey,
        ),
      ),
    };
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
    const itemKey = getItemKey(fetchParams);

    store.produceState(
      (draft) => {
        draft[itemKey] = {
          data,
          status: 'success',
          wasLoaded: true,
          refetchOnMount: false,
          error: null,
          payload: klona(fetchParams),
        };
      },
      { action: 'create-item-state' },
    );

    getScheduler(itemKey, fetchParams).setLastFetchStartTimeForRequest(
      itemKey,
      0,
    );
    touchItems([itemKey]);
    if (shouldScheduleCacheLimitEnforcement()) {
      scheduleCacheLimitEnforcement();
    }
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
      touchItems([...updatedItemKeys]);
      if (shouldScheduleCacheLimitEnforcement()) {
        scheduleCacheLimitEnforcement();
      }
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

  async function performMutation<
    T,
    TMutationPayload extends ItemPayload | undefined | null,
  >(
    payload: TMutationPayload,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      onSuccess,
      debounce: _debounce,
      offline,
    }: {
      optimisticUpdate?: (payload: TMutationPayload) => void | boolean;
      mutation: (payload: TMutationPayload) => Promise<T>;
      onSuccess?: (response: Awaited<T>, payload: TMutationPayload) => void;
      revalidateOnSuccess?: boolean;
      silentErrors?: boolean;
      debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
      /**
       * When provided, the mutation is durably queued and replayed by the
       * offline sync controller. The immediate result only reflects queue
       * persistence.
       */
      offline?: OfflineMutationDescriptor<TOfflineOperations>;
    },
  ): Promise<ResultType<Awaited<T>, StoreError | true>> {
    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(offlineSessionUnavailableError);
    }

    const hasPayload = payload != null;
    const mutationId = getAutoIncrementId();
    storeEvents.emit(
      'mutationStart',
      hasPayload ? { mutationId, payload } : { mutationId },
    );
    const result = await performMutationWithLifecycle({
      startMutation: () =>
        hasPayload ? startMutation(payload) : () => undefined,
      optimisticUpdate: optimisticUpdate
        ? () =>
            runWithBroadcastConsistency('optimistic', () =>
              optimisticUpdate(payload),
            )
        : undefined,
      debounce: _debounce,
      blockWindowClose: blockWindowClose ?? undefined,
      mutation: async () => {
        if (offline && offlineController) {
          await offlineController.queueMutation({
            operationName: offline.operation,
            input: offline.input,
          });
          return __LEGIT_CAST__<Awaited<T>, undefined>(undefined);
        }

        return mutation(payload);
      },
      onSuccess: (result) => {
        if (hasPayload && revalidateOnSuccess && !offline) {
          invalidateItem(payload);
        }

        if (onSuccess && !offline) {
          onSuccess(result, payload);
        }
      },
      onError: (exception) => {
        const error = errorNormalizer(unknownToError(exception));

        if (!silentErrors && onMutationError) {
          onMutationError(exception, { silentErrors });
        }

        if (hasPayload) {
          invalidateItem(payload);
        }

        return error;
      },
    });

    storeEvents.emit(
      'mutationEnd',
      hasPayload
        ? { mutationId, payload, success: result.ok }
        : { mutationId, success: result.ok },
    );

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
    touchItems(Object.keys(store.state));
    if (shouldScheduleCacheLimitEnforcement()) {
      scheduleCacheLimitEnforcement();
    }
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
    focusLifecycle.onTransportReconnect();
  }

  function reset() {
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
    itemCacheRuntime.clearAll();
    cacheLimitEnforcementScheduler.cancel();
    browserTabsPriority.reset();

    persistence?.dispose();
    void persistence?.clear();

    store.setState(persistence?.createInitialState({}) ?? {});
    focusLifecycle.reset();
    persistence?.attach(store);
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

  return {
    store,
    events,
    storeEvents,
    scheduler: null,
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
    preloadItemFromStorage,
    getItemKey,
    getItemState,
    getOfflineEntities: () => offlineController?.getOfflineEntities() ?? [],
    useOfflineEntities: () => {
      return useOfflineStoreEntities({
        sessionKey: getSessionKey(),
        inactiveScope: id,
        storeName: persistentStorageConfig?.storeName,
      });
    },
    getOfflineConflicts: () => offlineController?.getOfflineConflicts() ?? [],
    resolveOfflineConflict: (conflictId: string, resolution: unknown) =>
      offlineController?.resolveOfflineConflict(conflictId, resolution),
    startMutation,
    invalidateItem,
    updateItemState,
    addItemToState,
    deleteItemState,
    performMutation,
    onTransportReconnect,
  };
}
