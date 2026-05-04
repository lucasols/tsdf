import { useOnEvtmitterEvent } from '@evtmitter/react';
import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { useConst } from '@ls-stack/react-utils/useConst';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import {
  __LEGIT_CAST__,
  type __LEGIT_ANY__,
} from '@ls-stack/utils/saferTyping';
import { evtmitter, type Emitter } from 'evtmitter';
import { klona } from 'klona/json';
import { useCallback, useContext, useEffect, useMemo } from 'react';
import { Result, type Result as ResultType } from 't-result';
import { Store, useSubscribeToStore } from 't-state';
import { useListItem as useListItemBase } from './hooks/useListItem';
import { useListItemIsDeleted as useListItemIsDeletedBase } from './hooks/useListItemIsDeleted';
import { useListItemIsLoading as useListItemIsLoadingBase } from './hooks/useListItemIsLoading';
import {
  wrapGetSessionKeyForTest,
  wrapOfflineOperationsForTimeline,
} from './internal/offlineTestInstrumentation';
import type {
  TestOfflineTimelineEvent,
  TestSessionKeyChangedEvent,
} from './internal/testTimelineTypes';
import { IsOffScreenContext } from './isOffScreenContext';
import { DOCUMENT_PERSISTED_ENTRY_KEY } from './persistentStorage/documentEntryKey';
import { setupDocumentPersistence } from './persistentStorage/documentStorePersistence';
import {
  createOfflineEntityLookup,
  getIsPendingOfflineSync,
  shouldApplyOfflineOverlay,
} from './persistentStorage/offline/entityMetadata';
import {
  offlineConnectivityError,
  runOfflineAwareFetch,
} from './persistentStorage/offline/fetchRuntime';
import {
  runHybridOfflineMutation,
  type OfflineAwareMutationController,
  type OfflineMutationResult,
} from './persistentStorage/offline/mutationRuntime';
import { isOfflineResolutionRecordForStore } from './persistentStorage/offline/offlineResolution.typeGuards';
import {
  useOfflineStoreEntities,
  useOfflineStoreResolutions,
} from './persistentStorage/offline/sessionCoordinator';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  OfflineSessionUnavailableError,
} from './persistentStorage/offline/storeController';
import {
  OfflineResolutionConflictParseError,
  type AnyOfflineOperationDefinition,
  type GlobalOfflineEntity,
  type OfflineMutationInput,
  type OfflineResolutionActionForOperation,
  type OfflineResolutionRecord,
  type ParsedOfflineResolutionConflictResultForStore,
} from './persistentStorage/offline/types';
import type { OfflineMutationUploadsInput } from './persistentStorage/offlineUploadTypes';
import { createProtectedStorageKey } from './persistentStorage/persistentStorageManager';
import type {
  DocumentPersistentStorageConfig,
  ResolvedDocumentPersistentStorageConfig,
} from './persistentStorage/types';
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
} from './requestScheduler';
import {
  registerStoreWithManager,
  resolveStoreManagerOfflineSession,
  validateStoreManagerSessionConsistency,
  type StoreManager,
} from './storeManager';
import {
  observeAutomaticFetchStatus,
  shouldScheduleAutomaticFetch,
  tryClaimAutomaticFetchSlot,
  type AutomaticFetchRetryState,
} from './utils/automaticFetchPolicy';
import {
  type BrowserTabsPriorityTimings,
  type BrowserTabsTabStatusMessage,
} from './utils/browserTabsPriority';
import {
  createBrowserTabsCoordinatorWithPriority,
  isBrowserTabsSyncVersionNewer,
  SnapshotConsistency,
  toBrowserTabsSyncVersion,
  type BrowserTabsMessageMeta,
  type BrowserTabsSyncVersion,
  type BrowserTabsTransportFactory,
} from './utils/browserTabsSync';
import { performMutationWithLifecycle } from './utils/performMutation';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import { createStoreFocusLifecycle } from './utils/storeFocusLifecycle';
import {
  AbortedStoreError,
  fetchTypePriority,
  mutationSkipped,
  NotFoundStoreError,
  normalizeStoreError,
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
  type ValidStoreState,
} from './utils/storeShared';
import { useEnsureIsLoaded } from './utils/useEnsureIsLoaded';

/** Lifecycle status for a document store. */
export type DocumentStatus = 'idle' | TSDFStatus;

/** Value returned by `DocumentStore.useDocument(...)`. */
export type TSDFUseDocumentReturn<Selected> = {
  /** Hook-visible document status. */
  status: DocumentStatus;
  /** Selected document data. Defaults to the full document or `null`. */
  data: Selected;
  /** Last document fetch error, if any. */
  error: StoreError | null;
  /** Convenience flag for `loading` or `refetching` states. */
  isLoading: boolean;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
};

export type DocumentStoreState<State extends ValidStoreState> = {
  /** Latest loaded document data, or `null` before the document is available. */
  data: State | null;
  /** Last fetch error for this document, when the latest fetch failed. */
  error: StoreError | null;
  /** Current fetch lifecycle status for the document. */
  status: DocumentStatus;
  /** Pending automatic refetch priority for stale data mounted by hooks. */
  refetchOnMount: false | FetchType;
};

type DocumentStoreEvents = { invalidateData: FetchType };

type DocumentOfflineOverlay<State extends ValidStoreState> = {
  data: State | null;
} | null;

export type OnDocumentInvalidate = (priority: FetchType) => void;

/** Events emitted by document mutation lifecycle helpers. */
export type DocumentStoreStoreEvents = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number };
  /** Emitted when a mutation completes, fails, or is skipped */
  mutationEnd: { mutationId: number; status: 'success' | 'error' | 'skipped' };
};

