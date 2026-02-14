import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
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
    {
      withRevalidation: true,
      withOptimisticUpdate: true,
    },
  );

  await flushAllTimers();

  expect(env.uiChanges).toEqual([{ item1: { v: 0 } }, { item1: { v: 1 } }]);

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
    {
      withOptimisticUpdate: true,
    },
  );

  await flushAllTimers();

  expect(env.uiChanges).toEqual([{ item1: { v: 0 } }, { item1: { v: 1 } }]);

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
  expect(env.uiChanges).toEqual([
    { item1: { v: 1 } },
    { item1: { v: 1 }, item2: { v: 2 } },
  ]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2   |
    10ms  | -       | -       | 🔴 [item1] >fetch-started
    .     | -       | -       | 🟠 [item2] >fetch-started
    810ms | -       | -       | 🔴 [item1] <fetch-finished (value: {"v":1})
    .     | {"v":1} | -       | [item1] ui-initialized
    .     | {"v":1} | -       | 🟠 [item2] <fetch-finished (value: {"v":2})
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
    {
      withOptimisticUpdate: true,
      withRevalidation: true,
    },
  );

  await vi.advanceTimersByTimeAsync(100);

  env.addTimelineComments('beforeNextAction', [
    'Fetch for item2 should proceed independently of item1 mutation',
  ]);
  env.scheduleFetch('highPriority', 'item2');

  await flushAllTimers();

  expect(env.uiChanges).toEqual([
    { item1: { v: 0 } },
    { item1: { v: 0 }, item2: { v: 0 } },
    { item1: { v: 1 }, item2: { v: 0 } },
  ]);
  expect(env.serverTable.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1   | item2   |
    0     | {"v":0} | -       | [item1] ui-initialized
    .     | {"v":0} | {"v":0} | [item2] ui-changed
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
    0     | {"v":0} | -       | [item1] ui-initialized
    .     | {"v":0} | {"v":0} | [item2] ui-changed
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
  expect(item2State?.data?.value).toEqual({ v: 2 });
});

test('coalesces multiple fetches for the same item', async () => {
  const env = createCollectionStoreTestEnv({ item1: { v: 1 } });

  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item1');

  await flushAllTimers();

  expect(env.serverTable.numOfFinishedFetches).toBe(1);
  expect(env.apiStore.getItemState('item1')?.data?.value).toEqual({ v: 1 });
});
