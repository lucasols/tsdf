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
import { useCallback, useContext, useEffect } from 'react';
import { Result, unknownToError, type Result as ResultType } from 't-result';
import { Store, useSubscribeToStore } from 't-state';
import { useListItem as useListItemBase } from './hooks/useListItem';
import { useListItemIsDeleted as useListItemIsDeletedBase } from './hooks/useListItemIsDeleted';
import { useListItemIsLoading as useListItemIsLoadingBase } from './hooks/useListItemIsLoading';
import { IsOffScreenContext } from './isOffScreenContext';
import { setupDocumentPersistence } from './persistentStorage/documentStorePersistence';
import type {
  DocumentOfflineOperationsRegistry,
  OfflineMutationDescriptor,
} from './persistentStorage/offline/types';
import type {
  DocumentPersistentStorageConfig,
} from './persistentStorage/types';
import {
  BatchRequest,
  FetchContext,
  FetchType,
  getAutoIncrementId,
  RequestScheduler,
  RequestSchedulerEvents,
  ScheduleFetchOptions,
  ScheduleFetchResults,
} from './requestScheduler';
import {
  runOfflineAwareFetch,
  offlineConnectivityError,
} from './persistentStorage/offline/fetchRuntime';
import {
  createOfflineStoreController,
  initializeOfflineStoreController,
  offlineSessionUnavailableError,
} from './persistentStorage/offline/storeController';
import { getOfflineEntityMetadata } from './persistentStorage/offline/entityMetadata';
import { useOfflineStoreEntities } from './persistentStorage/offline/sessionCoordinator';
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
  fetchTypePriority,
  StoreFetchError,
  TSDFStatus,
  ValidStoreState,
  type StoreError,
} from './utils/storeShared';
import { shouldScheduleAutomaticFetch } from './utils/automaticFetchPolicy';
import { useEnsureIsLoaded } from './utils/useEnsureIsLoaded';
import { createProtectedStorageKey } from './persistentStorage/persistentStorageManager';

export type DocumentStatus = 'idle' | TSDFStatus;

export type TSDFUseDocumentReturn<Selected> = {
  status: DocumentStatus;
  data: Selected;
  error: StoreError | null;
  isLoading: boolean;
  isPendingOfflineSync: boolean;
  pendingOfflineMutations: number;
  hasOfflineConflict: boolean;
};

export type DocumentStoreState<State extends ValidStoreState> = {
  data: State | null;
  error: StoreError | null;
  status: DocumentStatus;
  refetchOnMount: false | FetchType;
};

type DocumentStoreEvents = { invalidateData: FetchType };

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

export type DocumentStoreOptions<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsRegistry<State> =
    DocumentOfflineOperationsRegistry<State>,
> = {
  debugName?: string;
  /** Stable id shared by the same logical document store across browser tabs. */
  id: string;
  /**
   * Returns the current authenticated session / tenant key used to scope
   * browser-tabs sync. Return `false` to disable browser-tabs sync when no
   * account is loaded.
   */
  getSessionKey: () => string | false;
  fetchFn: (signal: AbortSignal) => Promise<State>;
  errorNormalizer: (exception: Error) => StoreError;
  lowPriorityThrottleMs: number;
  baseCoalescingWindowMs: number;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  mediumPriorityDelayMs?: number;
  onSchedulerEvent?: (event: RequestSchedulerEvents) => void;
  onMutationError?: (
    error: unknown,
    options: { dontShowToast?: boolean },
  ) => void;
  blockWindowClose: BlockWindowCloseHandler | null;
  usesRealTimeUpdates?: boolean;
  /** Opt-in persistent storage configuration. When provided, cached data is loaded
   * from storage on first read and saved back on successful fetches.
   * Session scoping always reuses this store's `getSessionKey`. */
  persistentStorage?: DocumentPersistentStorageConfig<
    State,
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
  };
};

export type DocumentStore<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsRegistry<State> =
    DocumentOfflineOperationsRegistry<State>,
> = ReturnType<typeof createDocumentStore<State, TOfflineOperations>>;

// Constant requestId for document store (single-item mode)
const DOC_REQUEST_ID = '_doc';
const DOC_TARGET_KEY = 'document' as const;

export function createDocumentStore<
  State extends ValidStoreState,
  TOfflineOperations extends DocumentOfflineOperationsRegistry<State> =
    DocumentOfflineOperationsRegistry<State>,
