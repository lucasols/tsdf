import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';

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

function byTypeFilter(
  type: 'admin' | 'user',
): NonNullable<ListQueryParams['filters']> {
  return [{ op: 'eq', field: 'type', value: type }];
}

type DocumentValue = { hello: string };

test('document mutation failures use the manager onMutationError fallback', async () => {
  const onMutationError = vi.fn();
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    onMutationError,
  });
  const env = createDocumentStoreTestEnv<DocumentValue>(
    { hello: 'world' },
    { testScenario: 'loaded', storeManager },
  );

  const resultPromise = env.performClientUpdateAction(
    { hello: 'ignored' },
    { error: 'boom' },
  );

  await flushAllTimers();
  await resultPromise;

  expect(onMutationError).toHaveBeenCalledTimes(1);
  expect(onMutationError.mock.calls[0]?.[1]).toHaveProperty(
    'dontShowToast',
    undefined,
  );
});

test('document mutation failures use store onMutationError before manager fallback', async () => {
  const managerOnMutationError = vi.fn();
  const storeOnMutationError = vi.fn();
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    onMutationError: managerOnMutationError,
  });
  const env = createDocumentStoreTestEnv<DocumentValue>(
    { hello: 'world' },
    {
      testScenario: 'loaded',
      storeManager,
      onMutationError: storeOnMutationError,
    },
  );

  const resultPromise = env.performClientUpdateAction(
    { hello: 'ignored' },
    { error: 'boom' },
  );

  await flushAllTimers();
  await resultPromise;

  expect(storeOnMutationError).toHaveBeenCalledTimes(1);
  expect(managerOnMutationError).not.toHaveBeenCalled();
});

test('document mutation failures skip manager onMutationError when store disables it', async () => {
  const managerOnMutationError = vi.fn();
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    onMutationError: managerOnMutationError,
  });
  const env = createDocumentStoreTestEnv<DocumentValue>(
    { hello: 'world' },
    { testScenario: 'loaded', storeManager, onMutationError: null },
  );

  const resultPromise = env.performClientUpdateAction(
    { hello: 'ignored' },
    { error: 'boom' },
  );

  await flushAllTimers();
  await resultPromise;

  expect(managerOnMutationError).not.toHaveBeenCalled();
});

test('document optimistic mutation failures roll back without entering refetching', async () => {
  const env = createDocumentStoreTestEnv<DocumentValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data, status } = env.apiStore.useDocument({
      returnRefetchingStatus: true,
    });

    renders.add({ hello: data?.value.hello ?? null, status });
  });

  // Apply the optimistic document update through the public test env helper.
  act(() => {
    void env.performClientUpdateAction(
      { hello: 'was updated' },
      { withOptimisticUpdate: true, error: 'boom' },
    );
  });

  await flushAllTimers();

  // The original document should be restored immediately after the failure.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> hello: world ⋅ status: success
    -> hello: was updated ⋅ status: success
    -> hello: world ⋅ status: success
    "
  `);
  // The rollback should not schedule a follow-up refetch.
  expect(env.apiStore.store.state.refetchOnMount).toMatchInlineSnapshot(`"❌"`);
});

test('document non-optimistic mutation failures leave state untouched and skip invalidation', async () => {
  const env = createDocumentStoreTestEnv<DocumentValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data, status } = env.apiStore.useDocument({
      returnRefetchingStatus: true,
    });

    renders.add({ hello: data?.value.hello ?? null, status });
  });

  // Fail a mutation without any optimistic state change.
  act(() => {
    void env.performClientUpdateAction(
      { hello: 'ignored' },
      { withOptimisticUpdate: false, error: 'boom' },
    );
  });

  await flushAllTimers();

  // The visible document should stay exactly where it started.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> hello: world ⋅ status: success
    "
  `);
  // No error refetch should be queued anymore.
  expect(env.apiStore.store.state.refetchOnMount).toMatchInlineSnapshot(`"❌"`);
});

