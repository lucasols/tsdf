import { act } from 'react';
import {
  createCollectionStore,
  type CollectionBrowserTabsMessage,
  type CollectionInitialStateItem,
} from '../../src/collectionStore/collectionStore';
import type { FetchType } from '../../src/requestScheduler';
import type { BrowserTabsLeadershipTimings } from '../../src/utils/browserTabsLeadership';
import type { BrowserTabsTransportFactory } from '../../src/utils/browserTabsSync';
import type { BlockWindowCloseHandler } from '../../src/utils/performMutation';
import type { CollectionPersistentStorageConfig } from '../../src/persistentStorage/types';
import { getNextStoreId } from './browserTabsTestUtils';
import {
  createServerTableMock,
  type ServerTableSharedState,
} from './serverTableMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createPerItemUITracker,
  createUITracker,
  getDefaultLowPriorityThrottleMs,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
  TEST_INITIAL_TIME,
} from './testEnvUtils';

export type CollectionTestItem<D> = { value: D };

export type CollectionStoreTestScenario<D extends Record<string, unknown>> =
  /** App just opened, no data fetched yet. */
  | 'idle'
  /**
   * App already opened before and data was fetched successfully.
   * Using the default lowPriorityThrottleMs (200ms) it will still trigger a refetch on mount as initial system time is set to 10 seconds in the past.
   */
  | 'loaded'
  /** App started with data restored from local cache, pending server revalidation. */
  | { idleWithLocalCache: 'sameAsServer' | Record<string, D> }
  /** Data was loaded previously but is now outdated (server has newer data). */
  | { loadedWithStaleData: Record<string, D> };

export type CollectionStoreTestEnvOptions<D extends Record<string, unknown>> = {
  id?: string;
  getSessionKey?: () => string | false;
  sharedServerTableState?: ServerTableSharedState<D>;
  browserTabsTransportFactory?: BrowserTabsTransportFactory;
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
  baseCoalescingWindowMs?: number;
  lowPriorityThrottleMs?: number;
  mediumPriorityDelayMs?: number;
  /** Enable batch fetch mode - uses batchFetchFn instead of per-item fetchFn */
  useBatchFetch?: boolean;
  /** Max items per batch (only used when useBatchFetch is true) */
  maxBatchSize?: number;
  /** Optional function to group batch fetches by key */
  getItemsBatchKey?: (payload: string) => string | false;
  testScenario?: CollectionStoreTestScenario<D>;
  usesRealTimeUpdates?: boolean;
  blockWindowClose?: BlockWindowCloseHandler;
  persistentStorage?: CollectionPersistentStorageConfig<CollectionTestItem<D>>;
  ignoreInitialTimeCheck?: boolean;
};

export function createCollectionStoreTestEnv<D extends Record<string, unknown>>(
  serverInitialData: Record<string, D>,
  {
    id = getNextStoreId('collection'),
    getSessionKey = () => 'test-session',
    sharedServerTableState,
    browserTabsTransportFactory,
    browserTabsLeadershipTimings,
    bindFocusController,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    baseCoalescingWindowMs = 10,
    lowPriorityThrottleMs = getDefaultLowPriorityThrottleMs(),
    mediumPriorityDelayMs,
    useBatchFetch,
    maxBatchSize,
    getItemsBatchKey,
    testScenario,
    usesRealTimeUpdates,
    blockWindowClose,
    persistentStorage,
    ignoreInitialTimeCheck,
  }: CollectionStoreTestEnvOptions<D> = {},
) {
  if (!ignoreInitialTimeCheck) {
    if (Math.abs(Date.now() - TEST_INITIAL_TIME) > 1_000 * 60 * 60 * 24) {
      throw new Error(
        'Current time is too far from TEST_INITIAL_TIME. Please reset the system time or set ignoreInitialTimeCheck to true.',
      );
    }
  }

  const {
    actionsHistory,
    addAction,
    addTimelineComments,
    getTimelineString,
    getRelativeTime,
  } = createActionTracker();

  const { getMutationEmoji } = createEmojiCyclers();

  const serverTable = createServerTableMock<D>(
    serverInitialData,
    addAction,
    sharedServerTableState,
  );

  const { uiChanges, trackItemUI } = createPerItemUITracker(
    addAction,
    getRelativeTime,
    actionsHistory,
  );

  const { trackUIChanges } = createUITracker<
    Record<string, number | 'error' | undefined>
  >(addAction, getRelativeTime, actionsHistory);

  // Batch fetch function - delegates to serverTable.list
  const batchFetchFn = async (
    payloads: string[],
    signal: AbortSignal,
    batchKey: string,
  ) => {
    const uniquePayloads = new Map<string, string>();
    for (const payload of payloads) {
      if (!uniquePayloads.has(payload)) {
        uniquePayloads.set(payload, payload);
      }
    }

    const listResult = await serverTable.list(
      { itemIds: [...uniquePayloads.keys()], batchKey },
      signal,
    );

    // Convert list result to Map format expected by collection store
    const results = new Map<string, CollectionTestItem<D> | Error>();
    for (const { itemId, data } of listResult.items) {
      const originalPayload = uniquePayloads.get(itemId);
      if (!originalPayload) continue;

      if (data instanceof Error) {
        results.set(originalPayload, data);
      } else {
        results.set(originalPayload, { value: data });
      }
    }

    return results;
  };

  const testOptions = resolveTestOptions(testScenario, serverInitialData);

  const collectionStore = createCollectionStore<CollectionTestItem<D>, string>({
    id,
    getSessionKey,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    maxBatchSize: useBatchFetch ? maxBatchSize : undefined,
    getItemsBatchKey: useBatchFetch ? getItemsBatchKey : undefined,
    fetchFn: async (payload, signal) => {
      const value = await serverTable.fetch(payload, signal);
      return { value };
    },
    batchFetchFn: useBatchFetch ? batchFetchFn : undefined,
    usesRealTimeUpdates,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    mediumPriorityDelayMs,
    blockWindowClose: blockWindowClose ?? null,
    persistentStorage,
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
        message: CollectionBrowserTabsMessage<CollectionTestItem<D>, string>,
      ) => {
        if (message.kind === 'collection-item-snapshot') {
          addAction(`<${message.consistency}-snapshot-received`, {
            actionValue: message.item?.data?.value,
            itemId: message.item?.payload,
          });
        }
      },
    },
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

    serverTable.wsEvents.on('list_changed', () => {
      addAction('received-ws-data-change-event');
      collectionStore.invalidateItem(() => true, 'realtimeUpdate');
    });
  }

  const env = {
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
        error,
      }: {
        withRevalidation?: boolean;
        withOptimisticUpdate?: boolean;
        duration?: number;
        triggerRTU?: boolean;
        addServerDataChangeAction?: boolean;
        error?: string;
      } = {},
    ) => {
      const mutationId = getMutationEmoji();
      let mutationPromise!: ReturnType<typeof collectionStore.performMutation>;

      act(() => {
        mutationPromise = collectionStore.performMutation(itemId, {
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
            if (error) {
              addAction('<mutation-error', {
                actionValue: error,
                id: mutationId,
              });
              throw new Error(error);
            }

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
      });

      return mutationPromise;
    },
    get timelineString() {
      return getTimelineString();
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

function mapInitialData<D extends Record<string, unknown>>(
  data: Record<string, D>,
): CollectionInitialStateItem<string, CollectionTestItem<D>>[] {
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
      initialData?: CollectionInitialStateItem<string, CollectionTestItem<D>>[];
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
