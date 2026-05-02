import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
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
import type { ListQueryStore } from '../../src/listQueryStore/listQueryStore';
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  createListQueryStoreTestEnv,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  advanceTime,
  flushAllTimers,
  pick,
  range,
} from '../utils/genericTestUtils';

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
};

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({
    id,
    name: `User ${id}`,
    address: `Address ${id}`,
    age: id * 10,
    country: `Country ${id}`,
  })),
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

describe('useItem with partial resources', () => {
  test('getItemFromStateOrFetch forwards requested fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const resultPromise = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: ['id', 'name'],
    });

    await flushAllTimers();

    const result = await resultPromise;

    expect(result.ok ? result.value : null).toMatchInlineSnapshot(`
      id: 1
      name: 'User 1'
    `);
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['id', 'name']
            itemId: 'users||1'
      `);
  });

  test('getItemFromStateOrFetch fetches fields missing from cached state', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const listResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name'] },
    );
    await flushAllTimers();
    await listResultPromise;

    const itemResultPromise = env.apiStore.getItemFromStateOrFetch('users||1', {
      fields: ['id', 'name', 'address', 'country'],
    });
    await flushAllTimers();

    const itemResult = await itemResultPromise;

    expect(itemResult.ok ? itemResult.value : null).toMatchInlineSnapshot(`
      address: 'Address 1'
      country: 'Country 1'
      id: 1
      name: 'User 1'
    `);
    expect(env.serverTable.getRequestHistory('all', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
        - _type: 'item'
          payload:
            fields: ['address', 'country']
            itemId: 'users||1'
      `);
  });

  test('getItemFromStateOrFetch hits cache when requested fields are loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const firstResultPromise = env.apiStore.getItemFromStateOrFetch(
      'users||1',
      { fields: ['id', 'name', 'address'] },
    );
    await flushAllTimers();
    await firstResultPromise;

    env.serverTable.fetchHistory.length = 0;

    const secondResult = await env.apiStore.getItemFromStateOrFetch(
      'users||1',
      { fields: ['id', 'name'] },
    );

    expect(secondResult.ok ? secondResult.value : null).toMatchInlineSnapshot(`
      address: 'Address 1'
      id: 1
      name: 'User 1'
    `);
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('getItemFromStateOrFetch refetches a stale requested field when stale state is ignored', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const firstResultPromise = env.apiStore.getItemFromStateOrFetch(
      'users||1',
      { fields: ['id', 'name', 'address'] },
    );
    await flushAllTimers();
    await firstResultPromise;

    env.serverTable.updateItem('users||1', { address: 'Fresh Address 1' });
    env.apiStore.invalidateQueryAndItems({
      itemPayload: 'users||1',
      queryPayload: false,
      fields: ['address'],
    });
    env.serverTable.fetchHistory.length = 0;

    const freshResultPromise = env.apiStore.getItemFromStateOrFetch(
      'users||1',
      { fields: ['id', 'name', 'address'], ignoreStaleState: true },
    );
    await flushAllTimers();

    const freshResult = await freshResultPromise;

    expect(freshResult.ok ? freshResult.value : null).toMatchInlineSnapshot(`
      address: 'Fresh Address 1'
      id: 1
      name: 'User 1'
    `);
    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload:
            fields: ['address']
            itemId: 'users||1'
      `);
  });

  test('load only the selected fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name', 'address'],
      });

      renders.add(pick(result, ['status', 'data', 'error']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null ⋅ error: null
      -> status: success ⋅ data: {id:1, name:User 1, address:Address 1} ⋅ error: null
      "
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'address']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('fields "*" loads full item without projection', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: '*',
      });

      renders.add(pick(result, ['status', 'data', 'error']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null ⋅ error: null
      ┌─
      ⋅ status: success
      ⋅ data: {id:1, name:User 1, address:Address 1, age:10, country:Country 1}
      ⋅ error: null
      └─
      "
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('fields expand (3 -> 4): refetch triggers, data accumulates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ fields }: { fields: string[] }) => {
        const result = env.apiStore.useItem('users||1', {
          returnRefetchingStatus: true,
          fields,
        });

        renders.add(pick(result, ['status', 'data', 'error']));
      },
      { initialProps: { fields: ['id', 'name', 'address'] } },
    );

    await flushAllTimers();

    renders.addMark('Expand fields');

    act(() => {
      rerender({ fields: ['id', 'name', 'address', 'country'] });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null ⋅ error: null
      -> status: success ⋅ data: {id:1, name:User 1, address:Address 1} ⋅ error: null

      >>> Expand fields

      -> status: loading ⋅ data: null ⋅ error: null
      ┌─
      ⋅ status: success
      ⋅ data: {id:1, name:User 1, address:Address 1, country:Country 1}
      ⋅ error: null
      └─
      "
    `);

    // Verify accumulated data in store (has all fields)
    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['address', 'country', 'id', 'name']`);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'address']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['country']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('fields reduce (4 -> 3): cache hit, no fetch, instant success', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ fields }: { fields: string[] }) => {
        const result = env.apiStore.useItem('users||1', {
          returnRefetchingStatus: true,
          fields,
        });

        renders.add(pick(result, ['status', 'data', 'error']));
      },
      { initialProps: { fields: ['id', 'name', 'address', 'country'] } },
    );

    await flushAllTimers();

    renders.addMark('Reduce fields');

    act(() => {
      rerender({ fields: ['id', 'name', 'address'] });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null ⋅ error: null
      ┌─
      ⋅ status: success
      ⋅ data: {id:1, name:User 1, address:Address 1, country:Country 1}
      ⋅ error: null
      └─

      >>> Reduce fields

      -> status: success ⋅ data: {id:1, name:User 1, address:Address 1} ⋅ error: null
      "
    `);

    // Only the initial fetch - no refetch on field reduction (cache hit)
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'address', 'country']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('switching fields while loading still fetches the new missing fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const { result, rerender } = renderHook(
      ({ fields }: { fields: string[] }) =>
        env.apiStore.useItem('users||1', {
          returnRefetchingStatus: true,
          fields,
        }),
      { initialProps: { fields: ['id'] } },
    );

    await advanceTime(100);

    act(() => {
      rerender({ fields: ['name'] });
    });

    await flushAllTimers();

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['name']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
    expect(pick(result.current, ['status', 'data', 'error']))
      .toMatchInlineSnapshot(`
        data: { name: 'User 1' }
        error: null
        status: 'success'
      `);
  });
});

