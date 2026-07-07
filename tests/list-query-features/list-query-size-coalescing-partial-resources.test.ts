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
    return __LEGIT_CAST__<Row, Record<string, unknown>>(result);
  },
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
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

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 4, offset: 0 }
        returned_items: 4
        time: '50ms -> 850ms | duration: 800ms'
    `);

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

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['address', 'id', 'name']
          pos: { limit: 5, offset: 0 }
        returned_items: 5
        time: '50ms -> 850ms | duration: 800ms'
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

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 5, offset: 0 }
        returned_items: 5
        time: '50ms -> 850ms | duration: 800ms'
    `);

    const itemKey = env.getStoreItemKeyFromRaw('table1||1');
    expect(env.store.state.itemLoadedFields[itemKey]).toMatchInlineSnapshot(
      `"*"`,
    );
  });

  test('request without fields throws when partial resources is enabled', () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 50,
      defaultQuerySize: 2,
      partialResources: partialResourcesConfig,
    });
    const apiStore = __LEGIT_CAST__<
      {
        scheduleListQueryFetch: (
          fetchType: string,
          payload: { tableId: string },
          size?: number,
          options?: unknown,
        ) => unknown;
      },
      unknown
    >(env.apiStore);

    expect(() =>
      apiStore.scheduleListQueryFetch('highPriority', { tableId: 'table1' }, 4),
    ).toThrow('fields option is required when partialResources is enabled');
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

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id']
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '50ms -> 850ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['address', 'id', 'name']
          pos: { limit: 6, offset: 0 }
        returned_items: 6
        time: '900ms -> 1.7s | duration: 800ms'
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

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '50ms -> 850ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['address', 'country', 'id']
          pos: { limit: 4, offset: 0 }
        returned_items: 4
        time: '900ms -> 1.7s | duration: 800ms'
    `);

    const queryAfterFetch = env.apiStore.getQueryState({ tableId: 'table1' });
    expect(queryAfterFetch?.status).toBe('success');
    expect(queryAfterFetch?.items.length).toBe(4);
  });
});
