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
import { pick, range } from '../utils/genericTestUtils';
import { advanceTime, flushAllTimers } from '../utils/listQueryHooksTestUtils';

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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name', 'address']
        itemId: 'users||1'
        result: { address: 'Address 1', id: 1, name: 'User 1' }
        type: 'fetch'
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name', 'address']
        itemId: 'users||1'
        result: { address: 'Address 1', id: 1, name: 'User 1' }
        type: 'fetch'
      - fields: ['id', 'name', 'address', 'country']
        itemId: 'users||1'
        result: { address: 'Address 1', country: 'Country 1', id: 1, name: 'User 1' }
        type: 'fetch'
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

    const fetchCountBefore = env.serverTable.numOfFinishedFetches;

    renders.addMark('Reduce fields');

    act(() => {
    rerender({ fields: ['id', 'name', 'address'] });
    });

    // No additional fetch should happen
    expect(env.serverTable.numOfFinishedFetches).toBe(fetchCountBefore);

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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name', 'address', 'country']
        itemId: 'users||1'
        result: { address: 'Address 1', country: 'Country 1', id: 1, name: 'User 1' }
        type: 'fetch'
    `);
  });
});

describe('useListQuery with partial resources', () => {
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
        limit: 50
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
        type: 'list'
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
        limit: 50
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
        type: 'list'
      - fields: ['id', 'name', 'address']
        limit: 50
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
        type: 'list'
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

    const fetchCountBefore = env.serverTable.numOfFinishedFetches;

    renders.addMark('Reduce fields');

    act(() => {
      rerender({ fields: ['id', 'name'] });
    });

    await flushAllTimers();

    // No additional fetch
    expect(env.serverTable.numOfFinishedFetches).toBe(fetchCountBefore);

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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name', 'address']
        limit: 50
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
        type: 'list'
    `);
  });

    expect(
      jsonFormatter(
        Object.values(env.store.store.state.partialItemsQueries)[0],
      ),
    ).toMatchInlineSnapshotString(`
      "{
        fields: {
          id: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
          name: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
          address: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
          country: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
        },
        payload: { id: 'users||1', fields: [] },
      }"
    `);
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name']
        itemId: 'users||1'
        result: { id: 1, name: 'User 1' }
        type: 'fetch'
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

    expect(env.serverTable.fetchHistory).toMatchInlineSnapshot(`
      - fields: ['id', 'name', 'address']
        itemId: 'users||1'
        result: { address: 'Address 1', id: 1, name: 'User 1' }
        type: 'fetch'
    `);
  });
});


      >>> Change fields

      status: success -- items: [{id:1, name:User 1, address:Address 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address]} -- error: null
      "
    `);
  });

  test('load correctly when fields change from more to less fields: with refetch on mount', async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      partialResources: true,
    });

    const renders = createRenderLogger({
      filterKeys: ['status', 'items', 'payload', 'error'],
    });

    const { rerender } = renderHook<void, ChangeFieldsProps>(
      ({ fields }) => {
        const result = env.store.useListQuery(
          { tableId: 'users', fields },
          { returnRefetchingStatus: true },
        );

        renders.add(result);
      },
      {
        initialProps: { fields: ['id', 'name', 'address', 'country'] },
      },
    );

    await env.serverMock.waitFetchIdle();

    renders.addMark('Change fields');

    rerender({ fields: ['id', 'name', 'address'] });

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      status: loading -- items: [] -- payload: {tableId:users, fields:[id, name, address, country]} -- error: null
      status: success -- items: [{id:1, name:User 1, address:Address 1, country:Country 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address, country]} -- error: null

      >>> Change fields

      status: success -- items: [{id:1, name:User 1, address:Address 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address]} -- error: null
      "
    `);
  });
});

describe('type safety: fields requirement with partialResources', () => {
  test('fields is required in hooks when partialResources is enabled', () => {
    const store =
      __LEGIT_CAST__<
        ListQueryStore<Row, string, string, PartialResourcesConfig<Row>>
      >(undefined);

    // Type-only test: function is never called to avoid React hook errors
    function typeCheck_() {
      // @ts-expect-error - useItem requires fields when partialResources is enabled
      store.useItem('id');

      store.useItem('id', { fields: ['name'] });

      // @ts-expect-error - useListQuery requires fields when partialResources is enabled
      store.useListQuery('payload');

      store.useListQuery('payload', { fields: ['name'] });

      // @ts-expect-error - useMultipleItems requires fields when partialResources is enabled
      store.useMultipleItems([{ payload: 'id' }]);

      store.useMultipleItems([{ payload: 'id', fields: ['name'] }]);

      // @ts-expect-error - useMultipleListQueries requires fields when partialResources is enabled
      store.useMultipleListQueries([{ payload: 'payload' }]);

      store.useMultipleListQueries([{ payload: 'payload', fields: ['name'] }]);
    }

    void typeCheck_;
    expect(true).toBe(true); // Dummy assertion to satisfy test requirements
  });

  test('fields is optional in hooks when partialResources is not enabled', () => {
    const store =
      __LEGIT_CAST__<ListQueryStore<Row, string, string>>(undefined);

    function typeCheck_() {
      store.useItem('id');
      store.useListQuery('payload');
      store.useMultipleItems([{ payload: 'id' }]);
      store.useMultipleListQueries([{ payload: 'payload' }]);

      store.useItem('id', { fields: ['name'] });
      store.useListQuery('payload', { fields: ['name'] });
      store.useMultipleItems([{ payload: 'id', fields: ['name'] }]);
      store.useMultipleListQueries([{ payload: 'payload', fields: ['name'] }]);
    }

    void typeCheck_;
    expect(true).toBe(true); // Dummy assertion to satisfy test requirements
  });
});