>({
  debugName,
  id,
  getSessionKey,
  fetchFn,
  errorNormalizer,
  lowPriorityThrottleMs,
  baseCoalescingWindowMs,
  dynamicRealtimeThrottleMs,
  revalidateOnWindowFocus,
  mediumPriorityDelayMs,
  onSchedulerEvent,
  onMutationError,
  blockWindowClose,
  usesRealTimeUpdates = false,
  persistentStorage: persistentStorageConfig,
  '~test': testOptions,
}: DocumentStoreOptions<State, TOfflineOperations>) {
  let invalidationWasTriggered = false;
  let remoteApplyDepth = 0;
  let currentBroadcastConsistency: SnapshotConsistency = 'confirmed';
  let lastDocumentSyncVersion: BrowserTabsSyncVersion | undefined;

  let initialData: State | null = null;
  let initialRefetchOnMount: FetchType | false = false;
  let initialStatus: DocumentStatus = 'idle';
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
    ? setupDocumentPersistence({ ...persistentStorageConfig, getSessionKey })
    : null;

  const offlineController = persistentStorageConfig?.offlineMode
    ? createOfflineStoreController({
        storeName: persistentStorageConfig.storeName,
        storeType: 'document',
        getSessionKey,
        onPersistentStorageError:
          persistentStorageConfig.onPersistentStorageError,
        adapter: persistentStorageConfig.adapter,
        offlineMode: persistentStorageConfig.offlineMode,
        storeAdapter: {
          getHelpers: () => ({
            getState: () => store.state.data,
            updateState,
            invalidateData: () => invalidateData(),
          }),
          getEntityRefs: () => [
            { entityKey: DOC_TARGET_KEY, entityKind: 'document' },
          ],
          getProtectedCacheKeys: () => {
            const sessionKey = getSessionKey();
            if (sessionKey === false) return [];
            return [
              createProtectedStorageKey({
                sessionKey,
                storeName: persistentStorageConfig.storeName,
                kind: 'document',
                key: 'document',
              }),
            ];
          },
          applyPendingEntity: ({ pendingEntity }) => {
            if (!pendingEntity || typeof pendingEntity !== 'object') return;
            updateState((draft) => Object.assign(draft, pendingEntity));
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
        getSessionKey,
        onMessage: handleRemoteMessage,
        onSessionChange() {
          lastDocumentSyncVersion = undefined;
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
            { error: offlineConnectivityError, status: 'error' },
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
    const result = await scheduler.awaitFetch(DOC_REQUEST_ID, null, options);

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

    if (store.state.error) {
      return {
        data: null,
        error: new StoreFetchError(store.state.error, 'fetch'),
      };
    }

    if (!store.state.data) {
      return {
        data: null,
        error: new StoreFetchError(
          { code: 404, id: 'not-found', message: 'Not found' },
          'fetch',
        ),
      };
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
   * - If the window is focused, invalidates immediately with `realtimeUpdate` priority.
   * - If the window is **not** focused, defers invalidation until the next window
   *   focus event. Multiple calls while unfocused are coalesced (only one
   *   invalidation fires on focus).
   */
  function onTransportReconnect(): void {
    focusLifecycle.onTransportReconnect();
  }

  function reset(): void {
    scheduler.reset();
    lastDocumentSyncVersion = undefined;
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

  function startMutation(): () => boolean {
    return scheduler.startMutation(DOC_REQUEST_ID);
  }

  async function performMutation<T>({
    optimisticUpdate,
    mutation,
    debounce,
    dontShowErrorToast,
    revalidateOnSuccess,
    offline,
  }: {
    optimisticUpdate?: (currentState: State | null) => void | boolean;
    debounce?: { context: string; payload: __LEGIT_ANY__; ms: number };
    dontShowErrorToast?: boolean;
    mutation: (ctx: {
      updateState: typeof updateState;
      currentState: State | null;
    }) => Promise<T>;
    revalidateOnSuccess?: boolean;
    /**
     * When provided, the mutation is durably queued and replayed by the offline
     * sync controller. The immediate result only reflects queue persistence.
     */
    offline?: OfflineMutationDescriptor<TOfflineOperations>;
  }): Promise<ResultType<Awaited<T>, StoreError | true>> {
    if (offline && offlineController && !offlineController.canQueueMutation()) {
      return Result.err(offlineSessionUnavailableError);
    }

    const mutationId = getAutoIncrementId();
    storeEvents.emit('mutationStart', { mutationId });
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
      mutation: async () => {
        if (offline && offlineController) {
          await offlineController.queueMutation({
            operationName: offline.operation,
            input: offline.input,
          });
          return __LEGIT_CAST__<Awaited<T>, undefined>(undefined);
        }

        return mutation({ updateState, currentState: store.state.data });
      },
      onSuccess: () => {
        if (revalidateOnSuccess && !offline) {
          invalidateData();
        }
      },
      onError: (exception) => {
        if (onMutationError) {
          onMutationError(exception, { dontShowToast: dontShowErrorToast });
        }

        invalidateData();

        return errorNormalizer(unknownToError(exception));
      },
    });

    storeEvents.emit('mutationEnd', { mutationId, success: result.ok });

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
      sessionKey: getSessionKey(),
      inactiveScope: id,
      storeName: persistentStorageConfig?.storeName,
    });
    const isOffScreenFromContext = useContext(IsOffScreenContext);
    const disabled = disabledProp ?? isOffScreenProp ?? isOffScreenFromContext;
    const returnIdleStatus = returnIdleStatusProp ?? !!disabled;
    const storeStateSelector = useCallback(
      (state: DocumentStoreState<State>): TSDFUseDocumentReturn<Selected> => {
        const { error } = state;

        const data = selector
          ? selector(state.data)
          : __LEGIT_CAST__<Selected, State | null>(state.data);
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
          ...getOfflineEntityMetadata(
            offlineEntities.find(
              (entity) => entity.entityKey === DOC_TARGET_KEY,
            ),
          ),
        };
      },
      [offlineEntities, selector, returnIdleStatus, returnRefetchingStatus],
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
    startMutation,
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
    useDocument,
    useListItemIsLoading,
    useListItemIsDeleted,
    useListItem,
    performMutation,
    onTransportReconnect,
  };
}
