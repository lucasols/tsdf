import { sleep } from '@ls-stack/utils/sleep';
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
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';

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
    'silentErrors',
    undefined,
  );
});

test('document mutation failures pass silentErrors to the shared onMutationError handler', async () => {
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

  const result = await env.apiStore.performMutation({
    silentErrors: true,
    mutation: () => Promise.reject(new Error('boom')),
  });

  expect(result.ok).toBe(false);
  expect(onMutationError).toHaveBeenCalledTimes(1);
  expect(onMutationError.mock.calls[0]?.[1]).toMatchInlineSnapshot(`
    silentErrors: '✅'
  `);
});

test('collection mutation failures pass silentErrors to the shared onMutationError handler', async () => {
  const onMutationError = vi.fn();
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    onMutationError,
  });
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded', storeManager },
  );

  const result = await env.apiStore.performMutation('item-1', {
    silentErrors: true,
    mutation: () => Promise.reject(new Error('boom')),
  });

  expect(result.ok).toBe(false);
  expect(onMutationError).toHaveBeenCalledTimes(1);
  expect(onMutationError.mock.calls[0]?.[1]).toMatchInlineSnapshot(`
    silentErrors: '✅'
  `);
});

test('list query mutation failures pass silentErrors to the shared onMutationError handler', async () => {
  const onMutationError = vi.fn();
  const storeManager = createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    onMutationError,
  });
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { items: ['users||1'] } }, storeManager },
  );

  const result = await env.apiStore.performMutation('users||1', {
    silentErrors: true,
    mutation: () => Promise.reject(new Error('boom')),
  });

  expect(result.ok).toBe(false);
  expect(onMutationError).toHaveBeenCalledTimes(1);
  expect(onMutationError.mock.calls[0]?.[1]).toMatchInlineSnapshot(`
    silentErrors: '✅'
  `);
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

// An invalidation (e.g. from a realtime event) while the mutation is in
// flight only changes the item's fetch metadata, not its data. The failed
// optimistic data must still be reverted right away, and the invalidation must
// survive the rollback so the item is refetched once the mutation ends.
test('collection optimistic failures revert the data but keep an invalidation received in flight', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useItem('item-1', {
      disableRefetchOnMount: true,
    });
    renders.add({ name: data?.value.name ?? null });
  });

  let rejectMutation: (error: Error) => void = () => {};
  act(() => {
    void env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-1', (draft) => {
          draft.value.name = 'Renamed';
        });
      },
      mutation: () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        }),
    });
  });

  // The item is invalidated while the mutation is in flight; its refetch
  // waits for the mutation lock
  await advanceTime(100);
  act(() => {
    env.apiStore.invalidateItem('item-1');
  });
  renders.addMark('mutation fails');

  act(() => {
    rejectMutation(new Error('rename failed'));
  });
  await advanceTime(0);

  // The failed rename is reverted immediately, without waiting for the refetch
  expect(env.apiStore.getItemState('item-1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 1' }`,
  );

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Item 1
    -> name: Renamed

    >>> mutation fails

    -> name: Item 1
    "
  `);
  // The invalidation received in flight still refetches the item
  expect(env.serverTable.numOfStartedFetches).toBe(1);
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

// An invalidation reaching the new item while the create is in flight only
// changes its fetch metadata. The rejected item must still be removed.
test('collection rollback removes optimistic creations invalidated while in flight', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  let rejectMutation: (error: Error) => void = () => {};
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('item-2', { value: { name: 'Item 2' } });
      },
      mutation: () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        }),
    });
  });

  // e.g. a realtime event invalidating every item
  await advanceTime(100);
  act(() => {
    env.apiStore.invalidateItem(() => true);
  });

  act(() => {
    rejectMutation(new Error('boom'));
  });
  await flushAllTimers();

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