describe('useListQuery with partial resources', () => {
  test('getQueryFromStateOrFetch forwards requested fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const resultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name'] },
    );

    await flushAllTimers();

    const result = await resultPromise;

    expect(result.ok ? result.value.items[0]?.data : null)
      .toMatchInlineSnapshot(`
        id: 1
        name: 'User 1'
      `);
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
  });

  test('getQueryFromStateOrFetch fetches all requested fields when cached query is missing fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const firstResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name'] },
    );
    await flushAllTimers();
    await firstResultPromise;

    // The follow-up query may return different items than the cached query.
    // Fetch the full requested field set so newly returned items are complete.
    env.serverTable.setItem('users||6', {
      id: 6,
      name: 'User 6',
      address: 'Address 6',
      age: 60,
      country: 'Country 6',
    });

    const secondResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name', 'address', 'country'] },
    );
    await flushAllTimers();

    const secondResult = await secondResultPromise;

    expect(secondResult.ok ? secondResult.value.items[0]?.data : null)
      .toMatchInlineSnapshot(`
        address: 'Address 1'
        country: 'Country 1'
        id: 1
        name: 'User 1'
      `);
    expect(
      secondResult.ok
        ? secondResult.value.items.find(
            (item) => item.itemPayload === 'users||6',
          )?.data
        : null,
    ).toMatchInlineSnapshot(`
      address: 'Address 6'
      country: 'Country 6'
      id: 6
      name: 'User 6'
    `);
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
        - _type: 'list'
          payload:
            fields: ['id', 'name', 'address', 'country']
            pos: { limit: 50, offset: 0 }
          returned_items: 6
      `);
  });

  test('getQueryFromStateOrFetch hits cache when requested fields are loaded', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const firstResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name', 'address'] },
    );
    await flushAllTimers();
    await firstResultPromise;

    env.serverTable.fetchHistory.length = 0;

    const secondResult = await env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name'] },
    );

    expect(secondResult.ok ? secondResult.value.items[0]?.data : null)
      .toMatchInlineSnapshot(`
        address: 'Address 1'
        id: 1
        name: 'User 1'
      `);
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
  });

  test('getQueryFromStateOrFetch refetches a stale requested field when stale state is ignored', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const firstResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name', 'address'] },
    );
    await flushAllTimers();
    await firstResultPromise;

    env.serverTable.updateItem('users||1', { address: 'Fresh Address 1' });
    env.apiStore.invalidateQueryAndItems({
      itemPayload: 'users||1',
      queryPayload: false,
      fields: ['address'],
    });
    env.serverTable.fetchHistory.length = 0;

    const freshResultPromise = env.apiStore.getQueryFromStateOrFetch(
      { tableId: 'users' },
      { fields: ['id', 'name', 'address'], ignoreStaleState: true },
    );
    await flushAllTimers();

    const freshResult = await freshResultPromise;

    expect(freshResult.ok ? freshResult.value.items[0]?.data : null)
      .toMatchInlineSnapshot(`
        address: 'Fresh Address 1'
        id: 1
        name: 'User 1'
      `);
    expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'list'
          payload:
            fields: ['id', 'name', 'address']
            pos: { limit: 50, offset: 0 }
          returned_items: 5
      `);
  });

  test('load only the selected fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      renders.add(pick(result, ['status', 'items', 'error']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: [] ⋅ error: null
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)] ⋅ error: null
      "
    `);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('fields "*" loads full list items without projection', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: '*' },
      );

      renders.add(pick(result, ['status', 'items', 'error']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: [] ⋅ error: null
      ┌─
      ⋅ status: success
      ⋅ items: [{id:1, name:User 1, address:Address 1, age:10, country:Country 1}, …(4 more)]
      ⋅ error: null
      └─
      "
    `);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('fields expand: refetch with new fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ fields }: { fields: string[] }) => {
        const result = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields },
        );

        renders.add(pick(result, ['status', 'items', 'error']));
      },
      { initialProps: { fields: ['id', 'name'] } },
    );

    await flushAllTimers();

    renders.addMark('Expand fields');

    act(() => {
      rerender({ fields: ['id', 'name', 'address'] });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: [] ⋅ error: null
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)] ⋅ error: null

      >>> Expand fields

      -> status: loading ⋅ items: [] ⋅ error: null
      ┌─
      ⋅ status: success
      ⋅ items: [{id:1, name:User 1, address:Address 1}, …(4 more)]
      ⋅ error: null
      └─
      "
    `);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('fields reduce: cache hit, immediate success', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ fields }: { fields: string[] }) => {
        const result = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields },
        );

        renders.add(pick(result, ['status', 'items', 'error']));
      },
      { initialProps: { fields: ['id', 'name', 'address'] } },
    );

    await flushAllTimers();

    renders.addMark('Reduce fields');

    act(() => {
      rerender({ fields: ['id', 'name'] });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: [] ⋅ error: null
      ┌─
      ⋅ status: success
      ⋅ items: [{id:1, name:User 1, address:Address 1}, …(4 more)]
      ⋅ error: null
      └─

      >>> Reduce fields

      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)] ⋅ error: null
      "
    `);

    // Only the initial fetch - no refetch on field reduction (cache hit)
    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });
});

