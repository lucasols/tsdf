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
  inferFields: (item) =>
    Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field),
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

describe('list query field accumulation edge cases', () => {
  test('same fields with different query payloads (with filters and without) fetch independently', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const allUsersRenders = createLoggerStore();
    const filteredUsersRenders = createLoggerStore();

    renderHook(() => {
      const allUsersResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      const filteredUsersResult = env.apiStore.useListQuery(
        { tableId: 'users', filters: [{ op: 'gt', field: 'id', value: 5 }] },
        { returnRefetchingStatus: true, fields: ['id', 'name'] },
      );

      allUsersRenders.add(pick(allUsersResult, ['status', 'items']));
      filteredUsersRenders.add(pick(filteredUsersResult, ['status', 'items']));
    });

    await flushAllTimers();

    expect(allUsersRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1}, …(9 more)]
      "
    `);
    expect(filteredUsersRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:6, name:User 6}, …(4 more)]
      "
    `);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          filters:
            - { field: 'id', op: 'gt', value: 5 }
          pos: { limit: 50, offset: 0 }
        returned_items: 5
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('two list hooks mounted together with different fields coalesce into one fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

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

    expect(nameHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1}, …(9 more)]
      "
    `);
    expect(addressHookRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, address:Address 1}, …(9 more)]
      "
    `);

    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['address', 'id', 'name']`);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['address', 'id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '10ms -> 810ms | duration: 800ms'
    `);
  });

  test('list fields can accumulate across rerenders and satisfy a later item hook without item fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const { rerender } = renderHook(
      ({ showAddressList }: { showAddressList: boolean }) => {
        env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields: ['id', 'name'] },
        );

        env.apiStore.useListQuery(
          showAddressList ? { tableId: 'users' } : false,
          { returnRefetchingStatus: true, fields: ['id', 'address'] },
        );
      },
      { initialProps: { showAddressList: false } },
    );

    await flushAllTimers();

    act(() => {
      rerender({ showAddressList: true });
    });

    await flushAllTimers();

    const storeItemKey = env.getStoreItemKeyFromRaw('users||1');

    expect(
      env.store.state.itemLoadedFields[storeItemKey],
    ).toMatchInlineSnapshot(`['address', 'id', 'name']`);

    const itemRenders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        fields: ['id', 'name', 'address'],
      });

      itemRenders.add(pick(result, ['status', 'data']));
    });

    await flushAllTimers();

    expect(itemRenders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ data: {id:1, name:User 1, address:Address 1}
      "
    `);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('list field expansion refetches again when page membership changes during the missing-field fetch', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
    });

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ fields }: { fields: string[] }) => {
        const query = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnRefetchingStatus: true, fields, loadSize: 2 },
        );

        renders.add(pick(query, ['status', 'items']));
      },
      { initialProps: { fields: ['id', 'name'] } },
    );

    await flushAllTimers();

    env.serverTable.setItem(
      'users||0',
      {
        id: 0,
        name: 'User 0',
        address: 'Address 0',
        age: 0,
        country: 'Country 0',
      },
      { prepend: true },
    );

    renders.addMark('Expand fields');

    act(() => {
      rerender({ fields: ['id', 'name', 'address'] });
    });

    await advanceTime(900);

    env.serverTable.setItem(
      'users||10',
      {
        id: 10,
        name: 'User 10',
        address: 'Address 10',
        age: 10,
        country: 'Country 10',
      },
      { prepend: true },
    );

    await advanceTime(2000);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1}, {id:2, name:User 2}]

      >>> Expand fields

      -> status: loading ⋅ items: []
      ┌─
      ⋅ status: success
      ⋅ items: [{id:0, name:User 0, address:Address 0}, {id:1, name:User 1, address:Address 1}]
      └─
      "
    `);

    expect(env.serverTable.numOfFinishedFetches).toBe(2);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name']
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 2, offset: 0 }
        returned_items: 2
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });

  test('list field rtu invalidation triggers full refetch on list queries', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      partialResources: partialResourcesConfig,
      usesRealTimeUpdates: true,
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, fields: ['id', 'name', 'address'] },
      );

      renders.add(pick(result, ['status', 'items']));
    });

    await flushAllTimers();

    renders.addMark('Field RTU invalidation');

    // Simulate RTU that invalidates specific fields on all items
    env.serverTable.setItem('users||1', {
      id: 1,
      name: 'Updated User 1',
      address: 'Updated Address 1',
    });

    act(() => {
      env.apiStore.invalidateQueryAndItems({
        queryPayload: false,
        itemPayload: (item) => item.startsWith('users||'),
        type: 'realtimeUpdate',
        fields: ['name'],
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ items: []
      -> status: success ⋅ items: [{id:1, name:User 1, address:Address 1}, …(9 more)]

      >>> Field RTU invalidation

      -> status: refetching ⋅ items: [{id:1, name:User 1, address:Address 1}, …(9 more)]
      ┌─
      ⋅ status: success
      ⋅ items: [{id:1, name:Updated User 1, address:Updated Address 1}, …(9 more)]
      └─
      "
    `);

    expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '10ms -> 810ms | duration: 800ms'
      - _type: 'list'
        payload:
          fields: ['id', 'name', 'address']
          pos: { limit: 50, offset: 0 }
        returned_items: 10
        time: '820ms -> 1.62s | duration: 800ms'
    `);
  });
});