// An invalidation reaching the new item while the create is in flight only
// changes its fetch metadata. The rejected item and its metadata must still be
// removed, not leave an orphan item query behind.
test('list-query rollback removes optimistic creations invalidated while in flight', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  let rejectMutation: (error: Error) => void = () => {};
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'users||2',
          { id: 2, name: 'Grace', type: 'user' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        }),
    });
  });

  // e.g. a realtime event invalidating every item
  await advanceTime(100);
  act(() => {
    env.apiStore.invalidateItem(() => true);
  });

  act(() => {
    rejectMutation(new Error('boom'));
  });
  await flushAllTimers();

  expect(env.apiStore.getItemState('users||2')).toMatchInlineSnapshot(
    `undefined`,
  );
  // No item query is left behind for the removed item
  expect(Object.keys(env.store.state.itemQueries)).toMatchInlineSnapshot(
    `['"users||1']`,
  );
  expect(
    pick(env.apiStore.getQueryState(usersQuery), ['items']),
  ).toMatchInlineSnapshot(`items: ['"users||1']`);
});

// Undoing a delete: the item is recreated over its deleted cache entry, an
// invalidation hits it while the request is in flight, and the request fails.
// The item must go back to being deleted, not to a loaded item without data.
test('list-query rollback restores a deleted item when its failed recreation was invalidated in flight', async () => {
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

  // The item was deleted earlier, leaving a deleted cache entry
  act(() => {
    env.apiStore.deleteItemState('users||2');
  });

  const renders = createLoggerStore();
  renderHook(() => {
    const item = env.apiStore.useItem('users||2', { loadFromStateOnly: true });
    renders.add({ name: item.data?.name ?? null, status: item.status });
  });

  let rejectMutation: (error: Error) => void = () => {};
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('users||2', {
          id: 2,
          name: 'Grace',
          type: 'user',
        });
      },
      mutation: () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        }),
    });
  });

  // e.g. a realtime event invalidating every item
  await advanceTime(100);
  act(() => {
    env.apiStore.invalidateItem(() => true);
  });
  renders.addMark('recreation fails');

  act(() => {
    rejectMutation(new Error('boom'));
  });
  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: null ⋅ status: deleted
    -> name: Grace ⋅ status: success

    >>> recreation fails

    -> name: null ⋅ status: deleted
    "
  `);
});

// An item the server has but the client never loaded is added to the cache
// by a slow mutation that ends up failing. While it is in flight, a second
// mutation renames the item and succeeds. The renamed item is kept, so it must
// keep the metadata needed to read and revalidate it.
test('list-query failed creations keep a newer change readable and revalidate it', async () => {
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    {
      users: [
        { id: 1, name: 'Ada', type: 'admin' },
        { id: 2, name: 'Grace', type: 'user' },
      ],
    },
    { testScenario: { loaded: { items: ['users||1'] } } },
  );

  const renders = createLoggerStore();
  renderHook(() => {
    const item = env.apiStore.useItem('users||2', { loadFromStateOnly: true });
    renders.add({ name: item.data?.name ?? null, status: item.status });
  });

  // Slow mutation that seeds the item into the cache and fails
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('users||2', {
          id: 2,
          name: 'Grace',
          type: 'user',
        });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('seed failed');
      },
    });
  });

  // Rename: starts while the first mutation is in flight and succeeds
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||2', (draft) => {
          draft.name = 'Grace Hopper';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'users||2',
          { name: 'Grace Hopper' },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // The renamed item stays readable after the first mutation fails
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: null ⋅ status: error
    -> name: Grace ⋅ status: success
    -> name: Grace Hopper ⋅ status: success
    "
  `);
  // The kept item is marked stale, so mounted item hooks refetch it from the
  // server
  expect(env.store.state.itemQueries['"users||2']?.refetchOnMount).toBe(
    'highPriority',
  );
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

// An optimistic update can throw, e.g. when the cached data has an unexpected
// shape. That must fail the mutation like any other error instead of leaving
// the store mutation-locked, which would hold every later fetch forever.
test('document optimistic updates that throw fail the mutation and release the store lock', async () => {
  const env = createDocumentStoreTestEnv<DocumentValue>(
    { hello: 'world' },
    { testScenario: 'loaded' },
  );
  const mutation = vi.fn(() => Promise.resolve());

  const result = await env.apiStore.performMutation({
    optimisticUpdate: () => {
      throw new Error('unexpected cached data');
    },
    mutation,
  });

  // The failure is returned as a mutation error and nothing is sent
  expect(result.ok).toBe(false);
  expect(mutation).not.toHaveBeenCalled();

  // With a leaked lock the fetch would be held as 'scheduled' forever
  expect(env.scheduleFetch('highPriority')).toBe('triggered');
});

