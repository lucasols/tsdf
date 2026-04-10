import { useOnEvtmitterEvent } from '@evtmitter/react';
import {
  isWindowFocused,
  onWindowFocus as onWindowFocusDefault,
} from '@ls-stack/browser-utils/window';
import { deepEqual } from '@ls-stack/utils/deepEqual';
import {
  __LEGIT_CAST__,
  type __LEGIT_ANY__,
} from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import { produce } from 'immer';
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
import {
  useOfflineStoreEntities,
  useOfflineStoreResolutions,
} from './persistentStorage/offline/sessionCoordinator';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  offlineSessionUnavailableError,
} from './persistentStorage/offline/storeController';
import {
  OfflineResolutionConflictParseError,
  type AnyOfflineOperationDefinition,
  type OfflineMutationInput,
  type OfflineResolutionActionForOperation,
  type OfflineResolutionRecordForOperation,
  type ParsedOfflineResolutionConflictResultForOperation,
} from './persistentStorage/offline/types';
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
  type StoreManager,
  validateStoreManagerSessionConsistency,
} from './storeManager';
import { shouldScheduleAutomaticFetch } from './utils/automaticFetchPolicy';
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
import {
  performMutationWithLifecycle,
  type BlockWindowCloseHandler,
} from './utils/performMutation';
import { reusePrevIfEqual } from './utils/reusePrevIfEqual';
import { createStoreFocusLifecycle } from './utils/storeFocusLifecycle';
import {
  AbortedStoreError,
  fetchTypePriority,
  type MutationSkipped,
  NotFoundStoreError,
  StoreFetchError,
  StoreMutationError,
  toStoreMutationError,
  TimeoutStoreError,
  TSDFStatus,
  ValidStoreState,
  type StoreError,
} from './utils/storeShared';
import { useEnsureIsLoaded } from './utils/useEnsureIsLoaded';

export type DocumentStatus = 'idle' | TSDFStatus;

export type TSDFUseDocumentReturn<Selected> = {
  status: DocumentStatus;
  data: Selected;
  error: StoreError | null;
  isLoading: boolean;
  /** Whether this result has local offline changes that still need to sync to the server. */
  pendingSync: boolean;
};

export type DocumentStoreState<State extends ValidStoreState> = {
  data: State | null;
  error: StoreError | null;
  status: DocumentStatus;
  refetchOnMount: false | FetchType;
};

type DocumentStoreEvents = { invalidateData: FetchType };

type DocumentOfflineOverlay<State extends ValidStoreState> = {
  data: State | null;
} | null;

export type OnDocumentInvalidate = (priority: FetchType) => void;

