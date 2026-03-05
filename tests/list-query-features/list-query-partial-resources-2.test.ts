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
import type { PartialResourcesConfig } from '../../src/listQueryStore/types';
import {
  createListQueryStoreTestEnv,
  type Row,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick, range } from '../utils/genericTestUtils';

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
  users: range(1, 10).map((id) => ({
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

describe('list then load item: cross-source field accumulation', () => {
  test('load list then load item with less but common fields: cache hit', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const listRenders = createLoggerStore();
    const itemRenders = createLoggerStore();

    const { rerender } = renderHook(
      ({ itemPayload }: { itemPayload: string | false }) => {
        const listResult = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields: ['id', 'name', 'address'] },
        );

        listRenders.add(pick(listResult, ['status', 'items']));

        const itemResult = env.apiStore.useItem(itemPayload, {
          returnRefetchingStatus: true,
          fields: ['id', 'name'],
        });

        itemRenders.add(pick(itemResult, ['status', 'data']));
      },
      { initialProps: { itemPayload: false } },
    );

    await flushAllTimers();

    listRenders.addMark('Show item hook');
    itemRenders.addMark('Show item hook');

    act(() => {
      rerender({ itemPayload: 'users||1' });
    });

    await flushAllTimers();

    expect(listRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1, address:Address 1}, …(9 more)]

      >>> Show item hook

      -> status: success ⋅ items: [{id:1, name:User 1, address:Address 1}, …(9 more)]
      "
    `);

    expect(itemRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ data: null

      >>> Show item hook

      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(env.serverTable.getRequestMadeHistory('all')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('load list then load item with additional fields: fetch missing fields', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const listRenders = createLoggerStore();
    const itemRenders = createLoggerStore();

    const { rerender } = renderHook(
      ({ itemPayload }: { itemPayload: string | false }) => {
        const listResult = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields: ['id', 'name'] },
        );

        listRenders.add(pick(listResult, ['status', 'items']));

        const itemResult = env.apiStore.useItem(itemPayload, {
          returnRefetchingStatus: true,
          fields: ['id', 'name', 'address', 'country'],
        });

        itemRenders.add(pick(itemResult, ['status', 'data']));
      },
      { initialProps: { itemPayload: false } },
    );

    await flushAllTimers();

    listRenders.addMark('Show item hook');
    itemRenders.addMark('Show item hook');

    act(() => {
      rerender({ itemPayload: 'users||1' });
    });

    await flushAllTimers();

    expect(listRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1}, …(9 more)]

      >>> Show item hook

      -> status: success ⋅ items: [{id:1, name:User 1}, …(9 more)]
      "
    `);

    expect(itemRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ data: null

      >>> Show item hook

      -> status: loading ⋅ data: null
      ┌─
      ⋅ status: success
      ⋅ data: {id:1, name:User 1, address:Address 1, country:Country 1}
      └─
      "
    `);

    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['address', 'country', 'id', 'name']`);

    expect(env.store.state.items[storeItemKey]).toMatchInlineSnapshot(`
      address: 'Address 1'
      country: 'Country 1'
      id: 1
      name: 'User 1'
    `);

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - duration: 800
        fields: ['id', 'name']
        limit: 50
        offset: 0
        results:
          - data: { id: 1, name: 'User 1' }
            itemId: 'users||1'
          - data: { id: 2, name: 'User 2' }
            itemId: 'users||2'
          - data: { id: 3, name: 'User 3' }
            itemId: 'users||3'
          - data: { id: 4, name: 'User 4' }
            itemId: 'users||4'
          - data: { id: 5, name: 'User 5' }
            itemId: 'users||5'
          - data: { id: 6, name: 'User 6' }
            itemId: 'users||6'
          - data: { id: 7, name: 'User 7' }
            itemId: 'users||7'
          - data: { id: 8, name: 'User 8' }
            itemId: 'users||8'
          - data: { id: 9, name: 'User 9' }
            itemId: 'users||9'
          - data: { id: 10, name: 'User 10' }
            itemId: 'users||10'
        startedAt: 10
        type: 'list'
      - duration: 800
        fields: ['address', 'country']
        itemId: 'users||1'
        result: { address: 'Address 1', country: 'Country 1' }
        startedAt: 820
        type: 'fetch'
    `);
  });

  test('load list with id/name then load item with the same fields: cache hit', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const listRenders = createLoggerStore();
    const itemRenders = createLoggerStore();

    const { rerender } = renderHook(
      ({ itemPayload }: { itemPayload: string | false }) => {
        const listResult = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields: ['id', 'name'] },
        );

        listRenders.add(pick(listResult, ['status', 'items']));

        const itemResult = env.apiStore.useItem(itemPayload, {
          returnRefetchingStatus: true,
          fields: ['id', 'name'],
        });

        itemRenders.add(pick(itemResult, ['status', 'data']));
      },
      { initialProps: { itemPayload: false } },
    );

    await flushAllTimers();

    listRenders.addMark('Show item hook');
    itemRenders.addMark('Show item hook');

    act(() => {
      rerender({ itemPayload: 'users||1' });
    });

    await flushAllTimers();

    expect(listRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1}, …(9 more)]

      >>> Show item hook

      -> status: success ⋅ items: [{id:1, name:User 1}, …(9 more)]
      "
    `);

    expect(itemRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: idle ⋅ data: null

      >>> Show item hook

      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(env.serverTable.getRequestMadeHistory('all')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });
});

