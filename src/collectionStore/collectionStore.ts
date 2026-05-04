import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { filterAndMap } from '@ls-stack/utils/arrayUtils';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_ANY__, __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter, type Emitter } from 'evtmitter';
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
  runHybridOfflineMutation,
  type OfflineAwareMutationController,
  type OfflineMutationResult,
} from '../persistentStorage/offline/mutationRuntime';
import { isOfflineResolutionRecordForStore } from '../persistentStorage/offline/offlineResolution.typeGuards';
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
  OfflineSessionUnavailableError,
} from '../persistentStorage/offline/storeController';
import {
  offlineItemEntityRefSchema,
  OfflineResolutionConflictParseError,
  type AnyOfflineOperationDefinition,
  type CollectionOfflineEntityRef,
  type GlobalOfflineEntity,
  type OfflineMutationInput,
  type OfflineResolutionActionForOperation,
  type OfflineResolutionRecord,
  type ParsedOfflineResolutionConflictResultForStore,
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
  validateStoreManagerSessionConsistency,
  type StoreManager,
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
import { performMutationWithLifecycle } from '../utils/performMutation';
import { createStoreFocusLifecycle } from '../utils/storeFocusLifecycle';
import {
  AbortedStoreError,
  DEFAULT_BATCH_KEY,
  fetchTypePriority,
  mutationSkipped,
  NotFoundStoreError,
  resolveManagerFallback,
  StoreFetchError,
  StoreMutationError,
  TimeoutStoreError,
  toStoreMutationError,
  unwrapTSDFResult,
  type MaybeTSDFResult,
  type MutationSkipped,
  type StoreError,
  type StoreMutationErrorOptions,
  type TSDFStatus,
  type UnwrapTSDFResult,
  type ValidPayload,
  type ValidStoreState,
} from '../utils/storeShared';
import { createCollectionCacheLimits } from './collectionCacheLimits';
import { executeBatchFetch as executeBatchFetchBase } from './executeBatchFetch';
import { useItem as useItemBase, UseItemOptions } from './useItem';
import {
  useMultipleItems as useMultipleItemsBase,
  UseMultipleItemsOptions,
} from './useMultipleItems';

/** Lifecycle status for a cached collection item. */
export type CollectionItemStatus = TSDFStatus;

/** Raw cached state for one collection item. */
export type TSFDCollectionItem<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = {
  /** Latest loaded item data, or `null` before the item is available. */
  data: ItemState | null;
  /** Last fetch error for this item, when the latest fetch failed. */
  error: StoreError | null;
  /** Current fetch lifecycle status for this item. */
  status: CollectionItemStatus;
  /** Payload used to identify and fetch this item. */
  payload: ItemPayload;
  /** Pending automatic refetch priority for stale data mounted by hooks. */
  refetchOnMount: false | FetchType;
  /** Whether this item has ever loaded successfully. */
  wasLoaded: boolean;
};

/** Raw t-state shape used by a collection store. */
export type TSFDCollectionState<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = Record<string, TSFDCollectionItem<ItemState, ItemPayload> | null>;

/** Value returned by `CollectionStore.useItem(...)` and `useMultipleItems(...)`. */
export type TSFDUseCollectionItemReturn<
  Selected,
  ItemPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  /** Selected item data. Defaults to the full item or `null`. */
  data: Selected;
  /** Hook-visible item status, including idle/deleted states for hook ergonomics. */
  status: CollectionItemStatus | 'idle' | 'deleted';
  /** Item payload for this result, unless omitted or unavailable. */
  payload: ItemPayload | undefined;
  /** Last item fetch error, if any. */
  error: StoreError | null;
  /** Stable store key for the current item payload. */
  itemStateKey: string;
  /** Convenience flag for `loading` or `refetching` states. */
  isLoading: boolean;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
  /** Caller-provided metadata copied from the query descriptor. */
  queryMetadata: QueryMetadata;
};

/** Item descriptor accepted by `CollectionStore.useMultipleItems(...)`. */
export type CollectionUseMultipleItemsQuery<
  ItemPayload extends ValidPayload,
  QueryMetadata extends undefined | Record<string, unknown> = undefined,