test('collection optimistic updates that throw fail the mutation and release the item lock', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );
  const mutation = vi.fn(() => Promise.resolve());

  const result = await env.apiStore.performMutation('item-1', {
    optimisticUpdate: () => {
      throw new Error('unexpected cached data');
    },
    mutation,
  });

  // The failure is returned as a mutation error and nothing is sent
  expect(result.ok).toBe(false);
  expect(mutation).not.toHaveBeenCalled();

  // With a leaked lock the fetch would be held as 'scheduled' forever
  expect(env.scheduleFetch('highPriority', 'item-1')).toBe('triggered');
});

// The server accepted the mutation, so a buggy `onSuccess` callback must not
// revert its optimistic update: without a revalidation the UI would contradict
// the server. The call still reports the error.
test('collection onSuccess errors keep the optimistic update of an accepted mutation', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  let result: { ok: boolean } | undefined;
  void env.apiStore
    .performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-1', (draft) => {
          draft.value.name = 'Renamed';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'item-1',
          { name: 'Renamed' },
          { durationMs: 200 },
        ),
      revalidateOnSuccess: false,
      onSuccess: () => {
        throw new Error('onSuccess bug');
      },
    })
    .then((r) => {
      result = r;
    });

  await flushAllTimers();

  expect(result?.ok).toBe(false);
  // The optimistic value matches the server
  expect(env.apiStore.getItemState('item-1')?.data).toMatchInlineSnapshot(
    `value: { name: 'Renamed' }`,
  );
  expect(env.serverTable.get('item-1')).toMatchInlineSnapshot(
    `name: 'Renamed'`,
  );
});

test('list-query onSuccess errors keep the optimistic update of an accepted mutation', async () => {
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { testScenario: { loaded: { items: ['users||1'] } } },
  );

  let result: { ok: boolean } | undefined;
  void env.apiStore
    .performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (draft) => {
          draft.name = 'Ada Lovelace';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'users||1',
          { name: 'Ada Lovelace' },
          { durationMs: 200 },
        ),
      revalidateOnSuccess: false,
      onSuccess: () => {
        throw new Error('onSuccess bug');
      },
    })
    .then((r) => {
      result = r;
    });

  await flushAllTimers();

  expect(result?.ok).toBe(false);
  // The optimistic value matches the server
  expect(env.apiStore.getItemState('users||1')?.name).toBe('Ada Lovelace');
  expect(env.serverTable.get('users||1')?.name).toBe('Ada Lovelace');
});

test('list-query optimistic updates that throw fail the mutation and release the item and query locks', async () => {
  const adminQuery = { tableId: 'users', filters: byTypeFilter('admin') };
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { queries: [adminQuery] } } },
  );
  const mutation = vi.fn(() => Promise.resolve());

  const result = await env.apiStore.performMutation('users||1', {
    optimisticUpdate: () => {
      throw new Error('unexpected cached data');
    },
    mutation,
  });

  // The failure is returned as a mutation error and nothing is sent
  expect(result.ok).toBe(false);
  expect(mutation).not.toHaveBeenCalled();

  // Both the item and the query containing it must be fetchable again
  expect(env.scheduleItemFetch('highPriority', 'users||1')).toBe('triggered');
  expect(env.scheduleFetch('highPriority', adminQuery)).toBe('triggered');
});

test('a throwing onSuccess does not release the lock of a concurrent mutation on the same item', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  // A slow mutation keeps item-1 locked
  void env.apiStore.performMutation('item-1', {
    mutation: () => env.serverTable.delayedUpdateItem('item-1', { name: 'A' }),
  });

  // A fast mutation on the same item finishes first and its onSuccess throws,
  // which runs the error path after the lock was already released once
  await env.apiStore.performMutation('item-1', {
    mutation: () => Promise.resolve(),
    onSuccess: () => {
      throw new Error('onSuccess failed');
    },
  });

  // The slow mutation is still in flight, so fetches of item-1 must stay on
  // hold instead of committing data from before it is persisted
  expect(env.scheduleFetch('highPriority', 'item-1')).toBe('scheduled');
});

type Toggles = { a: boolean; b: boolean };