describe('cross-hook field loading', () => {
  test('hookB loads missing fields and reaches success after hookA', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const hookARenders = createLoggerStore();
    const hookBRenders = createLoggerStore();

    renderHook(() => {
      const resultA = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });

      hookARenders.add(pick(resultA, ['status', 'data']));
    });

    await flushAllTimers();

    renderHook(() => {
      const resultB = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'address'],
      });

      hookBRenders.add(pick(resultB, ['status', 'data']));
    });

    await flushAllTimers();

    expect(hookARenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}
      -> status: refetching ⋅ data: {id:1, name:User 1}
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(hookBRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, address:Address 1}
      "
    `);

    // Verify accumulated fields in store
    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['address', 'id', 'name']`);

    // The underlying item should have all accumulated data
    expect(env.store.state.items[storeItemKey]).toMatchInlineSnapshot(`
      address: 'Address 1'
      id: 1
      name: 'User 1'
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['address']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('hookA and hookB mounted together both reach success', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const hookARenders = createLoggerStore();
    const hookBRenders = createLoggerStore();

    renderHook(() => {
      const resultA = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });

      const resultB = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'address'],
      });

      hookARenders.add(pick(resultA, ['status', 'data']));
      hookBRenders.add(pick(resultB, ['status', 'data']));
    });

    await flushAllTimers();

    expect(hookARenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(hookBRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, address:Address 1}
      "
    `);

    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['address', 'id', 'name']`);

    expect(env.store.state.items[storeItemKey]).toMatchInlineSnapshot(`
      address: 'Address 1'
      id: 1
      name: 'User 1'
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['address', 'id', 'name']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });
});