> = {
  /** Item payload to subscribe to and fetch when needed. */
  payload: ItemPayload;
  /** Metadata returned with this query result for caller-side bookkeeping. */
  queryMetadata?: QueryMetadata;
  /** Omits `payload` from this query result. */
  omitPayload?: boolean;
  /**
   * Only fetches when the item is missing from state, skipping stale-state and
   * invalidation refetches.
   */
  disableRefetches?: boolean;
  /** Prevents the automatic mount refetch for stale loaded data. */
  disableRefetchOnMount?: boolean;
  /** Returns `idle` instead of `loading` while the item has not been fetched. */
  returnIdleStatus?: boolean;
  /** Returns `refetching` instead of keeping `loaded` status during refetches. */
  returnRefetchingStatus?: boolean;
  /** Marks this subscription as off-screen, lowering automatic fetch priority. */
  isOffScreen?: boolean;
};

/** Callback invoked when an already-loaded collection item is invalidated. */
export type OnCollectionItemInvalidate<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (props: {
  /** Current cached item state at invalidation time. */
  itemState: ItemState;
  /** Payload of the invalidated item. */
  payload: ItemPayload;
  /** Fetch priority requested for the invalidation. */
  priority: FetchType;
}) => void;

/** @internal */
export type CollectionInitialStateItem<
  ItemPayload extends ValidPayload,
  ItemState extends ValidStoreState,
> = { payload: ItemPayload; data: ItemState };

/** Events emitted by collection mutation lifecycle helpers. */
export type CollectionStoreStoreEvents<ItemPayload extends ValidPayload> = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number; items: ItemPayload[] };
  /** Emitted when a mutation completes, fails, or is skipped */
  mutationEnd: {
    mutationId: number;
    items: ItemPayload[];
    status: 'success' | 'error' | 'skipped';
  };
  /** Emitted when an offline temp item is reconciled to its final payload. */
  tempEntityReconciled: { tempId: ItemPayload; finalPayload: ItemPayload };
};

/** Details passed when collection cache-limit cleanup evicts cached items. */
export type CollectionStateCleanup<ItemPayload extends ValidPayload> = {
  /** Cleanup trigger that removed these items. */
  reason: 'cacheLimitEviction';
  /** Store keys removed from the collection state. */
  itemKeys: string[];
  /** Original item payloads removed from the collection state. */
  payloads: ItemPayload[];
};

/** @internal */
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

/** Options used to create a collection store. */
export type CollectionStoreOptions<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
  StorageState = unknown,
