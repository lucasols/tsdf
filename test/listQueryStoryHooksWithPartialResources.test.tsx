import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  Tables,
  createDefaultListQueryStore,
} from './utils/createDefaultListQueryStore';
import { jsonFormatter } from './utils/jsonFormatter';
import { range } from './utils/range';
import { createRenderLogger } from './utils/storeUtils';

const createTestEnv = createDefaultListQueryStore;

const initialServerData: Tables = {
  users: range(1, 50).map((id) => ({
    id,
    name: `User ${id}`,
    type: id % 2 === 0 ? 'admin' : 'user',
    address: `Address ${id}`,
    age: id,
    city: `City ${id}`,
    country: `Country ${id}`,
    createdAt: 12345678,
    createdBy: `User ${id}`,
    phone: `+${id}`,
    postalCode: `1234${id}`,
    updatedAt: 12345678,
    updatedBy: `User ${id}`,
  })),
};

type ChangeFieldsProps = {
  fields: (keyof Tables[string][number])[];
};

describe.concurrent('useItem', () => {
  test('should load only the selected fields', async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
      disableInitialDataInvalidation: true,
      partialResources: true,
      disableRefetchOnMount: true,
    });

    const renders = createRenderLogger({
      filterKeys: ['status', 'data', 'payload', 'error'],
    });

    renderHook(() => {
      const result = env.store.useItem(
        { id: 'users||1', fields: ['id', 'name', 'address'] },
        { returnRefetchingStatus: true },
      );

      renders.add(result);
    });

    await env.serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshotString(`
      "
      status: loading -- data: null -- payload: {id:users||1, fields:[id, name, address]} -- error: null
      status: success -- data: {id:1, name:User 1, address:Address 1} -- payload: {id:users||1, fields:[id, name, address]} -- error: null
      "
    `);
  });

  test('load correctly when fields change from less to more fields', async () => {
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
      { initialProps: { fields: ['id', 'name', 'address'] } },
    );

    await env.serverMock.waitFetchIdle();

    renders.addMark('Change fields');

    rerender({ fields: ['id', 'name', 'address', 'country'] });

    expect(jsonFormatter(env.store.store.state.partialItemsQueries))
      .toMatchInlineSnapshotString(`
      "{
        {"id":"users||1"}: {
          payload: { id: 'users||1', fields: [] },
          fields: {
            id: { status: 'refetching', error: null, wasLoaded: true, refetchOnMount: false },
            name: { status: 'refetching', error: null, wasLoaded: true, refetchOnMount: false },
            address: { status: 'refetching', error: null, wasLoaded: true, refetchOnMount: false },
            country: { status: 'loading', error: null, wasLoaded: false, refetchOnMount: false },
          },
        },
      }"
    `);

    await env.serverMock.waitFetchIdle();

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

    expect(renders.snapshot).toMatchInlineSnapshotString(`
        "
        status: loading -- data: null -- payload: {id:users||1, fields:[id, name, address]} -- error: null
        status: success -- data: {id:1, name:User 1, address:Address 1} -- payload: {id:users||1, fields:[id, name, address]} -- error: null

        >>> Change fields

        status: loading -- data: null -- payload: {id:users||1, fields:[id, name, address, country]} -- error: null
        status: success -- data: {id:1, name:User 1, address:Address 1, country:Country 1} -- payload: {id:users||1, fields:[id, name, address, country]} -- error: null
        "
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
