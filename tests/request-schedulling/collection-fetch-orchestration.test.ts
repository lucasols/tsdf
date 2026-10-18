import { sleep } from '@ls-stack/utils/sleep';
import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('simple mutation with revalidation and optimistic update', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 } },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  renderHook(() => {
    const item = env.apiStore.useItem('item1');
    env.trackItemUI('item1', item.data?.value);
  });

  await flushAllTimers();

  void env.performClientUpdateAction(
    'item1',
    { v: 1 },
    { withRevalidation: true, withOptimisticUpdate: true },
  );

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`
    - item1: { v: 0 }
    - item1: { v: 1 }
  `);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | {"v":0} | ui-initialized
    .     | {"v":1} | ⬜ optimistic-ui-commit
    .     | {"v":1} | ⬜ >mutation-started (value: {"v":1})
    840ms | {"v":1} | ⬜ <mutation-data-persisted (value: {"v":1})
    1.21s | {"v":1} | 🔴 >fetch-started
    2.01s | {"v":1} | 🔴 <fetch-finished (value: {"v":1})
    "
  `);
});

test('simple mutation with optimistic update', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 } },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  renderHook(() => {
    const item = env.apiStore.useItem('item1');
    env.trackItemUI('item1', item.data?.value);
  });

  await flushAllTimers();

  void env.performClientUpdateAction(
    'item1',
    { v: 1 },
    { withOptimisticUpdate: true },
  );

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`
    - item1: { v: 0 }
    - item1: { v: 1 }
  `);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | {"v":0} | ui-initialized
    .     | {"v":1} | ⬜ optimistic-ui-commit
    .     | {"v":1} | ⬜ >mutation-started (value: {"v":1})
    840ms | {"v":1} | ⬜ <mutation-data-persisted (value: {"v":1})
    "
  `);
});

test('prevent overfetch of low priority fetches', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 } },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  renderHook(() => {
    const item = env.apiStore.useItem('item1');
    env.trackItemUI('item1', item.data?.value);
  });

  env.scheduleFetch('lowPriority', 'item1');
  await vi.advanceTimersByTimeAsync(10);

  env.addTimelineComments('afterLastAction', [
    'All fetches started after this point should be skipped',
  ]);

  env.scheduleFetch('lowPriority', 'item1');
  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority', 'item1');
  await vi.advanceTimersByTimeAsync(10);

  env.scheduleFetch('lowPriority', 'item1');

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   |
    0     | {"v":0} | ui-initialized
    .     | {"v":0} | scheduled-fetch-triggered
    10ms  | {"v":0} | 🔴 >fetch-started
    .     | {"v":0} | -- All fetches started after this point should be skipped
    .     | {"v":0} | scheduled-fetch-skipped
    20ms  | {"v":0} | scheduled-fetch-skipped
    30ms  | {"v":0} | scheduled-fetch-skipped
    810ms | {"v":0} | 🔴 <fetch-finished (value: {"v":0})
    "
  `);
});

test('fetching one item does not interfere with another item', async () => {
  const env = createCollectionStoreTestEnv({
    item1: { v: 1 },
    item2: { v: 2 },
  });

  renderHook(() => {
    const item1 = env.apiStore.useItem('item1');
    const item2 = env.apiStore.useItem('item2');
    env.trackItemUI('item1', item1.data?.value);
    env.trackItemUI('item2', item2.data?.value);
  });

  await vi.advanceTimersByTimeAsync(15);

  expect(env.serverTable.numOfStartedFetches).toBe(2);

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2   |
    0     | ···     | ···     | [item1, item2] ui-initialized
    10ms  | ···     | ···     | 🔴 [item1] >fetch-started
    .     | ···     | ···     | 🟠 [item2] >fetch-started
    810ms | ···     | ···     | 🔴 [item1] <fetch-finished (value: {"v":1})
    .     | {"v":1} | ···     | [item1] ui-changed
    .     | {"v":1} | ···     | 🟠 [item2] <fetch-finished (value: {"v":2})
    .     | {"v":1} | {"v":2} | [item2] ui-changed
    "
  `);
});

