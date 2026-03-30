import { __LEGIT_CAST__ } from '@ls-stack/utils/saferTyping';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import '@testing-library/react/dont-cleanup-after-each';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

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
  users: [
    {
      id: 1,
      name: 'User 1',
      address: 'Address 1',
      age: 10,
      country: 'Country 1',
    },
  ],
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

test('useItem: default behavior keeps loading when cache exists but requested fields are still missing', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        showPartialAsRefetching: false,
        fields,
      });

      renders.add({ status: result.status, data: result.data, fields });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null ⋅ fields: [id]
    -> status: success ⋅ data: {id:1} ⋅ fields: [id]

    >>> Expand fields

    -> status: loading ⋅ data: null ⋅ fields: [id, name]
    -> status: success ⋅ data: {id:1, name:User 1} ⋅ fields: [id, name]
    "
  `);
});

test('useItem: option can expose refetching while cache exists but requested fields are still missing', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        showPartialAsRefetching: true,
        fields,
      });

      renders.add({ status: result.status, data: result.data, fields });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null ⋅ fields: [id]
    -> status: success ⋅ data: {id:1} ⋅ fields: [id]

    >>> Expand fields

    -> status: refetching ⋅ data: {id:1} ⋅ fields: [id, name]
    -> status: success ⋅ data: {id:1, name:User 1} ⋅ fields: [id, name]
    "
  `);
});

test('useItem: loadingFields exposes which requested fields are still pending', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      const result = env.apiStore.useItem('users||1', {
        returnRefetchingStatus: true,
        showPartialAsRefetching: true,
        fields,
      });

      renders.add({
        status: result.status,
        data: result.data,
        loadingFields: result.loadingFields ?? null,
        fields,
      });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ data: null ⋅ loadingFields: [id] ⋅ fields: [id]
    -> status: success ⋅ data: {id:1} ⋅ loadingFields: null ⋅ fields: [id]

    >>> Expand fields

    -> status: refetching ⋅ data: {id:1} ⋅ loadingFields: [name] ⋅ fields: [id, name]
    ┌─
    ⋅ status: success
    ⋅ data: {id:1, name:User 1}
    ⋅ loadingFields: null
    ⋅ fields: [id, name]
    └─
    "
  `);
});

test('useItem: cache miss still reports loading with showPartialAsRefetching enabled', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });

  const hook = renderHook(() =>
    env.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      showPartialAsRefetching: true,
      fields: ['id', 'name'],
    }),
  );
  await advanceTime(0);

  expect(hook.result.current).toMatchObject({
    status: 'loading',
    data: null,
    loadingFields: ['id', 'name'],
  });

  hook.unmount();
  await flushAllTimers();
});

test('useListQuery: default behavior keeps loading when cache exists but requested fields are still missing', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      const result = env.apiStore.useListQuery(
        { tableId: 'users' },
        {
          returnRefetchingStatus: true,
          showPartialAsRefetching: false,
          fields,
        },
      );

      renders.add({
        status: result.status,
        firstItem: result.items[0] ?? null,
        fields,
      });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: loading ⋅ firstItem: null ⋅ fields: [id]
    -> status: success ⋅ firstItem: {id:1} ⋅ fields: [id]

    >>> Expand fields

    -> status: loading ⋅ firstItem: null ⋅ fields: [id, name]
    -> status: success ⋅ firstItem: {id:1, name:User 1} ⋅ fields: [id, name]
    "
  `);
});

test('useListQuery: raw and masked hooks expose refetching vs success with showPartialAsRefetching', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      const rawResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, showPartialAsRefetching: true, fields },
      );
      const maskedResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        {
          returnRefetchingStatus: false,
          showPartialAsRefetching: true,
          fields,
        },
      );

      renders.add({
        rawStatus: rawResult.status,
        maskedStatus: maskedResult.status,
        rawFirstItem: rawResult.items[0] ?? null,
        maskedFirstItem: maskedResult.items[0] ?? null,
        fields,
      });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ rawStatus: loading
    ⋅ maskedStatus: loading
    ⋅ rawFirstItem: null
    ⋅ maskedFirstItem: null
    ⋅ fields: [id]
    └─
    ┌─
    ⋅ rawStatus: success
    ⋅ maskedStatus: success
    ⋅ rawFirstItem: {id:1}
    ⋅ maskedFirstItem: {id:1}
    ⋅ fields: [id]
    └─

    >>> Expand fields

    ┌─
    ⋅ rawStatus: refetching
    ⋅ maskedStatus: success
    ⋅ rawFirstItem: {id:1}
    ⋅ maskedFirstItem: {id:1}
    ⋅ fields: [id, name]
    └─
    ┌─
    ⋅ rawStatus: success
    ⋅ maskedStatus: success
    ⋅ rawFirstItem: {id:1, name:User 1}
    ⋅ maskedFirstItem: {id:1, name:User 1}
    ⋅ fields: [id, name]
    └─
    "
  `);
});

test('useListQuery: loadingFields exposes pending fields even when refetching is masked', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      const rawResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        { returnRefetchingStatus: true, showPartialAsRefetching: true, fields },
      );
      const maskedResult = env.apiStore.useListQuery(
        { tableId: 'users' },
        {
          returnRefetchingStatus: false,
          showPartialAsRefetching: true,
          fields,
        },
      );

      renders.add({
        rawStatus: rawResult.status,
        maskedStatus: maskedResult.status,
        rawLoadingFields: rawResult.loadingFields ?? null,
        maskedLoadingFields: maskedResult.loadingFields ?? null,
        rawFirstItem: rawResult.items[0] ?? null,
        maskedFirstItem: maskedResult.items[0] ?? null,
        fields,
      });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ rawStatus: loading
    ⋅ maskedStatus: loading
    ⋅ rawLoadingFields: [id]
    ⋅ maskedLoadingFields: [id]
    ⋅ rawFirstItem: null
    ⋅ maskedFirstItem: null
    ⋅ fields: [id]
    └─
    ┌─
    ⋅ rawStatus: success
    ⋅ maskedStatus: success
    ⋅ rawLoadingFields: null
    ⋅ maskedLoadingFields: null
    ⋅ rawFirstItem: {id:1}
    ⋅ maskedFirstItem: {id:1}
    ⋅ fields: [id]
    └─

    >>> Expand fields

    ┌─
    ⋅ rawStatus: refetching
    ⋅ maskedStatus: success
    ⋅ rawLoadingFields: [name]
    ⋅ maskedLoadingFields: [name]
    ⋅ rawFirstItem: {id:1}
    ⋅ maskedFirstItem: {id:1}
    ⋅ fields: [id, name]
    └─
    ┌─
    ⋅ rawStatus: success
    ⋅ maskedStatus: success
    ⋅ rawLoadingFields: null
    ⋅ maskedLoadingFields: null
    ⋅ rawFirstItem: {id:1, name:User 1}
    ⋅ maskedFirstItem: {id:1, name:User 1}
    ⋅ fields: [id, name]
    └─
    "
  `);
});

