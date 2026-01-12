import { createCollectionStore } from '../../src/collectionStore/collectionStore';
import type { FetchType } from '../../src/requestScheduler';
import { createServerTableMock } from './serverTableMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createUITracker,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
} from './testEnvUtils';

export type CollectionTestItem<D> = { value: D };

export function createCollectionStoreTestEnv<D extends Record<string, unknown>>(
  serverInitialData: Record<string, D>,
  {
    forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
    baseCoalescingWindowMs = 10,
    mediumPriorityDelayMs,
    useBatchFetch,
    maxBatchSize,
    useLoadedSnapshot = false,
  }: {
    forceInitialDataInvalidation?: boolean;
    dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
    baseCoalescingWindowMs?: number;
    mediumPriorityDelayMs?: number;
    /** Enable batch fetch mode - uses batchFetchFn instead of per-item fetchFn */
    useBatchFetch?: boolean;
    /** Max items per batch (only used when useBatchFetch is true) */
    maxBatchSize?: number;
    /* simulate a loaded snapshot without initial invalidation and refetch on mount (as if component was already mounted) */
    useLoadedSnapshot?: boolean;
  } = {},
) {
  const {
    actionsHistory,
    addAction,
    addTimelineComments,
    getTimelineString,
    getRelativeTime,
  } = createActionTracker();

  const { getMutationEmoji } = createEmojiCyclers();

  const serverTable = createServerTableMock<D>(serverInitialData, addAction);

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
          a.action === 'optimistic-ui-commit'
          && a.time === time
          && a.uiValue === value
          && a.itemId === itemId,
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

  // Batch fetch function - delegates to serverTable.list
  const batchFetchFn = async (itemIds: string[], signal: AbortSignal) => {
    const listResult = await serverTable.list({ itemIds }, signal);

    // Convert list result to Map format expected by collection store
    const results = new Map<string, CollectionTestItem<D> | Error>();
    for (const { itemId, data } of listResult.items) {
      if (data instanceof Error) {
        results.set(itemId, data);
      } else {
        results.set(itemId, { value: data });
      }
    }

    return results;
  };

  const collectionStore = createCollectionStore<CollectionTestItem<D>, string>({
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs,
    maxBatchSize: useBatchFetch ? maxBatchSize : undefined,
    fetchFn: async (itemId: string, signal: AbortSignal) => {
      const value = await serverTable.fetch(itemId, signal);
      return { value };
    },
    batchFetchFn: useBatchFetch ? batchFetchFn : undefined,
    disableInitialDataInvalidation: !forceInitialDataInvalidation || useLoadedSnapshot,
    getInitialData:
      !forceInitialDataInvalidation || useLoadedSnapshot ?
        () =>
          Object.entries(serverInitialData).map(([itemId, value]) => ({
            payload: itemId,
            data: { value },
          }))
      : undefined,
    disableRefetchOnMount: !forceInitialDataInvalidation || useLoadedSnapshot,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
  });

  // Set up RTU listener
  serverTable.wsEvents.on('data_changed', (event) => {
    addAction('received-ws-data-change-event', {
      itemId: event.payload.itemId,
    });
    collectionStore.invalidateItem(event.payload.itemId, 'realtimeUpdate');
  });

  return {
    apiStore: collectionStore,
    serverTable,
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
          const result = await serverTable.emulateClientMutation(
            itemId,
            newValue,
            {
              duration,
              triggerRTUEvent: triggerRTU,
              addServerDataChangeAction,
              mutationId,
            },
          );
          return { value: result };
        },
        revalidateOnSuccess: withRevalidation,
      });
    },
    get timelineString() {
      return getTimelineString();
    },
  };
}