/** @internal */
export type DocumentBrowserTabsMessage<State extends ValidStoreState> =
  | (BrowserTabsMessageMeta & BrowserTabsTabStatusMessage)
  | (BrowserTabsMessageMeta & {
      kind: 'document-snapshot';
      consistency: SnapshotConsistency;
      data: State | null;
    })
  | (BrowserTabsMessageMeta & {
      kind: 'fetch-start';
      targetKey: 'document';
      requestIds: string[];
      startedAt: number;
    })
  | (BrowserTabsMessageMeta & {
      kind: 'fetch-success';
      targetKey: 'document';
      requestIds: string[];
      startedAt: number;
      duration: number;
    });

type DocumentSnapshotMessage<State extends ValidStoreState> = Extract<
  DocumentBrowserTabsMessage<State>,
  { kind: 'document-snapshot' }
>;

const EMPTY_DOCUMENT_OFFLINE_OPERATIONS = {};

type InternalDocumentOfflineOperations<State extends ValidStoreState> = Record<
  string,
  AnyOfflineOperationDefinition<__LEGIT_ANY__>
> &
  ([State] extends [never] ? never : unknown);

type DocumentOfflineOperationsConfig<State extends ValidStoreState> =
  InternalDocumentOfflineOperations<State> | null;

function assertDocumentOfflineOperations(
  operations: DocumentOfflineOperationsConfig<ValidStoreState>,
): void {
  if (!operations) return;

  for (const [operationName, operation] of Object.entries(operations)) {
    if (
      operation.tempEntity !== undefined ||
      operation.tempEntities !== undefined
    ) {
      throw new Error(
        `Document offline operation "${operationName}" does not support tempEntity or tempEntities`,
      );
    }
  }
}

export type DocumentStoreOptions<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
  StorageState = unknown,
> = {
  /**
   * Stable id for this logical document store. Used for debug labels,
   * persistence namespaces, and browser tab sync.
   */
  id: string;
  /** Shared global store manager providing session scoping and error normalization. */
  storeManager: StoreManager;
  fetchFn: (signal: AbortSignal) => Promise<MaybeTSDFResult<State>>;
  /** Overrides the manager's default minimum interval between low-priority fetches for this store. */
  lowPriorityThrottleMs?: number;
  /** Overrides the manager's default coalescing window for this store. */
  baseCoalescingWindowMs?: number;
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
  /** Delay applied to medium-priority requests before they enter the scheduler. */
  mediumPriorityDelayMs?: number;
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
  /** Indicates that fresh data arrives via a real-time channel. Defaults to `false`. The store
   * skips the mount-time stale refetch since real-time pushes already cover
   * revalidation. */
  usesRealTimeUpdates?: boolean;
  /** Opt-in persistent storage configuration. When provided, cached data is loaded
   * from storage on first read and saved back on successful fetches.
   * Session scoping always reuses this store manager's `getSessionKey`, and the
   * persisted namespace always reuses this store's `id`. */
  persistentStorage?: DocumentPersistentStorageConfig<
    State,
    StorageState,
    TOfflineOperations
  >;
  /** @internal */
  '~test'?: {
    initialRefetchOnMount?: FetchType;
    initialStatus?: DocumentStatus;
    initialData?: State;
    initialError?: StoreError;
    initialLastFetchStartTime?: number;
    getWindowIsFocused?: () => boolean;
    onWindowFocus?: (handler: () => void) => () => void;
    onWindowFocusChange?: (handler: () => void) => () => void;
    browserTabsTransportFactory?: BrowserTabsTransportFactory;
    browserTabsPriorityTimings?: BrowserTabsPriorityTimings;
    browserTabsLeadershipTimings?: BrowserTabsPriorityTimings;
    onReceiveRemoteMsg?: (message: DocumentBrowserTabsMessage<State>) => void;
    onSessionKeyChanged?: (event: TestSessionKeyChangedEvent) => void;
    onOfflineTimelineEvent?: (event: TestOfflineTimelineEvent) => void;
  };
};

type ResolvedDocumentOfflineOperations<TOfflineOperations> =
  TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;

type DocumentUpdateState<State extends ValidStoreState> = (
  produceNewData: (draftData: State) => State | void | undefined,
) => boolean;

type DocumentMutationContext<State extends ValidStoreState> = {
  /** Updates the current document state during the mutation. Returns `false` when no document data is loaded. */
  updateState: DocumentUpdateState<State>;
  /** Document state at the moment the mutation function runs. */
  currentState: State | null;
};

type DocumentMutationArgsBase<State extends ValidStoreState, T> = {
  /**
   * Applies an optimistic document update before the mutation runs.
   *
   * Return `false` to cancel the mutation before the async mutation function is
   * called.
   */
  optimisticUpdate?: (currentState: State | null) => void | boolean;
  /** Performs the server mutation. */
  mutation: (ctx: DocumentMutationContext<State>) => Promise<T>;
  /** Debounces mutations with the same context and payload. Superseded calls are skipped. */
  debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
  /**
   * Passes `{ silentErrors: true }` to `onMutationError`.
   *
   * The handler is still called so centralized logging and recovery can run,
   * but UI handlers can suppress user-facing notifications.
   */
  silentErrors?: boolean;
  /** Invalidates the document after a successful online mutation. */
  revalidateOnSuccess?: boolean;
};

type DocumentOnlineMutationArgs<
  State extends ValidStoreState,
  T,
> = DocumentMutationArgsBase<State, T> & {
  offline?: undefined;
  upload?: undefined;
};

type DocumentOfflineMutationArgs<
  State extends ValidStoreState,
  T,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State>,