describe('deleteItemState with partial resources', () => {
  test('clears itemLoadedFields entry', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    renderHook(() => {
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });
    });

    await flushAllTimers();

    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['id', 'name']`);

    act(() => {
      env.apiStore.deleteItemState('users||1');
    });

    expect(env.store.state.itemLoadedFields[storeItemKey]).toBeUndefined();
    expect(env.store.state.items[storeItemKey]).toBeNull();

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });
});

describe('updateItemState with partial resources', () => {
  test('works correctly with accumulated data', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name', 'address'],
      });

      renders.add(pick(result, ['status', 'data']));
    });

    await flushAllTimers();

    act(() => {
      env.apiStore.updateItemState('users||1', (draft) => {
        draft['name'] = 'Updated Name';
      });
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1, address:Address 1}
      -> status: success ⋅ data: {id:1, name:Updated Name, address:Address 1}
      "
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name', 'address']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });
});

describe('invalidateQueryAndItems with fields', () => {
  test('per-field invalidation: only hooks requesting invalidated fields refetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const nameHookRenders = createLoggerStore();
    const addressHookRenders = createLoggerStore();

    renderHook(() => {
      const nameResult = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });

      const addressResult = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'address'],
      });

      nameHookRenders.add(pick(nameResult, ['status', 'data']));
      addressHookRenders.add(pick(addressResult, ['status', 'data']));
    });

    await flushAllTimers();

    nameHookRenders.addMark('Invalidate address field');
    addressHookRenders.addMark('Invalidate address field');

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        fields: ['address'],
      });
    });

    await flushAllTimers();

    expect(nameHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}

      >>> Invalidate address field

      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(addressHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, address:Address 1}

      >>> Invalidate address field

      -> status: success ⋅ data: {id:1, address:Address 1}
      -> status: refetching ⋅ data: {id:1, address:Address 1}
      -> status: success ⋅ data: {id:1, address:Address 1}
      "
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['address', 'id', 'name']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['address']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('invalidation without fields: clears all loaded fields, all hooks refetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const nameHookRenders = createLoggerStore();
    const addressHookRenders = createLoggerStore();

    renderHook(() => {
      const nameResult = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });

      const addressResult = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'address'],
      });

      nameHookRenders.add(pick(nameResult, ['status', 'data']));
      addressHookRenders.add(pick(addressResult, ['status', 'data']));
    });

    await flushAllTimers();

    nameHookRenders.addMark('Invalidate all fields');
    addressHookRenders.addMark('Invalidate all fields');

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
      });
    });

    await flushAllTimers();

    expect(nameHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}

      >>> Invalidate all fields

      -> status: success ⋅ data: {id:1, name:User 1}
      -> status: refetching ⋅ data: {id:1, name:User 1}
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(addressHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, address:Address 1}

      >>> Invalidate all fields

      -> status: success ⋅ data: {id:1, address:Address 1}
      -> status: refetching ⋅ data: {id:1, address:Address 1}
      -> status: success ⋅ data: {id:1, address:Address 1}
      "
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['address', 'id', 'name']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['address', 'id', 'name']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('per-field invalidation keeps the highest emitted priority for mounted full-resource hooks', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const emittedPriorities: string[] = [];
    const stopListening = env.apiStore.events.on(
      'invalidateItem',
      ({ payload }) => {
        emittedPriorities.push(payload.priority);
      },
    );

    renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: '*',
      }),
    );
    await flushAllTimers();

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        type: 'highPriority',
        fields: ['age'],
      });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        type: 'lowPriority',
        fields: ['name'],
      });
    });
    await flushAllTimers();
    stopListening();

    expect(emittedPriorities).toMatchInlineSnapshot(
      `['highPriority', 'highPriority']`,
    );
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['age', 'name']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('upgrading field invalidation priority from low to high should escalate throttled full-list refetches', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
      lowPriorityThrottleMs: 5_000,
    });

    renderHook(() =>
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: '*' },
      ),
    );

    await flushAllTimers();

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        type: 'lowPriority',
        fields: ['name'],
      });
    });

    await advanceTime(50);

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        type: 'highPriority',
        fields: ['name'],
      });
    });

    await flushAllTimers();

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '870ms -> 1.67s | duration: 800ms'
    `);
  });

  test('full invalidation still clears all fields after a higher-priority field invalidation', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const primeHook = renderHook(() =>
      env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name', 'age'],
      }),
    );
    await flushAllTimers();
    primeHook.unmount();

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        type: 'highPriority',
        fields: ['age'],
      });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        type: 'lowPriority',
      });
    });

    const itemKey = env.getStoreItemKeyFromRaw('users||1');
    expect({
      itemLoadedFields: env.store.state.itemLoadedFields[itemKey],
      itemFieldInvalidationFields:
        env.store.state.itemFieldInvalidationFields[itemKey],
      refetchOnMount: env.store.state.itemQueries[itemKey]?.refetchOnMount,
    }).toMatchInlineSnapshot(`
      itemLoadedFields: []
      refetchOnMount: 'highPriority'
    `);

    const nameHookRenders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['name'],
      });

      nameHookRenders.add(pick(result, ['status', 'data']));
    });

    await flushAllTimers();

    expect(nameHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {name:User 1}
      -> status: refetching ⋅ data: {name:User 1}
      -> status: success ⋅ data: {name:User 1}
      "
    `);
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['name', 'age']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['name']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('useListQuery per-field invalidation: affected hook stays refetching and list query refetches', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const { unmount } = renderHook(() => {
      env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name', 'address'] },
      );
    });

    await flushAllTimers();
    unmount();

    const nameHookRenders = createLoggerStore();
    const addressHookRenders = createLoggerStore();

    renderHook(() => {
      const nameResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      const addressResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'address'] },
      );

      nameHookRenders.add(pick(nameResult, ['status', 'items']));
      addressHookRenders.add(pick(addressResult, ['status', 'items']));
    });

    await flushAllTimers();

    nameHookRenders.addMark('Invalidate address field');
    addressHookRenders.addMark('Invalidate address field');

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
        fields: ['address'],
      });
    });

    await flushAllTimers();

    expect(nameHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)]

      >>> Invalidate address field

      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)]
      -> status: refetching ⋅ items: [{id:1, name:User 1}, …(4 more)]
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)]
      "
    `);
    expect(addressHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{id:1, address:Address 1}, …(4 more)]

      >>> Invalidate address field

      -> status: refetching ⋅ items: [{id:1, address:Address 1}, …(4 more)]
      -> status: success ⋅ items: [{id:1, address:Address 1}, …(4 more)]
      "
    `);
    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('useListQuery invalidation without fields: clears loaded fields and refetches the list hook', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      renders.add(pick(result, ['status', 'items']));
    });

    await flushAllTimers();

    renders.addMark('Invalidate all fields');

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        itemPayload: 'users||1',
        queryPayload: false,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)]

      >>> Invalidate all fields

      -> status: refetching ⋅ items: [{id:1, name:User 1}, …(4 more)]
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)]
      "
    `);
    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('switching list fields while loading still triggers a follow-up list fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const { result, rerender } = renderHook(
      ({ fields }: { fields: string[] }) =>
        env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields },
        ),
      { initialProps: { fields: ['id'] } },
    );

    await advanceTime(100);

    act(() => {
      rerender({ fields: ['name'] });
    });

    await flushAllTimers();

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['name']
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '820ms -> 1.62s | duration: 800ms'
    `);
    expect({
      status: result.current.status,
      firstItem: result.current.items[0],
      error: result.current.error,
    }).toMatchInlineSnapshot(`
      error: null
      firstItem: { name: 'User 1' }
      status: 'success'
    `);
  });
});

describe('RTU with partial resources', () => {
  test('RTU invalidation: refetch uses current hook fields, data merges correctly', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      usesRealTimeUpdates: true,
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        fields: ['id', 'name'],
      });

      renders.add(pick(result, ['status', 'data']));
    });

    await flushAllTimers();

    renders.addMark('Server update + RTU');

    // Simulate a server update that triggers RTU
    act(() => {
      env.serverTable.setItem(
        'users||1',
        {
          id: 1,
          name: 'Updated User 1',
          address: 'Address 1',
          age: 10,
          country: 'Country 1',
        },
        { triggerRTUEvent: true },
      );
    });

    await advanceTime(50);
    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}

      >>> Server update + RTU

      -> status: success ⋅ data: {id:1, name:User 1}
      -> status: refetching ⋅ data: {id:1, name:User 1}
      -> status: success ⋅ data: {id:1, name:Updated User 1}
      "
    `);

    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload:
          fields: ['id', 'name']
          itemId: 'users||1'
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'item'
        payload:
          fields: ['id', 'name']
          itemId: 'users||1'
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });
});

