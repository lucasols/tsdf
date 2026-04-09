import { act, cleanup, renderHook } from '@testing-library/react';
import { useCallback, useMemo } from 'react';
import { rc_string } from 'runcheck';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import type { TSFDUseCollectionItemReturn } from '../../src/collectionStore/collectionStore';
import type { TSFDUseListItemReturn } from '../../src/listQueryStore/types';
import type {
  DefineCollectionOfflineOperations,
  DefineListQueryOfflineOperations,
  DefineOfflineOperation,
} from '../../src/main';
import { createOfflineSession } from '../../src/main';
import type { CollectionTestItem } from '../mocks/collectionStoreTestEnv';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  deleteItemInputSchema,
  userPatchSchema,
  userRowSchema,
} from '../offline/offlineReplayTestShared';
import {
  collectionSchema,
  listQueryQueryPayloadSchema,
} from '../offline/offlineTestShared';
import { flushAllTimers, range } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  localStorage.clear();
});

type Todo = { title: string; completed: boolean };

const defaultTodo: Todo = { title: 'todo', completed: false };

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 5).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 5).map((id) => ({ id, name: `Order ${id}` })),
};

type StoreValue = { hello: string };

describe('document hook memoization', () => {
  test('useDocument keeps plain data stable across rerenders and same-data refetches', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: StoreValue | null | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { data } = env.apiStore.useDocument();

      renders += 1;
      dataChanges.push(prevData !== (data?.value ?? null));
      prevData = data?.value ?? null;

      return data?.value ?? null;
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(dataChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.setServerData({ hello: 'world' });
      env.apiStore.invalidateData();
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeInvalidation);
    expect(hook.result.current).toBe(prevData);
  });

  test('useDocument keeps selector results stable when selector identity is memoized', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: { label: string | null } | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: { value: StoreValue } | null) => ({
          label: data?.value.hello ?? null,
        }),
        [],
      );
      const { data } = env.apiStore.useDocument({ selector });

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.setServerData({ hello: 'world' });
      env.apiStore.invalidateData();
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);
    expect(renders).toBe(rendersBeforeInvalidation);
  });
});

type PendingSyncCollectionOperations = DefineCollectionOfflineOperations<
  { value: { name: string } },
  string,
  { patchName: DefineOfflineOperation<{ itemId: string; name: string }> }
>;