// Toggling two independent switches quickly: the first toggle fails after the
// second one already succeeded. Rolling back the first toggle must not undo
// the second one, which the server kept. The document data changed since the
// failed update, so the store keeps it and refetches to drop the failed toggle.
test('document optimistic failures keep the changes of a concurrent mutation that succeeded', async () => {
  const env = createDocumentStoreTestEnv<Toggles>(
    { a: false, b: false },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useDocument({ disableRefetchOnMount: true });
    renders.add({ a: data?.value.a, b: data?.value.b });
  });

  // Toggle A: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value.a = true;
        });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('toggle A failed');
      },
    });
  });

  // Toggle B: starts while A is in flight and succeeds before A fails
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation({
      optimisticUpdate: () => {
        env.apiStore.updateState((draft) => {
          draft.value.b = true;
        });
      },
      mutation: () =>
        env.serverMock.delayedSetData(
          { ...env.serverMock.current, b: true },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // B is never undone: A stays on until the refetch brings the server value
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> a: ❌ ⋅ b: ❌
    -> a: ✅ ⋅ b: ❌
    -> a: ✅ ⋅ b: ✅
    -> a: ❌ ⋅ b: ✅
    "
  `);
  expect(env.serverMock.current).toMatchInlineSnapshot(`
    a: '❌'
    b: '✅'
  `);
  // The reconciling refetch after A failed
  expect(env.serverMock.numOfStartedFetches).toBe(1);
});

// Both optimistic updates change the same field, so reverting the first one
// can't tell which value is right. The store keeps the newer value and
// refetches once the mutations end, so the UI converges to the server.
test('document optimistic failures that conflict with a newer change refetch to reconcile', async () => {
  const env = createDocumentStoreTestEnv<Toggles>(
    { a: false, b: false },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useDocument({ disableRefetchOnMount: true });
    renders.add({ a: data?.value.a, b: data?.value.b });
  });

  function toggleA(value: boolean, failAfterMs: number) {
    act(() => {
      void env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value.a = value;
          });
        },
        mutation: async () => {
          await sleep(failAfterMs);
          throw new Error('toggle failed');
        },
      });
    });
  }

  // Toggle A on and back off; both requests fail, the first one first
  toggleA(true, 500);
  await advanceTime(100);
  toggleA(false, 800);

  await flushAllTimers();

  // Reverting each toggle with its own snapshot would end on `a: true`, a
  // value the server never had. The refetch settles it on the server value.
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> a: ❌ ⋅ b: ❌
    -> a: ✅ ⋅ b: ❌
    -> a: ❌ ⋅ b: ❌
    -> a: ✅ ⋅ b: ❌
    -> a: ❌ ⋅ b: ❌
    "
  `);
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('collection optimistic failures keep the changes of a concurrent mutation that succeeded', async () => {
  const env = createCollectionStoreTestEnv<Toggles>(
    { 'item-1': { a: false, b: false } },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useItem('item-1', {
      disableRefetchOnMount: true,
    });
    renders.add({ a: data?.value.a, b: data?.value.b });
  });

  // Toggle A: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-1', (draft) => {
          draft.value.a = true;
        });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('toggle A failed');
      },
    });
  });

  // Toggle B: starts while A is in flight and succeeds before A fails
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-1', (draft) => {
          draft.value.b = true;
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'item-1',
          { b: true },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // B is never undone: A stays on until the refetch brings the server value
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> a: ❌ ⋅ b: ❌
    -> a: ✅ ⋅ b: ❌
    -> a: ✅ ⋅ b: ✅
    -> a: ❌ ⋅ b: ✅
    "
  `);
  expect(env.serverTable.get('item-1')).toMatchInlineSnapshot(`
    a: '❌'
    b: '✅'
  `);
  // The reconciling refetch after A failed
  expect(env.serverTable.numOfStartedFetches).toBe(1);
});

test('list-query optimistic failures keep the changes of a concurrent mutation that succeeded', async () => {
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', city: 'London' }] },
    { testScenario: { loaded: { items: ['users||1'] } } },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useItem('users||1', {
      disableRefetchOnMount: true,
    });
    renders.add({ name: data?.name, city: data?.city });
  });

  // Rename: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (draft) => {
          draft.name = 'Ada Lovelace';
        });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('rename failed');
      },
    });
  });

  // Move: starts while the rename is in flight and succeeds before it fails
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (draft) => {
          draft.city = 'Paris';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'users||1',
          { city: 'Paris' },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // The city change is never undone: the rename stays until the refetch
  // brings the server value
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Ada ⋅ city: London
    -> name: Ada Lovelace ⋅ city: London
    -> name: Ada Lovelace ⋅ city: Paris
    -> name: Ada ⋅ city: Paris
    "
  `);
  // The reconciling refetch after the rename failed
  expect(env.serverTable.numOfStartedFetches).toBe(1);
});

