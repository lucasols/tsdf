import { notNullish } from '@ls-stack/utils/assertions';
import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { evtmitter } from 'evtmitter';
import type { StoreError } from '../../src/utils/storeShared';
import { sleep } from '../../test-old/utils/sleep';
import { FetchError } from './testEnvUtils';

export const DEFAULT_FETCH_DURATION_MS = 800;
export const DEFAULT_MUTATION_DURATION_MS = 1200;
export const DEFAULT_RTU_DELAY_MS = 50;

export type FilterOperator =
  | { op: 'eq'; field: string; value: unknown }
  | { op: 'neq'; field: string; value: unknown }
  | { op: 'gt'; field: string; value: number }
  | { op: 'gte'; field: string; value: number }
  | { op: 'lt'; field: string; value: number }
  | { op: 'lte'; field: string; value: number }
  | { op: 'range'; field: string; min: number; max: number }
  | { op: 'in'; field: string; values: unknown[] }
  | { op: 'startsWith'; field: string; value: string };

export type ListQueryOptions = {
  offset?: number;
  limit?: number;
  itemIds?: string[];
  filters?: FilterOperator[];
  tableId?: string;
  fields?: string[];
};

function applyFilter<T extends Record<string, unknown>>(
  item: T,
  filter: FilterOperator,
): boolean {
  const value = item[filter.field];

  switch (filter.op) {
    case 'eq':
      return value === filter.value;
    case 'neq':
      return value !== filter.value;
    case 'gt':
      return typeof value === 'number' && value > filter.value;
    case 'gte':
      return typeof value === 'number' && value >= filter.value;
    case 'lt':
      return typeof value === 'number' && value < filter.value;
    case 'lte':
      return typeof value === 'number' && value <= filter.value;
    case 'range':
      return (
        typeof value === 'number' && value >= filter.min && value <= filter.max
      );
    case 'in':
      return filter.values.includes(value);
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(filter.value);
  }
}

function applyFilters<T extends Record<string, unknown>>(
  item: T,
  filters: FilterOperator[],
): boolean {
  return filters.every((filter) => applyFilter(item, filter));
}

function selectFields<T extends Record<string, unknown>>(
  item: T,
  fields: string[],
): T {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in item) {
      result[field] = item[field];
    }
  }
  return __LEGIT_CAST__<T>(result);
}

export type ListQueryResult<ItemData> = {
  items: Array<{ itemId: string; data: ItemData }>;
  hasMore: boolean;
};

export type ServerTableEvents<ItemData> = {
  data_changed: { itemId: string; data: ItemData };
  item_deleted: { itemId: string };
  item_added: { itemId: string; data: ItemData };
  list_changed: undefined;
};

export type MutationOptions = {
  duration?: number;
  setDataAt?: number;
  triggerRTUEvent?: boolean;
  addServerDataChangeAction?: boolean;
  mutationId?: string | number;
};

export type FetchErrorConfig = {
  message: string;
  path?: string;
  method?: StoreError['method'];
  code?: number;
};

const fetchEmojis = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪'];

export type AddActionFn = (
  action: string,
  options?: { id?: string | number; actionValue?: unknown; itemId?: string },
) => void;

