import { createCollectionStore } from '../../src/collectionStore';
import type { FetchType } from '../../src/requestScheduler';
import { createServerMock } from './serverMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createFetchCounter,
  createUITracker,
  logScheduleFetchResult,
  logSchedulerEvent,
} from './testEnvUtils';

export type CollectionTestItem<D> = { value: D };

export function createCollectionStoreTestEnv<D>(
  serverInitialData: Record<string, D>,
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

  // Create server mocks for each item
  const serverMocks = new Map<
    string,
    ReturnType<typeof createServerMock<D>>
  >();

  function getServerMock(itemId: string) {
    let mock = serverMocks.get(itemId);
    if (!mock) {
      const initialData = serverInitialData[itemId];
      if (initialData === undefined) {
        throw new Error(`No initial data for item: ${itemId}`);
      }
      mock = createServerMock<D>(initialData, (action, data, id) => {
        addAction(action, {
          actionValue: data,
          id,
          itemId,
        });
      });
      serverMocks.set(itemId, mock);
    }
    return mock;
  }

  // Initialize server mocks for all initial items
  for (const itemId of Object.keys(serverInitialData)) {
    getServerMock(itemId);
  }

  const nextFetchErrors = new Map<string, string>();

  // Per-item UI tracking
  const itemUIValues: Record<string, unknown> = {};
  const uiChanges: Array<Record<string, unknown>> = [];
  let uiInitialized = false;

  function trackItemUI(itemId: string, value: unknown) {
    if (itemUIValues[itemId] === value) return;

    itemUIValues[itemId] = value;
    uiChanges.push({ ...itemUIValues });

    const time = getRelativeTime();

    // Skip if this was already recorded by optimistic-ui-commit
    if (
      actionsHistory.some(
        (a) =>
          a.action === 'optimistic-ui-commit' &&
          a.time === time &&
          a.uiValue === value &&
          a.itemId === itemId,
      )
    ) {
      return;
    }

    addAction(!uiInitialized ? 'ui-initialized' : 'ui-changed', {
      uiValue: value,
      itemId,
    });
    uiInitialized = true;
  }

  const { trackUIChanges } = createUITracker<
    Record<string, number | 'error' | undefined>
  >(addAction, getRelativeTime, actionsHistory);

  const collectionStore = createCollectionStore<
    CollectionTestItem<D>,
    string,
    { error: string }
  >({
    errorNormalizer(exception) {
      return { error: exception.message };
    },
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs,
    fetchFn: async (itemId, signal) => {
      const fetchId = getFetchEmoji();
      addAction('>fetch-started', { id: fetchId, itemId });

      fetchCounter.incrementStarted();

      const errorForItem = nextFetchErrors.get(itemId);
      if (errorForItem) {
        fetchCounter.incrementFinished();
        nextFetchErrors.delete(itemId);
        addAction('<fetch-error', {
          actionValue: 'error',
          id: fetchId,
          itemId,
        });
        throw new Error(errorForItem);
      }

      const serverMock = getServerMock(itemId);
      const value = await serverMock.fetch();

      if (signal.aborted) {
        addAction('<fetch-aborted 🚫', { id: fetchId, itemId });
        throw new Error('Aborted');
      }

      fetchCounter.incrementFinished();
      addAction('<fetch-finished', {
        actionValue: value,
        id: fetchId,
        itemId,
      });
      return { value };
    },
    disableInitialDataInvalidation: !forceInitialDataInvalidation,
    getInitialData:
      !forceInitialDataInvalidation ?
        () =>
          Object.entries(serverInitialData).map(([itemId, value]) => ({
            payload: itemId,
            data: { value },
          }))
      : undefined,
    disableRefetchOnMount: !forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
  });

  // Set up RTU listeners for all items
  for (const [itemId, mock] of serverMocks) {
    mock.wsEvents.on('data_changed', () => {
      addAction('received-ws-data-change-event', { itemId });
      collectionStore.invalidateItem(itemId, 'realtimeUpdate');
    });
  }

  return {
    useItem: collectionStore.useItem,
    useMultipleItems: collectionStore.useMultipleItems,
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
    trackItemUI,
    addTimelineComments,
    scheduleFetch: (
      fetchType: FetchType,
      itemId: string,
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const result = collectionStore.scheduleFetch(fetchType, itemId, options);

      logScheduleFetchResult(result, (action) => addAction(action, { itemId }));

      return result;
    },
    scheduleFetchMultiple: (
      fetchType: FetchType,
      itemIds: string[],
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const results = collectionStore.scheduleFetch(fetchType, itemIds, options);

      for (let i = 0; i < itemIds.length; i++) {
        const itemId = itemIds[i];
        const result = results[i];
        if (itemId && result) {
          logScheduleFetchResult(result, (action) =>
            addAction(action, { itemId }),
          );
        }
      }

      return results;
    },
    performClientUpdateAction: (
      itemId: string,
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
      const serverMock = getServerMock(itemId);

      return collectionStore.performMutation(itemId, {
        optimisticUpdate:
          withOptimisticUpdate ?
            () => {
              collectionStore.updateItemState(itemId, (draft) => {
                draft.value = newValue;
              });
              addAction('optimistic-ui-commit', {
                uiValue: newValue,
                id: mutationId,
                itemId,
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
    getServerHistory(itemId: string) {
      return getServerMock(itemId).history;
    },
    errorInNextFetch(itemId: string, error = 'Fetch error') {
      nextFetchErrors.set(itemId, error);
    },
    setNextFetchDurations(itemId: string, ...durations: number[]) {
      getServerMock(itemId).setFetchDurations(...durations);
    },
    emulateExternalRTU(itemId: string, value: D, fetchDuration?: number) {
      const serverMock = getServerMock(itemId);
      serverMock.setData(value);

      if (fetchDuration !== undefined) {
        serverMock.setFetchDurations(fetchDuration);
      }

      serverMock.wsEvents.emit('data_changed', undefined);
    },
    invalidateItem: collectionStore.invalidateItem,
    getItemState: collectionStore.getItemState,
    addItemToState: collectionStore.addItemToState,
    deleteItemState: collectionStore.deleteItemState,
    updateItemState: collectionStore.updateItemState,
    /**
     * Add a new item to the server (for testing dynamic item creation)
     */
    addServerItem(itemId: string, value: D) {
      if (serverMocks.has(itemId)) {
        throw new Error(`Server item ${itemId} already exists`);
      }
      serverInitialData[itemId] = value;
      const mock = getServerMock(itemId);
      mock.wsEvents.on('data_changed', () => {
        addAction('received-ws-data-change-event', { itemId });
        collectionStore.invalidateItem(itemId, 'realtimeUpdate');
      });
    },
  };
}