// Same race, but the item is only displayed through a list. List hooks don't
// refetch on item invalidations, so the queries containing the item must be
// revalidated too, or the list would keep showing the rejected rename.
test('list-query optimistic failures that overlap a concurrent mutation revalidate the lists showing the item', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', city: 'London' }] },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { items } = env.apiStore.useListQuery(usersQuery, {
      disableRefetchOnMount: true,
    });
    renders.add({ name: items[0]?.name, city: items[0]?.city });
  });

  // Rename: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (draft) => {
          draft.name = 'Ada Lovelace';
        });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('rename failed');
      },
    });
  });

  // Move: starts while the rename is in flight and succeeds before it fails
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (draft) => {
          draft.city = 'Paris';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'users||1',
          { city: 'Paris' },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // The list refetch drops the rejected rename and keeps the city change
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Ada ⋅ city: London
    -> name: Ada Lovelace ⋅ city: London
    -> name: Ada Lovelace ⋅ city: Paris
    -> name: Ada ⋅ city: Paris
    "
  `);
  expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`
    - _type: 'list'
      payload:
        fields: '*'
        pos: { limit: 50, offset: 0 }
      returned_items: 1
      time: '1.21s -> 2.01s | duration: 800ms'
  `);
});

// Saving the same name twice: the second save's optimistic update leaves the
// state as it was, so reverting the first failed save can't see the overlap
// from the state alone. The store still knows a newer optimistic update
// happened, so it revalidates instead of trusting the reverted value.
test('document optimistic failures revalidate when a newer save of the same value succeeded', async () => {
  const env = createDocumentStoreTestEnv<{ name: string }>(
    { name: 'Ada' },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useDocument({ disableRefetchOnMount: true });
    renders.add({ name: data?.value.name });
  });

  function saveName(mutation: () => Promise<unknown>) {
    act(() => {
      void env.apiStore.performMutation({
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value.name = 'Grace';
          });
        },
        mutation,
      });
    });
  }

  // First save: slow request that ends up failing
  saveName(async () => {
    await sleep(1_200);
    throw new Error('save failed');
  });

  // Second save of the same name: succeeds before the first one fails
  await advanceTime(100);
  saveName(() =>
    env.serverMock.delayedSetData({ name: 'Grace' }, { durationMs: 500 }),
  );

  await flushAllTimers();

  // The failed save is reverted, then the refetch restores the saved name
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Ada
    -> name: Grace
    -> name: Ada
    -> name: Grace
    "
  `);
  expect(env.serverMock.current).toMatchInlineSnapshot(`name: 'Grace'`);
  expect(env.serverMock.numOfStartedFetches).toBe(1);
});

test('collection optimistic failures revalidate when a newer save of the same value succeeded', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Ada' } },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useItem('item-1', {
      disableRefetchOnMount: true,
    });
    renders.add({ name: data?.value.name });
  });

  function saveName(mutation: () => Promise<unknown>) {
    act(() => {
      void env.apiStore.performMutation('item-1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('item-1', (draft) => {
            draft.value.name = 'Grace';
          });
        },
        mutation,
      });
    });
  }

  // First save: slow request that ends up failing
  saveName(async () => {
    await sleep(1_200);
    throw new Error('save failed');
  });

  // Second save of the same name: succeeds before the first one fails
  await advanceTime(100);
  saveName(() =>
    env.serverTable.delayedUpdateItem(
      'item-1',
      { name: 'Grace' },
      { durationMs: 500 },
    ),
  );

  await flushAllTimers();

  // The failed save is reverted, then the refetch restores the saved name
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Ada
    -> name: Grace
    -> name: Ada
    -> name: Grace
    "
  `);
  expect(env.serverTable.numOfStartedFetches).toBe(1);
});

test('list-query optimistic failures revalidate when a newer save of the same value succeeded', async () => {
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada' }] },
    { testScenario: { loaded: { items: ['users||1'] } } },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const { data } = env.apiStore.useItem('users||1', {
      disableRefetchOnMount: true,
    });
    renders.add({ name: data?.name });
  });

  function saveName(mutation: () => Promise<unknown>) {
    act(() => {
      void env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => {
            draft.name = 'Grace';
          });
        },
        mutation,
      });
    });
  }

  // First save: slow request that ends up failing
  saveName(async () => {
    await sleep(1_200);
    throw new Error('save failed');
  });

  // Second save of the same name: succeeds before the first one fails
  await advanceTime(100);
  saveName(() =>
    env.serverTable.delayedUpdateItem(
      'users||1',
      { name: 'Grace' },
      { durationMs: 500 },
    ),
  );

  await flushAllTimers();

  // The failed save is reverted, then the refetch restores the saved name
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Ada
    -> name: Grace
    -> name: Ada
    -> name: Grace
    "
  `);
  expect(env.serverTable.numOfStartedFetches).toBe(1);
});

