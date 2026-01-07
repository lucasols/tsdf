import { evtmitter } from 'evtmitter';
import { sleep } from '../../test-old/utils/sleep';

export const DEFAULT_FETCH_DURATION_MS = 800;
export const DEFAULT_MUTATION_DURATION_MS = 1200;
export const DEFAULT_RTU_DELAY_MS = 50;

export type ListQueryOptions<ItemData> = {
  offset?: number;
  limit?: number;
  filter?: (item: ItemData, itemId: string) => boolean;
};

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

export type ActionListener<ItemData> = (
  action: string,
  data?: ItemData | Array<{ itemId: string; data: ItemData }>,
  id?: string | number,
) => void;

export function createServerTableMock<ItemData>(
  initialItems: Record<string, ItemData>,
  listenForActions?: ActionListener<ItemData>,
) {
  const items = new Map<string, ItemData>(Object.entries(initialItems));
  const itemHistory = new Map<string, ItemData[]>();
  const customFetchDurations: number[] = [];

  for (const [itemId, data] of items) {
    itemHistory.set(itemId, [data]);
  }

  const wsEvents = evtmitter<ServerTableEvents<ItemData>>();

  async function fetch(itemId: string, duration?: number): Promise<ItemData> {
    const actualDuration =
      customFetchDurations.shift() ?? duration ?? DEFAULT_FETCH_DURATION_MS;

    listenForActions?.('>fetch-item-started', undefined, itemId);

    await sleep(actualDuration);

    const item = items.get(itemId);
    if (item === undefined) {
      listenForActions?.('<fetch-item-not-found', undefined, itemId);
      throw new Error(`Item not found: ${itemId}`);
    }

    listenForActions?.('<fetch-item-finished', item, itemId);
    return item;
  }

  async function list(
    options?: ListQueryOptions<ItemData>,
  ): Promise<ListQueryResult<ItemData>> {
    const { offset = 0, limit, filter } = options ?? {};

    const actualDuration =
      customFetchDurations.shift() ?? DEFAULT_FETCH_DURATION_MS;

    listenForActions?.('>list-fetch-started');

    await sleep(actualDuration);

    let entries = Array.from(items.entries());

    if (filter) {
      entries = entries.filter(([itemId, data]) => filter(data, itemId));
    }

    const totalCount = entries.length;
    const startIndex = offset;
    const endIndex = limit !== undefined ? offset + limit : totalCount;

    const paginatedEntries = entries.slice(startIndex, endIndex);
    const hasMore = endIndex < totalCount;

    const result: ListQueryResult<ItemData> = {
      items: paginatedEntries.map(([itemId, data]) => ({ itemId, data })),
      hasMore,
    };

    listenForActions?.('<list-fetch-finished', result.items);

    return result;
  }

  function get(itemId: string): ItemData | undefined {
    return items.get(itemId);
  }

  function getAll(): Record<string, ItemData> {
    return Object.fromEntries(items);
  }

  function setItem(itemId: string, data: ItemData): void {
    items.set(itemId, data);

    const history = itemHistory.get(itemId);
    if (history) {
      history.push(data);
    } else {
      itemHistory.set(itemId, [data]);
    }

    listenForActions?.('server-data-changed', data, itemId);
  }

  function removeItem(itemId: string): void {
    items.delete(itemId);
    listenForActions?.('server-item-removed', undefined, itemId);
  }

  async function mutateItem(
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

    listenForActions?.('>mutation-started', newData, mutationId);

    await sleep(setDataAt);

    items.set(itemId, newData);

    const history = itemHistory.get(itemId);
    if (history) {
      history.push(newData);
    } else {
      itemHistory.set(itemId, [newData]);
    }

    if (addServerDataChangeAction) {
      listenForActions?.('server-data-changed', newData, itemId);
    }

    listenForActions?.('<mutation-data-persisted', newData, mutationId);

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('data_changed', { itemId, data: newData });
      });
    }

    await sleep(duration - setDataAt);

    return newData;
  }

  async function addItem(
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

    listenForActions?.('>add-item-started', data, mutationId);

    await sleep(setDataAt);

    items.set(itemId, data);
    itemHistory.set(itemId, [data]);

    if (addServerDataChangeAction) {
      listenForActions?.('server-item-added', data, itemId);
    }

    listenForActions?.('<add-item-persisted', data, mutationId);

    if (triggerRTUEvent) {
      void sleep(DEFAULT_RTU_DELAY_MS).then(() => {
        wsEvents.emit('item_added', { itemId, data });
        wsEvents.emit('list_changed', undefined);
      });
    }

    await sleep(duration - setDataAt);
  }

  async function deleteItem(
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

    listenForActions?.('>delete-item-started', existingItem, mutationId);

    await sleep(setDataAt);

    items.delete(itemId);

    if (addServerDataChangeAction) {
      listenForActions?.('server-item-deleted', existingItem, itemId);
    }

    listenForActions?.('<delete-item-persisted', existingItem, mutationId);

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

  function setFetchDurations(...durations: number[]): void {
    customFetchDurations.push(...durations);
  }

  return {
    fetch,
    list,
    get,
    getAll,
    setItem,
    removeItem,
    mutateItem,
    addItem,
    deleteItem,
    wsEvents,
    getItemHistory,
    setFetchDurations,
  };
}