test('mutation on one item does not affect fetch state of another item', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 }, item2: { v: 0 } },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  renderHook(() => {
    const item1 = env.apiStore.useItem('item1');
    const item2 = env.apiStore.useItem('item2');
    env.trackItemUI('item1', item1.data?.value);
    env.trackItemUI('item2', item2.data?.value);
  });

  await flushAllTimers();

  void env.performClientUpdateAction(
    'item1',
    { v: 1 },
    { withOptimisticUpdate: true, withRevalidation: true },
  );

  await vi.advanceTimersByTimeAsync(100);

  env.addTimelineComments('beforeNextAction', [
    'Fetch for item2 should proceed independently of item1 mutation',
  ]);
  env.scheduleFetch('highPriority', 'item2');

  await flushAllTimers();

  expect(env.uiChanges).toMatchInlineSnapshot(`
    - item1: { v: 0 }
    - item1: { v: 0 }
      item2: { v: 0 }
    - item1: { v: 1 }
      item2: { v: 0 }
  `);
  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2   |
    0     | {"v":0} | {"v":0} | [item1, item2] ui-initialized
    .     | {"v":1} | {"v":0} | ⬜ [item1] optimistic-ui-commit
    .     | {"v":1} | {"v":0} | ⬜ [item1] >mutation-started (value: {"v":1})
    100ms | {"v":1} | {"v":0} | -- Fetch for item2 should proceed independently of item1 mutation
    .     | {"v":1} | {"v":0} | [item2] scheduled-fetch-triggered
    110ms | {"v":1} | {"v":0} | 🔴 [item2] >fetch-started
    840ms | {"v":1} | {"v":0} | ⬜ [item1] <mutation-data-persisted (value: {"v":1})
    910ms | {"v":1} | {"v":0} | 🔴 [item2] <fetch-finished (value: {"v":0})
    1.21s | {"v":1} | {"v":0} | 🟠 [item1] >fetch-started
    2.01s | {"v":1} | {"v":0} | 🟠 [item1] <fetch-finished (value: {"v":1})
    "
  `);
});

test('low priority fetch on one item is independent of another item fetch state', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 }, item2: { v: 0 } },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  renderHook(() => {
    const item1 = env.apiStore.useItem('item1');
    const item2 = env.apiStore.useItem('item2');
    env.trackItemUI('item1', item1.data?.value);
    env.trackItemUI('item2', item2.data?.value);
  });

  await flushAllTimers();

  env.scheduleFetch('highPriority', 'item1');
  await vi.advanceTimersByTimeAsync(15);

  env.addTimelineComments('beforeNextAction', [
    'Low priority fetch for item2 should not be affected by item1 in-flight fetch',
  ]);

  const result = env.scheduleFetch('lowPriority', 'item2');
  expect(result).toBe('triggered');

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2   |
    0     | {"v":0} | {"v":0} | [item1, item2] ui-initialized
    .     | {"v":0} | {"v":0} | [item1] scheduled-fetch-triggered
    10ms  | {"v":0} | {"v":0} | 🔴 [item1] >fetch-started
    15ms  | {"v":0} | {"v":0} | -- Low priority fetch for item2 should not be affected by item1 in-flight fetch
    .     | {"v":0} | {"v":0} | [item2] scheduled-fetch-triggered
    25ms  | {"v":0} | {"v":0} | 🟠 [item2] >fetch-started
    810ms | {"v":0} | {"v":0} | 🔴 [item1] <fetch-finished (value: {"v":0})
    825ms | {"v":0} | {"v":0} | 🟠 [item2] <fetch-finished (value: {"v":0})
    "
  `);
});