// Moving an item to another list twice: the second move succeeds before the
// first one fails. Reverting the first move puts the item back in the list it
// left, so both lists must be revalidated to show the item where the server
// has it.
test('list-query failed moves revalidate both lists when a newer identical move succeeded', async () => {
  const adminQuery = { tableId: 'users', filters: byTypeFilter('admin') };
  const userQuery = { tableId: 'users', filters: byTypeFilter('user') };
  const env = createListQueryStoreTestEnv(
    {
      users: [
        { id: 1, name: 'Ada', type: 'admin' },
        { id: 2, name: 'Grace', type: 'user' },
      ],
    },
    {
      testScenario: { loaded: { queries: [adminQuery, userQuery] } },
      optimisticListUpdates: [
        { queries: adminQuery, filterItem: (item) => item.type === 'admin' },
        { queries: userQuery, filterItem: (item) => item.type === 'user' },
      ],
    },
  );

  const adminRenders = createLoggerStore({ arrays: 'all' });
  const userRenders = createLoggerStore({ arrays: 'all' });

  renderHook(() => {
    const query = env.apiStore.useListQuery(adminQuery, {
      disableRefetchOnMount: true,
    });
    adminRenders.add({ items: query.items.map((item) => item.name) });
  });
  renderHook(() => {
    const query = env.apiStore.useListQuery(userQuery, {
      disableRefetchOnMount: true,
    });
    userRenders.add({ items: query.items.map((item) => item.name) });
  });

  function moveToUsers(mutation: () => Promise<unknown>) {
    act(() => {
      void env.apiStore.performMutation('users||1', {
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (item) => ({
            ...item,
            type: 'user',
          }));
        },
        mutation,
      });
    });
  }

  // First move: slow request that ends up failing
  moveToUsers(async () => {
    await sleep(1_200);
    throw new Error('move failed');
  });

  // Second, identical move: succeeds before the first one fails
  await advanceTime(100);
  moveToUsers(() =>
    env.serverTable.delayedUpdateItem(
      'users||1',
      { type: 'user' },
      { durationMs: 500 },
    ),
  );

  await flushAllTimers();

  // The failed move is reverted, then the refetches show Ada in the user list
  // again, where the server has her
  expect(adminRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Ada]
    -> items: []
    -> items: [Ada]
    -> items: []
    "
  `);
  expect(userRenders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Grace]
    -> items: [Grace, Ada]
    -> items: [Grace]
    -> items: [Ada, Grace]
    "
  `);
  expect(
    pick(env.apiStore.getQueryState(userQuery), ['items']),
  ).toMatchInlineSnapshot(`items: ['"users||1', '"users||2']`);
});

// Creating an item and saving it again with the same value: the save succeeds
// before the create fails. Reverting the create can't remove an item the
// server now has, so the item is kept and revalidated instead.
test('collection failed creations keep the item when a newer save of it succeeded', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  // Create: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('item-2', { value: { name: 'Item 2' } });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('create failed');
      },
    });
  });

  // Save of the same value: succeeds before the create fails. Its optimistic
  // update leaves the item as it is.
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-2', (draft) => {
          draft.value.name = 'Item 2';
        });
      },
      mutation: () =>
        env.serverTable.delayedSetItem(
          'item-2',
          { name: 'Item 2' },
          { durationMs: 500 },
        ),
    });
  });

  // Right after the create fails, the item is still there...
  await advanceTime(1_100);
  expect(env.apiStore.getItemState('item-2')?.data).toMatchInlineSnapshot(
    `value: { name: 'Item 2' }`,
  );

  // ...and is revalidated against the server
  expect(
    pick(env.apiStore.getItemState('item-2'), ['refetchOnMount']),
  ).toMatchInlineSnapshot(`refetchOnMount: 'highPriority'`);
});

