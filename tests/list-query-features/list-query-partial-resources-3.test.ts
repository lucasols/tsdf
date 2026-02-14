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
    return __LEGIT_CAST__<Row>(result);
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
        {
          tableId: 'users',
          filters: [{ op: 'gt', field: 'id', value: 5 }],
        },
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
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
        type: 'list'
      - fields: ['id', 'name']
        filters:
          - { field: 'id', op: 'gt', value: 5 }
        limit: 50
        offset: 0
        results:
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
        type: 'list'
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['address', 'id', 'name']
        limit: 50
        offset: 0
        results:
          - data: { address: 'Address 1', id: 1, name: 'User 1' }
            itemId: 'users||1'
          - data: { address: 'Address 2', id: 2, name: 'User 2' }
            itemId: 'users||2'
          - data: { address: 'Address 3', id: 3, name: 'User 3' }
            itemId: 'users||3'
          - data: { address: 'Address 4', id: 4, name: 'User 4' }
            itemId: 'users||4'
          - data: { address: 'Address 5', id: 5, name: 'User 5' }
            itemId: 'users||5'
          - data: { address: 'Address 6', id: 6, name: 'User 6' }
            itemId: 'users||6'
          - data: { address: 'Address 7', id: 7, name: 'User 7' }
            itemId: 'users||7'
          - data: { address: 'Address 8', id: 8, name: 'User 8' }
            itemId: 'users||8'
          - data: { address: 'Address 9', id: 9, name: 'User 9' }
            itemId: 'users||9'
          - data: { address: 'Address 10', id: 10, name: 'User 10' }
            itemId: 'users||10'
        type: 'list'
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
          {
            returnRefetchingStatus: true,
            fields: ['id', 'name'],
          },
        );

        env.apiStore.useListQuery(
          showAddressList ? { tableId: 'users' } : false,
          {
            returnRefetchingStatus: true,
            fields: ['id', 'address'],
          },
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
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
        type: 'list'
      - fields: ['id', 'address']
        limit: 50
        offset: 0
        results:
          - data: { address: 'Address 1', id: 1 }
            itemId: 'users||1'
          - data: { address: 'Address 2', id: 2 }
            itemId: 'users||2'
          - data: { address: 'Address 3', id: 3 }
            itemId: 'users||3'
          - data: { address: 'Address 4', id: 4 }
            itemId: 'users||4'
          - data: { address: 'Address 5', id: 5 }
            itemId: 'users||5'
          - data: { address: 'Address 6', id: 6 }
            itemId: 'users||6'
          - data: { address: 'Address 7', id: 7 }
            itemId: 'users||7'
          - data: { address: 'Address 8', id: 8 }
            itemId: 'users||8'
          - data: { address: 'Address 9', id: 9 }
            itemId: 'users||9'
          - data: { address: 'Address 10', id: 10 }
            itemId: 'users||10'
        type: 'list'
    `);
  });
});
