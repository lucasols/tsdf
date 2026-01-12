import { createDocumentStore } from '../../src/documentStore';
import type { FetchType } from '../../src/requestScheduler';
import { createServerMock, type FetchErrorConfig } from './serverMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createUITracker,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
} from './testEnvUtils';

export type DocumentStoreTestEnvOptions<D> = {
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  baseCoalescingWindowMs?: number;
  lowPriorityThrottleMs?: number;
  mediumPriorityDelayMs?: number;
  initialStateData?:
    | 'sameAsServer'
    | {
        value: D;
      }
    | null;
  disableInitialInvalidation?: boolean;
};

export function createDocumentStoreTestEnv<D>(
  serverInitialData: D,
  {
    initialStateData = null,
    disableInitialInvalidation = false,
    dynamicRealtimeThrottleMs,
    baseCoalescingWindowMs = 10,
    lowPriorityThrottleMs = 200,
    mediumPriorityDelayMs,
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

  const resolvedInitialState =
    initialStateData === 'sameAsServer' ?
      { value: serverInitialData }
    : initialStateData;

  const documentStore = createDocumentStore<{ value: D }>({
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    fetchFn: async (signal) => {
      const value = await serverMock.fetch(signal);
      return { value };
    },
    disableInitialInvalidation,
    getInitialData:
      resolvedInitialState ? () => resolvedInitialState : undefined,
    disableRefetchOnMount: disableInitialInvalidation,
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
  };
}
