import { act } from 'react';
import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import type { BrowserTabsTransportFactory } from '../../src/utils/browserTabsSync';
import type { BrowserTabsLeadershipTimings } from '../../src/utils/browserTabsLeadership';
import type { BlockWindowCloseHandler } from '../../src/utils/performMutation';
import { createServerMock, type FetchErrorConfig } from './serverMock';
import { getNextStoreId } from './browserTabsTestUtils';
import {
  simulateWindowBlur,
  simulateWindowFocus,
} from '../utils/genericTestUtils';
import {
  createActionTracker,
  createEmojiCyclers,
  createUITracker,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
} from './testEnvUtils';

export type DocumentStoreTestScenario<D> =
  /** App just opened, no data fetched yet. */
  | 'idle'
  /** App already opened before and data was fetched successfully. */
  | 'loaded'
  /** App started with data restored from local cache, pending server revalidation. */
  | { idleWithLocalCache: 'sameAsServer' | D }
  /** Data was loaded previously but is now outdated (server has newer data). */
  | { loadedWithStaleData: D };

export type DocumentStoreTestEnvOptions<D> = {
  id?: string;
  browserTabsTransportFactory?: BrowserTabsTransportFactory;
  browserTabsLeadershipTimings?: BrowserTabsLeadershipTimings;
  getWindowIsFocused?: () => boolean;
  dynamicRealtimeThrottleMs?: (params: {
    lastFetchDuration: number;
    windowIsNotFocused: boolean;
  }) => number;
  revalidateOnWindowFocus?: boolean | (() => boolean);
  baseCoalescingWindowMs?: number;
  lowPriorityThrottleMs?: number;
  mediumPriorityDelayMs?: number;
  testScenario?: DocumentStoreTestScenario<D>;
  usesRealTimeUpdates?: boolean;
  blockWindowClose?: BlockWindowCloseHandler;
};

export function createDocumentStoreTestEnv<D>(
  serverInitialData: D,
  {
    id = getNextStoreId('document'),
    browserTabsTransportFactory,
    browserTabsLeadershipTimings,
    getWindowIsFocused,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    baseCoalescingWindowMs = 10,
    lowPriorityThrottleMs = 200,
    mediumPriorityDelayMs,
    testScenario,
    usesRealTimeUpdates,
    blockWindowClose,
  }: DocumentStoreTestEnvOptions<D> = {},
) {
  const {
    actionsHistory,
    addAction,
    addTimelineComments,
    getTimelineString,
    getRelativeTime,
  } = createActionTracker();

  const { getMutationEmoji } = createEmojiCyclers();

  const { uiChanges, trackUIChanges } = createUITracker<
    number | string | undefined
  >(addAction, getRelativeTime, actionsHistory);

  const serverMock = createServerMock<D>(serverInitialData, addAction);

  const testOptions = resolveTestOptions(testScenario, serverInitialData);

  const documentStore = createDocumentStore<{ value: D }>({
    id,
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
    mediumPriorityDelayMs,
    blockWindowClose: blockWindowClose ?? null,
    '~test': {
      ...testOptions,
      getWindowIsFocused,
      browserTabsTransportFactory,
      browserTabsLeadershipTimings,
    },
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
  });

  if (usesRealTimeUpdates) {
    serverMock.wsEvents.on('data_changed', () => {
      addAction('received-ws-data-change-event');
      documentStore.invalidateData('realtimeUpdate');
    });
  }

  return {
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

            return {
              value: newValue,
            };
          },
          revalidateOnSuccess: withRevalidation,
        });
      });

      return mutationPromise;
    },
    get timelineString() {
      return getTimelineString();
    },
    serverMock,
    errorInNextFetch(error: FetchErrorConfig | string = 'Fetch error') {
      serverMock.setNextFetchError(error);
    },
    setNextFetchDurations(...durations: number[]) {
      serverMock.setFetchDurations(...durations);
    },
    emulateExternalRTU(value: D, fetchDuration?: number) {
      serverMock.setData(value);

      if (fetchDuration !== undefined) {
        serverMock.setFetchDurations(fetchDuration);
      }

      serverMock.wsEvents.emit('data_changed', undefined);
    },
    setServerData(value: D) {
      serverMock.setData(value);
    },
    simulateWindowFocus() {
      addAction('window-focused');
      simulateWindowFocus();
    },
    simulateWindowBlur() {
      addAction('window-blurred');
      simulateWindowBlur();
    },
  };
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

  if ('idleWithLocalCache' in scenario) {
    const cacheData =
      scenario.idleWithLocalCache === 'sameAsServer'
        ? serverInitialData
        : scenario.idleWithLocalCache;

    return {
      initialData: { value: cacheData },
      initialStatus: 'success',
      initialRefetchOnMount: 'lowPriority',
      initialLastFetchStartTime: Date.now() - 10_000,
    };
  }

  return {
    initialData: { value: scenario.loadedWithStaleData },
    initialStatus: 'success',
    initialLastFetchStartTime: Date.now() - 10_000,
  };
}