describe('await* preload with partial resources', () => {
  test('awaitItemFetch with fields "*" satisfies later field hook without refetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const preloadPromise = env.apiStore.awaitItemFetch('users||1', {
      fields: '*',
    });

    await flushAllTimers();
    await preloadPromise;

    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });

      renders.add(pick(result, ['status', 'data']));
    });

    await flushAllTimers();

    expect(env.store.state.itemLoadedFields[storeItemKey])
      .toMatchInlineSnapshot(`
        ['address', 'age', 'country', 'id', 'name']
      `);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    // Only the preload fetch with '*' - no refetch from hook (cache hit)
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('awaitListQueryFetch with fields "*" satisfies later list hook without refetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const preloadPromise = env.apiStore.awaitListQueryFetch(
      { tableId: 'users' },
      { fields: '*' },
    );

    await flushAllTimers();
    await preloadPromise;

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      renders.add(pick(result, ['status', 'items']));
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ items: [{id:1, name:User 1}, …(4 more)]
      "
    `);

    // Only the preload fetch with '*' - no refetch from hook (cache hit)
    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('fetch methods accept fields "*"', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    expect(() =>
      env.apiStore.scheduleItemFetch('highPriority', 'users||1', {
        fields: '*',
      }),
    ).not.toThrow();
    await flushAllTimers();

    expect(() =>
      env.apiStore.scheduleListQueryFetch(
        'highPriority',
        { tableId: 'users' },
        2,
        { fields: '*' },
      ),
    ).not.toThrow();
    await flushAllTimers();

    expect(() =>
      env.apiStore.loadMore({ tableId: 'users' }, { size: 2, fields: '*' }),
    ).not.toThrow();
    await flushAllTimers();

    const awaitItemPromise = env.apiStore.awaitItemFetch('users||2', {
      fields: '*',
    });
    const awaitListPromise = env.apiStore.awaitListQueryFetch(
      { tableId: 'users' },
      { fields: '*' },
    );

    await flushAllTimers();

    await expect(awaitItemPromise).resolves.toMatchInlineSnapshot(`
      data: { address: 'Address 2', age: 20, country: 'Country 2', id: 2, name: 'User 2' }
      error: null
    `);
    await expect(awaitListPromise).resolves.toMatchInlineSnapshot(`
      error: null
      hasMore: '❌'
      items:
        - data: { address: 'Address 1', age: 10, country: 'Country 1', id: 1, name: 'User 1' }
          itemPayload: 'users||1'
        - data: { address: 'Address 2', age: 20, country: 'Country 2', id: 2, name: 'User 2' }
          itemPayload: 'users||2'
        - data: { address: 'Address 3', age: 30, country: 'Country 3', id: 3, name: 'User 3' }
          itemPayload: 'users||3'
        - data: { address: 'Address 4', age: 40, country: 'Country 4', id: 4, name: 'User 4' }
          itemPayload: 'users||4'
        - data: { address: 'Address 5', age: 50, country: 'Country 5', id: 5, name: 'User 5' }
          itemPayload: 'users||5'
    `);

    // All fetches should have no fields (fields '*' = no projection)
    expect(env.serverTable.getRequestHistory('all')).toMatchInlineSnapshot(`
      - _type: 'item'
        payload: { itemId: 'users||1' }
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '820ms -> 1.62s | duration: 800ms'
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 4, offset: 0 }
        returned_items: 4
        time: '1.63s -> 2.43s | duration: 800ms'
      - _type: 'item'
        payload: { itemId: 'users||2' }
        time: '2.44s -> 3.24s | duration: 800ms'
      - _type: 'list'
        payload:
          fields: '*'
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '2.44s -> 3.24s | duration: 800ms'
    `);
  });

  test('fetch methods throw when fields is missing', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });
    const apiStore = __LEGIT_CAST__<
      {
        scheduleItemFetch: (
          fetchType: string,
          payload: string,
          options?: unknown,
        ) => unknown;
        scheduleListQueryFetch: (
          fetchType: string,
          payload: { tableId: string },
          size?: number,
          options?: unknown,
        ) => unknown;
        awaitItemFetch: (
          payload: string,
          options?: unknown,
        ) => Promise<unknown>;
        awaitListQueryFetch: (
          payload: { tableId: string },
          options?: unknown,
        ) => Promise<unknown>;
        loadMore: (...args: unknown[]) => unknown;
      },
      unknown
    >(env.apiStore);

    expect(() =>
      apiStore.scheduleItemFetch('highPriority', 'users||1'),
    ).toThrow('fields option is required when partialResources is enabled');

    expect(() =>
      apiStore.scheduleListQueryFetch('highPriority', { tableId: 'users' }),
    ).toThrow('fields option is required when partialResources is enabled');

    await expect(apiStore.awaitItemFetch('users||1')).rejects.toThrow(
      'fields option is required when partialResources is enabled',
    );

    await expect(
      apiStore.awaitListQueryFetch({ tableId: 'users' }),
    ).rejects.toThrow(
      'fields option is required when partialResources is enabled',
    );

    env.apiStore.scheduleListQueryFetch(
      'highPriority',
      { tableId: 'users' },
      undefined,
      { fields: ['id', 'name'] },
    );
    await flushAllTimers();

    expect(() => apiStore.loadMore({ tableId: 'users' })).toThrow(
      'fields option is required when partialResources is enabled',
    );
  });
});

describe('type safety: fields requirement with partialResources', () => {
  test('fields is required in hooks when partialResources is enabled', () => {
    const store = __LEGIT_CAST__<
      ListQueryStore<Row, string, string, true>,
      undefined
    >(undefined);

    // Type-only test: function is never called to avoid React hook errors
    function typeCheck_() {
      // @ts-expect-error - useItem requires fields when partialResources is enabled
      store.useItem('id');

      store.useItem('id', { fields: ['name'] });
      store.useItem('id', { fields: '*' });

      // @ts-expect-error - useListQuery requires fields when partialResources is enabled
      store.useListQuery('payload');

      store.useListQuery('payload', { fields: ['name'] });
      store.useListQuery('payload', { fields: '*' });

      // @ts-expect-error - useMultipleItems requires fields when partialResources is enabled
      store.useMultipleItems([{ payload: 'id' }]);

      store.useMultipleItems([{ payload: 'id', fields: ['name'] }]);
      store.useMultipleItems([{ payload: 'id', fields: '*' }]);

      // @ts-expect-error - useMultipleListQueries requires fields when partialResources is enabled
      store.useMultipleListQueries([{ payload: 'payload' }]);

      store.useMultipleListQueries([{ payload: 'payload', fields: ['name'] }]);
      store.useMultipleListQueries([{ payload: 'payload', fields: '*' }]);

      // @ts-expect-error - scheduleItemFetch requires fields when partialResources is enabled
      store.scheduleItemFetch('highPriority', 'id');

      store.scheduleItemFetch('highPriority', 'id', { fields: ['name'] });
      store.scheduleItemFetch('highPriority', 'id', { fields: '*' });

      // @ts-expect-error - scheduleListQueryFetch requires fields when partialResources is enabled
      store.scheduleListQueryFetch('highPriority', 'payload');

      store.scheduleListQueryFetch('highPriority', 'payload', undefined, {
        fields: ['name'],
      });
      store.scheduleListQueryFetch('highPriority', 'payload', undefined, {
        fields: '*',
      });

      // @ts-expect-error - loadMore requires fields when partialResources is enabled
      store.loadMore('payload');

      store.loadMore('payload', { fields: ['name'] });
      store.loadMore('payload', { fields: '*' });

      // @ts-expect-error - awaitItemFetch requires fields when partialResources is enabled
      void store.awaitItemFetch('id');

      void store.awaitItemFetch('id', { fields: ['name'] });
      void store.awaitItemFetch('id', { fields: '*' });

      // @ts-expect-error - awaitListQueryFetch requires fields when partialResources is enabled
      void store.awaitListQueryFetch('payload');

      void store.awaitListQueryFetch('payload', { fields: ['name'] });
      void store.awaitListQueryFetch('payload', { fields: '*' });
    }

    void typeCheck_;
    expect(true).toBe(true); // Dummy assertion to satisfy test requirements
  });

  test('fields is optional in hooks when partialResources is not enabled', () => {
    const store = __LEGIT_CAST__<
      ListQueryStore<Row, string, string>,
      undefined
    >(undefined);

    function typeCheck_() {
      store.useItem('id');
      store.useListQuery('payload');
      store.useMultipleItems([{ payload: 'id' }]);
      store.useMultipleListQueries([{ payload: 'payload' }]);

      store.useItem('id', { fields: ['name'] });
      store.useItem('id', { fields: '*' });
      store.useListQuery('payload', { fields: ['name'] });
      store.useListQuery('payload', { fields: '*' });
      store.useMultipleItems([{ payload: 'id', fields: ['name'] }]);
      store.useMultipleItems([{ payload: 'id', fields: '*' }]);
      store.useMultipleListQueries([{ payload: 'payload', fields: ['name'] }]);
      store.useMultipleListQueries([{ payload: 'payload', fields: '*' }]);

      store.scheduleItemFetch('highPriority', 'id');
      store.scheduleListQueryFetch('highPriority', 'payload');
      store.loadMore('payload');
      void store.awaitItemFetch('id');
      void store.awaitListQueryFetch('payload');

      store.scheduleItemFetch('highPriority', 'id', { fields: ['name'] });
      store.scheduleItemFetch('highPriority', 'id', { fields: '*' });
      store.scheduleListQueryFetch('highPriority', 'payload', undefined, {
        fields: ['name'],
      });
      store.scheduleListQueryFetch('highPriority', 'payload', undefined, {
        fields: '*',
      });
      store.loadMore('payload', { fields: ['name'] });
      store.loadMore('payload', { fields: '*' });
      void store.awaitItemFetch('id', { fields: ['name'] });
      void store.awaitItemFetch('id', { fields: '*' });
      void store.awaitListQueryFetch('payload', { fields: ['name'] });
      void store.awaitListQueryFetch('payload', { fields: '*' });
    }

    void typeCheck_;
    expect(true).toBe(true); // Dummy assertion to satisfy test requirements
  });
});
