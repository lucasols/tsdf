import { act } from 'react';
import type { __LEGIT_ANY__ } from '@ls-stack/utils/saferTyping';
import {
  createDocumentStore,
  type DocumentBrowserTabsMessage,
} from '../../src/documentStore';
import type { AnyOfflineOperationDefinition } from '../../src/persistentStorage/offline/types';
import type {
  DocumentPersistentStorageConfig,
  StorageAdapter,
} from '../../src/persistentStorage/types';
import type { FetchType } from '../../src/requestScheduler';
import type { BrowserTabsLeadershipTimings } from '../../src/utils/browserTabsLeadership';
import type { BrowserTabsTransportFactory } from '../../src/utils/browserTabsSync';
import type { BlockWindowCloseHandler } from '../../src/utils/performMutation';
import {
  getNextStoreId,
  registerMockStoreInstance,
} from './browserTabsTestUtils';
import {
  createServerMock,
  type FetchErrorConfig,
  type SharedServerMockState,
} from './serverMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createUITracker,
  getDefaultLowPriorityThrottleMs,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
  TEST_INITIAL_TIME,
} from './testEnvUtils';

export type DocumentStoreTestScenario<D> =
  /** App just opened, no data fetched yet. */
  | 'idle'
  /**
   * App already opened before and data was fetched successfully.
   * Using the default lowPriorityThrottleMs (200ms) it will still trigger a refetch on mount as initial system time is set to 10 seconds in the past.
   */
  | 'loaded'
  /** Data was loaded previously but is now outdated (server has newer data). */
  | { loadedWithStaleData: D };

type TestDocumentOfflineOperationsRegistry<D> = Record<
  string,
  AnyOfflineOperationDefinition
> &
  ([D] extends [never] ? never : unknown);

type TestDocumentOfflineOperationsConfig<D> =
  TestDocumentOfflineOperationsRegistry<D> | null;

export type DocumentStoreTestEnvOptions<
  D,
  TOfflineOperations extends TestDocumentOfflineOperationsConfig<D> = null,
  StorageState = unknown,
> = {
  id?: string;
  getSessionKey?: () => string | false;
  sharedServerState?: SharedServerMockState<D>;
  browserTabsTransportFactory?: BrowserTabsTransportFactory;
  testBrowserTabId?: string;
  browserTabsLeadershipTimings?: BrowserTabsLeadershipTimings;
  /** Binds this env to a focus coordinator. Provides per-tab `getWindowIsFocused` and `onWindowFocus`/`onWindowBlur` for scoped focus events. */
  bindFocusController?: {
    getWindowIsFocused: () => boolean;
    onWindowFocus: (handler: () => void) => () => void;
    onWindowBlur: (handler: () => void) => () => void;
  };
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  transportReconnectCooldownMs?: number;
  baseCoalescingWindowMs?: number;
  lowPriorityThrottleMs?: number;
  mediumPriorityDelayMs?: number;
  testScenario?: DocumentStoreTestScenario<D>;
  usesRealTimeUpdates?: boolean;
  blockWindowClose?: BlockWindowCloseHandler;
  persistentStorage?: DocumentPersistentStorageConfig<
    { value: D },
    StorageState,
    TOfflineOperations
  >;
  storageAdapter?: StorageAdapter;
  __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__?: boolean;
};

export function createDocumentStoreTestEnv<
  D,
  TOfflineOperations extends TestDocumentOfflineOperationsConfig<D> = null,
  StorageState = unknown,