describe('collection hook memoization', () => {
  test('useItem keeps plain data stable across rerenders and unrelated item updates', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: Todo | null | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { data } = env.apiStore.useItem('1');

      renders += 1;
      dataChanges.push(prevData !== (data?.value ?? null));
      prevData = data?.value ?? null;

      return data?.value ?? null;
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(dataChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('2', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('2');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevData);
  });

  test('useItem keeps selector results stable when selector identity is memoized', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevData: { label: string | null } | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: CollectionTestItem<Todo> | null) => ({
          label: data?.value.title ?? null,
        }),
        [],
      );
      const { data } = env.apiStore.useItem('1', { selector });

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('3', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('3');
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleItems keeps plain entries and outer array stable across rerenders and unrelated updates', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const queries = [{ payload: '1' }, { payload: '2' }] as const;

    let renders = 0;
    let prevResult:
      | readonly TSFDUseCollectionItemReturn<
          CollectionTestItem<Todo> | null,
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: Todo | null | undefined;
    let prevSecondData: Todo | null | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      // Multi-query hooks now expect callers (or the React Compiler) to keep
      // query arrays stable when referential stability matters.
      const memoizedQueries = useMemo(() => [...queries], []);
      const result = env.apiStore.useMultipleItems(memoizedQueries);

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== (result[0]?.data?.value ?? null),
        second: prevSecondData !== (result[1]?.data?.value ?? null),
      });
      prevResult = result;
      prevFirstData = result[0]?.data?.value ?? null;
      prevSecondData = result[1]?.data?.value ?? null;

      return result;
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(
      `- { first: '✅', result: '✅', second: '✅' }`,
    );

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(changes).toMatchInlineSnapshot(`
      - { first: '✅', result: '✅', second: '✅' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
    `);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('3', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('3');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevResult);
  });

  test('useMultipleItems keeps selector results stable when selector identity is memoized', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo, '2': defaultTodo, '3': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    let renders = 0;
    let prevResult:
      | readonly TSFDUseCollectionItemReturn<
          { label: string | null },
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: { label: string | null } | undefined;
    let prevSecondData: { label: string | null } | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: CollectionTestItem<Todo> | null) => ({
          label: data?.value.title ?? null,
        }),
        [],
      );
      // The selector is memoized here, and the query array is memoized too,
      // because multi-query hook stability is now a caller-side contract.
      const queries = useMemo(() => [{ payload: '1' }, { payload: '2' }], []);
      const result = env.apiStore.useMultipleItems(queries, { selector });

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== result[0]?.data,
        second: prevSecondData !== result[1]?.data,
      });
      prevResult = result;
      prevFirstData = result[0]?.data;
      prevSecondData = result[1]?.data;

      return result;
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(
      `- { first: '✅', result: '✅', second: '✅' }`,
    );

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('3', {
        title: 'changed elsewhere',
        completed: true,
      });
      env.apiStore.invalidateItem('3');
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(`
      - { first: '✅', result: '✅', second: '✅' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
    `);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleItems updates pendingSync without changing loaded data and stays stable on plain rerender', async () => {
    const network = createOfflineNetworkMock(false);
    network.install();

    const env = createCollectionStoreTestEnv<
      { name: string },
      PendingSyncCollectionOperations
    >(
      { '1': { name: 'Ada' }, '2': { name: 'Grace' } },
      {
        getSessionKey: () => 'collection-pending-sync-memoization',
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: collectionSchema,
          payloadSchema: rc_string,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'collection-pending-sync-memoization',
              config: { network: network.config },
            }),
            operations: {
              patchName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: () => ({ name: 'ignored' }),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, () => ({
                    value: { name: input.name },
                  }));
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      // This simulates the expected caller/compiler contract: stable args in,
      // stable multi-hook result out when only offline metadata changes.
      const queries = useMemo(() => [{ payload: '1' }, { payload: '2' }], []);
      return env.apiStore.useMultipleItems(queries);
    });

    await flushAllTimers();

    const stableBeforeQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableBeforeQueue);

    await act(async () => {
      await env.apiStore.performMutation('1', {
        mutation: () => Promise.resolve({ value: { name: 'Ada queued' } }),
        offline: {
          operation: 'patchName',
          input: { itemId: '1', name: 'Ada queued' },
        },
      });
    });
    await Promise.resolve();

    expect(hook.result.current.map((item) => item.pendingSync))
      .toMatchInlineSnapshot(`
        ['✅', '❌']
      `);
    expect(hook.result.current.map((item) => item.data?.value.name))
      .toMatchInlineSnapshot(`
        ['Ada', 'Grace']
      `);

    const stableAfterQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableAfterQueue);
  });
});

type PendingSyncListQueryOperations = DefineListQueryOfflineOperations<
  { id: number; name: string },
  ListQueryParams,
  string,
  { patchUserName: DefineOfflineOperation<{ itemId: string; name: string }> }
>;

type PendingOfflineItemsListQueryOperations = DefineListQueryOfflineOperations<
  { id: number; name: string },
  ListQueryParams,
  string,
  {
    patchUserName: DefineOfflineOperation<{ itemId: string; name: string }>;
    deleteUser: DefineOfflineOperation<{ itemId: string }>;
  }
>;