test('list-query failed creations keep the item when a newer identical create succeeded', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  const renders = createLoggerStore({ arrays: 'all' });

  renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      disableRefetchOnMount: true,
    });
    renders.add({ items: query.items.map((item) => item.name) });
  });

  function createGrace(mutation: () => Promise<unknown>) {
    act(() => {
      void env.apiStore.performMutation('users||2', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'users||2',
            { id: 2, name: 'Grace', type: 'user' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation,
      });
    });
  }

  // First create: slow request that ends up failing
  createGrace(async () => {
    await sleep(1_200);
    throw new Error('create failed');
  });

  // Second, identical create: succeeds before the first one fails
  await advanceTime(100);
  createGrace(() =>
    env.serverTable.delayedSetItem(
      'users||2',
      { id: 2, name: 'Grace', type: 'user' },
      { durationMs: 500 },
    ),
  );

  await flushAllTimers();

  // The failed create reverts the list membership, then the refetch shows
  // Grace again, as the server has her
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Ada]
    -> items: [Ada, Grace]
    -> items: [Ada]
    -> items: [Ada, Grace]
    "
  `);
  expect(env.apiStore.getItemState('users||2')?.name).toBe('Grace');
});

// Adding two items to a list quickly: the first add fails while the second one
// is still in flight. The list keeps the second item, but must not keep
// listing the first one, whose item state the rollback removed.
test('list-query failed creations are removed from a list changed again since', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  function addUser(id: number, name: string, mutation: () => Promise<unknown>) {
    act(() => {
      void env.apiStore.performMutation(`users||${id}`, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            `users||${id}`,
            { id, name, type: 'user' },
            { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
          );
        },
        mutation,
      });
    });
  }

  // First add: fails while the second one is in flight
  addUser(2, 'Grace', async () => {
    await sleep(300);
    throw new Error('create failed');
  });
  await advanceTime(100);
  addUser(3, 'Linus', () =>
    env.serverTable.delayedSetItem(
      'users||3',
      { id: 3, name: 'Linus', type: 'user' },
      { durationMs: 1_000 },
    ),
  );

  // Right after the first add fails, the list no longer lists Grace
  await advanceTime(300);
  expect(
    pick(env.apiStore.getQueryState(usersQuery), ['items']),
  ).toMatchInlineSnapshot(`items: ['"users||1', '"users||3']`);
});

// An edit of a newly created item fails first (e.g. the server doesn't have
// the item yet), then the create fails too. The failed edit is no newer save
// the create's rollback could contradict, so the item is removed.
test('collection failed creations are removed when an edit of the new item failed first', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  // Create: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('item-2', { value: { name: 'Item 2' } });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('create failed');
      },
    });
  });

  // Edit of the new item: fails before the create does
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-2', (draft) => {
          draft.value.name = 'Item 2 edited';
        });
      },
      mutation: async () => {
        await sleep(200);
        throw new Error('item not found');
      },
    });
  });

  await flushAllTimers();

  // The item the server never created is gone
  expect(env.apiStore.getItemState('item-2')).toMatchInlineSnapshot(
    `undefined`,
  );
});

// Same as above, but the second mutation is canceled by its optimistic update
// instead of failing
test('collection failed creations are removed when a canceled mutation targeted the new item', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  // Create: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('item-2', { value: { name: 'Item 2' } });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('create failed');
      },
    });
  });

  // A mutation of the new item that cancels itself
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('item-2', {
      optimisticUpdate: () => false,
      mutation: () => env.serverTable.delayedSetItem('item-2', { name: 'x' }),
    });
  });

  await flushAllTimers();

  // The item the server never created is gone
  expect(env.apiStore.getItemState('item-2')).toMatchInlineSnapshot(
    `undefined`,
  );
});

test('list-query failed creations are removed when an edit of the new item failed first', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  // Create: slow request that ends up failing
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'users||2',
          { id: 2, name: 'Grace', type: 'user' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('create failed');
      },
    });
  });

  // Edit of the new item: fails before the create does
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||2', (draft) => {
          draft.name = 'Grace Hopper';
        });
      },
      mutation: async () => {
        await sleep(200);
        throw new Error('item not found');
      },
    });
  });

  await advanceTime(1_200);

  // Right after the create fails, the item the server never created is gone
  // from the store and from the list
  expect(env.apiStore.getItemState('users||2')).toMatchInlineSnapshot(
    `undefined`,
  );
  expect(
    pick(env.apiStore.getQueryState(usersQuery), ['items']),
  ).toMatchInlineSnapshot(`items: ['"users||1']`);
});

// An item is edited (e.g. from an open detail panel) while its delete is in
// flight. The edit succeeds, then the delete fails, so the item still exists
// on the server: it must come back with the edit, not stay deleted.
test('collection failed deletes bring the item back when a newer edit of it succeeded', async () => {
  const env = createCollectionStoreTestEnv(
    { 'item-1': { name: 'Item 1' } },
    { testScenario: 'loaded' },
  );

  const renders = createLoggerStore();

  renderHook(() => {
    const result = env.apiStore.useItem('item-1', {
      disableRefetchOnMount: true,
    });
    renders.add({
      name: result.data?.value.name ?? null,
      status: result.status,
    });
  });

  // Delete: hangs and ends up failing
  act(() => {
    void env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('item-1');
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('timeout');
      },
    });
  });

  // Edit: its optimistic update is a no-op on the deleted item, but the server
  // accepts it before the delete fails
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('item-1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('item-1', (draft) => {
          draft.value.name = 'Renamed';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'item-1',
          { name: 'Renamed' },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // The item is restored when the delete fails and the revalidation brings
  // the edit
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> name: Item 1 ⋅ status: success
    -> name: null ⋅ status: deleted
    -> name: Item 1 ⋅ status: success
    -> name: Renamed ⋅ status: success
    "
  `);
});

