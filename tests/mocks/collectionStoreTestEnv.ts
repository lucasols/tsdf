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

type CollectionTestPayload = string | { id: { id: string } };

export type CollectionStoreTestEnvOptions<D extends Record<string, unknown>> = {
  /** When true, disables initial data invalidation (default: false) */
  disableDataInvalidation?: boolean;
  /** Backward-compatible inverse of disableDataInvalidation */
  forceInitialDataInvalidation?: boolean;
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  baseCoalescingWindowMs?: number;
  mediumPriorityDelayMs?: number;
  /** Enable batch fetch mode - uses batchFetchFn instead of per-item fetchFn */
  useBatchFetch?: boolean;
  /** Max items per batch (only used when useBatchFetch is true) */
  maxBatchSize?: number;
  /** Simulate a loaded snapshot without initial invalidation and refetch on mount (as if component was already mounted) */
  useLoadedSnapshot?: boolean;
  initialData?: Record<string, D> | 'fromServer';
};

export function createCollectionStoreTestEnv<D extends Record<string, unknown>>(
  serverInitialData: Record<string, D>,
  {
    disableDataInvalidation,
    forceInitialDataInvalidation,
    dynamicRealtimeThrottleMs,
    baseCoalescingWindowMs = 10,
    mediumPriorityDelayMs,
    useBatchFetch,
    maxBatchSize,
    useLoadedSnapshot = false,
    initialData,
  }: CollectionStoreTestEnvOptions<D> = {},
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

  function normalizeItemId(itemId: CollectionTestPayload): string {
    return typeof itemId === 'string' ? itemId : itemId.id.id;
  }

  // Batch fetch function - delegates to serverTable.list
  const batchFetchFn = async (
    payloads: CollectionTestPayload[],
    signal: AbortSignal,
  ) => {
    const itemIdToPayload = new Map<string, CollectionTestPayload>();
    for (const payload of payloads) {
      const itemId = normalizeItemId(payload);
      if (!itemIdToPayload.has(itemId)) {
        itemIdToPayload.set(itemId, payload);
      }
    }

    const listResult = await serverTable.list(
      { itemIds: [...itemIdToPayload.keys()] },
      signal,
    );

    // Convert list result to Map format expected by collection store
    const results = new Map<CollectionTestPayload, CollectionTestItem<D> | Error>();
    for (const { itemId, data } of listResult.items) {
      const payload = itemIdToPayload.get(itemId) ?? itemId;
      if (data instanceof Error) {
        results.set(payload, data);
      } else {
        results.set(payload, { value: data });
      }
    }

    return results;
  };

  function mapInitialData(data: Record<string, D>) {
    return Object.entries(data).map(([itemId, value]) => ({
      payload: itemId,
      data: { value },
    }));
  }

  const shouldDisableDataInvalidation =
    forceInitialDataInvalidation === undefined ?
      (disableDataInvalidation ?? false)
    : !forceInitialDataInvalidation;

  function getInitialData() {
    if (useLoadedSnapshot) {
      return mapInitialData(serverInitialData);
    }

    if (forceInitialDataInvalidation) {
      if (initialData === 'fromServer') {
        return mapInitialData(serverInitialData);
      }

      if (initialData) {
        return mapInitialData(initialData);
      }

      return undefined;
    }

    return shouldDisableDataInvalidation ?
        mapInitialData(serverInitialData)
      : undefined;
  }

  const initialDataSnapshot = getInitialData();

  const collectionStore = createCollectionStore<
    CollectionTestItem<D>,
    CollectionTestPayload
  >({
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 200,
    baseCoalescingWindowMs,
    maxBatchSize: useBatchFetch ? maxBatchSize : undefined,
    fetchFn: async (payload, signal) => {
      const itemId = normalizeItemId(payload);
      const value = await serverTable.fetch(itemId, signal);
      return { value };
    },
    batchFetchFn: useBatchFetch ? batchFetchFn : undefined,
    disableInitialDataInvalidation:
      shouldDisableDataInvalidation || useLoadedSnapshot,
    getInitialData:
      initialDataSnapshot ? () => initialDataSnapshot
      : undefined,
    disableRefetchOnMount: shouldDisableDataInvalidation || useLoadedSnapshot,
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
    store: collectionStore.store,
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