> = DocumentMutationArgsBase<State, T> & {
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

type DocumentPerformMutation<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State>,
> = {
  /**
   * Runs a document mutation with optional optimistic updates and revalidation.
   *
   * Returns the direct server result when offline replay is not configured for
   * this call.
   */
  <T>(
    args: DocumentOnlineMutationArgs<State, T>,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a document mutation that may fall back to durable offline queueing.
   *
   * When the mutation is queued, the result is `{ kind: 'queued' }` instead of
   * the server payload.
   */
  <T>(
    args: DocumentOfflineMutationArgs<State, T, TOfflineOperations>,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  <T>(
    args:
      | DocumentOnlineMutationArgs<State, T>
      | DocumentOfflineMutationArgs<State, T, TOfflineOperations>,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
};

export type DocumentStore<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
> = {
  /** Underlying t-state store containing the raw document cache state. */
  store: Store<DocumentStoreState<State>>;
  /** Invalidation event emitter used by hooks and integrations. */
  events: Emitter<DocumentStoreEvents>;
  /** Mutation lifecycle event emitter for observers and tests. */
  storeEvents: Emitter<DocumentStoreStoreEvents>;
  /** Whether the document has been explicitly invalidated and is awaiting refresh. */
  readonly invalidationWasTriggered: boolean;
  /** Schedules a document fetch with the requested priority. */
  scheduleFetch: (
    fetchType: FetchType,
    options?: ScheduleFetchOptions,
  ) => ScheduleFetchResults;
  /** Waits for a document fetch to settle and returns data or a fetch error. */
  awaitFetch: (options?: {
    timeoutMs?: number;
  }) => Promise<
    { data: State; error: null } | { data: null; error: StoreFetchError }
  >;
  /** Returns cached document data when usable, otherwise fetches it first. */
  getDataFromStateOrFetch: (options?: {
    /** When `true`, stale cached data is ignored and refetched before returning. Defaults to `false`. */
    ignoreStaleState?: boolean;
    timeoutMs?: number;
  }) => Promise<ResultType<State, StoreFetchError>>;
  /** Loads cached document data from persistent storage when available. */
  preloadPersistentStorage: () => Promise<void>;
  /** Marks the document stale and schedules refetches for active subscriptions. Defaults to `highPriority`. */
  invalidateData: (
    /** Fetch priority used for refetches triggered by this invalidation. Defaults to `highPriority`. */
    priority?: FetchType,
  ) => void;
  /** Applies an immutable update to the cached document data. */
  updateState: DocumentUpdateState<State>;
  /** Clears in-memory state and cancels store-local runtime state. */
  reset: () => void;
  /** Unregisters listeners and releases resources owned by this store. */
  dispose: () => void;
  /** Marks the document as mutating and returns a function that ends the mutation. */
  startMutation: () => () => boolean;
  /** Returns offline sync metadata for this store's tracked entity. */
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
    ResolvedDocumentOfflineOperations<TOfflineOperations>
  >;
  /** Applies a retry/discard/requeue/commit action to a pending offline resolution. */
  resolveOfflineResolution: <
    TName extends keyof ResolvedDocumentOfflineOperations<TOfflineOperations> &
      string,
  >(
    resolutionId: string,
    operationName: TName,
    resolution: OfflineResolutionActionForOperation<
      ResolvedDocumentOfflineOperations<TOfflineOperations>,
      TName
    >,
  ) => Promise<void> | void;
  useDocument: <Selected = State | null>(args?: {
    /** Maps the document data before it is returned from the hook. */
    selector?: (data: State | null) => Selected;
    /** Disables this hook subscription and prevents automatic fetches. */
    disabled?: boolean;
    /** Marks this subscription as off-screen, lowering automatic fetch priority. */
    isOffScreen?: boolean;
    /**
     * Only fetches when the document is missing from state, skipping stale-state
     * and invalidation refetches.
     */
    disableRefetches?: boolean;
    /** Prevents the automatic mount refetch for stale loaded data. */
    disableRefetchOnMount?: boolean;
    /** Returns `idle` instead of `loading` while the document has not been fetched. */
    returnIdleStatus?: boolean;
    /**
     * Forces a high-priority fetch on mount and keeps the hook in `loading`
     * until the document finishes loading.
     */
    ensureIsLoaded?: boolean;
    /** Returns `refetching` instead of keeping `loaded` status during refetches. */
    returnRefetchingStatus?: boolean;
  }) => TSDFUseDocumentReturn<Selected>;
  /** React hook that tracks whether a nested list item is still loading. */
  useListItemIsLoading: (args: {
    /** Unique identifier of the item within the document. */
    itemId: string;
    /** Extracts the item from the document data. */
    selector: (data: State | null) => unknown;
    /** Called if the item is still missing and no refetch is in progress. */
    loadItemFallback?: () => void;
    /** Forces a high-priority fetch and keeps the hook loading until data is loaded. */
    ensureIsLoaded?: boolean;
  }) => boolean;
  /** React hook that tracks whether a nested list item has been deleted. */
  useListItemIsDeleted: (args: {
    /** Unique identifier of the item within the document. */
    itemId: string;
    /** Extracts the item from the document data. */
    selector: (data: State | null) => unknown;
    /** Called once when deletion is detected. */
    onDelete?: () => void;
    /** Forces a high-priority fetch and keeps the hook loading until data is loaded. */
    ensureIsLoaded?: boolean;
  }) => boolean;
  /** React hook for selecting one nested list item plus loading/deleted flags. */
  useListItem: <Selected>(args: {
    /** Unique identifier of the item within the document. */
    itemId: string;
    /** Extracts and maps the item from the document data. */
    selector: (data: State | null) => Selected;
    /** Called if the item is still missing and no refetch is in progress. */
    loadItemFallback?: () => void;
    /** Called once when deletion is detected. */
    onDelete?: () => void;
    /** Forces a high-priority fetch and keeps the hook loading until data is loaded. */
    ensureIsLoaded?: boolean;
  }) => { isLoading: boolean; isDeleted: boolean; data: Selected };
  /**
   * Runs the full mutation lifecycle: optional optimistic update, async
   * mutation, rollback/error handling, revalidation, and offline queue fallback.
   */
  performMutation: DocumentPerformMutation<State, TOfflineOperations>;
  /** Notifies the store that a shared transport reconnected and should revalidate active data. */
  onTransportReconnect: () => void;
};

// Constant requestId for document store (single-item mode)
const DOC_REQUEST_ID = '_doc';
const DOC_TARGET_KEY = 'document' as const;

export function createDocumentStore<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
  StorageState = unknown,
>(
  storeOptions: DocumentStoreOptions<State, TOfflineOperations, StorageState>,
): DocumentStore<State, TOfflineOperations> {
  const {
    id,
    storeManager,
    fetchFn,
    lowPriorityThrottleMs: storeLowPriorityThrottleMs,
    baseCoalescingWindowMs: storeBaseCoalescingWindowMs,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs = 2_000,
    mediumPriorityDelayMs,
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
  const blockWindowClose = storeManager.storeDefaults.blockWindowClose;
  const resolvedRevalidateOnWindowFocus =
    revalidateOnWindowFocus ??
    storeManager.storeDefaults.revalidateOnWindowFocus;
  const resolvedOnMutationError = resolveManagerFallback(
    onMutationError,
    storeManager.onMutationError,
  );

  let invalidationWasTriggered = false;
  type ResolvedOfflineOperations = TOfflineOperations extends null
    ? Record<never, never>
    : Exclude<TOfflineOperations, null>;
  let remoteApplyDepth = 0;
  let currentBroadcastConsistency: SnapshotConsistency = 'confirmed';
  let lastDocumentSyncVersion: BrowserTabsSyncVersion | undefined;
  const offlineOverlayStore = new Store<DocumentOfflineOverlay<State>>({
    debugName: `${id}:document-offline-overlay`,
    state: () => null,
  });
  offlineOverlayStore.initializeStore();
  let offlineOverlaySessionKey: string | null = null;

  function clearOfflineOverlay(nextSessionKey: string | null = null): void {
    offlineOverlaySessionKey = nextSessionKey;
    offlineOverlayStore.setState(null);
  }

  let initialData: State | null = null;
  let initialRefetchOnMount: FetchType | false = false;
  let initialStatus: DocumentStatus = 'idle';
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
  const resolvedPersistentStorageConfig: ResolvedDocumentPersistentStorageConfig<
    State,
    StorageState,
    TOfflineOperations
  > | null = persistentStorageConfig
    ? __LEGIT_CAST__<
        ResolvedDocumentPersistentStorageConfig<
          State,
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
    ? setupDocumentPersistence(resolvedPersistentStorageConfig)
    : null;
  const persistentStorageErrorReporter = resolvedPersistentStorageConfig
    ? resolvedPersistentStorageConfig.onPersistentStorageError
    : storeManager.onPersistentStorageError;
  const resolvedOfflineConfig = resolvedPersistentStorageConfig?.offline;
  // WORKAROUND: Session-only offline config omits operations, so document stores normalize that case to an empty registry before passing it through the generic offline controller surface.
  const resolvedOfflineOperations = __LEGIT_CAST__<
    ResolvedOfflineOperations,
    unknown
  >(resolvedOfflineConfig?.operations ?? EMPTY_DOCUMENT_OFFLINE_OPERATIONS);

  if (import.meta.env.DEV) {
    assertDocumentOfflineOperations(
      // WORKAROUND: Persistent config stores offline operations behind the generic persistence surface, and the assertion helper expects the already-narrowed ValidStoreState variant.
      __LEGIT_CAST__<DocumentOfflineOperationsConfig<ValidStoreState>, unknown>(
        resolvedOfflineOperations,
      ),
    );
  }

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
          storeType: 'document',
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
            getEntityRefs: () => [
              { entityKey: DOC_TARGET_KEY, entityKind: 'document' },
            ],
            normalizeEntityRefs: () => [
              { entityKey: DOC_TARGET_KEY, entityKind: 'document' },
            ],
            getProtectedCacheKeys: () => {
              const sessionKey = getSessionKeyForRuntime();
              if (sessionKey === false) return [];
              return [
                createProtectedStorageKey({
                  backend:
                    resolvedPersistentStorageConfig.adapter !== 'local-sync'
                      ? 'async'
                      : 'localStorage',
                  sessionKey,
                  storeName: id,
                  kind: 'document',
                  key: DOCUMENT_PERSISTED_ENTRY_KEY,
                }),
              ];
            },
            applyPendingEntity: ({ pendingEntity }) => {
              if (!pendingEntity || typeof pendingEntity !== 'object') return;
              updateState((draft) => Object.assign(draft, pendingEntity));
            },
            reconcileTempEntity: ({ reconciliation }) => {
              if (
                !reconciliation.finalData ||
                typeof reconciliation.finalData !== 'object'
              ) {
                return;
              }

              updateState((draft) =>
                Object.assign(draft, reconciliation.finalData),
              );
            },
            captureQueuedMutationOverlays: ({ sessionKey }) => {
              if (offlineOverlaySessionKey !== sessionKey) {
                clearOfflineOverlay(sessionKey);
              }

              offlineOverlayStore.setState({ data: klona(store.state.data) });
            },
            syncEntityOverlays: ({ entities, sessionKey }) => {
              if (offlineOverlaySessionKey !== sessionKey) {
                clearOfflineOverlay(sessionKey);
              }

              if (
                !entities.some((entity) => {
                  return entity.entityKey === DOC_TARGET_KEY;
                })
              ) {
                offlineOverlayStore.setState(null);
              }
            },
          },
        })
      : null;

  const store = new Store<DocumentStoreState<State>>({
    debugName: id,
    state: () =>
      persistence?.createInitialState({
        data: initialData,
        error: initialError,
        status: initialStatus,
        refetchOnMount: initialRefetchOnMount,
      }) ?? {
        data: initialData,
        error: initialError,
        status: initialStatus,
        refetchOnMount: initialRefetchOnMount,
      },
  });

  const events = evtmitter<DocumentStoreEvents>();

  const storeEvents = evtmitter<DocumentStoreStoreEvents>();
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

  function recordDocumentSyncVersion(
    meta: Pick<BrowserTabsMessageMeta, 'tabId' | 'seq' | 'sentAt'>,
    consistency: SnapshotConsistency,
  ): void {
    lastDocumentSyncVersion = toBrowserTabsSyncVersion(meta, consistency);
  }

  function publishDocumentSnapshot(
    consistency: SnapshotConsistency = currentBroadcastConsistency,
  ): void {
    if (remoteApplyDepth > 0) return;

    const message = browserTabsSync.publish({
      kind: 'document-snapshot',
      consistency,
      data: store.state.data,
    });
    if (!message) return;

    recordDocumentSyncVersion(message, consistency);
  }

  function hasLocalDocumentState(): boolean {
    return (
      store.state.status !== 'idle' ||
      store.state.data !== null ||
      store.state.error !== null
    );
  }

  function applyRemoteDocumentSnapshot(
    message: DocumentSnapshotMessage<State>,
    candidateVersion: BrowserTabsSyncVersion,
  ): void {
    if (!hasLocalDocumentState()) {
      lastDocumentSyncVersion = candidateVersion;
      return;
    }

    runWithoutBroadcast(() => {
      store.setPartialState(
        {
          data: reusePrevIfEqual({
            prev: store.state.data,
            current: message.data,
          }),
          error: null,
          status: 'success',
          refetchOnMount: false,
        },
        { action: 'browser-tabs-document-snapshot' },
      );
    });

    lastDocumentSyncVersion = candidateVersion;
  }

  function shouldIgnoreConfirmedRemoteDocumentSnapshot(
    message: DocumentSnapshotMessage<State>,
  ): boolean {
    return (
      message.consistency === 'confirmed' &&
      scheduler.isMutationInProgress(DOC_REQUEST_ID)
    );
  }

  function handleRemoteMessage(
    message: DocumentBrowserTabsMessage<State>,
  ): void {
    if (message.kind === 'tab-status') {
      browserTabsPriority.onTabStatusMessage(message.tabId, message);
      return;
    }

    if (message.kind === 'fetch-start') {
      if (!hasLocalDocumentState()) return;
      scheduler.syncExternalFetchStart(message.requestIds, message.startedAt);
      scheduler.cancelCoalescingRequests(message.requestIds);
      return;
    }

    if (message.kind === 'fetch-success') {
      if (!hasLocalDocumentState()) return;
      scheduler.syncExternalFetchSuccess(
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

    if (
      !isBrowserTabsSyncVersionNewer(candidateVersion, lastDocumentSyncVersion)
    ) {
      return;
    }

    if (shouldIgnoreConfirmedRemoteDocumentSnapshot(message)) {
      lastDocumentSyncVersion = candidateVersion;
      return;
    }

    if (import.meta.env.TEST) {
      testOptions?.onReceiveRemoteMsg?.(message);
    }

    applyRemoteDocumentSnapshot(message, candidateVersion);
  }

  const { coordinator: browserTabsSync, priority: browserTabsPriority } =
    createBrowserTabsCoordinatorWithPriority<DocumentBrowserTabsMessage<State>>(
      {
        storeType: 'document',
        storeKey: id,
        getSessionKey: getSessionKeyForRuntime,
        onMessage: handleRemoteMessage,
        onSessionChange() {
          lastDocumentSyncVersion = undefined;
          clearOfflineOverlay();
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
      },
    );

  async function executeFetch(fetchCtx: FetchContext): Promise<boolean> {
    const currentStatus = store.state.status;
    const wasLoadedBeforeFetch = currentStatus === 'success';

    store.setPartialState(
      {
        status: currentStatus === 'success' ? 'refetching' : 'loading',
        error: null,
        refetchOnMount: false,
      },
      {
        action:
          currentStatus === 'success'
            ? 'fetch-start-refetching'
            : 'fetch-start-loading',
      },
    );

    try {
      const result = await runOfflineAwareFetch({
        controller: offlineController,
        fetcher: () => fetchFn(fetchCtx.signal),
      });

      if (!result.ok) {
        if (result.offline) {
          store.setPartialState(
            wasLoadedBeforeFetch
              ? { error: null, status: 'success' }
              : { error: offlineConnectivityError, status: 'error' },
            { action: 'fetch-error-offline' },
          );
          return false;
        }

        throw result.error;
      }
      const data = result.data;

      if (fetchCtx.shouldAbort()) return false;

      store.setPartialState(
        {
          data: reusePrevIfEqual({ prev: store.state.data, current: data }),
          status: 'success',
        },
        { action: 'fetch-success' },
      );

      return true;
    } catch (exception) {
      if (fetchCtx.shouldAbort()) return false;

      store.setPartialState(
        {
          error: normalizeStoreError(exception, errorNormalizer),
          status: 'error',
        },
        { action: 'fetch-error' },
      );

      return false;
    }
  }

  const wrappedDynamicRealtimeThrottleMs = dynamicRealtimeThrottleMs
    ? (lastFetchDuration: number) =>
        dynamicRealtimeThrottleMs({
          lastFetchDuration,
          windowIsNotFocused: !getWindowIsFocused(),
        })
    : undefined;

  function getAutomaticCoalescingWindowMs(): number {
    return browserTabsPriority.getCoalescingWindowMs(baseCoalescingWindowMs);
  }

  // Scheduler with batch-aware fetchFn (but we always use single item)
  const scheduler = new RequestScheduler<null>({
    fetchFn: async (
      requests: BatchRequest<null>[],
      fetchCtx: FetchContext,
    ): Promise<Map<string, boolean>> => {
      browserTabsSync.publish({
        kind: 'fetch-start',
        targetKey: DOC_TARGET_KEY,
        requestIds: requests.map(({ requestId }) => requestId),
        startedAt: fetchCtx.getStartTime(),
      });

      // Document store always has single request
      const success = await executeFetch(fetchCtx);
      if (success) {
        browserTabsSync.publish({
          kind: 'fetch-success',
          targetKey: DOC_TARGET_KEY,
          requestIds: requests.map(({ requestId }) => requestId),
          startedAt: fetchCtx.getStartTime(),
          duration: Date.now() - fetchCtx.getStartTime(),
        });
        publishDocumentSnapshot('confirmed');
      }

      const results = new Map<string, boolean>();
      for (const { requestId } of requests) {
        results.set(requestId, success);
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

  if (
    initialStatus !== 'idle' ||
    initialData !== null ||
    initialError !== null
  ) {
    scheduler.setLastFetchStartTimeForRequest(
      DOC_REQUEST_ID,
      testOptions?.initialLastFetchStartTime ?? 0,
    );
  }

  const focusLifecycle = createStoreFocusLifecycle({
    revalidateOnWindowFocus: resolvedRevalidateOnWindowFocus,
    usesRealTimeUpdates,
    transportReconnectCooldownMs,
    getWindowIsFocused,
    onWindowFocus: testOptions?.onWindowFocus ?? onWindowFocusDefault,
    onWindowFocusRevalidate: () => {
      invalidateData('lowPriority');
    },
    onTransportReconnectRevalidate: () => {
      invalidateData('realtimeUpdate');
    },
  });

  // Attach persistent storage after store creation
  persistence?.attach(store);
  initializeOfflineStoreController(offlineController);

  function scheduleFetch(
    fetchType: FetchType,
    options?: ScheduleFetchOptions,
  ): ScheduleFetchResults {
    return scheduler.scheduleFetch(DOC_REQUEST_ID, fetchType, null, options);
  }

  async function awaitFetch(
    options: { timeoutMs?: number } = {},
  ): Promise<
    { data: State; error: null } | { data: null; error: StoreFetchError }
  > {
    if (persistence?.hasAsyncPreload && store.state.data === null) {
      await persistence.preloadPersistentStorage();
    }

    const result = await scheduler.awaitFetch(DOC_REQUEST_ID, null, options);

    if (result === 'timeout') {
      return { data: null, error: new TimeoutStoreError() };
    }

    if (result === true) {
      return { data: null, error: new AbortedStoreError() };
    }

    if (store.state.error) {
      return {
        data: null,
        error: new StoreFetchError(store.state.error, 'fetch'),
      };
    }

    if (!store.state.data) {
      return { data: null, error: new NotFoundStoreError() };
    }

    return { data: store.state.data, error: null };
  }

  async function getDataFromStateOrFetch({
    ignoreStaleState,
    timeoutMs,
  }: { ignoreStaleState?: boolean; timeoutMs?: number } = {}): Promise<
    ResultType<State, StoreFetchError>
  > {
    const state = store.state;

    if (
      state.data !== null &&
      (!ignoreStaleState ||
        (state.status === 'success' && !state.error && !state.refetchOnMount))
    ) {
      return Result.ok(state.data);
    }

    const result = await awaitFetch({ timeoutMs });

    if (result.error) {
      return Result.err(result.error);
    }

    return Result.ok(result.data);
  }

  async function preloadPersistentStorage(): Promise<void> {
    if (!persistence?.hasAsyncPreload) {
      persistentStorageErrorReporter?.(
        new Error('Async preload is not available'),
      );
      return;
    }

    await persistence.preloadPersistentStorage();
  }

  function invalidateData(priority: FetchType = 'highPriority'): void {
    const currentRefetchOnMount = store.state.refetchOnMount;
    const currentInvalidationPriority = currentRefetchOnMount
      ? fetchTypePriority[currentRefetchOnMount]
      : -1;
    const newInvalidationPriority = fetchTypePriority[priority];

    if (currentInvalidationPriority >= newInvalidationPriority) return;

    store.setKey('refetchOnMount', priority, { action: 'invalidate-data' });
    invalidationWasTriggered = false;
    events.emit('invalidateData', priority);
  }

  function updateState(
    produceNewData: (draftData: State) => State | void | undefined,
  ): boolean {
    if (!store.state.data) return false;

    store.produceState(
      (draft) => {
        if (!draft.data) return;

        const newData = produceNewData(draft.data);
        if (newData !== undefined) {
          draft.data = newData;
        }
      },
      { action: 'update-state' },
    );

    if (remoteApplyDepth === 0) {
      scheduler.setLastFetchStartTimeForRequest(DOC_REQUEST_ID, 0);
      publishDocumentSnapshot();
    }

    return true;
  }

  /**
   * Signals that the real-time transport (e.g. WebSocket) has reconnected after
   * a disconnection. Events may have been missed during the outage, so data
   * needs to be revalidated.
   *
   * - No-op when `usesRealTimeUpdates` is `false`.
   * - If the window is focused, the first reconnect invalidates immediately
   *   with `realtimeUpdate` priority.
   * - Additional reconnects within `transportReconnectCooldownMs` are coalesced
   *   into one trailing invalidation.
   * - If the window is **not** focused, reconnect invalidation waits until the
   *   next window focus event.
   */
  function onTransportReconnect(): void {
    if (isDisposed) return;
    focusLifecycle.onTransportReconnect();
  }

  function reset(): void {
    if (isDisposed) return;
    scheduler.reset();
    lastDocumentSyncVersion = undefined;
    clearOfflineOverlay();
    browserTabsPriority.reset();

    persistence?.dispose();
    void persistence?.clear();

    store.setState({
      data: null,
      error: null,
      status: 'idle',
      refetchOnMount: 'lowPriority',
    });
    focusLifecycle.reset();
    persistence?.attach(store);
  }

  /** Releases store resources and unregisters the store from its manager. */
  function dispose(): void {
    if (isDisposed) return;

    isDisposed = true;
    unregisterStoreFromManager();
    scheduler.reset();
    lastDocumentSyncVersion = undefined;
    clearOfflineOverlay();
    browserTabsSync.close();
    browserTabsPriority.close();
    focusLifecycle.dispose();
    persistence?.dispose();
    offlineController?.dispose();
  }

  function startMutation(): () => boolean {
    return scheduler.startMutation(DOC_REQUEST_ID);
  }

  /**
   * Runs a document mutation with optional optimistic updates and revalidation.
   *
   * Returns the direct server result when offline replay is not configured for
   * this call.
   */
  async function performMutation<T>(
    args: DocumentOnlineMutationArgs<State, T>,
  ): Promise<
    ResultType<
      UnwrapTSDFResult<Awaited<T>>,
      StoreMutationError | MutationSkipped
    >
  >;
  /**
   * Runs a document mutation that may fall back to durable offline queueing.
   *
   * When the mutation is queued, the result is `{ kind: 'queued' }` instead of
   * the server payload. Use this overload when you want the mutation to keep
   * working while offline or during classified outages.
   */
  async function performMutation<T>(
    args: DocumentOfflineMutationArgs<State, T, TOfflineOperations>,
  ): Promise<
    ResultType<
      OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>(
    args:
      | DocumentOnlineMutationArgs<State, T>
      | DocumentOfflineMutationArgs<State, T, TOfflineOperations>,
  ): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>({
    optimisticUpdate,
    mutation,
    debounce,
    silentErrors,
    revalidateOnSuccess,
    offline,
    upload,
  }:
    | DocumentOnlineMutationArgs<State, T>
    | DocumentOfflineMutationArgs<State, T, TOfflineOperations>): Promise<
    ResultType<
      | UnwrapTSDFResult<Awaited<T>>
      | OfflineMutationResult<UnwrapTSDFResult<Awaited<T>>>,
      StoreMutationError | MutationSkipped
    >
  > {
    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(
        toStoreMutationError(
          new OfflineSessionUnavailableError(),
          errorNormalizer,
        ),
      );
    }

    const mutationId = getAutoIncrementId();
    storeEvents.emit('mutationStart', { mutationId });
    const optimisticRollbackSnapshot = optimisticUpdate
      ? klona(store.state.data)
      : undefined;

    const directMutation = async () =>
      unwrapTSDFResult(
        await mutation({ updateState, currentState: store.state.data }),
      );

    const result = await performMutationWithLifecycle({
      startMutation,
      optimisticUpdate: optimisticUpdate
        ? () =>
            runWithBroadcastConsistency('optimistic', () =>
              optimisticUpdate(store.state.data),
            )
        : undefined,
      debounce,
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
        if (revalidateOnSuccess && result.kind === 'online') {
          invalidateData();
        }
      },
      onError: (exception) => {
        if (optimisticUpdate) {
          runWithBroadcastConsistency('confirmed', () => {
            store.setKey('data', optimisticRollbackSnapshot ?? null, {
              action: 'rollback-mutation-error',
            });
            publishDocumentSnapshot();
          });
        }

        if (resolvedOnMutationError) {
          resolvedOnMutationError(exception, { silentErrors });
        }

        return toStoreMutationError(exception, errorNormalizer);
      },
    });

    storeEvents.emit('mutationEnd', {
      mutationId,
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

  function useDocument<Selected = State | null>({
    selector,
    isOffScreen: isOffScreenProp,
    disabled: disabledProp,
    returnRefetchingStatus,
    disableRefetchOnMount = globalDisableRefetchOnMount,
    returnIdleStatus: returnIdleStatusProp,
    ensureIsLoaded,
    disableRefetches,
  }: {
    /** Maps the document data before it is returned from the hook. */
    selector?: (data: State | null) => Selected;
    /** Disables this hook subscription and prevents automatic fetches. */
    disabled?: boolean;
    /** Marks this subscription as off-screen, lowering automatic fetch priority. */
    isOffScreen?: boolean;
    /**
     * Only fetches when the document is missing from state, skipping stale-state
     * and invalidation refetches.
     */
    disableRefetches?: boolean;
    /** Prevents the automatic mount refetch for stale loaded data. */
    disableRefetchOnMount?: boolean;
    /** Returns `idle` instead of `loading` while the document has not been fetched. */
    returnIdleStatus?: boolean;
    /**
     * Forces a high-priority fetch on mount and keeps the hook in `loading`
     * until the document finishes loading.
     */
    ensureIsLoaded?: boolean;
    /** Returns `refetching` instead of keeping `loaded` status during refetches. */
    returnRefetchingStatus?: boolean;
  } = {}) {
    const offlineEntities = useOfflineStoreEntities({
      sessionKey: getSessionKeyForRuntime(),
      inactiveScope: id,
      storeName: resolvedPersistentStorageConfig ? id : undefined,
    });
    const offlineEntitiesByKey = useMemo(
      () => createOfflineEntityLookup(offlineEntities),
      [offlineEntities],
    );
    const offlineOverlaySelector = useCallback(
      (state: DocumentOfflineOverlay<State>) => state,
      [],
    );
    const offlineOverlay = offlineOverlayStore.useSelectorRC(
      offlineOverlaySelector,
    );
    const isOffScreenFromContext = useContext(IsOffScreenContext);
    const disabled = disabledProp ?? isOffScreenProp ?? isOffScreenFromContext;
    const returnIdleStatus = returnIdleStatusProp ?? !!disabled;
    const storeStateSelector = useCallback(
      (state: DocumentStoreState<State>): TSDFUseDocumentReturn<Selected> => {
        const { error } = state;
        const activeOfflineEntity = offlineEntitiesByKey.get(DOC_TARGET_KEY);
        const resolvedData =
          shouldApplyOfflineOverlay(activeOfflineEntity, offlineOverlay) &&
          offlineOverlay !== null
            ? offlineOverlay.data
            : state.data;

        const data = selector
          ? selector(resolvedData)
          : // WORKAROUND: Runtime selector presence does not narrow Selected, so the default branch must forward the raw document state through the generic.
            __LEGIT_CAST__<Selected, State | null>(resolvedData);
        let status = state.status;

        if (!returnIdleStatus && status === 'idle') {
          status = 'loading';
        }

        if (!returnRefetchingStatus && status === 'refetching') {
          status = 'success';
        }

        return {
          data,
          error,
          status,
          isLoading: status === 'loading',
          pendingSync: getIsPendingOfflineSync(activeOfflineEntity),
        };
      },
      [
        offlineEntitiesByKey,
        offlineOverlay,
        selector,
        returnIdleStatus,
        returnRefetchingStatus,
      ],
    );

    const storeState = store.useSelectorRC(storeStateSelector, {
      equalityFn: deepEqual,
    });
    const automaticRetryState = useConst<AutomaticFetchRetryState>(
      () => new Map(),
    );

    useEffect(() => {
      if (disabled) {
        automaticRetryState.delete(DOC_TARGET_KEY);
        return;
      }

      observeAutomaticFetchStatus(
        automaticRetryState,
        DOC_TARGET_KEY,
        store.state.status,
      );
    }, [automaticRetryState, disabled, storeState]);

    useOnEvtmitterEvent(events, 'invalidateData', ({ payload: priority }) => {
      if (disabled) return;
      if (
        disableRefetches &&
        store.state.status !== 'idle' &&
        store.state.status !== 'error'
      ) {
        return;
      }

      if (!invalidationWasTriggered) {
        store.setKey('refetchOnMount', false);

        scheduleFetch(priority);
        invalidationWasTriggered = true;
      }
    });

    useEffect(() => {
      const effectState = { cancelled: false };

      void (async () => {
        if (persistence) {
          await persistence.maybeHydrateFromStorage();
          if (effectState.cancelled) return;
        }

        if (disabled) return;

        const fetchType = store.state.refetchOnMount || 'lowPriority';
        const wasLoaded =
          store.state.status === 'success' ||
          store.state.status === 'refetching';
        const requiredFetch =
          store.state.status === 'idle' || store.state.status === 'error';
        const shouldFetch = requiredFetch || !!store.state.refetchOnMount;

        if (
          shouldScheduleAutomaticFetch({
            wasLoaded,
            shouldFetch,
            requiredFetch,
            disableRefetches: !!disableRefetches,
            disableRefetchOnMount: !!disableRefetchOnMount,
            refetchOnMount: store.state.refetchOnMount,
          }) &&
          tryClaimAutomaticFetchSlot(
            automaticRetryState,
            DOC_TARGET_KEY,
            store.state.status,
          )
        ) {
          scheduleFetch(fetchType);
        }
      })();

      return () => {
        effectState.cancelled = true;
      };
    }, [
      automaticRetryState,
      disableRefetchOnMount,
      disableRefetches,
      disabled,
    ]);

    const [useModifyResult, emitIsLoadedEvt] = useEnsureIsLoaded(
      ensureIsLoaded,
      !disabled,
      () => {
        scheduleFetch('highPriority');
      },
    );

    useSubscribeToStore(store, ({ observe }) => {
      observe
        .ifSelector((state) => state.status)
        .change.then(({ current }) => {
          if (current === 'success' || current === 'error') {
            emitIsLoadedEvt();
          }
        });
    });

    return useModifyResult(storeState);
  }

  /** Detects whether a specific item inside the document's data is still loading.
   * Useful when the document holds a list/record of items and a component displays
   * an individual item that may not be present yet. */
  function useListItemIsLoading({
    itemId,
    selector,
    loadItemFallback,
    ensureIsLoaded,
  }: {
    /** Unique identifier of the item within the document */
    itemId: string;
    /** Extracts the item from the document data; returning `null`/`undefined` means "not found" */
    selector: (data: State | null) => unknown;
    /** Called after a timeout if the item is still missing and no refetch is in progress. Defaults to `invalidateData()`. */
    loadItemFallback?: () => void;
    /** If true, forces a high-priority fetch and shows loading until the data is loaded */
    ensureIsLoaded?: boolean;
  }): boolean {
    const doc = useDocument({
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = doc.data != null;
    const listIsLoading = doc.isLoading;
    const isRefetching = doc.status === 'refetching';

    return useListItemIsLoadingBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateData()),
    });
  }

  /** Detects when a specific item inside the document's data has been deleted.
   * Only triggers after the item was previously found and then disappears — not
   * during initial loading. */
  function useListItemIsDeleted({
    itemId,
    selector,
    onDelete,
    ensureIsLoaded,
  }: {
    /** Unique identifier of the item within the document */
    itemId: string;
    /** Extracts the item from the document data; returning `null`/`undefined` means "not found" */
    selector: (data: State | null) => unknown;
    /** Called once when the deletion is detected */
    onDelete?: () => void;
    /** If true, forces a high-priority fetch and shows loading until the data is loaded */
    ensureIsLoaded?: boolean;
  }): boolean {
    const doc = useDocument({
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = doc.data != null;
    const listIsLoading = doc.isLoading;

    return useListItemIsDeletedBase({
      itemId,
      itemExists,
      listIsLoading,
      onDelete,
    });
  }

  /** Combined hook that returns `{ isLoading, isDeleted, data }` for a specific item
   * inside the document's data. Composes `useListItemIsLoading` and `useListItemIsDeleted`. */
  function useListItem<Selected>({
    itemId,
    selector,
    loadItemFallback,
    onDelete,
    ensureIsLoaded,
  }: {
    /** Unique identifier of the item within the document */
    itemId: string;
    /** Extracts and maps the item from the document data */
    selector: (data: State | null) => Selected;
    /** Called after a timeout if the item is still missing. Defaults to `invalidateData()`. */
    loadItemFallback?: () => void;
    /** Called once when the deletion is detected */
    onDelete?: () => void;
    /** If true, forces a high-priority fetch and shows loading until the data is loaded */
    ensureIsLoaded?: boolean;
  }): { isLoading: boolean; isDeleted: boolean; data: Selected } {
    const doc = useDocument({
      returnRefetchingStatus: true,
      selector,
      ensureIsLoaded,
    });

    const itemExists = doc.data != null;
    const listIsLoading = doc.isLoading;
    const isRefetching = doc.status === 'refetching';

    return useListItemBase({
      itemId,
      isRefetching,
      listIsLoading,
      itemExists,
      loadItemFallback: loadItemFallback ?? (() => invalidateData()),
      data: doc.data,
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
    getDataFromStateOrFetch,
    preloadPersistentStorage,
    invalidateData,
    updateState,
    reset,
    dispose,
    startMutation,
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
    useDocument,
    useListItemIsLoading,
    useListItemIsDeleted,
    useListItem,
    performMutation,
    onTransportReconnect,
  };
}