test('list-query failed deletes bring the item back when a newer edit of it succeeded', async () => {
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

  const renders = createLoggerStore({ arrays: 'all' });

  renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      disableRefetchOnMount: true,
    });
    renders.add({ items: query.items.map((item) => item.name) });
  });

  // Delete: hangs and ends up failing
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||2');
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('timeout');
      },
    });
  });

  // Edit: its optimistic update is a no-op on the deleted item, but the server
  // accepts it before the delete fails
  await advanceTime(100);
  act(() => {
    void env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||2', (draft) => {
          draft.name = 'Grace Hopper';
        });
      },
      mutation: () =>
        env.serverTable.delayedUpdateItem(
          'users||2',
          { name: 'Grace Hopper' },
          { durationMs: 500 },
        ),
    });
  });

  await flushAllTimers();

  // Grace is listed again when the delete fails and the revalidation brings
  // the edit
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Ada, Grace]
    -> items: [Ada]
    -> items: [Ada, Grace]
    -> items: [Ada, Grace Hopper]
    "
  `);
  expect(env.apiStore.getItemState('users||2')?.name).toBe('Grace Hopper');
});

// An invalidation (e.g. from a realtime event) while an optimistic upsert is
// in flight only changes the item metadata. The failed data is reverted
// cleanly, so the lists showing the item don't need a refetch.
test('list-query failed upserts with an invalidation received in flight do not refetch the lists', async () => {
  const usersQuery = { tableId: 'users' };
  const env = createListQueryStoreTestEnv<ListQueryUser>(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    { testScenario: { loaded: { queries: [usersQuery] } } },
  );

  const renders = createLoggerStore({ arrays: 'all' });

  renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      disableRefetchOnMount: true,
    });
    renders.add({ items: query.items.map((item) => item.name) });
  });

  act(() => {
    void env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState('users||1', {
          id: 1,
          name: 'Ada Lovelace',
          type: 'admin',
        });
      },
      mutation: async () => {
        await sleep(1_200);
        throw new Error('save failed');
      },
    });
  });

  // The item is invalidated while the mutation is in flight
  await advanceTime(100);
  act(() => {
    env.apiStore.invalidateItem('users||1');
  });

  await flushAllTimers();

  // The failed name is reverted
  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> items: [Ada]
    -> items: [Ada Lovelace]
    -> items: [Ada]
    "
  `);
  // No list refetch
  expect(env.serverTable.getRequestHistory('list')).toMatchInlineSnapshot(`[]`);
});