test('useMultipleItems: per-query option overrides global showPartialAsRefetching', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      // Query-level options should win over global options for each entry.
      const results = env.apiStore.useMultipleItems(
        [
          {
            payload: 'users||1',
            fields,
            returnRefetchingStatus: true,
            showPartialAsRefetching: false,
          },
          { payload: 'users||1', fields, returnRefetchingStatus: true },
        ],
        { showPartialAsRefetching: true },
      );
      const queryOverrideFalse = results[0]!;
      const inheritsGlobalTrue = results[1]!;

      renders.add({
        overrideStatus: queryOverrideFalse.status,
        globalStatus: inheritsGlobalTrue.status,
        overrideData: queryOverrideFalse.data,
        globalData: inheritsGlobalTrue.data,
        fields,
      });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ overrideStatus: loading
    ⋅ globalStatus: loading
    ⋅ overrideData: null
    ⋅ globalData: null
    ⋅ fields: [id]
    └─
    ┌─
    ⋅ overrideStatus: success
    ⋅ globalStatus: success
    ⋅ overrideData: {id:1}
    ⋅ globalData: {id:1}
    ⋅ fields: [id]
    └─

    >>> Expand fields

    ┌─
    ⋅ overrideStatus: loading
    ⋅ globalStatus: refetching
    ⋅ overrideData: null
    ⋅ globalData: {id:1}
    ⋅ fields: [id, name]
    └─
    ┌─
    ⋅ overrideStatus: success
    ⋅ globalStatus: success
    ⋅ overrideData: {id:1, name:User 1}
    ⋅ globalData: {id:1, name:User 1}
    ⋅ fields: [id, name]
    └─
    "
  `);
});

test('useMultipleListQueries: per-query option overrides global showPartialAsRefetching', async () => {
  const env = createListQueryStoreTestEnv(initialServerData, {
    partialResources: partialResourcesConfig,
  });
  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ fields }: { fields: string[] }) => {
      // Query-level options should win over global options for each entry.
      const results = env.apiStore.useMultipleListQueries(
        [
          {
            payload: { tableId: 'users' },
            fields,
            returnRefetchingStatus: true,
            showPartialAsRefetching: false,
          },
          {
            payload: { tableId: 'users' },
            fields,
            returnRefetchingStatus: true,
          },
        ],
        { showPartialAsRefetching: true },
      );
      const queryOverrideFalse = results[0]!;
      const inheritsGlobalTrue = results[1]!;

      renders.add({
        overrideStatus: queryOverrideFalse.status,
        globalStatus: inheritsGlobalTrue.status,
        overrideFirstItem: queryOverrideFalse.items[0] ?? null,
        globalFirstItem: inheritsGlobalTrue.items[0] ?? null,
        fields,
      });
    },
    { initialProps: { fields: ['id'] } },
  );

  await flushAllTimers();

  renders.addMark('Expand fields');
  act(() => {
    rerender({ fields: ['id', 'name'] });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    ┌─
    ⋅ overrideStatus: loading
    ⋅ globalStatus: loading
    ⋅ overrideFirstItem: null
    ⋅ globalFirstItem: null
    ⋅ fields: [id]
    └─
    ┌─
    ⋅ overrideStatus: success
    ⋅ globalStatus: success
    ⋅ overrideFirstItem: {id:1}
    ⋅ globalFirstItem: {id:1}
    ⋅ fields: [id]
    └─

    >>> Expand fields

    ┌─
    ⋅ overrideStatus: loading
    ⋅ globalStatus: refetching
    ⋅ overrideFirstItem: null
    ⋅ globalFirstItem: {id:1}
    ⋅ fields: [id, name]
    └─
    ┌─
    ⋅ overrideStatus: success
    ⋅ globalStatus: success
    ⋅ overrideFirstItem: {id:1, name:User 1}
    ⋅ globalFirstItem: {id:1, name:User 1}
    ⋅ fields: [id, name]
    └─
    "
  `);
});
