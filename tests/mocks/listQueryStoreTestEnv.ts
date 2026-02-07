import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createListQueryStore } from '../../src/listQueryStore/listQueryStore';
import type { FetchType } from '../../src/requestScheduler';
import { createServerTableMock, type FilterOperator } from './serverTableMock';
import {
  createActionTracker,
  createEmojiCyclers,
  createUITracker,
  logScheduleFetchResult,
  logSchedulerEvent,
  normalizeError,
} from './testEnvUtils';

export type Row = {
  id: number;
  name: string;
  [key: string]: unknown;
};

export type Tables = Record<string, Row[]>;

export type ListQueryParams = {
  tableId: string;
  filters?: FilterOperator[];
};

type ListQuerySnapshotConfig = {
  tables?: string[];
  items?: string[];
  queries?: ListQueryParams[];
};

export type ListQueryStoreTestScenario =
  /** App just opened, no data fetched yet. */
  | 'idle'
  /** User already have the app loaded and data was fetched successfully. */
  | { loaded: ListQuerySnapshotConfig }
  /** App started with data restored from local cache, pending server revalidation. */
  | { idleWithLocalCache: ListQuerySnapshotConfig };

// Raw item key (used for serverTable and external references)
function getRawItemKey(tableId: string, id: number): string {
  return `${tableId}||${id}`;
}

// Store item key (matches what getCompositeKey produces for string payloads)
function getStoreItemKey(tableId: string, id: number): string {
  return getCompositeKey(getRawItemKey(tableId, id));
}

