import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { createListQueryStore } from '../../src/listQueryStore/listQueryStore';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
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

export type Tables<TRow extends Row = Row> = Record<string, TRow[]>;

export type ListQueryParams = {
  tableId: string;
  filters?: FilterOperator[];
};

type ListQueryItemPayload = string;

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

export function createListQueryStoreTestEnv<
  TRow extends Row = Row,
  TPartialResources extends PartialResourcesConfig<TRow> | undefined =
    undefined,
>(
  serverInitialData: Tables<TRow>,
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
    disableFetchItemFn,
    optimisticListUpdates,
    partialResources,
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
    disableFetchItemFn?: boolean;
    optimisticListUpdates?: Parameters<
      typeof createListQueryStore<TRow, ListQueryParams, ListQueryItemPayload>
    >[0]['optimisticListUpdates'];
    partialResources?: TPartialResources;
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

  // Convert Tables to Record<string, TRow> for serverTableMock
  const flatItems: Record<string, TRow> = {};
  for (const [tableId, rows] of Object.entries(serverInitialData)) {
    for (const row of rows) {
      flatItems[getRawItemKey(tableId, row.id)] = row;
    }
  }

  const serverTable = createServerTableMock<TRow>(flatItems, addAction);

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
  const batchFetchItemFn = async (
    requests: { payload: ListQueryItemPayload; fields?: string[] }[],
    { signal }: { signal: AbortSignal },
  ) => {
    const ids = requests.map((r) => r.payload);
    const listResult = await serverTable.list({ itemIds: ids }, signal);

    const results = new Map<ListQueryItemPayload, TRow | Error>();
    for (const request of requests) {
      const listItem = listResult.items.find(
        (item) => item.itemId === request.payload,
      );
      if (listItem) {
        results.set(request.payload, listItem.data);
      }
    }

    return results;
  };

  const testOptions = resolveTestOptions(testScenario, serverTable);

  const listQueryStore = createListQueryStore<
    TRow,
    ListQueryParams,
    ListQueryItemPayload,
    TPartialResources
  >({
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs,
    baseCoalescingWindowMs,
    dynamicRealtimeThrottleMs,
    mediumPriorityDelayMs,
    defaultQuerySize,
    usesRealTimeUpdates,
    maxItemBatchSize: useBatchFetch ? maxItemBatchSize : undefined,
    batchFetchItemFn: useBatchFetch ? batchFetchItemFn : undefined,
    optimisticListUpdates,
    partialResources,
    '~test': testOptions,
    onSchedulerEvent: (event) => {
      logSchedulerEvent(event, addAction);
    },
    fetchListFn: async ({ tableId, filters }, size, { signal, fields }) => {
      const result = await serverTable.list(
        {
          tableId,
          filters,
          fields: partialResources ? fields : undefined,
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
    fetchItemFn: disableFetchItemFn
      ? undefined
      : async (payload, { signal, fields }) => {
          return serverTable.fetch(payload, signal, { fields });
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

    serverTable.wsEvents.on('item_added', ({ payload }) => {
      addAction('received-ws-item-added-event', {
        itemId: payload.itemId,
      });

      const [tableId] = payload.itemId.split('||');

      listQueryStore.invalidateQueryAndItems({
        queryPayload: (qp) => qp.tableId === tableId,
        itemPayload: false,
        type: 'realtimeUpdate',
      });
    });

    serverTable.wsEvents.on('item_deleted', ({ payload }) => {
      addAction('received-ws-item-deleted-event', {
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
      itemPayload: ListQueryItemPayload,
      options?: { mediumPriorityDelayMs?: number },
    ) => {
      const result = listQueryStore.scheduleItemFetch(
        fetchType,
        itemPayload,
        options,
      );

      logScheduleFetchResult(result, (action) =>
        addAction(action, { itemId: itemPayload }),
      );

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
    performClientItemUpdateAction: (
      itemId: string,
      newValue: Partial<TRow>,
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

      return listQueryStore.performMutation(itemId, {
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
    },
    get timelineString() {
      return getTimelineString();
    },
  };
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