describe('load more with partial resources', () => {
  test('load list with fields then load more: new items also have fields', async () => {
    const env = createListQueryStoreTestEnv<Row, true>(initialServerData, {
      partialResources: partialResourcesConfig,
      defaultQuerySize: 3,
    });

    const renders = createLoggerStore();

    const { result } = renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      renders.add(
        pick(result, ['status', 'items', 'hasMore', 'isLoadingMore']),
      );

      return result.fields;
    });

    await flushAllTimers();

    renders.addMark('Load more');

    act(() => {
      const fields = result.current;
      if (!fields) throw new Error('Expected fields to be defined');
      env.apiStore.loadMore({ tableId: 'users' }, { fields });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: [] ⋅ hasMore: ❌ ⋅ isLoadingMore: ❌
      ┌─
      ⋅ status: success
      ⋅ items: [{id:1, name:User 1}, …(2 more)]
      ⋅ hasMore: ✅
      ⋅ isLoadingMore: ❌
      └─

      >>> Load more

      ┌─
      ⋅ status: loadingMore
      ⋅ items: [{id:1, name:User 1}, …(2 more)]
      ⋅ hasMore: ✅
      ⋅ isLoadingMore: ✅
      └─
      ┌─
      ⋅ status: success
      ⋅ items: [{id:1, name:User 1}, …(5 more)]
      ⋅ hasMore: ✅
      ⋅ isLoadingMore: ❌
      └─
      "
    `);

    expect(env.serverTable.getRequestMadeHistory('list'))
      .toMatchInlineSnapshot(`
        - payload:
            fields: ['id', 'name']
            pos: { limit: 3, offset: 0 }
          returned_items: 3
          time: '10ms -> 810ms | duration: 800ms'
        - payload:
            fields: ['id', 'name']
            pos: { limit: 6, offset: 0 }
          returned_items: 6
          time: '820ms -> 1.62s | duration: 800ms'
      `);
  });
});

describe('concurrent fetches with different fields', () => {
  test('two items with different fields fetched concurrently', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const item1Renders = createLoggerStore();
    const item2Renders = createLoggerStore();

    renderHook(() => {
      const result1 = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name'],
      });

      const result2 = env.apiStore.useItem('users||2', {
        returnRefetchingStatus: true,
        fields: ['id', 'address', 'country'],
      });

      item1Renders.add(pick(result1, ['status', 'data']));
      item2Renders.add(pick(result2, ['status', 'data']));
    });

    await flushAllTimers();

    expect(item1Renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:1, name:User 1}
      "
    `);

    expect(item2Renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ data: null
      -> status: success ⋅ data: {id:2, address:Address 2, country:Country 2}
      "
    `);

    expect(env.serverTable.getRequestMadeHistory('item'))
      .toMatchInlineSnapshot(`
        - payload:
            fields: ['id', 'name']
            itemId: 'users||1'
          time: '10ms -> 810ms | duration: 800ms'
        - payload:
            fields: ['address', 'country', 'id']
            itemId: 'users||2'
          time: '10ms -> 810ms | duration: 800ms'
      `);
  });
});