> = {
  /**
   * Stable id for this logical collection store. Used for debug labels,
   * persistence namespaces, and browser tab sync.
   */
  id: string;
  /** Shared global store manager providing session scoping and error normalization. */
  storeManager: StoreManager;
  /** Fetches one item by payload. */
  fetchFn: (
    params: ItemPayload,
    signal: AbortSignal,
  ) => Promise<MaybeTSDFResult<ItemState>>;
  /** Optional batch fetch function for fetching multiple items at once */
  batchFetchFn?: (
    payloads: ItemPayload[],
    signal: AbortSignal,
    batchKey: string,
  ) => Promise<
    MaybeTSDFResult<Map<ItemPayload, MaybeTSDFResult<ItemState> | Error>>
  >;
  /** Optional function to group batch fetches by key. When omitted, all batched items share one default batch key. Return false to fall back to individual fetchFn */
  getItemsBatchKey?: (payload: ItemPayload) => string | false;
  /** Max items per batch - triggers immediate fetch when reached */
  maxBatchSize?: number;
  /** Maximum number of cached items kept in memory. Defaults to 5,000. Inactive items are evicted in LRU order, while mounted hook items stay protected. */
  maxItems?: number;
  /** Called when cache-limit eviction removes items from in-memory state. */
  onStateCleanup?: (cleanup: CollectionStateCleanup<ItemPayload>) => void;
  /** Converts an item payload to the stable cache key used by this store. */
  getCollectionItemKey?: (params: ItemPayload) => ValidPayload | unknown[];
  /** Overrides the manager's default minimum interval between low-priority fetches for this store. */
  lowPriorityThrottleMs?: number;
  /** Overrides the manager's default coalescing window for this store. */
  baseCoalescingWindowMs?: number;
  /** Delay applied to medium-priority requests before they enter the scheduler. */
  mediumPriorityDelayMs?: number;
  /** Computes a per-fetch throttle for real-time updates using recent fetch cost and focus state. */
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  /** Store-level focus revalidation policy. Overrides the manager default. */
  revalidateOnWindowFocus?: boolean | (() => boolean);
  /** Reconnect-specific cooldown. Defaults to 2,000ms. The first reconnect revalidates immediately;
   * additional reconnects within the cooldown are coalesced into one trailing
   * revalidation. Set to `0` to disable this cooldown. */
  transportReconnectCooldownMs?: number;
  /** Called when an already-loaded item is invalidated. */
  onInvalidate?: OnCollectionItemInvalidate<ItemState, ItemPayload>;
  /** Observes request scheduler lifecycle events for this store. */
  onSchedulerEvent?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  /**
   * Store-specific mutation error handler.
   *
   * Overrides the manager fallback. Use `null` to disable inherited mutation
   * error handling for this store.
   */
  onMutationError?:
    | ((error: unknown, options: StoreMutationErrorOptions) => void)
    | null;
  /** Treats refetches as real-time driven, disabling stale mount refetches by default. Defaults to `false`. */
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

/** Event payloads emitted by `CollectionStore.events`. */
export type CollectionStoreEvents = {
  /** Emitted whenever one or more cached items are invalidated. */
  invalidateData: {
    /** Fetch priority requested by the invalidation. */
    priority: FetchType;
    /** Store key for the invalidated item. */
    itemKey: string;
  };
};

type CollectionFilterItemsFn<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
> = (params: ItemPayload, data: ItemState | null) => boolean;

type ResolvedCollectionOfflineOperations<TOfflineOperations> =
  TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;

type CollectionMutationPayload<ItemPayload extends ValidPayload> =
  | ItemPayload
  | ItemPayload[]
  | null;

type CollectionMutationTarget<ItemPayload extends ValidPayload> =
  | ItemPayload
  | ItemPayload[];

type CollectionMutationPayloadToUse<ItemPayload extends ValidPayload> =
  CollectionMutationTarget<ItemPayload>;

type CollectionMutationArgsBase<T, ItemPayload extends ValidPayload> = {
  /**
   * Applies optimistic updates for the affected item payloads before the
   * mutation runs. Return `false` to cancel the mutation before the async
   * mutation function is called.
   */
  optimisticUpdate?: (
    payload: CollectionMutationPayloadToUse<ItemPayload>,
  ) => void | boolean;
  /** Performs the server mutation for the affected item payloads. */
  mutation: (
    payload: CollectionMutationPayloadToUse<ItemPayload>,
  ) => Promise<T>;
  /** Called after a successful online mutation. */
  onSuccess?: (
    response: UnwrapTSDFResult<Awaited<T>>,
    payload: CollectionMutationPayloadToUse<ItemPayload>,
  ) => void;
  /** Invalidates affected items after a successful online mutation. */
  revalidateOnSuccess?: boolean;
  /**
   * Passes `{ silentErrors: true }` to `onMutationError`.
   *
   * The handler is still called so centralized logging and recovery can run,
   * but UI handlers can suppress user-facing notifications.
   */
  silentErrors?: boolean;
  /** Debounces mutations with the same context and payload. Superseded calls are skipped. */
  debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
};

type CollectionOnlineMutationArgs<
  T,
  ItemPayload extends ValidPayload,
> = CollectionMutationArgsBase<T, ItemPayload> & {
  offline?: undefined;
  upload?: undefined;
};

type CollectionOfflineMutationArgs<
  T,
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  >,
> = CollectionMutationArgsBase<T, ItemPayload> & {
  /**
   * Queues this mutation through the store's registered offline operation when
   * the session is offline or the direct request fails with an offline outage.
   */
  offline: TOfflineOperations extends null
    ? never
    : OfflineMutationInput<Exclude<TOfflineOperations, null>>;
  /** Files to attach if this mutation is queued for offline replay. */
  upload?: OfflineMutationUploadsInput;
};

type CollectionPerformMutation<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  >,
> = {
  /**
   * Runs a collection mutation for one or more existing item payloads.
   *
   * Returns the direct server result when offline replay is not configured for
   * this call.
   */
  <T>(
    payload: CollectionMutationTarget<ItemPayload>,
    args: CollectionOnlineMutationArgs<T, ItemPayload>,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a collection mutation for one or more existing item payloads, with
   * durable offline queueing as a fallback.
   *
   * When the mutation is queued, the result is `{ kind: 'queued' }` instead of
   * the server payload.
   */
  <T>(
    payload: CollectionMutationTarget<ItemPayload>,
    args: CollectionOfflineMutationArgs<
      T,
      ItemState,
      ItemPayload,
      TOfflineOperations
    >,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a collection mutation with no current item target.
   *
   * Use this for create mutations that do not have a pre-generated item payload
   * yet. Optimistic updates are not available without a target payload.
   */
  <T>(
    payload: null,
    args: Omit<
      CollectionOnlineMutationArgs<T, ItemPayload>,
      'optimisticUpdate'
    >,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs an offline-capable collection mutation with no current item target.
   *
   * Use this for create mutations that do not have a pre-generated item payload
   * yet. When the mutation is queued, the result is `{ kind: 'queued' }`.
   */
  <T>(
    payload: null,
    args: Omit<
      CollectionOfflineMutationArgs<
        T,
        ItemState,
        ItemPayload,
        TOfflineOperations
      >,
      'optimisticUpdate'
    >,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  <T>(
    payload: CollectionMutationPayload<ItemPayload>,
    args:
      | CollectionOnlineMutationArgs<T, ItemPayload>
      | CollectionOfflineMutationArgs<
          T,
          ItemState,
          ItemPayload,
          TOfflineOperations
        >,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
};

/** Public API returned by `createCollectionStore(...)`. */
export type CollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
> = {
  /** Underlying t-state store containing raw cached items. */
  store: Store<TSFDCollectionState<ItemState, ItemPayload>>;
  /** Invalidation event emitter used by hooks and integrations. */
  events: Emitter<CollectionStoreEvents>;
  /** Mutation lifecycle event emitter for observers and tests. */
  storeEvents: Emitter<CollectionStoreStoreEvents<ItemPayload>>;
  /** Item keys that have been explicitly invalidated and are awaiting refresh. */
  readonly invalidationWasTriggered: Set<string>;
  /** Schedules a fetch for one item or a batch of item payloads. */
  scheduleFetch: {
    (
      fetchType: FetchType,
      payload: ItemPayload,
      options?: ScheduleFetchOptions,
    ): ScheduleFetchResults;
    (
      fetchType: FetchType,
      payload: ItemPayload[],
      options?: ScheduleFetchOptions,
    ): ScheduleFetchResults[];
  };
  /** Waits for an item fetch to settle and returns data or a fetch error. */
  awaitFetch: (
    params: ItemPayload,
    options?: { timeoutMs?: number },
  ) => Promise<
    { data: ItemState; error: null } | { data: null; error: StoreFetchError }
  >;
  /** Returns cached item data when usable, otherwise fetches it first. */
  getItemFromStateOrFetch: (
    params: ItemPayload,
    options?: {
      /** When `true`, stale cached data is ignored and refetched before returning. Defaults to `false`. */
      ignoreStaleState?: boolean;
      timeoutMs?: number;
    },
  ) => Promise<ResultType<ItemState, StoreFetchError>>;
  /** React hook for subscribing to many collection items at once. */
  useMultipleItems: <
    Selected = ItemState | null,
    QueryMetadata extends undefined | Record<string, unknown> = undefined,
  >(
    items: CollectionUseMultipleItemsQuery<ItemPayload, QueryMetadata>[],
    options?: UseMultipleItemsOptions<ItemState, Selected>,
  ) => readonly TSFDUseCollectionItemReturn<
    Selected,
    ItemPayload,
    QueryMetadata
  >[];
  /** React hook for subscribing to one collection item. */
  useItem: <Selected = ItemState | null>(
    payload: ItemPayload | undefined | false | null,
    options?: UseItemOptions<ItemState, Selected>,
  ) => TSFDUseCollectionItemReturn<Selected, ItemPayload>;
  /** React hook that tracks whether a nested list item is still loading. */
  useListItemIsLoading: (
    payload: ItemPayload,
    args: {
      /** Unique identifier of the sub-item within the collection item. */
      itemId: string;
      /** Extracts the sub-item from the collection item data. */
      selector: (data: ItemState | null) => unknown;
      /** Called if the sub-item is still missing and no refetch is in progress. */
      loadItemFallback?: () => void;
      /** Forces a high-priority fetch and keeps the hook loading until data is loaded. */
      ensureIsLoaded?: boolean;
    },
  ) => boolean;
  /** React hook that tracks whether a nested list item has been deleted. */
  useListItemIsDeleted: (
    payload: ItemPayload,
    args: {
      /** Unique identifier of the sub-item within the collection item. */
      itemId: string;
      /** Extracts the sub-item from the collection item data. */
      selector: (data: ItemState | null) => unknown;
      /** Called once when deletion is detected. */
      onDelete?: () => void;
      /** Forces a high-priority fetch and keeps the hook loading until data is loaded. */
      ensureIsLoaded?: boolean;
    },
  ) => boolean;
  /** React hook for selecting one nested list item plus loading/deleted flags. */
  useListItem: <Selected>(
    payload: ItemPayload,
    args: {
      /** Unique identifier of the sub-item within the collection item. */
      itemId: string;
      /** Extracts and maps the sub-item from the collection item data. */
      selector: (data: ItemState | null) => Selected;
      /** Called if the sub-item is still missing and no refetch is in progress. */
      loadItemFallback?: () => void;
      /** Called once when deletion is detected. */
      onDelete?: () => void;
      /** Forces a high-priority fetch and keeps the hook loading until data is loaded. */
      ensureIsLoaded?: boolean;
    },
  ) => { isLoading: boolean; isDeleted: boolean; data: Selected };
  /** Clears in-memory state and cancels store-local runtime state. */
  reset: () => void;
  /** Unregisters listeners and releases resources owned by this store. */
  dispose: () => void;
  /** Loads item payloads from persistent storage into memory when available. */
  preloadItemFromStorage: (
    params: ItemPayload | ItemPayload[],
  ) => Promise<PersistentStoragePreloadResult<ItemPayload>[]>;
  /** Returns the stable cache key for an item payload. */
  getItemKey: (params: ItemPayload) => string;
  /** Reads one or many cached items directly from store state. */
  getItemState: {
    (
      params: ItemPayload,
    ): TSFDCollectionItem<ItemState, ItemPayload> | undefined | null;
    (
      params: ItemPayload[] | CollectionFilterItemsFn<ItemState, ItemPayload>,
    ): TSFDCollectionItem<ItemState, ItemPayload>[];
  };
  /** Returns offline sync metadata for this store's tracked entities. */
  getOfflineEntities: () => GlobalOfflineEntity[];
  /** React hook subscribing to this store's offline entity metadata. */
  useOfflineEntities: () => readonly GlobalOfflineEntity[];
  /** React hook subscribing to manual offline resolutions for this store. */
  useOfflineResolutions: () => readonly OfflineResolutionRecord[];
  /** Returns manual offline resolutions for this store. */
  getOfflineResolutions: () => OfflineResolutionRecord[];
  /** Parses a stored offline conflict into the operation-specific conflict shape. */
  parseOfflineResolutionConflict: (
    resolution: OfflineResolutionRecord,
  ) => ParsedOfflineResolutionConflictResultForStore<
    ResolvedCollectionOfflineOperations<TOfflineOperations>
  >;
  /** Applies a retry/discard/requeue/commit action to a pending offline resolution. */
  resolveOfflineResolution: <
    TName extends
      keyof ResolvedCollectionOfflineOperations<TOfflineOperations> & string,
  >(
    resolutionId: string,
    operationName: TName,
    resolution: OfflineResolutionActionForOperation<
      ResolvedCollectionOfflineOperations<TOfflineOperations>,
      TName
    >,
  ) => Promise<void> | void;
  /** Marks one or more items as mutating and returns a function that ends the mutation. */
  startMutation: (
    fetchParams:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
  ) => () => void;
  /** Marks cached items stale and schedules refetches for active subscriptions. Defaults to `highPriority`. */
  invalidateItem: (
    itemPayload:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
    /** Fetch priority used for refetches triggered by this invalidation. Defaults to `highPriority`. */
    priority?: FetchType,
  ) => void;
  /** Applies an immutable update to one or more cached collection items. */
  updateItemState: (
    fetchParams:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
    produceNewData: (
      draftData: ItemState,
      collectionItem: TSFDCollectionItem<ItemState, ItemPayload>,
    ) => void | ItemState,
    options?: { ifNothingWasUpdated?: () => void },
  ) => boolean;
  /** Adds or replaces one cached item directly in state. */
  addItemToState: (fetchParams: ItemPayload, data: ItemState) => void;
  /** Deletes one or more cached items directly from state. */
  deleteItemState: (
    fetchParams:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
  ) => void;
  /**
   * Runs the full mutation lifecycle: optional optimistic update, async
   * mutation, rollback/error handling, revalidation, and offline queue fallback.
   */
  performMutation: CollectionPerformMutation<
    ItemState,
    ItemPayload,
    TOfflineOperations
  >;
  /** Notifies the store that a shared transport reconnected and should revalidate active data. */
  onTransportReconnect: () => void;
};

export function createCollectionStore<
  ItemState extends ValidStoreState,
  ItemPayload extends ValidPayload,
  TOfflineOperations extends CollectionOfflineOperationsConfig<
    ItemState,
    ItemPayload
  > = null,
  StorageState = unknown,
>(
  storeOptions: CollectionStoreOptions<
    ItemState,
    ItemPayload,
    TOfflineOperations,
    StorageState
  >,
): CollectionStore<ItemState, ItemPayload, TOfflineOperations> {
  const {
    id,
    storeManager,
    fetchFn,
    batchFetchFn,
    getItemsBatchKey,
    maxBatchSize,
    maxItems = 5_000,
    onStateCleanup,
    lowPriorityThrottleMs: storeLowPriorityThrottleMs,
    baseCoalescingWindowMs: storeBaseCoalescingWindowMs,
    mediumPriorityDelayMs,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs = 2_000,
    getCollectionItemKey: filterCollectionItemObjKey,
    onInvalidate,
    onSchedulerEvent,
    onMutationError,
    usesRealTimeUpdates = false,
    persistentStorage: persistentStorageConfig,
    '~test': testOptions,
  } = storeOptions;

  const lowPriorityThrottleMs =
    storeLowPriorityThrottleMs ??
    storeManager.storeDefaults.lowPriorityThrottleMs;
  const baseCoalescingWindowMs =
    storeBaseCoalescingWindowMs ??
    storeManager.storeDefaults.baseCoalescingWindowMs;
  const resolvedDynamicRealtimeThrottleMs =
    dynamicRealtimeThrottleMs ??
    storeManager.storeDefaults.dynamicRealtimeThrottleMs;
  const blockWindowClose = storeManager.storeDefaults.blockWindowClose;
  const resolvedRevalidateOnWindowFocus =
    revalidateOnWindowFocus ??
    storeManager.storeDefaults.revalidateOnWindowFocus;
  const resolvedOnMutationError = resolveManagerFallback(
    onMutationError,
    storeManager.onMutationError,
  );

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
        onPersistentStorageError: resolveManagerFallback(
          persistentStorageConfig.onPersistentStorageError,
          storeManager.onPersistentStorageError,
        ),
        offline: persistentStorageConfig.offline
          ? {
              ...persistentStorageConfig.offline,
              session: resolvedOfflineSessionForPersistentStorage,
            }
          : undefined,
        ...(import.meta.env.DEV
          ? { debugLogger: storeManager.debugLogger }
          : undefined),
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

  // Persistent storage setup
  const persistence = resolvedPersistentStorageConfig
    ? setupCollectionPersistence(resolvedPersistentStorageConfig, {
        getItemKey,
      })
    : null;
  const persistentStorageErrorReporter = resolvedPersistentStorageConfig
    ? resolvedPersistentStorageConfig.onPersistentStorageError
    : storeManager.onPersistentStorageError;

  const store = new Store<CollectionState>({
    debugName: id,
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
          ...(import.meta.env.DEV
            ? { debugLogger: storeManager.debugLogger }
            : undefined),
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
                  entityKey: getItemKey(
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
  const wrappedDynamicRealtimeThrottleMs = (lastFetchDuration: number) =>
    resolvedDynamicRealtimeThrottleMs({
      lastFetchDuration,
      windowIsNotFocused: !getWindowIsFocused(),
    });

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
  const itemKeyToPayload = new Map<string, ItemPayload>();

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
    itemKeyToPayload.set(itemKey, payload);

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

  function getKnownScheduler(
    itemKey: string,
  ): RequestScheduler<ItemPayload> | null {
    const existingScheduler = perItemSchedulers.get(itemKey);
    if (existingScheduler) return existingScheduler;

    const payload =
      itemKeyToPayload.get(itemKey) ?? store.state[itemKey]?.payload;
    if (payload === undefined) return null;

    return getScheduler(itemKey, payload);
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
    return getKnownScheduler(itemKey);
  }

  function applyRemoteItemSnapshot(
    message: CollectionItemSnapshotMessage<ItemState, ItemPayload>,
    candidateVersion: BrowserTabsSyncVersion,
  ): void {
    const existingItem = store.state[message.itemKey];
    const schedulerPayload =
      existingItem?.payload ?? itemKeyToPayload.get(message.itemKey);
    const snapshotItem = message.item;
    const cancelPendingConfirmedFetch = () => {
      if (message.consistency !== 'confirmed') return;
      // Use the known scheduler (keyed by the previously-seen payload) so that
      // pending fetches against the old batch partition are cancelled, even
      // when the snapshot brings a different payload.
      getKnownScheduler(message.itemKey)?.cancelPendingRequests([
        message.itemKey,
      ]);
    };

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
      cancelPendingConfirmedFetch();
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

    if (message.item === null && schedulerPayload !== undefined) {
      cancelPendingConfirmedFetch();
      cleanupItemResources(message.itemKey, schedulerPayload);
    } else if (message.item !== null) {
      cancelPendingConfirmedFetch();
      touchItemsAndMaybeEnforceLimits([message.itemKey]);
    }

    lastCollectionSyncVersions.set(message.itemKey, candidateVersion);
  }

  function shouldIgnoreConfirmedRemoteCollectionSnapshot(
    message: CollectionItemSnapshotMessage<ItemState, ItemPayload>,
  ): boolean {
    if (message.consistency !== 'confirmed') return false;

    return (
      getKnownScheduler(message.itemKey)?.isMutationInProgress(
        message.itemKey,
      ) ?? false
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
      ...(import.meta.env.DEV
        ? { debugLogger: storeManager.debugLogger }
        : undefined),
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
      touchItemsAndMaybeEnforceLimits(
        successfulRequests.map(({ requestId }) => requestId),
      );
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
    itemKeyToPayload.delete(itemKey);
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

    if (persistence?.hasAsyncPreload && !Object.hasOwn(store.state, itemId)) {
      await persistence.preloadItems([itemId]);
    }

    const result = await scheduler.awaitFetch(itemId, params, options);

    if (result === 'timeout') {
      return { data: null, error: new TimeoutStoreError() };
    }

    if (result === true) {
      return { data: null, error: new AbortedStoreError() };
    }

    let item = getItemFromStateOrPersistence(itemId, {
      materializeSyncState: true,
    });

    if (item?.error?.id === 'offline') {
      const hydratedItem = persistence?.readHydratedItem(itemId);

      if (hydratedItem?.data) {
        item = hydratedItem;
        store.produceState(
          (draft) => {
            draft[itemId] = hydratedItem;
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

  async function getItemFromStateOrFetch(
    params: ItemPayload,
    {
      ignoreStaleState,
      timeoutMs,
    }: { ignoreStaleState?: boolean; timeoutMs?: number } = {},
  ): Promise<ResultType<ItemState, StoreFetchError>> {
    const itemKey = getItemKey(params);
    const item = getItemFromStateOrPersistence(itemKey, {
      materializeSyncState: true,
    });

    if (
      item?.data &&
      (!ignoreStaleState ||
        (item.status === 'success' && !item.error && !item.refetchOnMount))
    ) {
      return Result.ok(item.data);
    }

    const result = await awaitFetch(params, { timeoutMs });

    if (result.error) {
      return Result.err(result.error);
    }

    return Result.ok(result.data);
  }

  function getItemFromStateOrPersistence(
    itemKey: string,
    options: { materializeSyncState?: boolean } = {},
  ): TSFDCollectionItem<ItemState, ItemPayload> | null | undefined {
    const item = store.state[itemKey];
    if (Object.hasOwn(store.state, itemKey)) return item;
    const hydratedItem = persistence?.readHydratedItem(itemKey);

    if (
      hydratedItem &&
      options.materializeSyncState &&
      persistence &&
      !persistence.hasAsyncPreload
    ) {
      void persistence.preloadItems([itemKey]);

      if (Object.hasOwn(store.state, itemKey)) {
        return store.state[itemKey];
      }
    }

    return hydratedItem;
  }

  function getItemsKeyArray(
    params:
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>
      | ItemPayload,
  ): { itemKey: string; payload: ItemPayload }[] {
    if (Array.isArray(params)) {
      return params.map((p) => ({ itemKey: getItemKey(p), payload: p }));
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
      return [{ payload: params, itemKey: getItemKey(params) }];
    }
  }

  const invalidationWasTriggered = new Set<string>();

  function invalidateItem(
    itemPayload:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
    priority: FetchType = 'highPriority',
  ): void {
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
  ): TSFDCollectionItem<ItemState, ItemPayload> | undefined | null;
  function getItemState(
    fetchParams:
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
  ): TSFDCollectionItem<ItemState, ItemPayload>[];
  function getItemState(
    params:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
  ):
    | TSFDCollectionItem<ItemState, ItemPayload>
    | TSFDCollectionItem<ItemState, ItemPayload>[]
    | undefined
    | null {
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

    const itemKey = getItemKey(params);
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
      persistentStorageErrorReporter?.(
        new Error('Persistent storage preload is not available'),
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
      getItemKey,
      getItemState,
      persistence?.readHydratedItem,
      registerActiveItems,
      touchItems,
      persistence
        ? (payloads) =>
            persistence.maybeHydrateItems(
              payloads.map((payload) => getItemKey(payload)),
            )
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

  function startMutation(
    fetchParams:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
  ): () => void {
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
    touchItemsAndMaybeEnforceLimits([itemKey]);
    publishItemSnapshot(itemKey);
  }

  function deleteItemState(
    fetchParams:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
  ): void {
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
    fetchParams:
      | ItemPayload
      | ItemPayload[]
      | CollectionFilterItemsFn<ItemState, ItemPayload>,
    produceNewData: (
      draftData: ItemState,
      collectionItem: TSFDCollectionItem<ItemState, ItemPayload>,
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

  type CollectionMutationRollbackSnapshot = {
    itemKey: string;
    payload: ItemPayload;
    item: TSFDCollectionItem<ItemState, ItemPayload> | null | undefined;
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
    payload: CollectionMutationPayload<ItemPayload>,
    args: CollectionOnlineMutationArgs<T, ItemPayload>,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a collection mutation that may fall back to durable offline queueing.
   *
   * Pass `null` for create mutations that do not have a pre-generated item id
   * yet. When the mutation is queued, the result is `{ kind: 'queued' }`
   * instead of the server payload.
   */
  async function performMutation<T>(
    payload: CollectionMutationPayload<ItemPayload>,
    args: CollectionOfflineMutationArgs<
      T,
      ItemState,
      ItemPayload,
      TOfflineOperations
    >,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>(
    payload: CollectionMutationPayload<ItemPayload>,
    args:
      | CollectionOnlineMutationArgs<T, ItemPayload>
      | CollectionOfflineMutationArgs<
          T,
          ItemState,
          ItemPayload,
          TOfflineOperations
        >,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>(
    payload: CollectionMutationPayload<ItemPayload>,
    {
      optimisticUpdate,
      mutation,
      silentErrors,
      revalidateOnSuccess,
      onSuccess,
      debounce: _debounce,
      offline,
      upload,
    }:
      | CollectionOnlineMutationArgs<T, ItemPayload>
      | CollectionOfflineMutationArgs<
          T,
          ItemState,
          ItemPayload,
          TOfflineOperations
        >,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  > {
    const payloadToUse: CollectionMutationPayloadToUse<ItemPayload> =
      payload === null ? [] : payload;
    const affectedItems = Array.isArray(payloadToUse)
      ? payloadToUse
      : [payloadToUse];
    const affectedItemEntries = getItemsKeyArray(payloadToUse);

    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(
        toStoreMutationError(
          new OfflineSessionUnavailableError(),
          errorNormalizer,
        ),
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

    const directMutation = async () =>
      unwrapTSDFResult(await mutation(payloadToUse));

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

        if (resolvedOnMutationError) {
          resolvedOnMutationError(exception, { silentErrors });
        }

        return error;
      },
    });

    storeEvents.emit('mutationEnd', {
      mutationId,
      items: affectedItems,
      status: result.ok
        ? 'success'
        : result.error === mutationSkipped
          ? 'skipped'
          : 'error',
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
    revalidateOnWindowFocus: resolvedRevalidateOnWindowFocus,
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
    itemKeyToPayload.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();

    invalidationWasTriggered.clear();
    lastCollectionSyncVersions.clear();
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
    itemKeyToPayload.clear();

    for (const scheduler of perItemSchedulers.values()) {
      scheduler.reset();
    }
    perItemSchedulers.clear();

    invalidationWasTriggered.clear();
    lastCollectionSyncVersions.clear();
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
    onTransportReconnect,
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
    getItemFromStateOrFetch,
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
    useOfflineEntities: () =>
      useOfflineStoreEntities({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      }),
    useOfflineResolutions: () =>
      useOfflineStoreResolutions({
        sessionKey: getSessionKeyForRuntime(),
        inactiveScope: id,
        storeName: resolvedPersistentStorageConfig ? id : undefined,
      }),
    getOfflineResolutions: () =>
      offlineController?.getOfflineResolutions() ?? [],
    parseOfflineResolutionConflict: (resolution) => {
      if (!offlineController) {
        return Result.err(
          new OfflineResolutionConflictParseError({
            code: 'offline-not-configured',
            operation: resolution.operation,
          }),
        );
      }

      if (
        !isOfflineResolutionRecordForStore(
          resolution,
          resolvedOfflineOperations,
        )
      ) {
        return Result.err(
          new OfflineResolutionConflictParseError({
            code: 'operation-not-found',
            operation: resolution.operation,
          }),
        );
      }

      return offlineController.parseOfflineResolutionConflict(resolution);
    },
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
