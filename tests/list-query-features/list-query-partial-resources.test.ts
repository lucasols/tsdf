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

  test('load correctly when fields change from more to less fields', async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      partialResources: true,
    });

    const renders = createRenderLogger({
      filterKeys: ['status', 'data', 'payload', 'error'],
    });

    const { rerender } = renderHook<void, ChangeFieldsProps>(
      ({ fields }) => {
        const result = env.store.useItem(
          { id: 'users||1', fields },
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
      status: loading -- data: null -- payload: {id:users||1, fields:[id, name, address, country]} -- error: null
      status: success -- data: {id:1, name:User 1, address:Address 1, country:Country 1} -- payload: {id:users||1, fields:[id, name, address, country]} -- error: null

      >>> Change fields

      status: success -- data: {id:1, name:User 1, address:Address 1} -- payload: {id:users||1, fields:[id, name, address]} -- error: null
      "
    `);

    expect(jsonFormatter(env.store.store.state.partialItemsQueries))
      .toMatchInlineSnapshotString(`
      "{
        {"id":"users||1"}: {
          payload: { id: 'users||1', fields: [] },
          fields: {
            id: { status: 'success', error: null, wasLoaded: true, refetchOnMount: false },
            name: { status: 'success', error: null, wasLoaded: true, refetchOnMount: false },
            address: { status: 'success', error: null, wasLoaded: true, refetchOnMount: false },
            country: { status: 'success', error: null, wasLoaded: true, refetchOnMount: false },
          },
        },
      }"
    `);
  });
});

describe.concurrent('useListQuery', () => {
  test('should load only the selected fields', async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      partialResources: true,
      disableRefetchOnMount: true,
    });

    const renders = createRenderLogger({
      filterKeys: ['status', 'items', 'payload', 'error'],
    });

    renderHook(() => {
      const result = env.store.useListQuery(
        {
          tableId: 'users',
          fields: ['id', 'name', 'address'],
        },
        { returnRefetchingStatus: true },
      );

      renders.add(result);
    });

    await env.serverMock.waitFetchIdle();

    expect(jsonFormatter(env.store.store.state.queries, { maxArrayItems: 5 }))
      .toMatchInlineSnapshot(`
      "{
        [{"fields":["id","name","address"]},{"tableId":"users"}]: {
          error: null,
          status: 'success',
          wasLoaded: true,
          payload: { tableId: 'users', fields: [ 'id', 'name', 'address' ] },
          refetchOnMount: false,
          hasMore: false,
          items:     [
            '{"id":"users||1"}',
            '{"id":"users||2"}',
            '{"id":"users||3"}',
            '{"id":"users||4"}',
            '{"id":"users||5"}',
            ... +45 items
          ],
        },
      }"
    `);

    expect(env.store.store.state.itemQueries).toEqual({});

    expect(
      jsonFormatter(
        Object.values(env.store.store.state.partialItemsQueries)[0],
      ),
    ).toMatchInlineSnapshot(`
      "{
        fields: {
          id: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
          name: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
          address: { error: null, status: 'success', wasLoaded: true, refetchOnMount: false },
        },
        payload: { id: 'users||1', fields: [] },
      }"
    `);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: loading -- items: [] -- payload: {tableId:users, fields:[id, name, address]} -- error: null
    status: success -- items: [{id:1, name:User 1, address:Address 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address]} -- error: null
    "
    `);
  });

  test('load correctly when fields change from less to more fields', async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      partialResources: true,
      disableRefetchOnMount: true,
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
        initialProps: { fields: ['id', 'name', 'address'] },
      },
    );

    await env.serverMock.waitFetchIdle();

    renders.addMark('Change fields');

    rerender({ fields: ['id', 'name', 'address', 'country'] });

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
        },
        payload: { id: 'users||1', fields: [] },
      }"
    `);

    await env.serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshotString(`
        "
        status: loading -- items: [] -- payload: {tableId:users, fields:[id, name, address]} -- error: null
        status: success -- items: [{id:1, name:User 1, address:Address 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address]} -- error: null

        >>> Change fields

        status: loading -- items: [] -- payload: {tableId:users, fields:[id, name, address, country]} -- error: null
        status: success -- items: [{id:1, name:User 1, address:Address 1, country:Country 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address, country]} -- error: null
        "
      `);

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

  test('load correctly when fields change from more to less fields', async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      partialResources: true,
      disableRefetchOnMount: true,
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

    expect(jsonFormatter(env.store.store.state.queries, { maxArrayItems: 2 }))
      .toMatchInlineSnapshotString(`
        "{
          [{"fields":["id","name","address","country"]},{"tableId":"users"}]: {
            error: null,
            status: 'success',
            wasLoaded: true,
            payload: { tableId: 'users', fields: [ 'id', 'name', 'address', 'country' ] },
            refetchOnMount: false,
            hasMore: false,
            items:     [
              '{"id":"users||1"}',
              '{"id":"users||2"}',
              ... +48 items
            ],
          },
        }"
      `);

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      status: loading -- items: [] -- payload: {tableId:users, fields:[id, name, address, country]} -- error: null
      status: success -- items: [{id:1, name:User 1, address:Address 1, country:Country 1}, ...(49 more)] -- payload: {tableId:users, fields:[id, name, address, country]} -- error: null

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

// FIX: test concurrent fetches with different fields

// FIX: test use fallback list then load more

// FIX: test use fallback list then load more

// FIX: load list then load item with less but common fields

// FIX: load two lists with different fields then load item with common fields

// FIX: update item state