test('collection optimistic update failures restore the previous item state', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const result = env.apiStore.useItem('item-1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({
      name: result.data?.value.name ?? null,
      status: result.status,
    });
  });

  // Optimistically change the item through the public mutation helper.
  act(() => {
    void env.performClientUpdateAction(
      'item-1',
      { name: 'Renamed' },
      { withOptimisticUpdate: true, error: 'boom' },
    );
  });

  await flushAllTimers();

  // The collection item should bounce back to its previous snapshot.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Item 1 ⋅ status: success
    -> name: Renamed ⋅ status: success
    -> name: Item 1 ⋅ status: success
    "
  `);
  // Failed optimistic writes should not leave the item invalidated.
  expect(
    pick(env.apiStore.getItemState('item-1'), ['refetchOnMount']),
  ).toMatchInlineSnapshot(`refetchOnMount: '❌'`);
});

test('collection rollback removes optimistic creations when the payload is concrete', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  // Add a brand-new targeted item optimistically, then fail the mutation.
  await env.apiStore.performMutation('item-2', {
    optimisticUpdate: () => {
      env.apiStore.addItemToState('item-2', { value: { name: 'Item 2' } });
    },
    mutation: () => Promise.reject(new Error('boom')),
  });

  await flushAllTimers();

  // The optimistic item should disappear entirely after the rollback.
  expect(env.apiStore.getItemState('item-2')).toMatchInlineSnapshot(
    `undefined`,
  );
});

test('collection optimistic delete failures restore the deleted item', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const result = env.apiStore.useItem('item-1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({
      name: result.data?.value.name ?? null,
      status: result.status,
    });
  });

  // Optimistically delete the item and fail the request so rollback must
  // restore the full pre-mutation item snapshot.
  await act(async () => {
    await env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('item-1');
      },
      mutation: () => Promise.reject(new Error('boom')),
    });
  });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Item 1 ⋅ status: success
    -> name: null ⋅ status: deleted
    -> name: Item 1 ⋅ status: success
    "
  `);
  expect(pick(env.apiStore.getItemState('item-1'), ['data', 'refetchOnMount']))
    .toMatchInlineSnapshot(`
      data:
        value: { name: 'Item 1' }

      refetchOnMount: '❌'
    `);
});

type ListQueryUser = { id: number; name: string; type: 'admin' | 'user' };

test('list-query optimistic failures restore item data and query membership', async () => {
  const initialServerData: Tables<ListQueryUser> = {
    users: [
      { id: 1, name: 'Ada', type: 'admin' },
      { id: 2, name: 'Grace', type: 'user' },
    ],
  };
  const adminQuery = { tableId: 'users', filters: byTypeFilter('admin') };
  const userQuery = { tableId: 'users', filters: byTypeFilter('user') };
  const env = createListQueryStoreTestEnv(initialServerData, {
    testScenario: { loaded: { queries: [adminQuery, userQuery] } },
    optimisticListUpdates: [
      { queries: adminQuery, filterItem: (item) => item.type === 'admin' },
      {
        queries: userQuery,
        filterItem: (item) => item.type === 'user',
        // Items entering this query appear at the top — this is why the
        // optimistic snapshot shows [Ada moved, Grace] in that order.
        appendNewTo: 'start',
        // Mark the destination query for revalidation on optimistic moves.
        // The rollback must also undo this deferred invalidation.
        invalidateQueries: true,
      },
    ],
  });

  const adminRenders = createLoggerStore({ arrays: 'all' });
  const userRenders = createLoggerStore({ arrays: 'all' });

  // Track the admin and user query items through render cycles to observe
  // the optimistic → rollback transition from the consumer's perspective.
  renderHook(() => {
    const query = env.apiStore.useListQuery(adminQuery, {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    adminRenders.add({
      items: query.items.map((item) => item.name),
      status: query.status,
    });
  });

  renderHook(() => {
    const query = env.apiStore.useListQuery(userQuery, {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    userRenders.add({
      items: query.items.map((item) => item.name),
      status: query.status,
    });
  });

  // Optimistically move Ada from admin → user, then fail the request
  // immediately so the rollback fires within the same act boundary.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: (payload) => {
        env.apiStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Ada moved',
          type: 'user',
        }));
      },
      mutation: () => Promise.reject(new Error('boom')),
    });
  });

  await flushAllTimers();

  // Both queries should show: initial → optimistic → rollback to original.
  expect(adminRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Ada] ⋅ status: success
    -> items: [] ⋅ status: success
    -> items: [Ada] ⋅ status: success
    "
  `);
  expect(userRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Grace] ⋅ status: success
    -> items: [Ada moved, Grace] ⋅ status: success
    -> items: [Grace] ⋅ status: success
    "
  `);

  // The item data should be fully restored to its pre-mutation values.
  expect(pick(env.apiStore.getItemState('users||1'), ['name', 'type']))
    .toMatchInlineSnapshot(`
      name: 'Ada'
      type: 'admin'
    `);
  // Both queries should be back to original membership AND the deferred
  // invalidation from `invalidateQueries: true` should also be reverted —
  // refetchOnMount stays false, not upgraded to highPriority.
  expect(
    pick(env.apiStore.getQueryState(adminQuery), ['items', 'refetchOnMount']),
  ).toMatchInlineSnapshot(`
    items: ['"users||1']
    refetchOnMount: '❌'
  `);
  expect(
    pick(env.apiStore.getQueryState(userQuery), ['items', 'refetchOnMount']),
  ).toMatchInlineSnapshot(`
    items: ['"users||2']
    refetchOnMount: '❌'
  `);
});

