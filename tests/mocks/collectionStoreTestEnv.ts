import {
  createCollectionStore,
  type CollectionInitialStateItem,
} from '../../src/collectionStore/collectionStore';
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

export type CollectionStoreTestScenario<D extends Record<string, unknown>> =
  /** App just opened, no data fetched yet. */
  | 'idle'
  /** App already opened before and data was fetched successfully. */
  | 'loaded'
  /** App started with data restored from local cache, pending server revalidation. */
  | { idleWithLocalCache: 'sameAsServer' | Record<string, D> }
  /** Data was loaded previously but is now outdated (server has newer data). */
  | { loadedWithStaleData: Record<string, D> };

export type CollectionStoreTestEnvOptions<D extends Record<string, unknown>> = {
  dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
  baseCoalescingWindowMs?: number;
  mediumPriorityDelayMs?: number;
  /** Enable batch fetch mode - uses batchFetchFn instead of per-item fetchFn */
  useBatchFetch?: boolean;
  /** Max items per batch (only used when useBatchFetch is true) */
  maxBatchSize?: number;
  testScenario?: CollectionStoreTestScenario<D>;
  usesRealTimeUpdates?: boolean;
};

export function createCollectionStoreTestEnv<D extends Record<string, unknown>>(
  serverInitialData: Record<string, D>,
  {
    dynamicRealtimeThrottleMs,
    baseCoalescingWindowMs = 10,
    mediumPriorityDelayMs,
    useBatchFetch,
    maxBatchSize,
    testScenario,
    usesRealTimeUpdates,
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
    const results = new Map<
      CollectionTestPayload,
      CollectionTestItem<D> | Error
    >();
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

  const testOptions = resolveTestOptions(testScenario, serverInitialData);

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
    usesRealTimeUpdates,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    '~test': testOptions,
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
  });

  if (usesRealTimeUpdates) {
    serverTable.wsEvents.on('data_changed', (event) => {
      addAction('received-ws-data-change-event', {
        itemId: event.payload.itemId,
      });
      collectionStore.invalidateItem(event.payload.itemId, 'realtimeUpdate');
    });
  }

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
        optimisticUpdate: withOptimisticUpdate
          ? () => {
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

function mapInitialData<D extends Record<string, unknown>>(
  data: Record<string, D>,
): CollectionInitialStateItem<CollectionTestPayload, CollectionTestItem<D>>[] {
  return Object.entries(data).map(([itemId, value]) => ({
    payload: itemId,
    data: { value },
  }));
}

function resolveTestOptions<D extends Record<string, unknown>>(
  scenario: CollectionStoreTestScenario<D> | undefined,
  serverInitialData: Record<string, D>,
):
  | {
      initialRefetchOnMount?: FetchType;
      initialStatus?: 'success';
      initialData?: CollectionInitialStateItem<
        CollectionTestPayload,
        CollectionTestItem<D>
      >[];
      initialLastFetchStartTime?: number;
    }
  | undefined {
  if (!scenario || scenario === 'idle') {
    return undefined;
  }

  if (scenario === 'loaded') {
    return {
      initialData: mapInitialData(serverInitialData),
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
      initialData: mapInitialData(cacheData),
      initialStatus: 'success',
      initialRefetchOnMount: 'lowPriority',
      initialLastFetchStartTime: Date.now() - 10_000,
    };
  }

  return {
    initialData: mapInitialData(scenario.loadedWithStaleData),
    initialStatus: 'success',
    initialLastFetchStartTime: Date.now() - 10_000,
  };
}