export function createListQueryStoreTestEnv(
  serverInitialData: Tables,
  {
    dynamicRealtimeThrottleMs,
    baseCoalescingWindowMs = 10,
    mediumPriorityDelayMs,
    defaultQuerySize = 50,
    lowPriorityThrottleMs = 200,
    testScenario,
    usesRealTimeUpdates,
    useBatchFetch,
    maxItemBatchSize,
  }: {
    dynamicRealtimeThrottleMs?: (lastFetchDuration: number) => number;
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

  // Convert Tables to Record<string, Row> for serverTableMock
  const flatItems: Record<string, Row> = {};
  for (const [tableId, rows] of Object.entries(serverInitialData)) {
    for (const row of rows) {
      flatItems[getRawItemKey(tableId, row.id)] = row;
    }
  }

  const serverTable = createServerTableMock<Row>(flatItems, addAction);

  const { trackUIChanges } = createUITracker<unknown>(
    addAction,
    getRelativeTime,
    actionsHistory,
  );

  // Per-item UI tracking (same pattern as collection store)
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

  // Batch fetch function - delegates to serverTable.list with itemIds
  const batchFetchItemFn = async (payloads: string[], signal: AbortSignal) => {
    const listResult = await serverTable.list({ itemIds: payloads }, signal);

    const results = new Map<string, Row | Error>();
    for (const { itemId, data } of listResult.items) {
      if (data instanceof Error) {
        results.set(itemId, data);
      } else {
        results.set(itemId, data);
      }
    }

    return results;
  };

  const testOptions = resolveTestOptions(testScenario, serverTable);

  const listQueryStore = createListQueryStore<Row, ListQueryParams, string>({
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    defaultQuerySize,
    usesRealTimeUpdates,
    maxItemBatchSize: useBatchFetch ? maxItemBatchSize : undefined,
    batchFetchItemFn: useBatchFetch ? batchFetchItemFn : undefined,
    '~test': testOptions,
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
    fetchListFn: async ({ tableId, filters }, size, signal) => {
      const result = await serverTable.list(
        {
          tableId,
          filters,
          limit: size,
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
    },
    fetchItemFn: async (itemId, signal) => {
      return serverTable.fetch(itemId, signal);
    },
  });

  if (usesRealTimeUpdates) {
    serverTable.wsEvents.on('data_changed', ({ payload }) => {
      addAction('received-ws-data-change-event', {
        itemId: payload.itemId,
      });

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

  return {
    apiStore: listQueryStore,
    store: listQueryStore.store,
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
    getItemKey: (tableId: string, id: number) => getRawItemKey(tableId, id),
    getStoreItemKey: (tableId: string, id: number) =>
      getStoreItemKey(tableId, id),
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
      const result = listQueryStore.scheduleListQueryFetch(
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
      itemId: string,
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const result = listQueryStore.scheduleItemFetch(
        fetchType,
        itemId,
        options,
      );

      logScheduleFetchResult(result, (action) => addAction(action, { itemId }));

      return result;
    },
    forceListUpdate: (params: ListQueryParams) => {
      const result = listQueryStore.scheduleListQueryFetch(
        'highPriority',
        params,
      );

      if (result !== 'started' && result !== 'triggered') {
        throw new Error(`error forceListUpdate: ${result}`);
      }

      return result;
    },
    performClientUpdateAction: async (
      itemId: string,
      newValue: Row,
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
      const endMutation = listQueryStore.startItemMutation(itemId);

      if (withOptimisticUpdate) {
        listQueryStore.updateItemState(itemId, () => newValue);
        addAction('optimistic-ui-commit', {
          uiValue: newValue,
          id: mutationId,
          itemId,
        });
      }

      await serverTable.emulateClientMutation(itemId, newValue, {
        duration,
        triggerRTUEvent: triggerRTU,
        addServerDataChangeAction,
        mutationId,
      });

      endMutation();

      if (withRevalidation) {
        listQueryStore.scheduleItemFetch('highPriority', itemId);
      }
    },
    get timelineString() {
      return getTimelineString();
    },
  };
}

type InitialData = {
  queries: Array<{
    payload: ListQueryParams;
    hasMore: boolean;
    items: string[];
  }>;
  items: Array<{ payload: string; data: Row }>;
};

function buildSnapshotData(
  config: ListQuerySnapshotConfig,
  serverTable: ReturnType<typeof createServerTableMock<Row>>,
): InitialData {
  const tablesToSnapshot = config.tables ?? [];

  const initialData: InitialData = { queries: [], items: [] };

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
      initialData.items.push({
        payload: itemId,
        data,
      });
    }
  }

  for (const query of config.queries ?? []) {
    const { tableId, filters } = query;
    const result = serverTable.listSync({
      tableId,
      filters,
    });

    initialData.queries.push({
      payload: query,
      hasMore: false,
      items: result.items.map(({ itemId }) => getCompositeKey(itemId)),
    });

    for (const { itemId, data } of result.items) {
      initialData.items.push({
        payload: itemId,
        data,
      });
    }
  }

  if (config.items) {
    for (const itemId of config.items) {
      const itemData = serverTable.get(itemId);

      if (!itemData) {
        throw new Error(`loadItemsSnapshot: Item '${itemId}' doesn't exist`);
      }

      initialData.items.push({
        payload: itemId,
        data: itemData,
      });
    }
  }

  return initialData;
}

function resolveTestOptions(
  scenario: ListQueryStoreTestScenario | undefined,
  serverTable: ReturnType<typeof createServerTableMock<Row>>,
):
  | {
      initialData?: InitialData;
      initialRefetchOnMount?: FetchType | false;
      initialLastFetchStartTime?: number;
    }
  | undefined {
  if (!scenario || scenario === 'idle') {
    return undefined;
  }

  if ('loaded' in scenario) {
    return {
      initialData: buildSnapshotData(scenario.loaded, serverTable),
      initialRefetchOnMount: false,
      initialLastFetchStartTime: Date.now() - 10_000,
    };
  }

  return {
    initialData: buildSnapshotData(scenario.idleWithLocalCache, serverTable),
    initialRefetchOnMount: 'lowPriority',
    initialLastFetchStartTime: Date.now() - 10_000,
  };
}
