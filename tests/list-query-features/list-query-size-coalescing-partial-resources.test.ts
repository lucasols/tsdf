import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  createListQueryStoreTestEnv,
  Row,
  Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

const partialResourcesConfig: PartialResourcesConfig<Row> = {
  mergeItems: (prev, fetched) => {
    if (!prev) return fetched;
    return { ...prev, ...fetched };
  },
  selectFields: (fields, item) => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in item) {
        result[field] = item[field];
      }
    }
    return __LEGIT_CAST__<Row>(result);
  },
};

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

const serverData: Tables = {
  table1: [
    { id: 1, name: 'Item 1', address: 'Address 1', country: 'Country 1' },
    { id: 2, name: 'Item 2', address: 'Address 2', country: 'Country 2' },
    { id: 3, name: 'Item 3', address: 'Address 3', country: 'Country 3' },
    { id: 4, name: 'Item 4', address: 'Address 4', country: 'Country 4' },
    { id: 5, name: 'Item 5', address: 'Address 5', country: 'Country 5' },
    { id: 6, name: 'Item 6', address: 'Address 6', country: 'Country 6' },
  ],
};

describe('query coalescing with partial resources', () => {
  test('same fields with different order still coalesce into one fetch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      2,
      { fields: ['id', 'name'] },
    );
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      4,
      { fields: ['name', 'id'] },
    );

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
        limit: 4
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { id: 4, name: 'Item 4' }
            itemId: 'table1||4'
        type: 'list'
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    const itemKey = env.getStoreItemKeyFromRaw('table1||1');
    expect(env.store.state.itemLoadedFields[itemKey]).toMatchInlineSnapshot(
      `['id', 'name']`,
    );
  });

  test('same query key with different fields and sizes uses merged fields and max size', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      2,
      { fields: ['id', 'name'] },
    );
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      5,
      { fields: ['id', 'address'] },
    );

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['address', 'id', 'name']
        limit: 5
        results:
          - data: { address: 'Address 1', id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { address: 'Address 2', id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { address: 'Address 3', id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { address: 'Address 4', id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { address: 'Address 5', id: 5, name: 'Item 5' }
            itemId: 'table1||5'
        type: 'list'
    `);

    const itemKey = env.getStoreItemKeyFromRaw('table1||1');
    expect(env.store.state.itemLoadedFields[itemKey]).toMatchInlineSnapshot(
      `['address', 'id', 'name']`,
    );
  });

  test('coalescing "*" with specific fields resolves to one full fetch', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      2,
      { fields: '*' },
    );
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      5,
      { fields: ['id', 'address'] },
    );

    await flushAllTimers();

    expect(env.serverTable.numOfFinishedFetches).toBe(1);

    const [firstFetch] = env.serverTable.fetchHistory;
    expect(firstFetch?.type).toBe('list');
    if (firstFetch?.type === 'list') {
      expect(firstFetch.limit).toBe(5);
      expect(firstFetch.fields).toBeUndefined();
    }

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - limit: 5
        results:
          - data: { address: 'Address 1', country: 'Country 1', id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { address: 'Address 2', country: 'Country 2', id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { address: 'Address 3', country: 'Country 3', id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { address: 'Address 4', country: 'Country 4', id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { address: 'Address 5', country: 'Country 5', id: 5, name: 'Item 5' }
            itemId: 'table1||5'
        type: 'list'
    `);

    const itemKey = env.getStoreItemKeyFromRaw('table1||1');
    expect(env.store.state.itemLoadedFields[itemKey]).toMatchInlineSnapshot(
      `['address', 'country', 'id', 'name']`,
    );
  });

  test('request without fields throws when partial resources is enabled', () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });
    const apiStore = __LEGIT_CAST__<{
      scheduleListQueryFetch: (
        fetchType: string,
        payload: { tableId: string },
        size?: number,
        options?: unknown,
      ) => unknown;
    }>(env.apiStore);

    expect(() =>
      apiStore.scheduleListQueryFetch('highPriority', { tableId: 'table1' }, 4),
    ).toThrowError(
      'fields option is required when partialResources is enabled',
    );
  });
});

describe('size and field coalescing in scheduledRequests during active fetch', () => {
  test('requests during fetch coalesce to merged fields and max size', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      2,
      { fields: ['id'] },
    );

    await vi.advanceTimersByTimeAsync(60);

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      3,
      { fields: ['id', 'name'] },
    );
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      6,
      { fields: ['id', 'address'] },
    );

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id']
        limit: 2
        results:
          - data: { id: 1 }
            itemId: 'table1||1'
          - data: { id: 2 }
            itemId: 'table1||2'
        type: 'list'
      - fields: ['address', 'id', 'name']
        limit: 6
        results:
          - data: { address: 'Address 1', id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { address: 'Address 2', id: 2, name: 'Item 2' }
            itemId: 'table1||2'
          - data: { address: 'Address 3', id: 3, name: 'Item 3' }
            itemId: 'table1||3'
          - data: { address: 'Address 4', id: 4, name: 'Item 4' }
            itemId: 'table1||4'
          - data: { address: 'Address 5', id: 5, name: 'Item 5' }
            itemId: 'table1||5'
          - data: { address: 'Address 6', id: 6, name: 'Item 6' }
            itemId: 'table1||6'
        type: 'list'
    `);
  });

  test('loadMore + load coalesce as loadMore with merged fields and max size', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      2,
      { fields: ['id', 'name'] },
    );
    await flushAllTimers();

    env.apiStore.loadMore({ tableId: 'table1' }, 2, {
      fields: ['id', 'address'],
    });
    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'table1' },
      3,
      { fields: ['id', 'country'] },
    );

    await vi.advanceTimersByTimeAsync(60);

    // 'loadMore' type wins over 'load' in size mode coalescePayload → status is 'loadingMore'
    const queryDuringFetch = env.apiStore.getQueryState({ tableId: 'table1' });
    expect(queryDuringFetch?.status).toBe('loadingMore');

    await flushAllTimers();

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
        limit: 2
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        type: 'list'
      - fields: ['address', 'country', 'id']
        limit: 4
        results:
          - data: { address: 'Address 1', country: 'Country 1', id: 1 }
            itemId: 'table1||1'
          - data: { address: 'Address 2', country: 'Country 2', id: 2 }
            itemId: 'table1||2'
          - data: { address: 'Address 3', country: 'Country 3', id: 3 }
            itemId: 'table1||3'
          - data: { address: 'Address 4', country: 'Country 4', id: 4 }
            itemId: 'table1||4'
        type: 'list'
    `);

    const queryAfterFetch = env.apiStore.getQueryState({ tableId: 'table1' });
    expect(queryAfterFetch?.status).toBe('success');
    expect(queryAfterFetch?.items.length).toBe(4);
  });
});
