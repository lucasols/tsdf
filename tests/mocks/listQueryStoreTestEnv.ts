import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { act } from 'react';
import {
  createListQueryStore,
  type ListQueryBrowserTabsMessage,
  type ListQueryStoreOptions,
} from '../../src/listQueryStore/listQueryStore';
import type {
  OffsetPaginationConfig,
  PartialResourcesConfig,
} from '../../src/listQueryStore/types';
import type {
  ListQueryPersistentStorageConfig,
  StorageAdapter,
} from '../../src/persistentStorage/types';
import type {
  FetchType,
  RequestSchedulerEventData,
  RequestSchedulerEvents,
} from '../../src/requestScheduler';
import type { BrowserTabsLeadershipTimings } from '../../src/utils/browserTabsLeadership';
import type { BrowserTabsTransportFactory } from '../../src/utils/browserTabsSync';
import type { BlockWindowCloseHandler } from '../../src/utils/performMutation';
import { getNextStoreId } from './browserTabsTestUtils';
import {
  createServerTableMock,
  createSharedServerTableState,
  type FilterOperator,
  type ServerTableSharedState,
} from './serverTableMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createPerItemUITracker,
  getDefaultLowPriorityThrottleMs,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
  TEST_INITIAL_TIME,
} from './testEnvUtils';

type ListQueryItemPayload = string;

export type ListQueryParams = { tableId: string; filters?: FilterOperator[] };

type ListQuerySnapshotConfig = {
  tables?: string[];
  items?: string[];
  queries?: ListQueryParams[];
};

export type ListQueryStoreTestScenario =
  /** App just opened, no data fetched yet. */
  | 'idle'
  /**
   * App already opened before and data was fetched successfully.
   * Using the default lowPriorityThrottleMs (200ms) it will still trigger a refetch on mount as initial system time is set to 10 seconds in the past.
   */
  | { loaded: ListQuerySnapshotConfig };