test('error on one item does not affect other items', async () => {
  const env = createCollectionStoreTestEnv({
    item1: { v: 1 },
    item2: { v: 2 },
  });

  env.serverTable.setNextFetchError('item1', 'Network error');

  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item2');

  await flushAllTimers();

  const item1State = env.apiStore.getItemState('item1');
  const item2State = env.apiStore.getItemState('item2');

  expect(item1State?.status).toBe('error');
  expect(item1State?.error?.message).toBe('Network error');

  expect(item2State?.status).toBe('success');
  expect(item2State?.data?.value).toMatchInlineSnapshot(`v: 2`);
});

test('coalesces multiple fetches for the same item', async () => {
  const env = createCollectionStoreTestEnv({ item1: { v: 1 } });

  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item1');

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);
  expect(env.apiStore.getItemState('item1')?.data?.value).toMatchInlineSnapshot(
    `v: 1`,
  );
});

test('fetch interrupted by a mutation is retried after the mutation ends', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 } },
    { testScenario: 'loaded' },
  );

  renderHook(() => {
    const { status, data } = env.apiStore.useItem('item1');
    env.trackItemUI('item1', `${status}:${data?.value.v ?? '-'}`);
  });

  await flushAllTimers();

  env.scheduleFetch('highPriority', 'item1');
  await advanceTime(100);

  env.addTimelineComments('beforeNextAction', [
    'Mutation without revalidation starts while the refetch is in flight',
  ]);
  void env.performClientUpdateAction('item1', { v: 1 });

  await flushAllTimers();

  // The aborted refetch must not leave the item stuck on refetching: it is
  // retried once the mutation lock is released
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1     |
    0     | success:0 | ui-initialized
    10ms  | success:0 | 🔴 >fetch-started
    810ms | success:0 | 🔴 <fetch-finished (value: {"v":0})
    .     | success:0 | scheduled-fetch-triggered
    820ms | success:0 | 🟠 >fetch-started
    910ms | success:0 | -- Mutation without revalidation starts while the refetch is in flight
    .     | success:0 | 🟠 <fetch-aborted 🚫
    .     | success:0 | ⬜ >mutation-started (value: {"v":1})
    1.75s | success:0 | ⬜ <mutation-data-persisted (value: {"v":1})
    2.12s | success:0 | 🟡 >fetch-started
    2.92s | success:0 | 🟡 <fetch-finished (value: {"v":1})
    .     | success:1 | ui-changed
    "
  `);
  expect(env.apiStore.getItemState('item1')?.status).toBe('success');
});

test('mutation on one item does not drop an in-flight batch fetch of other items', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 }, item2: { v: 0 } },
    { testScenario: 'loaded', useBatchFetch: true },
  );

  renderHook(() => {
    const item1 = env.apiStore.useItem('item1');
    const item2 = env.apiStore.useItem('item2');
    env.trackItemUI('item1', `${item1.status}:${item1.data?.value.v ?? '-'}`);
    env.trackItemUI('item2', `${item2.status}:${item2.data?.value.v ?? '-'}`);
  });

  await flushAllTimers();

  // Both items are refetched in the same batch request
  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item2');
  await advanceTime(100);

  env.addTimelineComments('beforeNextAction', [
    'Mutation on item1 starts while the item1+item2 batch fetch is in flight',
  ]);
  void env.performClientUpdateAction('item1', { v: 1 });

  await flushAllTimers();

  // Neither item may stay stuck on refetching: item2 is refetched as soon as
  // the aborted batch settles and item1 after its mutation ends
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1     | item2     |
    0     | success:0 | success:0 | [item1, item2] ui-initialized
    10ms  | success:0 | success:0 | 🔴 [item1] >fetch-started
    810ms | success:0 | success:0 | 🔴 [item1] <fetch-finished (value: {"v":0})
    .     | success:0 | success:0 | [item1] scheduled-fetch-triggered
    820ms | success:0 | success:0 | 🟠 >list-fetch-started (value: {"itemIds":["item1","item2"]})
    910ms | success:0 | success:0 | -- Mutation on item1 starts while the item1+item2 batch fetch is in flight
    .     | success:0 | success:0 | 🟠 <list-fetch-aborted 🚫
    .     | success:0 | success:0 | ⬜ [item1] >mutation-started (value: {"v":1})
    1.63s | success:0 | success:0 | 🟡 [item2] >fetch-started
    1.75s | success:0 | success:0 | ⬜ [item1] <mutation-data-persisted (value: {"v":1})
    2.43s | success:0 | success:0 | 🟡 [item2] <fetch-finished (value: {"v":0})
    2.44s | success:0 | success:0 | 🟢 [item1] >fetch-started
    3.24s | success:0 | success:0 | 🟢 [item1] <fetch-finished (value: {"v":1})
    .     | success:1 | success:0 | [item1] ui-changed
    "
  `);
  expect(env.apiStore.getItemState('item1')?.status).toBe('success');
  expect(env.apiStore.getItemState('item2')?.status).toBe('success');
});