export function createServerTableMock<ItemData extends Record<string, unknown>>(
  initialItems: Record<string, ItemData>,
  addAction?: AddActionFn,
) {
  const items = new Map<string, ItemData>(Object.entries(initialItems));
  const knownTableIds = new Set<string>();
  const itemHistory = new Map<string, ItemData[]>();
  const customFetchDurations = new Map<string, number[]>();
  const defaultFetchDuration = DEFAULT_FETCH_DURATION_MS;
  const nextFetchErrors = new Map<string, FetchErrorConfig>();
  let nextListFetchError: FetchErrorConfig | null = null;

  // Fetch tracking state
  let numOfStartedFetches = 0;
  let numOfFinishedFetches = 0;
  let fetchIdCounter = 0;

  // Fetch history tracking
  type FetchHistoryEntry =
    | {
        type: 'fetch';
        itemId: string;
        fields: string[] | undefined;
        result: ItemData | 'error' | 'aborted';
      }
    | {
        type: 'list';
        itemIds: string[] | undefined;
        limit: number | undefined;
        fields: string[] | undefined;
        results:
          | Array<{ itemId: string; data: ItemData | 'error' }>
          | 'aborted';
      };
  const fetchHistory: FetchHistoryEntry[] = [];

  function getFetchId() {
    return notNullish(fetchEmojis[fetchIdCounter++ % fetchEmojis.length]);
  }

  function getNextFetchDuration(itemId: string): number {
    const durations = customFetchDurations.get(itemId);
    if (durations && durations.length > 0) {
      return notNullish(durations.shift());
    }
    return defaultFetchDuration;
  }

  function getTableId(itemId: string): string | null {
    const [tableId, rowId] = itemId.split('||');
    if (!tableId || !rowId) {
      return null;
    }
    return tableId;
  }

  for (const [itemId, data] of items) {
    itemHistory.set(itemId, [data]);

    const tableId = getTableId(itemId);
    if (tableId) {
      knownTableIds.add(tableId);
    }
  }

  const wsEvents = evtmitter<ServerTableEvents<ItemData>>();

  async function fetch(
    itemId: string,
    signal?: AbortSignal,
    options?: { fields?: string[] },
  ): Promise<ItemData> {
    const fetchId = addAction ? getFetchId() : undefined;

    if (addAction) {
      addAction('>fetch-started', { id: fetchId, itemId });
      numOfStartedFetches++;
    }

    let abortLogged = false;
    function onAbort() {
      if (!addAction || abortLogged) return;
      abortLogged = true;
      addAction('<fetch-aborted 🚫', { id: fetchId, itemId });
    }
    signal?.addEventListener('abort', onAbort);

    // Check for scheduled error first
    const errorConfig = nextFetchErrors.get(itemId);
    if (errorConfig) {
      signal?.removeEventListener('abort', onAbort);
      nextFetchErrors.delete(itemId);
      fetchHistory.push({ type: 'fetch', itemId, fields: options?.fields, result: 'error' });
      if (addAction) {
        numOfFinishedFetches++;
        addAction('<fetch-error', {
          actionValue: 'error',
          id: fetchId,
          itemId,
        });
      }

      if (errorConfig.path) {
        throw new FetchError(errorConfig.message, {
          path: errorConfig.path,
          method: errorConfig.method,
          code: errorConfig.code,
        });
      }
      throw new Error(errorConfig.message);
    }

    const actualDuration = getNextFetchDuration(itemId);
    await sleep(actualDuration);

    signal?.removeEventListener('abort', onAbort);

    // Check for abort after network delay
    if (signal?.aborted) {
      onAbort();
      fetchHistory.push({ type: 'fetch', itemId, fields: options?.fields, result: 'aborted' });
      if (addAction) {
        numOfFinishedFetches++;
      }
      throw new Error('Aborted');
    }

    const item = items.get(itemId);
    if (item === undefined) {
      fetchHistory.push({ type: 'fetch', itemId, fields: options?.fields, result: 'error' });
      if (addAction) {
        numOfFinishedFetches++;
      }
      throw new Error(`Item not found: ${itemId}`);
    }

    const result =
      options?.fields && options.fields.length > 0
        ? selectFields(item, options.fields)
        : item;

    fetchHistory.push({ type: 'fetch', itemId, fields: options?.fields, result });
    if (addAction) {
      numOfFinishedFetches++;
      addAction('<fetch-finished', {
        actionValue: result,
        id: fetchId,
        itemId,
      });
    }

    return result;
  }

  async function list(
    options?: ListQueryOptions,
    signal?: AbortSignal,
  ): Promise<ListQueryResult<ItemData>> {
    const {
      offset = 0,
      limit,
      itemIds: filterItemIds,
      filters,
      tableId,
      fields,
    } = options ?? {};
    const listId = addAction ? getFetchId() : undefined;

    if (addAction) {
      const filterInfo = filterItemIds ? { itemIds: filterItemIds } : undefined;
      addAction('>list-fetch-started', {
        id: listId,
        actionValue: filterInfo,
      });
      numOfStartedFetches++;
    }

    let abortLogged = false;
    function onAbort() {
      if (!addAction || abortLogged) return;
      abortLogged = true;
      addAction('<list-fetch-aborted 🚫', { id: listId });
    }
    signal?.addEventListener('abort', onAbort);

    // Calculate max duration from filtered items
    let maxDuration = defaultFetchDuration;
    if (filterItemIds) {
      for (const itemId of filterItemIds) {
        const duration = getNextFetchDuration(itemId);
        if (duration > maxDuration) maxDuration = duration;
      }
    }

    await sleep(maxDuration);

    signal?.removeEventListener('abort', onAbort);

    if (signal?.aborted) {
      onAbort();
      fetchHistory.push({
        type: 'list',
        itemIds: filterItemIds,
        limit,
        results: 'aborted',
        fields,
      });
      if (addAction) {
        numOfFinishedFetches++;
      }
      throw new Error('Aborted');
    }

    // Check for list-level fetch error (network failure)
    if (nextListFetchError) {
      const errorConfig = nextListFetchError;
      nextListFetchError = null;
      fetchHistory.push({
        type: 'list',
        itemIds: filterItemIds,
        limit,
        results: 'aborted',
        fields,
      });
      if (addAction) {
        numOfFinishedFetches++;
        addAction('<list-fetch-error', {
          id: listId,
          actionValue: 'error',
        });
      }
      throw new Error(errorConfig.message);
    }

    if (tableId && !knownTableIds.has(tableId)) {
      fetchHistory.push({
        type: 'list',
        itemIds: filterItemIds,
        results: 'aborted',
        limit,
        fields,
      });

      if (addAction) {
        numOfFinishedFetches++;
        addAction('<list-fetch-error', {
          id: listId,
          actionValue: 'error',
        });
      }

      throw new Error(`Table not found: ${tableId}`);
    }

    let resultEntries = Array.from(items.entries());

    // Filter by tableId if provided (items are keyed as "tableId||id")
    if (tableId) {
      const prefix = `${tableId}||`;
      resultEntries = resultEntries.filter(([itemId]) =>
        itemId.startsWith(prefix),
      );
    }

    // Filter by itemIds if provided
    if (filterItemIds) {
      resultEntries = resultEntries.filter(([itemId]) =>
        filterItemIds.includes(itemId),
      );
    }

    // Apply filters
    if (filters && filters.length > 0) {
      resultEntries = resultEntries.filter(([, data]) =>
        applyFilters(data, filters),
      );
    }

    const totalCount = resultEntries.length;
    const startIndex = offset;
    const endIndex = limit !== undefined ? offset + limit : totalCount;

    const paginatedEntries = resultEntries.slice(startIndex, endIndex);
    const hasMore = endIndex < totalCount;

    // Build result (apply field selection if requested)
    const resultItems = paginatedEntries.map(([itemId, data]) => ({
      itemId,
      data: fields && fields.length > 0 ? selectFields(data, fields) : data,
    }));

    const result: ListQueryResult<ItemData> = {
      items: resultItems,
      hasMore,
    };

    fetchHistory.push({
      type: 'list',
      itemIds: filterItemIds,
      limit,
      results: resultItems.map(({ itemId, data }) => ({
        itemId,
        data,
      })),
      fields,
    });

    if (addAction) {
      numOfFinishedFetches++;
      addAction('<list-fetch-finished', {
        id: listId,
        actionValue: { count: resultItems.length },
      });
    }

    return result;
  }

  function get(itemId: string): ItemData | undefined {
    return items.get(itemId);
  }

  function getAll(): Record<string, ItemData> {
    return Object.fromEntries(items);
  }

  function setItem(
    itemId: string,
    data: ItemData,
    options?: { triggerRTUEvent?: boolean },
  ): void {
    const tableId = getTableId(itemId);
    if (tableId) {
      knownTableIds.add(tableId);
    }

    items.set(itemId, data);

    const history = itemHistory.get(itemId);
    if (history) {
      history.push(data);
    } else {
      itemHistory.set(itemId, [data]);
    }

    addAction?.('server-data-changed', { actionValue: data, itemId });

    if (options?.triggerRTUEvent) {
      wsEvents.emit('data_changed', { itemId, data });
    }
  }

  function updateItem(itemId: string, data: Partial<ItemData>): void {
    const existingItem = items.get(itemId);
    if (existingItem === undefined) {
      throw new Error(`Item not found: ${itemId}`);
    }
    items.set(itemId, { ...existingItem, ...data });

    addAction?.('server-data-changed', { actionValue: data, itemId });
  }

  function removeItem(itemId: string): void {
    items.delete(itemId);
    addAction?.('server-item-removed', { itemId });
  }

  async function emulateClientMutation(
    itemId: string,
    newData: ItemData,
    options: MutationOptions = {},
  ): Promise<ItemData> {
    const {
      duration = DEFAULT_MUTATION_DURATION_MS,
      setDataAt = duration * 0.7,
      triggerRTUEvent,
      addServerDataChangeAction,
      mutationId,
    } = options;

    const existingItem = items.get(itemId);
    if (existingItem === undefined) {
      throw new Error(`Item not found: ${itemId}`);
    }

    addAction?.('>mutation-started', {
      actionValue: newData,
      id: mutationId,
      itemId,
    });

    await sleep(setDataAt);

    items.set(itemId, newData);

    const history = itemHistory.get(itemId);
    if (history) {
      history.push(newData);
    } else {
      itemHistory.set(itemId, [newData]);
    }

    if (addServerDataChangeAction) {
      addAction?.('server-data-changed', { actionValue: newData, itemId });
    }

    addAction?.('<mutation-data-persisted', {
      actionValue: newData,
      id: mutationId,
      itemId,
    });

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('data_changed', { itemId, data: newData });
      });
    }

    await sleep(duration - setDataAt);

    return newData;
  }

  async function addItemToServer(
    itemId: string,
    data: ItemData,
    options: MutationOptions = {},
  ): Promise<void> {
    const {
      duration = DEFAULT_MUTATION_DURATION_MS,
      setDataAt = duration * 0.7,
      triggerRTUEvent,
      addServerDataChangeAction,
      mutationId,
    } = options;

    if (items.has(itemId)) {
      throw new Error(`Item already exists: ${itemId}`);
    }

    addAction?.('>add-item-started', {
      actionValue: data,
      id: mutationId,
      itemId,
    });

    await sleep(setDataAt);

    const tableId = getTableId(itemId);
    if (tableId) {
      knownTableIds.add(tableId);
    }

    items.set(itemId, data);
    itemHistory.set(itemId, [data]);

    if (addServerDataChangeAction) {
      addAction?.('server-item-added', { actionValue: data, itemId });
    }

    addAction?.('<add-item-persisted', {
      actionValue: data,
      id: mutationId,
      itemId,
    });

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('item_added', { itemId, data });
        wsEvents.emit('list_changed', undefined);
      });
    }

    await sleep(duration - setDataAt);
  }

  async function addItemWithAutoGeneratedKey(
    tableId: string,
    createData: (id: number, itemId: string) => ItemData,
    options: MutationOptions = {},
  ): Promise<{ id: number; itemId: string; data: ItemData }> {
    const tableItems = getByPrefix(`${tableId}||`);
    let maxId = 0;

    for (const tableItem of tableItems) {
      const [, itemIdSuffix] = tableItem.itemId.split('||');

      if (itemIdSuffix) {
        const parsedId = Number(itemIdSuffix);
        if (Number.isFinite(parsedId) && parsedId > maxId) {
          maxId = parsedId;
        }
      }
    }

    const id = maxId + 1;
    const itemId = `${tableId}||${id}`;
    const itemData = createData(id, itemId);

    await addItemToServer(itemId, itemData, options);

    return { id, itemId, data: itemData };
  }

  async function deleteItemFromServer(
    itemId: string,
    options: MutationOptions = {},
  ): Promise<void> {
    const {
      duration = DEFAULT_MUTATION_DURATION_MS,
      setDataAt = duration * 0.7,
      triggerRTUEvent,
      addServerDataChangeAction,
      mutationId,
    } = options;

    const existingItem = items.get(itemId);
    if (existingItem === undefined) {
      throw new Error(`Item not found: ${itemId}`);
    }

    addAction?.('>delete-item-started', {
      actionValue: existingItem,
      id: mutationId,
      itemId,
    });

    await sleep(setDataAt);

    items.delete(itemId);

    if (addServerDataChangeAction) {
      addAction?.('server-item-deleted', { actionValue: existingItem, itemId });
    }

    addAction?.('<delete-item-persisted', {
      actionValue: existingItem,
      id: mutationId,
      itemId,
    });

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('item_deleted', { itemId });
        wsEvents.emit('list_changed', undefined);
      });
    }

    await sleep(duration - setDataAt);
  }

  function getItemHistory(itemId: string): ItemData[] {
    return itemHistory.get(itemId) ?? [];
  }

  // Utility methods for synchronous data retrieval (useful for test setup)
  function getByPrefix(
    prefix: string,
  ): Array<{ itemId: string; data: ItemData }> {
    const result: Array<{ itemId: string; data: ItemData }> = [];
    for (const [itemId, data] of items) {
      if (itemId.startsWith(prefix)) {
        result.push({ itemId, data });
      }
    }
    return result;
  }

  function entries(): Array<[string, ItemData]> {
    return Array.from(items.entries());
  }

  /** Synchronous version of list() for test setup (no network delay) */
  function listSync(options?: ListQueryOptions): ListQueryResult<ItemData> {
    const {
      offset = 0,
      limit,
      itemIds: filterItemIds,
      filters,
      tableId,
      fields,
    } = options ?? {};

    if (tableId && !knownTableIds.has(tableId)) {
      throw new Error(`Table not found: ${tableId}`);
    }

    let entriesArr = Array.from(items.entries());

    if (tableId) {
      const prefix = `${tableId}||`;
      entriesArr = entriesArr.filter(([itemId]) => itemId.startsWith(prefix));
    }

    if (filterItemIds) {
      entriesArr = entriesArr.filter(([itemId]) =>
        filterItemIds.includes(itemId),
      );
    }

    if (filters && filters.length > 0) {
      entriesArr = entriesArr.filter(([, data]) => applyFilters(data, filters));
    }

    const totalCount = entriesArr.length;
    const startIndex = offset;
    const endIndex = limit !== undefined ? offset + limit : totalCount;

    const paginatedEntries = entriesArr.slice(startIndex, endIndex);
    const hasMore = endIndex < totalCount;

    return {
      items: paginatedEntries.map(([itemId, data]) => ({
        itemId,
        data: fields && fields.length > 0 ? selectFields(data, fields) : data,
      })),
      hasMore,
    };
  }

  return {
    fetch,
    list,
    listSync,
    get,
    getAll,
    getByPrefix,
    entries,
    setItem,
    removeItem,
    updateItem,
    emulateClientMutation,
    addItem: addItemToServer,
    addItemWithAutoGeneratedKey,
    deleteItem: deleteItemFromServer,
    wsEvents,
    getItemHistory,
    setFetchDurations(itemId: string, ...durations: number[]) {
      const existing = customFetchDurations.get(itemId) ?? [];
      existing.push(...durations);
      customFetchDurations.set(itemId, existing);
    },
    setNextFetchError(itemId: string, error: FetchErrorConfig | string) {
      nextFetchErrors.set(
        itemId,
        typeof error === 'string' ? { message: error } : error,
      );
    },
    setNextListFetchError(error: FetchErrorConfig | string) {
      nextListFetchError =
        typeof error === 'string' ? { message: error } : error;
    },
    getNextFetchError(itemId: string): FetchErrorConfig | undefined {
      const error = nextFetchErrors.get(itemId);
      if (error) {
        nextFetchErrors.delete(itemId);
      }
      return error;
    },
    get numOfStartedFetches() {
      return numOfStartedFetches;
    },
    get numOfFinishedFetches() {
      return numOfFinishedFetches;
    },
    get fetchHistory() {
      return fetchHistory;
    },
  };
}