export type DocumentStoreStoreEvents = {
  /** Emitted when a mutation begins executing */
  mutationStart: { mutationId: number };
  /** Emitted when a mutation completes or fails */
  mutationEnd: { mutationId: number; success: boolean };
};

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
  AnyOfflineOperationDefinition
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
  debugName?: string;
  /** Stable id shared by the same logical document store across browser tabs. */
  id: string;
  /** Shared global store manager providing session scoping and error normalization. */
  storeManager: StoreManager;
  fetchFn: (signal: AbortSignal) => Promise<State>;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  /** Reconnect-specific cooldown. The first reconnect revalidates immediately;
   * additional reconnects within the cooldown are coalesced into one trailing
   * revalidation. Set to `0` to disable this cooldown. */
  transportReconnectCooldownMs?: number;
  mediumPriorityDelayMs?: number;
  onSchedulerEvent?: (
    event: RequestSchedulerEvents,
    data?: RequestSchedulerEventData,
  ) => void;
  onMutationError?: (
    error: unknown,
    options: { dontShowToast?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
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

export type DocumentStore<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
> = ReturnType<typeof createDocumentStore<State, TOfflineOperations>>;

// Constant requestId for document store (single-item mode)
const DOC_REQUEST_ID = '_doc';
const DOC_TARGET_KEY = 'document' as const;

export function createDocumentStore<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsConfig<State> = null,
  StorageState = unknown,
>({
  debugName,
  id,
  storeManager,
  fetchFn,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  dynamicRealtimeThrottleMs,
  revalidateOnWindowFocus,
  transportReconnectCooldownMs = 2_000,
  mediumPriorityDelayMs,
  onSchedulerEvent,
  onMutationError,
  blockWindowClose,
  usesRealTimeUpdates = false,
  persistentStorage: persistentStorageConfig,
  '~test': testOptions,
}: DocumentStoreOptions<State, TOfflineOperations, StorageState>) {
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

  // Persistent storage setup
  const persistence = resolvedPersistentStorageConfig
    ? setupDocumentPersistence(resolvedPersistentStorageConfig)
    : null;
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
                      ? 'opfs'
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
    debugName,
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
          error: errorNormalizer(
            exception instanceof Error
              ? exception
              : new Error(String(exception), { cause: exception }),
          ),
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
    revalidateOnWindowFocus,
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

  async function preloadPersistentStorage(): Promise<void> {
    if (!persistence?.hasAsyncPreload) {
      persistentStorageConfig?.onPersistentStorageError?.(
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

    store.setKey(
      'data',
      (current) => {
        if (!current) return current;

        return produce(current, produceNewData);
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

  type DocumentMutationArgs<T> = {
    optimisticUpdate?: (currentState: State | null) => void | boolean;
    mutation: (ctx: {
      updateState: typeof updateState;
      currentState: State | null;
    }) => Promise<T>;
    debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
    dontShowErrorToast?: boolean;
    revalidateOnSuccess?: boolean;
  };

  type DocumentOnlineMutationArgs<T> = DocumentMutationArgs<T> & {
    offline?: undefined;
  };

  type DocumentOfflineMutationArgs<T> = DocumentMutationArgs<T> & {
    /**
     * When provided, the mutation tries the direct request while the session is
     * online, but degrades into durable offline queueing when the session is
     * already offline or the failure is classified as offline/outage. Callers
     * must not assume a successful result always includes the server payload.
     */
    offline: TOfflineOperations extends null
      ? never
      : OfflineMutationInput<Exclude<TOfflineOperations, null>>;
  };

  /**
   * Runs a document mutation with optional optimistic updates and revalidation.
   *
   * Returns the direct server result when offline replay is not configured for
   * this call.
   */
  async function performMutation<T>(
    args: DocumentOnlineMutationArgs<T>,
  ): Promise<ResultType<Awaited<T>, StoreMutationError | MutationSkipped>>;
  /**
   * Runs a document mutation that may fall back to durable offline queueing.
   *
   * When the mutation is queued, the result is `{ kind: 'queued' }` instead of
   * the server payload. Use this overload when you want the mutation to keep
   * working while offline or during classified outages.
   */
  async function performMutation<T>(
    args: DocumentOfflineMutationArgs<T>,
  ): Promise<
    ResultType<OfflineMutationResult<T>, StoreMutationError | MutationSkipped>
  >;
  async function performMutation<T>(
    args: DocumentOnlineMutationArgs<T> | DocumentOfflineMutationArgs<T>,
  ): Promise<
    ResultType<
      Awaited<T> | OfflineMutationResult<T>,
      StoreMutationError | MutationSkipped
    >
  >;
  async function performMutation<T>({
    optimisticUpdate,
    mutation,
    debounce,
    dontShowErrorToast,
    revalidateOnSuccess,
    offline,
  }: DocumentOnlineMutationArgs<T> | DocumentOfflineMutationArgs<T>): Promise<
    ResultType<
      Awaited<T> | OfflineMutationResult<T>,
      StoreMutationError | MutationSkipped
    >
  > {
    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(
        toStoreMutationError(offlineSessionUnavailableError, errorNormalizer),
      );
    }

    const mutationId = getAutoIncrementId();
    storeEvents.emit('mutationStart', { mutationId });
    const optimisticRollbackSnapshot = optimisticUpdate
      ? klona(store.state.data)
      : undefined;

    const directMutation = () =>
      mutation({ updateState, currentState: store.state.data });

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

        if (onMutationError) {
          onMutationError(exception, { dontShowToast: dontShowErrorToast });
        }

        return toStoreMutationError(exception, errorNormalizer);
      },
    });

    storeEvents.emit('mutationEnd', { mutationId, success: result.ok });

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
    selector?: (data: State | null) => Selected;
    disabled?: boolean;
    isOffScreen?: boolean;
    /** only loads the data if it is not already loaded and skip any other refetches */
    disableRefetches?: boolean;
    disableRefetchOnMount?: boolean;
    returnIdleStatus?: boolean;
    ensureIsLoaded?: boolean;
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
          })
        ) {
          scheduleFetch(fetchType);
        }
      })();

      return () => {
        effectState.cancelled = true;
      };
    }, [disableRefetchOnMount, disableRefetches, disabled]);

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
  });

  return {
    store,
    events,
    storeEvents,
    get invalidationWasTriggered() {
      return invalidationWasTriggered;
    },
    set invalidationWasTriggered(value: boolean) {
      invalidationWasTriggered = value;
    },
    scheduleFetch,
    awaitFetch,
    preloadPersistentStorage,
    invalidateData,
    updateState,
    reset,
    dispose,
    startMutation,
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
    useDocument,
    useListItemIsLoading,
    useListItemIsDeleted,
    useListItem,
    performMutation,
    onTransportReconnect,
  };
}
