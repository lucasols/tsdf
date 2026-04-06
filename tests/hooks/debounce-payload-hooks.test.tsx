import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import '@testing-library/react/dont-cleanup-after-each';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  range,
} from '../utils/genericTestUtils';
import { withSuppressedActError } from '../utils/withSuppressedActError';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
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

afterAll(() => {
  cleanup();
});

async function advanceTrackedTime(ms: number) {
  await withSuppressedActError(async () => {
    await advanceTime(ms);
  });
}

async function flushTrackedTimers() {
  await withSuppressedActError(async () => {
    await flushAllTimers();
  });
}

type Todo = { title: string; completed: boolean };

describe('collection hook payload debounce', () => {
  test('debouncePayload delays rapid payload changes while selection follows the latest payload', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      {
        '1': { title: 'one', completed: false },
        '2': { title: 'two', completed: true },
        '3': { title: 'three', completed: false },
      },
      {
        testScenario: {
          loadedWithStaleData: {
            '1': { title: 'one', completed: false },
            '2': { title: 'two', completed: true },
          },
        },
      },
    );

    const renders = createLoggerStore({
      filterKeys: ['status', 'payload', 'data'],
    });

    const { rerender } = renderHook(
      ({ payload }: { payload: string | false }) => {
        const result = env.apiStore.useItem(payload, {
          debouncePayload: { ms: 100 },
        });

        renders.add({
          status: result.status,
          payload: result.payload,
          data: result.data?.value ?? null,
        });
      },
      { initialProps: { payload: false } },
    );

    renders.reset();

    act(() => {
      rerender({ payload: '1' });
    });
    await advanceTrackedTime(50);

    act(() => {
      rerender({ payload: '2' });
    });
    await advanceTrackedTime(50);

    act(() => {
      rerender({ payload: '3' });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: 1 ⋅ data: {title:one, completed:❌}
      -> status: success ⋅ payload: 2 ⋅ data: {title:two, completed:✅}
      -> status: loading ⋅ payload: 3 ⋅ data: null
      "
    `);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await advanceTrackedTime(99);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await advanceTrackedTime(1);
    await flushTrackedTimers();
    await flushTrackedTimers();

    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: '3' }
      `);
  });

  test('debouncePayload delays fetches while switching between unloaded item payloads', async () => {
    const env = createCollectionStoreTestEnv<Todo>({
      '1': { title: 'one', completed: false },
      '2': { title: 'two', completed: true },
    });

    const renders = createLoggerStore({
      filterKeys: ['status', 'payload', 'data'],
    });

    const { rerender } = renderHook(
      ({ payload }: { payload: string | false }) => {
        const result = env.apiStore.useItem(payload, {
          debouncePayload: { ms: 100 },
        });

        renders.add({
          status: result.status,
          payload: result.payload,
          data: result.data?.value ?? null,
        });
      },
      { initialProps: { payload: false } },
    );

    renders.reset();

    act(() => {
      rerender({ payload: '1' });
    });
    await advanceTrackedTime(50);

    act(() => {
      rerender({ payload: '2' });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: 1 ⋅ data: null
      -> status: loading ⋅ payload: 2 ⋅ data: null
      "
    `);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await advanceTrackedTime(99);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await advanceTrackedTime(1);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await flushTrackedTimers();
    await flushTrackedTimers();

    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: '2' }
      `);

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: loading ⋅ payload: 2 ⋅ data: null
      -> status: success ⋅ payload: 2 ⋅ data: {title:two, completed:✅}
      "
    `);
  });
});

type FetchQueryParams = { tableId: string };

describe('list query hook payload debounce', () => {
  test('debouncePayload delays rapid query payload changes while selection follows the latest payload', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ payload }: { payload: FetchQueryParams | false }) => {
        const queryResult = listQueryStore.useListQuery(payload, {
          debouncePayload: { ms: 100 },
          itemSelector: (data) => data.name,
        });

        renders.add(pick(queryResult, ['status', 'payload', 'items']));
      },
      { initialProps: { payload: false } },
    );

    renders.reset();

    act(() => {
      rerender({ payload: { tableId: 'users' } });
    });
    await advanceTrackedTime(50);

    act(() => {
      rerender({ payload: { tableId: 'products' } });
    });
    await advanceTrackedTime(50);

    act(() => {
      rerender({ payload: { tableId: 'orders' } });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: {tableId:users} ⋅ items: [User 1, …(4 more)]
      -> status: success ⋅ payload: {tableId:products} ⋅ items: [Product 1, …(49 more)]
      -> status: loading ⋅ payload: {tableId:orders} ⋅ items: []
      "
    `);

    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await advanceTrackedTime(99);

    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await flushTrackedTimers();
    await flushTrackedTimers();

    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: '*'
            pos: { limit: 50, offset: 0 }
          returned_items: 50
      `);
  });

  test('debouncePayload maxWait flushes the latest query after repeated payload changes', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ payload }: { payload: FetchQueryParams }) => {
        const queryResult = listQueryStore.useListQuery(payload, {
          debouncePayload: { ms: 300, maxWait: 500 },
          itemSelector: (data) => data.name,
        });

        renders.add(pick(queryResult, ['status', 'payload', 'items']));
      },
      { initialProps: { payload: { tableId: 'orders' } } },
    );

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: {tableId:orders} ⋅ items: []
      "
    `);

    rerender({ payload: { tableId: 'users' } });
    await advanceTrackedTime(200);

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: success ⋅ payload: {tableId:users} ⋅ items: [User 1, …(4 more)]
      "
    `);

    rerender({ payload: { tableId: 'orders' } });
    await advanceTrackedTime(299);

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: loading ⋅ payload: {tableId:orders} ⋅ items: []
      "
    `);

    expect(env.serverTable.numOfStartedFetches).toBe(1);

    await advanceTrackedTime(1);
    await advanceTrackedTime(11);

    expect(env.serverTable.numOfStartedFetches).toBe(1);

    await flushTrackedTimers();

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: loading ⋅ payload: {tableId:orders} ⋅ items: []
      -> status: success ⋅ payload: {tableId:orders} ⋅ items: [Order 1, …(49 more)]
      "
    `);
  });

  test('debouncePayload delays rapid item payload changes while selection follows the latest payload', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { items: ['users||1', 'products||1'] } },
    });
    const listQueryStore = env.apiStore;

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ payload }: { payload: string | false }) => {
        const queryResult = listQueryStore.useItem(payload, {
          debouncePayload: { ms: 100 },
        });

        renders.add(pick(queryResult, ['status', 'payload', 'data']));
      },
      { initialProps: { payload: false } },
    );

    renders.reset();

    rerender({ payload: 'users||1' });
    await advanceTrackedTime(50);

    rerender({ payload: 'products||1' });
    await advanceTrackedTime(50);

    rerender({ payload: 'orders||1' });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ payload: users||1 ⋅ data: {id:1, name:User 1}
      -> status: success ⋅ payload: products||1 ⋅ data: {id:1, name:Product 1}
      -> status: loading ⋅ payload: orders||1 ⋅ data: null
      "
    `);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await advanceTrackedTime(99);

    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);

    await flushTrackedTimers();
    await flushTrackedTimers();

    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: 'orders||1' }
      `);
  });

  test('debouncePayload leading fetches immediately and debounces later payload changes', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);
    const listQueryStore = env.apiStore;

    env.serverTable.setItem('users||100', { id: 100, name: 'User 100' });
    env.serverTable.setItem('users||101', { id: 101, name: 'User 101' });

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ payload }: { payload: string }) => {
        const selectionResult = listQueryStore.useItem(payload, {
          debouncePayload: { ms: 300, leading: true },
          selector: (data) => data?.name ?? null,
        });

        renders.add(
          pick(selectionResult, ['status', 'payload', 'isLoading', 'data']),
        );
      },
      { initialProps: { payload: 'users||100' } },
    );

    await advanceTrackedTime(11);

    expect(env.serverTable.numOfStartedFetches).toBe(1);

    rerender({ payload: 'users||101' });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ payload: users||100 ⋅ isLoading: ✅ ⋅ data: null
      -> status: loading ⋅ payload: users||101 ⋅ isLoading: ✅ ⋅ data: null
      "
    `);

    await advanceTrackedTime(299);
    await advanceTrackedTime(11);

    expect(env.serverTable.numOfStartedFetches).toBe(2);

    await flushTrackedTimers();

    expect(renders.snapshotFromLast).toMatchInlineSnapshot(`
      "
      ⋅⋅⋅
      -> status: loading ⋅ payload: users||101 ⋅ isLoading: ✅ ⋅ data: null
      -> status: success ⋅ payload: users||101 ⋅ isLoading: ❌ ⋅ data: User 101
      "
    `);
  });
});