// Raw item key (used for serverTable and external references)
function getRawItemKey(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

// Store item key (matches what getCompositeKey produces for string payloads)
function getStoreItemKey(tableId: string, id: number): string {
  return getCompositeKey(getRawItemKey(tableId, id));
}

export type Row = {
  id: number;
  name: string;
  age?: number;
  city?: string;
  [key: string]: unknown;
};

export type Tables<TRow extends Row = Row> = Record<string, TRow[]>;

function flattenTables<TRow extends Row>(
  tables: Tables<TRow>,
): Record<string, TRow> {
  const flatItems: Record<string, TRow> = {};
  for (const [tableId, rows] of Object.entries(tables)) {
    for (const row of rows) {
      flatItems[getRawItemKey(tableId, row.id)] = row;
    }
  }
  return flatItems;
}

export function createSharedListQueryServerTableState<TRow extends Row>(
  tables: Tables<TRow>,
): ServerTableSharedState<TRow> {
  return createSharedServerTableState(flattenTables(tables));
}

export function createListQueryStoreTestEnv<
  TRow extends Row = Row,
  TPartialResources extends boolean = false,
  TOffsetPagination extends boolean = false,
  StorageState = unknown,
>(
  serverInitialData: Tables<TRow>,
  {
    id = getNextStoreId('list-query'),
    getSessionKey = () => 'test-session',
    sharedServerTableState,
    browserTabsTransportFactory,
    browserTabsLeadershipTimings,
    bindFocusController,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs,
    baseCoalescingWindowMs = 10,
    mediumPriorityDelayMs,
    defaultQuerySize = 50,
    lowPriorityThrottleMs = getDefaultLowPriorityThrottleMs(),
    testScenario,
    usesRealTimeUpdates,
    useBatchFetch,
    maxItemBatchSize,
    maxItems,
    maxQueries,
    onStateCleanup,
    getItemsBatchKey,
    disableFetchItemFn,
    optimisticListUpdates,
    partialResources,
    offsetPagination,
    blockWindowClose,
    persistentStorage,
    storageAdapter,
    __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__,
  }: {
    id?: string;
    getSessionKey?: () => string | false;
    sharedServerTableState?: ServerTableSharedState<TRow>;
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
    transportReconnectCooldownMs?: number;
    baseCoalescingWindowMs?: number;
    mediumPriorityDelayMs?: number;
    defaultQuerySize?: number;
    lowPriorityThrottleMs?: number;
    testScenario?: ListQueryStoreTestScenario;
    usesRealTimeUpdates?: boolean;
    /** Enable batch fetch mode - uses batchFetchItemFn instead of per-item fetchItemFn */
    useBatchFetch?: boolean;
    /** Max items per batch (only used when useBatchFetch is true) */
    maxItemBatchSize?: number;
    maxItems?: number;
    maxQueries?: number;
    onStateCleanup?: ListQueryStoreOptions<
      TRow,
      ListQueryParams,
      ListQueryItemPayload,
      TPartialResources,
      TOffsetPagination
    >['onStateCleanup'];
    /** Optional function to group batch fetches by key */
    getItemsBatchKey?: (payload: string) => string | false;
    disableFetchItemFn?: boolean;
    optimisticListUpdates?: Parameters<
      typeof createListQueryStore<TRow, ListQueryParams, ListQueryItemPayload>
    >[0]['optimisticListUpdates'];
    partialResources?: PartialResourcesConfig<TRow>;
    offsetPagination?: OffsetPaginationConfig;
    blockWindowClose?: BlockWindowCloseHandler;
    persistentStorage?: ListQueryPersistentStorageConfig<
      TRow,
      ListQueryParams,
      ListQueryItemPayload,
      StorageState
    >;
    storageAdapter?: StorageAdapter;
    __DANGEROUS_IGNORE_INITIAL_TIME_CHECK__?: boolean;
  } = {},
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

  const serverTable = createServerTableMock<TRow>(
    flattenTables(serverInitialData),
    addAction,
    sharedServerTableState,
  );

  const { uiChanges, trackItemUI } = createPerItemUITracker(
    addAction,
    getRelativeTime,
    actionsHistory,
  );

  // Batch fetch function - delegates to serverTable.list with itemIds
  const batchFetchItemFn = async (
    requests: { payload: ListQueryItemPayload; fields?: string[] }[],
    { signal, batchKey }: { signal: AbortSignal; batchKey: string },
  ): Promise<Map<ListQueryItemPayload, TRow | Error>> => {
    const ids = requests.map((r) => r.payload);
    const shouldFetchAllFields = requests.some(
      (request) => !request.fields || request.fields.length === 0,
    );
    const mergedFields = shouldFetchAllFields
      ? undefined
      : Array.from(
          new Set(requests.flatMap((request) => request.fields ?? [])),
        ).sort();
    const listResult = await serverTable.list(
      {
        itemIds: ids,
        batchKey,
        fields: partialResources ? mergedFields : undefined,
      },
      signal,
    );

    const results = new Map<ListQueryItemPayload, TRow | Error>();
    for (const request of requests) {
      const listItem = listResult.items.find(
        (item) => item.itemId === request.payload,
      );
      if (listItem) {
        results.set(request.payload, listItem.data);
      } else {
        results.set(
          request.payload,
          new Error(`Item not found: ${request.payload}`),
        );
      }
    }

    return results;
  };

  const testOptions = resolveTestOptions(testScenario, serverTable);

  async function fetchFromServer(
    { tableId, filters }: ListQueryParams,
    offset: number | undefined,
    limit: number,
    signal: AbortSignal,
    fields: string[] | undefined,
  ) {
    const result = await serverTable.list(
      {
        tableId,
        filters,
        fields: partialResources ? fields : undefined,
        offset,
        limit,
      },
      signal,
    );

    return {
      items: result.items.map(({ itemId, data }) => ({
        itemPayload: itemId,
        data,
      })),
      hasMore: result.hasMore,
    };
  }

  const baseOptions = {
    id,
    getSessionKey,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    dynamicRealtimeThrottleMs,
    revalidateOnWindowFocus,
    transportReconnectCooldownMs,
    mediumPriorityDelayMs,
    defaultQuerySize,
    usesRealTimeUpdates,
    maxItemBatchSize: useBatchFetch ? maxItemBatchSize : undefined,
    maxItems,
    maxQueries,
    onStateCleanup,
    batchFetchItemFn: useBatchFetch ? batchFetchItemFn : undefined,
    getItemsBatchKey: useBatchFetch ? getItemsBatchKey : undefined,
    blockWindowClose: blockWindowClose ?? null,
    persistentStorage,
    optimisticListUpdates,
    partialResources,
    '~test': {
      ...testOptions,
      storageAdapter,
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
        message: ListQueryBrowserTabsMessage<TRow, ListQueryParams, string>,
      ) => {
        if (message.kind === 'list-item-snapshot') {
          addAction(`<${message.consistency}-item-snapshot-received`, {
            actionValue: message.item,
            itemId: message.itemQuery?.payload,
          });
        }

        if (message.kind === 'list-query-snapshot') {
          addAction(`<${message.consistency}-query-snapshot-received`, {
            actionValue: {
              queryKey: message.queryKey,
              itemCount: message.items.length,
            },
          });
        }
      },
    },
    onSchedulerEvent: (
      event: RequestSchedulerEvents,
      data?: RequestSchedulerEventData,
    ) => {
      logSchedulerEvent(event, addAction, data);
    },
    fetchItemFn: disableFetchItemFn
      ? undefined
      : async (
          payload: ListQueryItemPayload,
          { signal, fields }: { signal: AbortSignal; fields?: string[] },
        ) => {
          return serverTable.fetch(payload, signal, { fields });
        },
  };

  // TypeScript cannot narrow generic params from a runtime check, so we use
  // __LEGIT_CAST__ on the options object to satisfy the conditional type.
  const storeOptions = offsetPagination
    ? {
        ...baseOptions,
        offsetPagination,
        fetchListFn: async (
          payload: ListQueryParams,
          { offset, limit }: { offset: number; limit: number },
          { signal, fields }: { signal: AbortSignal; fields?: string[] },
        ) => fetchFromServer(payload, offset, limit, signal, fields),
      }
    : {
        ...baseOptions,
        fetchListFn: async (
          payload: ListQueryParams,
          size: number,
          { signal, fields }: { signal: AbortSignal; fields?: string[] },
        ) => fetchFromServer(payload, undefined, size, signal, fields),
      };

  const listQueryStore = createListQueryStore<
    TRow,
    ListQueryParams,
    ListQueryItemPayload,
    TPartialResources,
    TOffsetPagination,
    StorageState
  >(
    __LEGIT_CAST__<
      ListQueryStoreOptions<
        TRow,
        ListQueryParams,
        ListQueryItemPayload,
        TPartialResources,
        TOffsetPagination,
        StorageState
      >,
      unknown
    >(storeOptions),
  );

  // Simplified method references for internal test helpers.
  // The store methods have deferred conditional rest params (from boolean generics)
  // that TypeScript can't resolve in a generic context. These casts provide concrete
  // signatures for the internal wrapper functions.
  const internalScheduleListQueryFetch = __LEGIT_CAST__<
    (
      fetchType: FetchType,
      payload: ListQueryParams,
      size?: number,
      options?: { fields?: string[]; mediumPriorityDelayMs?: number },
    ) => 'started' | 'skipped' | 'triggered' | 'scheduled',
    unknown
  >(listQueryStore.scheduleListQueryFetch);

  const internalScheduleItemFetch = __LEGIT_CAST__<
    (
      fetchType: FetchType,
      payload: string,
      options?: { fields?: string[]; mediumPriorityDelayMs?: number },
    ) => 'started' | 'skipped' | 'triggered' | 'scheduled',
    unknown
  >(listQueryStore.scheduleItemFetch);

  if (usesRealTimeUpdates) {
    serverTable.wsEvents.on('data_changed', ({ payload }) => {
      addAction('received-ws-data-change-event', { itemId: payload.itemId });

      const [tableId] = payload.itemId.split('||');

      listQueryStore.invalidateQueryAndItems({
        queryPayload: (qp) => qp.tableId === tableId,
        itemPayload: payload.itemId,
        type: 'realtimeUpdate',
      });
    });

    serverTable.wsEvents.on('item_added', ({ payload }) => {
      addAction('received-ws-item-added-event', { itemId: payload.itemId });

      const [tableId] = payload.itemId.split('||');

      listQueryStore.invalidateQueryAndItems({
        queryPayload: (qp) => qp.tableId === tableId,
        itemPayload: false,
        type: 'realtimeUpdate',
      });
    });

    serverTable.wsEvents.on('item_deleted', ({ payload }) => {
      addAction('received-ws-item-deleted-event', { itemId: payload.itemId });

      const [tableId] = payload.itemId.split('||');

      listQueryStore.invalidateQueryAndItems({
        queryPayload: (qp) => qp.tableId === tableId,
        itemPayload: payload.itemId,
        type: 'realtimeUpdate',
      });
    });

    serverTable.wsEvents.on('list_changed', () => {
      addAction('received-ws-list-change-event');
    });
  }

  // Hide wsEvents from the public type to prevent direct usage in tests,
  // while keeping the runtime object intact (preserves getters).
  const typedServerTable: Omit<
    ReturnType<typeof createServerTableMock<TRow>>,
    'wsEvents'
  > = serverTable;

  const env = {
    apiStore: listQueryStore,
    store: listQueryStore.store,
    serverTable: typedServerTable,
    get uiChanges() {
      return uiChanges;
    },
    get actions() {
      return actionsHistory;
    },
    trackItemUI,
    addTimelineComments,
    getItemKey: (tableId: string, rowId: number) =>
      getRawItemKey(tableId, rowId),
    getStoreItemKey: (tableId: string, rowId: number) =>
      getStoreItemKey(tableId, rowId),
    getStoreItemKeyFromRaw: (rawKey: string) => getCompositeKey(rawKey),
    getQueryKey: (params: ListQueryParams) => getCompositeKey(params),
    getItemQueryState: (rawItemKey: string) =>
      listQueryStore.store.state.itemQueries[getCompositeKey(rawItemKey)],
    scheduleFetch: (
      fetchType: FetchType,
      params: ListQueryParams,
      size?: number,
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const result = internalScheduleListQueryFetch(
        fetchType,
        params,
        size,
        options,
      );

      logScheduleFetchResult(result, addAction);

      return result;
    },
    scheduleItemFetch: (
      fetchType: FetchType,
      itemPayload: ListQueryItemPayload,
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const result = internalScheduleItemFetch(fetchType, itemPayload, options);

      logScheduleFetchResult(result, (action) =>
        addAction(action, { itemId: itemPayload }),
      );

      return result;
    },
    forceListUpdate: (params: ListQueryParams) => {
      const result = internalScheduleListQueryFetch('highPriority', params);

      if (result !== 'started' && result !== 'triggered') {
        throw new Error(`error forceListUpdate: ${result}`);
      }

      return result;
    },
    performClientItemUpdateAction: (
      itemId: string,
      newValue: Partial<TRow>,
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
      const tableId = itemId.split('||')[0];
      const currentItemState = listQueryStore.getItemState(itemId);
      const baseValue = currentItemState ?? serverTable.get(itemId);

      if (!tableId) {
        throw new Error(`Invalid itemId format: "${itemId}"`);
      }
      if (!baseValue) {
        throw new Error(`Item not found in server or store state: "${itemId}"`);
      }

      const mergedValue: TRow = { ...baseValue, ...newValue };
      let mutationPromise!: ReturnType<typeof listQueryStore.performMutation>;

      act(() => {
        mutationPromise = listQueryStore.performMutation(itemId, {
          optimisticUpdate: withOptimisticUpdate
            ? () => {
                listQueryStore.updateItemState(itemId, (draft) => {
                  Object.assign(draft, newValue);
                });

                addAction('optimistic-ui-commit', {
                  uiValue: mergedValue,
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

            return serverTable.emulateClientMutation(itemId, mergedValue, {
              duration,
              triggerRTUEvent: triggerRTU,
              addServerDataChangeAction,
              mutationId,
            });
          },
          revalidateOnSuccess: withRevalidation,
          getRelatedQueries: (payload) => payload.tableId === tableId,
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
    getRelativeTime,
  };

  bindFocusController?.onWindowFocus(() => {
    addAction('👁 window-focused');
  });

  bindFocusController?.onWindowBlur(() => {
    addAction('🔕 window-blurred');
  });

  return env;
}

type InitialData<TRow extends Row = Row> = {
  queries: Array<{
    payload: ListQueryParams;
    hasMore: boolean;
    items: string[];
  }>;
  items: Array<{ payload: string; data: TRow }>;
};

function buildSnapshotData<TRow extends Row>(
  config: ListQuerySnapshotConfig,
  serverTable: ReturnType<typeof createServerTableMock<TRow>>,
): InitialData<TRow> {
  const tablesToSnapshot = config.tables ?? [];

  const initialData: InitialData<TRow> = { queries: [], items: [] };

  for (const tableId of tablesToSnapshot) {
    const tableItems = serverTable.getByPrefix(`${tableId}||`);

    if (tableItems.length === 0) {
      throw new Error(
        `loadTablesSnapshot: Table '${tableId}' doesn't exist or is empty`,
      );
    }

    initialData.queries.push({
      payload: { tableId },
      hasMore: false,
      items: tableItems.map(({ itemId }) => getCompositeKey(itemId)),
    });

    for (const { itemId, data } of tableItems) {
      initialData.items.push({ payload: itemId, data });
    }
  }

  for (const query of config.queries ?? []) {
    const { tableId, filters } = query;
    const result = serverTable.listSync({ tableId, filters });

    initialData.queries.push({
      payload: query,
      hasMore: false,
      items: result.items.map(({ itemId }) => getCompositeKey(itemId)),
    });

    for (const { itemId, data } of result.items) {
      initialData.items.push({ payload: itemId, data });
    }
  }

  if (config.items) {
    for (const itemId of config.items) {
      const itemData = serverTable.get(itemId);

      if (!itemData) {
        throw new Error(`loadItemsSnapshot: Item '${itemId}' doesn't exist`);
      }

      initialData.items.push({ payload: itemId, data: itemData });
    }
  }

  return initialData;
}

function resolveTestOptions<TRow extends Row>(
  scenario: ListQueryStoreTestScenario | undefined,
  serverTable: ReturnType<typeof createServerTableMock<TRow>>,
):
  | {
      initialData?: InitialData<TRow>;
      initialRefetchOnMount?: FetchType | false;
      initialLastFetchStartTime?: number;
    }
  | undefined {
  if (!scenario || scenario === 'idle') {
    return undefined;
  }

  return {
    initialData: buildSnapshotData(scenario.loaded, serverTable),
    initialRefetchOnMount: false,
    initialLastFetchStartTime: Date.now() - 10_000,
  };
}
