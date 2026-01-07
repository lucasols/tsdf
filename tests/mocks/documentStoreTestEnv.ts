import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import type { StoreError } from '../../src/storeShared';
import { createServerMock } from './serverMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createFetchCounter,
  createUITracker,
  FetchError,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
} from './testEnvUtils';

export function createDocumentStoreTestEnv<D>(
  serverInitialData: D,
  {
    forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
    baseCoalescingWindowMs = 10,
    mediumPriorityDelayMs,
  }: {
    forceInitialDataInvalidation?: boolean;
    dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
    baseCoalescingWindowMs?: number;
    mediumPriorityDelayMs?: number;
  } = {},
) {
  const {
    actionsHistory,
    addAction,
    addTimelineComments,
    getTimelineString,
    getRelativeTime,
  } = createActionTracker();

  const { getFetchEmoji, getMutationEmoji } = createEmojiCyclers();
  const fetchCounter = createFetchCounter();

  let nextFetchError: {
    message: string;
    path?: string;
    method?: StoreError['method'];
    code?: number;
  } | null = null;

  const { uiChanges, trackUIChanges } = createUITracker<
    number | string | undefined
  >(addAction, getRelativeTime, actionsHistory);

  const serverMock = createServerMock<D>(
    serverInitialData,
    (action, data, id) => {
      addAction(action, {
        actionValue: data,
        id,
      });
    },
  );

  const documentStore = createDocumentStore<{ value: D }>({
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs,
    fetchFn: async (signal) => {
      const fetchId = getFetchEmoji();
      addAction(`>fetch-started`, { id: fetchId });

      fetchCounter.incrementStarted();

      if (nextFetchError) {
        fetchCounter.incrementFinished();
        const errorConfig = nextFetchError;
        nextFetchError = null;
        addAction(`<fetch-error`, { actionValue: 'error', id: fetchId });

        if (errorConfig.path) {
          throw new FetchError(errorConfig.message, {
            path: errorConfig.path,
            method: errorConfig.method,
            code: errorConfig.code,
          });
        }
        throw new Error(errorConfig.message);
      }

      const value = await serverMock.fetch();

      if (signal.aborted) {
        addAction(`<fetch-aborted 🚫`, { id: fetchId });
        throw new Error('Aborted');
      }

      fetchCounter.incrementFinished();
      addAction(`<fetch-finished`, { actionValue: value, id: fetchId });
      return { value };
    },
    disableInitialDataInvalidation: !forceInitialDataInvalidation,
    getInitialData:
      !forceInitialDataInvalidation ?
        () => ({ value: serverInitialData })
      : undefined,
    disableRefetchOnMount: !forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
  });

  serverMock.wsEvents.on('data_changed', () => {
    addAction('received-ws-data-change-event');
    documentStore.invalidateData('realtimeUpdate');
  });

  return {
    store: documentStore.store,
    invalidateData: documentStore.invalidateData,
    awaitFetch: documentStore.awaitFetch,
    useDocument: documentStore.useDocument,
    get numOfFinishedFetches() {
      return fetchCounter.numOfFinishedFetches;
    },
    get numOfStartedFetches() {
      return fetchCounter.numOfStartedFetches;
    },
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
      }: {
        withRevalidation?: boolean;
        withOptimisticUpdate?: boolean;
        duration?: number;
        triggerRTU?: boolean;
        addServerDataChangeAction?: boolean;
      } = {},
    ) => {
      const mutationId = getMutationEmoji();

      return documentStore.performMutation({
        optimisticUpdate:
          withOptimisticUpdate ?
            () => {
              documentStore.updateState((draft) => {
                draft.value = newValue;
              });
              addAction('optimistic-ui-commit', {
                uiValue: newValue,
                id: mutationId,
              });
            }
          : undefined,
        mutation: async () => {
          return {
            value: await serverMock.mutateData(newValue, {
              duration,
              triggerRTUEvent: triggerRTU,
              addServerDataChangeAction,
              mutationId,
            }),
          };
        },
        revalidateOnSuccess: withRevalidation,
      });
    },
    get timelineString() {
      return getTimelineString();
    },
    get serverHistory() {
      return serverMock.history;
    },
    errorInNextFetch(
      error:
        | string
        | {
            message: string;
            path?: string;
            method?: StoreError['method'];
            code?: number;
          } = 'Fetch error',
    ) {
      nextFetchError = typeof error === 'string' ? { message: error } : error;
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
  };
}