>(
  serverInitialData: D,
  {
    id = getNextStoreId('document'),
    getSessionKey = () => 'test-session',
    sharedServerState,
    browserTabsTransportFactory,
    testBrowserTabId,
    browserTabsLeadershipTimings,
    bindFocusController,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs,
    baseCoalescingWindowMs = 10,
    lowPriorityThrottleMs = getDefaultLowPriorityThrottleMs(),
    mediumPriorityDelayMs,
    testScenario,
    usesRealTimeUpdates,
    blockWindowClose,
    persistentStorage,
    storageAdapter,
    __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__,
  }: DocumentStoreTestEnvOptions<D, TOfflineOperations, StorageState> = {},
) {
  if (!__DANGEROUS_IGNORE_INITIAL_TIME_CHECK__) {
    if (Math.abs(Date.now() - TEST_INITIAL_TIME) > 1_000 * 60 * 60 * 24) {
      throw new Error(
        'Current time is too far from TEST_INITIAL_TIME. If this test REALLY needs to run with a different time, set it the test. As last resort, set __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__ to true.',
      );
    }
  }

  const {
    actionsHistory,
    addAction,
    addTimelineComments,
    getTimelineString,
    getRelativeTime,
    clearTimeline: clearActionTimeline,
  } = createActionTracker();

  const { getMutationEmoji } = createEmojiCyclers();

  const { uiChanges, trackUIChanges } = createUITracker<
    number | string | undefined
  >(addAction, getRelativeTime, actionsHistory);

  const serverMock = createServerMock<D>(
    serverInitialData,
    addAction,
    sharedServerState,
  );

  const testOptions = resolveTestOptions(testScenario, serverInitialData);
  const resolvedPersistentStorage =
    persistentStorage && storageAdapter
      ? { ...persistentStorage, adapter: storageAdapter }
      : persistentStorage;

  const unregisterMockStoreInstance =
    testBrowserTabId === undefined
      ? () => {}
      : registerMockStoreInstance({
          storeId: id,
          storeType: 'document',
          testBrowserTabId,
        });

  let documentStore: ReturnType<
    typeof createDocumentStore<{ value: D }, TOfflineOperations, StorageState>
  >;

  try {
    documentStore = createDocumentStore<
      { value: D },
      TOfflineOperations,
      StorageState
    >({
      id,
      getSessionKey,
      errorNormalizer: normalizeError,
      lowPriorityThrottleMs,
      baseCoalescingWindowMs,
      fetchFn: async (signal) => {
        const value = await serverMock.fetch(signal);
        return { value };
      },
      usesRealTimeUpdates,
      dynamicRealtimeThrottleMs,
      revalidateOnWindowFocus,
      transportReconnectCooldownMs,
      mediumPriorityDelayMs,
      blockWindowClose: blockWindowClose ?? null,
      persistentStorage: resolvedPersistentStorage,
      '~test': {
        ...testOptions,
        getWindowIsFocused: bindFocusController?.getWindowIsFocused,
        onWindowFocus: bindFocusController
          ? (handler: () => void) => {
              return bindFocusController.onWindowFocus(handler);
            }
          : undefined,
        onWindowFocusChange: bindFocusController
          ? (handler: () => void) => {
              const cleanupFocus = bindFocusController.onWindowFocus(handler);
              const cleanupBlur = bindFocusController.onWindowBlur(handler);
              return () => {
                cleanupFocus();
                cleanupBlur();
              };
            }
          : undefined,
        browserTabsTransportFactory,
        browserTabsLeadershipTimings,
        onReceiveRemoteMsg: (
          message: DocumentBrowserTabsMessage<{ value: D }>,
        ) => {
          if (message.kind === 'document-snapshot') {
            addAction(`<${message.consistency}-snapshot-received`, {
              actionValue: message.data?.value,
            });
          }
        },
      },
      onSchedulerEvent: (event, data) => {
        logSchedulerEvent(event, addAction, data);
      },
    });
  } catch (error) {
    unregisterMockStoreInstance();
    throw error;
  }

  if (usesRealTimeUpdates) {
    serverMock.wsEvents.on('data_changed', () => {
      addAction('received-ws-data-change-event');
      documentStore.invalidateData('realtimeUpdate');
    });
  }

  const env = {
    apiStore: documentStore,
    store: documentStore.store,
    get uiChanges() {
      return uiChanges;
    },
    get actions() {
      return actionsHistory;
    },
    trackUIChanges,
    addTimelineComments,
    scheduleFetch: (
      fetchType: FetchType,
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const result = documentStore.scheduleFetch(fetchType, options);

      logScheduleFetchResult(result, addAction);

      return result;
    },
    /** default duration: 1200ms */
    performClientUpdateAction: (
      newValue: D,
      {
        withRevalidation,
        withOptimisticUpdate,
        duration,
        triggerRTU,
        addServerDataChangeAction,
        error,
        updateStateWithMutationResult,
      }: {
        withRevalidation?: boolean;
        withOptimisticUpdate?: boolean;
        duration?: number;
        triggerRTU?: boolean;
        addServerDataChangeAction?: boolean;
        error?: string;
        updateStateWithMutationResult?: boolean;
      } = {},
    ) => {
      const mutationId = getMutationEmoji();
      let mutationPromise!: ReturnType<typeof documentStore.performMutation>;

      act(() => {
        mutationPromise = documentStore.performMutation({
          optimisticUpdate: withOptimisticUpdate
            ? () => {
                documentStore.updateState((draft) => {
                  draft.value = newValue;
                });
                addAction('optimistic-ui-commit', {
                  uiValue: newValue,
                  id: mutationId,
                });
              }
            : undefined,
          mutation: async ({ updateState }) => {
            if (error) {
              addAction('<mutation-error', {
                actionValue: error,
                id: mutationId,
              });
              throw new Error(error);
            }

            await serverMock.mutateData(newValue, {
              duration,
              triggerRTUEvent: triggerRTU,
              addServerDataChangeAction,
              mutationId,
            });

            if (updateStateWithMutationResult) {
              updateState((draft) => {
                draft.value = newValue;
              });
            }

            return { value: newValue };
          },
          revalidateOnSuccess: withRevalidation,
        });
      });

      return mutationPromise;
    },
    get timelineString() {
      return getTimelineString();
    },
    clearTimeline() {
      clearActionTimeline();
    },
    serverMock,
    errorInNextFetch(error: FetchErrorConfig | string = 'Fetch error') {
      serverMock.setNextFetchError(error);
    },
    setNextFetchDurations(...durations: number[]) {
      serverMock.setFetchDurations(...durations);
    },
    emulateExternalRTU(value: D) {
      serverMock.setData(value);

      serverMock.wsEvents.emit('data_changed', undefined);
    },
    setServerData(value: D) {
      serverMock.setData(value);
    },
  };

  bindFocusController?.onWindowFocus(() => {
    addAction('👁 window-focused');
  });

  bindFocusController?.onWindowBlur(() => {
    addAction('🔕 window-blurred');
  });

  return env;
}

function resolveTestOptions<D>(
  scenario: DocumentStoreTestScenario<D> | undefined,
  serverInitialData: D,
):
  | {
      initialRefetchOnMount?: FetchType;
      initialStatus?: 'idle' | 'success';
      initialData?: { value: D };
      initialLastFetchStartTime?: number;
    }
  | undefined {
  if (!scenario || scenario === 'idle') {
    return undefined;
  }

  if (scenario === 'loaded') {
    return {
      initialData: { value: serverInitialData },
      initialStatus: 'success',
      initialLastFetchStartTime: Date.now() - 10_000,
    };
  }

  return {
    initialData: { value: scenario.loadedWithStaleData },
    initialStatus: 'success',
    initialLastFetchStartTime: Date.now() - 10_000,
  };
}