test('deleting an item while its batch refetch is in flight keeps it deleted', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: { v: 0 }, item2: { v: 0 } },
    { testScenario: 'loaded', useBatchFetch: true },
  );

  // Both items are refetched in the same batch request
  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item2');
  await advanceTime(100);

  env.addTimelineComments('beforeNextAction', [
    'item1 is deleted while the item1+item2 batch fetch is in flight',
  ]);
  void env.apiStore.performMutation('item1', {
    optimisticUpdate: () => {
      env.apiStore.deleteItemState('item1');
    },
    mutation: () => env.serverTable.delayedRemoveItem('item1'),
  });

  await flushAllTimers();

  // Only item2 is retried: the deleted item must not be refetched, which
  // would bring it back as an "item not found" error
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  |
    0     | [item1] scheduled-fetch-triggered
    10ms  | 🔴 >list-fetch-started (value: {"itemIds":["item1","item2"]})
    100ms | -- item1 is deleted while the item1+item2 batch fetch is in flight
    .     | 🔴 <list-fetch-aborted 🚫
    820ms | 🟠 [item2] >fetch-started
    1.3s  | [item1] server-item-removed
    1.62s | 🟠 [item2] <fetch-finished (value: {"v":0})
    "
  `);
  expect(env.apiStore.getItemState('item1')).toBe(null);
  expect(env.apiStore.getItemState('item2')?.status).toBe('success');
});

test.each([
  { scheduler: 'batch', useBatchFetch: true },
  { scheduler: 'per-item', useBatchFetch: false },
])(
  'a failed delete of an item whose refetch was in flight refetches the restored item ($scheduler scheduler)',
  async ({ useBatchFetch }) => {
    const env = createCollectionStoreTestEnv(
      { item1: { v: 0 }, item2: { v: 0 } },
      { testScenario: 'loaded', useBatchFetch },
    );

    const ui = createLoggerStore();
    renderHook(() => {
      const item1 = env.apiStore.useItem('item1', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });
      ui.add({ item1: `${item1.status}:${item1.data?.value.v ?? '-'}` });
    });

    await flushAllTimers();

    // The server has a newer value, so the refetch is needed
    env.serverTable.setItem('item1', { v: 1 });
    env.scheduleFetch('highPriority', 'item1');
    env.scheduleFetch('highPriority', 'item2');
    await advanceTime(100);
    ui.addMark('item1 is deleted while its refetch is in flight');

    // The delete aborts item1's refetch and drops its retry, then fails
    act(() => {
      void env.apiStore.performMutation('item1', {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState('item1');
        },
        mutation: async () => {
          await sleep(1200);
          throw new Error('Delete failed');
        },
      });
    });

    await flushAllTimers();

    // The rollback restores item1 mid-refetch, so it is refetched instead of
    // staying on `refetching` with no fetch pending
    expect(ui.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> item1: success:0
      -> item1: refetching:0

      >>> item1 is deleted while its refetch is in flight

      -> item1: deleted:-
      -> item1: refetching:0
      -> item1: success:1
      "
    `);
    expect(env.apiStore.getItemState('item1')?.status).toBe('success');
    expect(env.apiStore.getItemState('item2')?.status).toBe('success');
  },
);
