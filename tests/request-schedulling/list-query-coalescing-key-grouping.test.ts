import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

const serverData = {
  table1: [
    { id: 1, name: 'Item 1' },
    { id: 2, name: 'Item 2' },
    { id: 3, name: 'Item 3' },
    { id: 4, name: 'Item 4' },
    { id: 5, name: 'Item 5' },
    { id: 6, name: 'Item 6' },
  ],
};

const multiTableServerData = {
  table1: [
    { id: 1, name: 'Table 1 Item 1' },
    { id: 2, name: 'Table 1 Item 2' },
    { id: 3, name: 'Table 1 Item 3' },
    { id: 4, name: 'Table 1 Item 4' },
  ],
  table2: [
    { id: 1, name: 'Table 2 Item 1' },
    { id: 2, name: 'Table 2 Item 2' },
    { id: 3, name: 'Table 2 Item 3' },
    { id: 4, name: 'Table 2 Item 4' },
  ],
};

describe('list query coalescing key grouping', () => {
  test('different payloads with same coalescing key share one window but do not payload-coalesce', async () => {
    const env = createListQueryStoreTestEnv(serverData, {
      baseCoalescingWindowMs: 100,
      defaultQuerySize: 2,
      getListQueryCoalescingKey: ({ tableId }) => tableId,
    });

    const firstQuery: ListQueryParams = {
      tableId: 'table1',
      filters: [{ op: 'lte', field: 'id', value: 2 }],
    };
    const secondQuery: ListQueryParams = {
      tableId: 'table1',
      filters: [{ op: 'gte', field: 'id', value: 5 }],
    };

    const firstResult = env.scheduleFetch('highPriority', firstQuery, 2);
    expect(firstResult).toBe('triggered');

    await vi.advanceTimersByTimeAsync(30);

    const secondResult = env.scheduleFetch('highPriority', secondQuery, 2);
    expect(secondResult).toBe('added-to-batch');

    await vi.advanceTimersByTimeAsync(69);
    expect(env.serverTable.numOfStartedFetches).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(env.serverTable.numOfStartedFetches).toBe(2);

    await vi.runAllTimersAsync();

    expect(env.apiStore.getQueryState(firstQuery)?.items.length).toBe(2);
    expect(env.apiStore.getQueryState(secondQuery)?.items.length).toBe(2);
    expect(env.serverTable.fetchHistory.length).toBe(2);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - batchKey: 'table1'
        limit: 2
        results:
          - data: { id: 1, name: 'Item 1' }
            itemId: 'table1||1'
          - data: { id: 2, name: 'Item 2' }
            itemId: 'table1||2'
        type: 'list'
      - batchKey: 'table1'
        limit: 2
        results:
          - data: { id: 5, name: 'Item 5' }
            itemId: 'table1||5'
          - data: { id: 6, name: 'Item 6' }
            itemId: 'table1||6'
        type: 'list'
    `);
  });