test('list-query rollback removes temp items added through addItemToQueries', async () => {
  // temp: prefix — this item has no server-side backing, simulating an
  // optimistic create (e.g. offline-first flow).
  const tempItemId = 'temp:Linus offline';
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    {
      users: [
        { id: 1, name: 'Ada', type: 'admin' },
        { id: 2, name: 'Grace', type: 'user' },
      ],
    },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  // Optimistically create a new item and manually insert it into the query
  // via addItemToQueries, then fail the mutation.
  await act(async () => {
    await env.apiStore.performMutation(tempItemId, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          tempItemId,
          { id: -1, name: 'Linus offline', type: 'user' },
          // Manually add the new item to query membership — unlike
          // optimisticListUpdates filters, this is a direct insertion.
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () => Promise.reject(new Error('boom')),
    });
  });

  await flushAllTimers();

  // The failed optimistic create should disappear from both item state and the
  // query membership it inserted itself into.
  expect(env.apiStore.getItemState(tempItemId)).toMatchInlineSnapshot(
    `undefined`,
  );
  expect(
    pick(env.apiStore.getQueryState(usersQuery), ['items', 'refetchOnMount']),
  ).toMatchInlineSnapshot(`
    items: ['"users||1', '"users||2']
    refetchOnMount: '❌'
  `);
});

test('list-query optimistic delete failures restore item state and query membership', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    {
      users: [
        { id: 1, name: 'Ada', type: 'admin' },
        { id: 2, name: 'Grace', type: 'user' },
      ],
    },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  const itemRenders = createLoggerStore();
  const queryRenders = createLoggerStore({ arrays: 'all' });

  renderHook(() => {
    const item = env.apiStore.useItem('users||1', {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    itemRenders.add({ name: item.data?.name ?? null, status: item.status });
  });

  renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    queryRenders.add({
      items: query.items.map((item) => item.name),
      status: query.status,
    });
  });

  // Optimistically delete Ada, then fail the mutation. Both the item hook and
  // the loaded query should snap back to their original state.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||1');
      },
      mutation: () => Promise.reject(new Error('boom')),
    });
  });

  await flushAllTimers();

  expect(itemRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Ada ⋅ status: success
    -> name: null ⋅ status: deleted
    -> name: Ada ⋅ status: success
    "
  `);
  expect(queryRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Ada, Grace] ⋅ status: success
    -> items: [Grace] ⋅ status: success
    -> items: [Ada, Grace] ⋅ status: success
    "
  `);
  expect(pick(env.apiStore.getItemState('users||1'), ['name', 'type']))
    .toMatchInlineSnapshot(`
      name: 'Ada'
      type: 'admin'
    `);
  expect(
    pick(env.apiStore.getQueryState(usersQuery), ['items', 'refetchOnMount']),
  ).toMatchInlineSnapshot(`
    items: ['"users||1', '"users||2']
    refetchOnMount: '❌'
  `);
});