describe('list-query hook memoization', () => {
  test('useItem keeps plain data stable across rerenders and unrelated item updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevData: { id: number; name: string } | null | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { data } = env.apiStore.useItem('users||1');

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(dataChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('users||2', { id: 2, name: 'Changed User 2' });
      env.apiStore.invalidateItem('users||2');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevData);
  });

  test('useItem keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevData: { label: string | null } | undefined;
    const dataChanges: boolean[] = [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: { id: number; name: string } | null) => ({
          label: data?.name ?? null,
        }),
        [],
      );
      const { data } = env.apiStore.useItem('users||1', { selector });

      renders += 1;
      dataChanges.push(prevData !== data);
      prevData = data;

      return data;
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('users||3', { id: 3, name: 'Changed User 3' });
      env.apiStore.invalidateItem('users||3');
    });

    await flushAllTimers();

    expect(dataChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleItems keeps plain entries and outer array stable across rerenders and unrelated updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly TSFDUseListItemReturn<
          { id: number; name: string } | null,
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: { id: number; name: string } | null | undefined;
    let prevSecondData: { id: number; name: string } | null | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      // Multi-query hooks rely on caller/compiler-memoized query arrays rather
      // than rebuilding stability internally.
      const queries = useMemo(
        () => [{ payload: 'users||1' }, { payload: 'users||2' }],
        [],
      );
      const result = env.apiStore.useMultipleItems(queries);

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== result[0]?.data,
        second: prevSecondData !== result[1]?.data,
      });
      prevResult = result;
      prevFirstData = result[0]?.data;
      prevSecondData = result[1]?.data;

      return result;
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(
      `- { first: '✅', result: '✅', second: '✅' }`,
    );

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(changes).toMatchInlineSnapshot(`
      - { first: '✅', result: '✅', second: '✅' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
    `);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('users||3', { id: 3, name: 'Changed User 3' });
      env.apiStore.invalidateItem('users||3');
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevResult);
  });

  test('useMultipleItems keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly TSFDUseListItemReturn<
          { label: string | null },
          string,
          undefined
        >[]
      | undefined;
    let prevFirstData: { label: string | null } | undefined;
    let prevSecondData: { label: string | null } | undefined;
    const changes: Array<{ result: boolean; first: boolean; second: boolean }> =
      [];

    const hook = renderHook(() => {
      const selector = useCallback(
        (data: { id: number; name: string } | null) => ({
          label: data?.name ?? null,
        }),
        [],
      );
      // The query array is memoized explicitly to reflect the intended
      // compiler-backed calling convention for multi-item hooks.
      const queries = useMemo(
        () => [{ payload: 'users||1' }, { payload: 'users||2' }],
        [],
      );
      const result = env.apiStore.useMultipleItems<{ label: string | null }>(
        queries,
        { selector },
      );

      renders += 1;
      changes.push({
        result: prevResult !== result,
        first: prevFirstData !== result[0]?.data,
        second: prevSecondData !== result[1]?.data,
      });
      prevResult = result;
      prevFirstData = result[0]?.data;
      prevSecondData = result[1]?.data;

      return result;
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(
      `- { first: '✅', result: '✅', second: '✅' }`,
    );

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('users||3', { id: 3, name: 'Changed User 3' });
      env.apiStore.invalidateItem('users||3');
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(`
      - { first: '✅', result: '✅', second: '✅' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
      - { first: '❌', result: '❌', second: '❌' }
    `);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useListQuery keeps plain items stable across rerenders and unrelated query updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevItems: ReadonlyArray<{ id: number; name: string }> | undefined;
    const itemsChanges: boolean[] = [];

    const hook = renderHook(() => {
      const { items } = env.apiStore.useListQuery({ tableId: 'users' });

      renders += 1;
      itemsChanges.push(prevItems !== items);
      prevItems = items;

      return items;
    });

    await flushAllTimers();

    expect(itemsChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(itemsChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('products||1', {
        id: 1,
        name: 'Changed Product 1',
      });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'products' },
      });
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevItems);
  });

  test('useListQuery keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevItems: ReadonlyArray<{ label: string }> | undefined;
    const itemsChanges: boolean[] = [];

    const hook = renderHook(() => {
      const itemSelector = useCallback(
        (data: { id: number; name: string }) => ({ label: data.name }),
        [],
      );
      const { items } = env.apiStore.useListQuery(
        { tableId: 'users' },
        { itemSelector },
      );

      renders += 1;
      itemsChanges.push(prevItems !== items);
      prevItems = items;

      return items;
    });

    await flushAllTimers();

    expect(itemsChanges).toMatchInlineSnapshot(`['✅']`);

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('products||1', {
        id: 1,
        name: 'Changed Product 1',
      });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'products' },
      });
    });

    await flushAllTimers();

    expect(itemsChanges).toMatchInlineSnapshot(`['✅', '❌', '❌', '❌']`);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleListQueries keeps plain results stable across rerenders and unrelated query updates', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly ReturnType<
          typeof env.apiStore.useMultipleListQueries
        >[number][]
      | undefined;
    let prevUsersItems: ReadonlyArray<{ id: number; name: string }> | undefined;
    let prevProductsItems:
      | ReadonlyArray<{ id: number; name: string }>
      | undefined;
    const changes: Array<{
      result: boolean;
      users: boolean;
      products: boolean;
    }> = [];

    const hook = renderHook(() => {
      // Query-array stability is expected from the caller/compiler for the
      // multi-query APIs.
      const queries = useMemo(
        () => [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        [],
      );
      const result = env.apiStore.useMultipleListQueries(queries);

      renders += 1;
      changes.push({
        result: prevResult !== result,
        users: prevUsersItems !== result[0]?.items,
        products: prevProductsItems !== result[1]?.items,
      });
      prevResult = result;
      prevUsersItems = result[0]?.items;
      prevProductsItems = result[1]?.items;

      return result;
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(
      `- { products: '✅', result: '✅', users: '✅' }`,
    );

    hook.rerender();
    hook.rerender();
    hook.rerender();

    expect(changes).toMatchInlineSnapshot(`
      - { products: '✅', result: '✅', users: '✅' }
      - { products: '❌', result: '❌', users: '❌' }
      - { products: '❌', result: '❌', users: '❌' }
      - { products: '❌', result: '❌', users: '❌' }
    `);

    const rendersBeforeUpdate = renders;

    act(() => {
      env.serverTable.setItem('orders||1', { id: 1, name: 'Changed Order 1' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'orders' },
      });
    });

    await flushAllTimers();

    expect(renders).toBe(rendersBeforeUpdate);
    expect(hook.result.current).toBe(prevResult);
  });

  test('useMultipleListQueries keeps selector results stable when selector identity is memoized', async () => {
    const env = createListQueryStoreTestEnv(initialServerData, {
      testScenario: { loaded: { tables: ['users', 'products', 'orders'] } },
      usesRealTimeUpdates: true,
    });

    let renders = 0;
    let prevResult:
      | readonly ReturnType<
          typeof env.apiStore.useMultipleListQueries
        >[number][]
      | undefined;
    let prevUsersItems: ReadonlyArray<{ label: string }> | undefined;
    let prevProductsItems: ReadonlyArray<{ label: string }> | undefined;
    const changes: Array<{
      result: boolean;
      users: boolean;
      products: boolean;
    }> = [];

    const hook = renderHook(() => {
      const itemSelector = useCallback(
        (data: { id: number; name: string }) => ({ label: data.name }),
        [],
      );
      // Keep the query list stable at the call site to reflect the contract of
      // the public multi-query hooks.
      const queries = useMemo(
        () => [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        [],
      );
      const result = env.apiStore.useMultipleListQueries<{ label: string }>(
        queries,
        { itemSelector },
      );

      renders += 1;
      changes.push({
        result: prevResult !== result,
        users: prevUsersItems !== result[0]?.items,
        products: prevProductsItems !== result[1]?.items,
      });
      prevResult = result;
      prevUsersItems = result[0]?.items;
      prevProductsItems = result[1]?.items;

      return result;
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(
      `- { products: '✅', result: '✅', users: '✅' }`,
    );

    hook.rerender();
    hook.rerender();
    hook.rerender();

    const rendersBeforeInvalidation = renders;

    act(() => {
      env.serverTable.setItem('orders||1', { id: 1, name: 'Changed Order 1' });
      env.apiStore.invalidateQueryAndItems({
        itemPayload: false,
        queryPayload: { tableId: 'orders' },
      });
    });

    await flushAllTimers();

    expect(changes).toMatchInlineSnapshot(`
      - { products: '✅', result: '✅', users: '✅' }
      - { products: '❌', result: '❌', users: '❌' }
      - { products: '❌', result: '❌', users: '❌' }
      - { products: '❌', result: '❌', users: '❌' }
    `);
    expect(renders).toBe(rendersBeforeInvalidation);
  });

  test('useMultipleItems updates pendingSync without changing loaded item data and stays stable on plain rerender', async () => {
    const network = createOfflineNetworkMock(false);
    network.install();

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PendingSyncListQueryOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        getSessionKey: () => 'list-query-item-pending-sync-memoization',
        testScenario: { loaded: { tables: ['users'] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'list-query-item-pending-sync-memoization',
              config: { network: network.config },
            }),
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: () => ({ name: 'ignored' }),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      // Pending-sync changes should preserve outer-array stability when the
      // caller/compiler keeps the multi-item query array stable.
      const queries = useMemo(
        () => [{ payload: 'users||1' }, { payload: 'users||2' }],
        [],
      );
      return env.apiStore.useMultipleItems(queries);
    });

    await flushAllTimers();

    const stableBeforeQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableBeforeQueue);

    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada queued' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued' },
        },
      });
    });
    await Promise.resolve();

    expect(hook.result.current.map((item) => item.pendingSync))
      .toMatchInlineSnapshot(`
        ['✅', '❌']
      `);
    expect(hook.result.current.map((item) => item.data?.name))
      .toMatchInlineSnapshot(`
        ['Ada', 'Grace']
      `);

    const stableAfterQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableAfterQueue);
  });

  test('useMultipleListQueries updates query pendingSync when an item becomes pending and stays stable on plain rerender', async () => {
    const network = createOfflineNetworkMock(false);
    network.install();

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PendingSyncListQueryOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
        products: [{ id: 1, name: 'Keyboard' }],
      },
      {
        getSessionKey: () => 'list-query-query-pending-sync-memoization',
        testScenario: { loaded: { tables: ['users', 'products'] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () => 'list-query-query-pending-sync-memoization',
              config: { network: network.config },
            }),
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: () => ({ name: 'ignored' }),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      // As above, the multi-query hook relies on stable caller-provided query
      // arrays instead of internal deep-stable repair logic.
      const queries = useMemo(
        () => [
          { payload: { tableId: 'users' } },
          { payload: { tableId: 'products' } },
        ],
        [],
      );
      return env.apiStore.useMultipleListQueries(queries);
    });

    await flushAllTimers();

    const stableBeforeQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableBeforeQueue);

    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada queued' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued' },
        },
      });
    });
    await Promise.resolve();

    expect(hook.result.current.map((query) => query.pendingSync))
      .toMatchInlineSnapshot(`
        ['✅', '❌']
      `);
    expect(hook.result.current[0]?.items.map((item) => item.name))
      .toMatchInlineSnapshot(`
        ['Ada', 'Grace']
      `);

    const stableAfterQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableAfterQueue);
  });

  test('usePendingOfflineItems stays stable on plain rerender while exposing visible items and deleted payloads', async () => {
    const network = createOfflineNetworkMock(false);
    network.install();

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PendingOfflineItemsListQueryOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        getSessionKey: () => 'list-query-pending-offline-items-memoization',
        testScenario: { loaded: { tables: ['users'] } },
        persistentStorage: {
          adapter: 'local-sync',
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offline: {
            session: createOfflineSession({
              getSessionKey: () =>
                'list-query-pending-offline-items-memoization',
              config: { network: network.config },
            }),
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: () => ({ name: 'ignored' }),
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (item) => ({
                    ...item,
                    name: input.name,
                  }));
                },
              },
              deleteUser: {
                inputSchema: deleteItemInputSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute: async () => {},
                onSuccessExecute: ({ input }) => {
                  env.apiStore.deleteItemState(input.itemId);
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      return env.apiStore.usePendingOfflineItems({
        selector: (item) => item.name,
      });
    });

    await flushAllTimers();

    const stableBeforeQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableBeforeQueue);

    // Queue one visible edit and one delete so the hook has to keep both
    // collection outputs stable across plain rerenders.
    await act(async () => {
      await env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            name: 'Ada queued',
          }));
        },
        mutation: () => Promise.resolve({ name: 'Ada queued' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued' },
        },
      });
    });
    await act(async () => {
      await env.apiStore.performMutation('users||2', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('users||2');
        },
        mutation: async () => {},
        offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
      });
    });
    await Promise.resolve();

    expect(hook.result.current).toMatchInlineSnapshot(`
      deletedItems: ['users||2']
      items: ['Ada queued']
    `);

    const stableAfterQueue = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(stableAfterQueue);
  });
});
