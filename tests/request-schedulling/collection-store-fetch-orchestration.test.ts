import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

test('simple mutation with revalidation and optimistic update', async () => {
  const env = createCollectionStoreTestEnv({ item1: 0 });

  renderHook(() => {
    const item = env.useItem('item1');
    env.trackItemUI('item1', item.data?.value);
  });

  await vi.runAllTimersAsync();

  void env.performClientUpdateAction('item1', 1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([{ item1: 0 }, { item1: 1 }]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1 |
    0     | 0     | ui-initialized
    .     | 1     | ⬜ optimistic-ui-commit
    .     | 1     | ⬜ >mutation-started (value: 1)
    840ms | 1     | ⬜ <mutation-data-persisted (value: 1)
    1.21s | 1     | 🔴 >fetch-started
    2.01s | 1     | 🔴 <fetch-finished (value: 1)
    "
  `);
});

test('simple mutation with optimistic update', async () => {
  const env = createCollectionStoreTestEnv({ item1: 0 });

  renderHook(() => {
    const item = env.useItem('item1');
    env.trackItemUI('item1', item.data?.value);
  });

  await vi.runAllTimersAsync();

  void env.performClientUpdateAction('item1', 1, {
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([{ item1: 0 }, { item1: 1 }]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1 |
    0     | 0     | ui-initialized
    .     | 1     | ⬜ optimistic-ui-commit
    .     | 1     | ⬜ >mutation-started (value: 1)
    840ms | 1     | ⬜ <mutation-data-persisted (value: 1)
    "
  `);
});

test('prevent overfetch of low priority fetches', async () => {
  const env = createCollectionStoreTestEnv({ item1: 0 });

  renderHook(() => {
    const item = env.useItem('item1');
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

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(1);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1 |
    0     | 0     | ui-initialized
    .     | 0     | scheduled-fetch-triggered
    10ms  | 0     | 🔴 >fetch-started
    .     | 0     | -- All fetches started after this point should be skipped
    .     | 0     | scheduled-fetch-skipped
    20ms  | 0     | scheduled-fetch-skipped
    30ms  | 0     | scheduled-fetch-skipped
    810ms | 0     | 🔴 <fetch-finished (value: 0)
    "
  `);
});

test('fetching one item does not interfere with another item', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: 1, item2: 2 },
    { forceInitialDataInvalidation: true },
  );

  renderHook(() => {
    const item1 = env.useItem('item1');
    const item2 = env.useItem('item2');
    env.trackItemUI('item1', item1.data?.value);
    env.trackItemUI('item2', item2.data?.value);
  });

  await vi.advanceTimersByTimeAsync(15);

  expect(env.numOfStartedFetches).toBe(2);

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(2);
  expect(env.uiChanges).toEqual([
    { item1: 1 },
    { item1: 1, item2: 2 },
  ]);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1 | item2 |
    10ms  | -     | -     | 🔴 [item1] >fetch-started
    .     | -     | -     | 🟠 [item2] >fetch-started
    810ms | -     | -     | 🔴 [item1] <fetch-finished (value: 1)
    .     | 1     | -     | [item1] ui-initialized
    .     | 1     | -     | 🟠 [item2] <fetch-finished (value: 2)
    .     | 1     | 2     | [item2] ui-changed
    "
  `);
});

test('mutation on one item does not affect fetch state of another item', async () => {
  const env = createCollectionStoreTestEnv({ item1: 0, item2: 0 });

  renderHook(() => {
    const item1 = env.useItem('item1');
    const item2 = env.useItem('item2');
    env.trackItemUI('item1', item1.data?.value);
    env.trackItemUI('item2', item2.data?.value);
  });

  await vi.runAllTimersAsync();

  void env.performClientUpdateAction('item1', 1, {
    withOptimisticUpdate: true,
    withRevalidation: true,
  });

  await vi.advanceTimersByTimeAsync(100);

  env.addTimelineComments('beforeNextAction', [
    'Fetch for item2 should proceed independently of item1 mutation',
  ]);
  env.scheduleFetch('highPriority', 'item2');

  await vi.runAllTimersAsync();

  expect(env.uiChanges).toEqual([
    { item1: 0 },
    { item1: 0, item2: 0 },
    { item1: 1, item2: 0 },
  ]);
  expect(env.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1 | item2 |
    0     | 0     | -     | [item1] ui-initialized
    .     | 0     | 0     | [item2] ui-changed
    .     | 1     | 0     | ⬜ [item1] optimistic-ui-commit
    .     | 1     | 0     | ⬜ [item1] >mutation-started (value: 1)
    100ms | 1     | 0     | -- Fetch for item2 should proceed independently of item1 mutation
    .     | 1     | 0     | [item2] scheduled-fetch-triggered
    110ms | 1     | 0     | 🔴 [item2] >fetch-started
    840ms | 1     | 0     | ⬜ [item1] <mutation-data-persisted (value: 1)
    910ms | 1     | 0     | 🔴 [item2] <fetch-finished (value: 0)
    1.21s | 1     | 0     | 🟠 [item1] >fetch-started
    2.01s | 1     | 0     | 🟠 [item1] <fetch-finished (value: 1)
    "
  `);
});

test('low priority fetch on one item is independent of another item fetch state', async () => {
  const env = createCollectionStoreTestEnv({ item1: 0, item2: 0 });

  renderHook(() => {
    const item1 = env.useItem('item1');
    const item2 = env.useItem('item2');
    env.trackItemUI('item1', item1.data?.value);
    env.trackItemUI('item2', item2.data?.value);
  });

  await vi.runAllTimersAsync();

  env.scheduleFetch('highPriority', 'item1');
  await vi.advanceTimersByTimeAsync(15);

  env.addTimelineComments('beforeNextAction', [
    'Low priority fetch for item2 should not be affected by item1 in-flight fetch',
  ]);

  const result = env.scheduleFetch('lowPriority', 'item2');
  expect(result).toBe('triggered');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(2);

  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | item1 | item2 |
    0     | 0     | -     | [item1] ui-initialized
    .     | 0     | 0     | [item2] ui-changed
    .     | 0     | 0     | [item1] scheduled-fetch-triggered
    10ms  | 0     | 0     | 🔴 [item1] >fetch-started
    15ms  | 0     | 0     | -- Low priority fetch for item2 should not be affected by item1 in-flight fetch
    .     | 0     | 0     | [item2] scheduled-fetch-triggered
    25ms  | 0     | 0     | 🟠 [item2] >fetch-started
    810ms | 0     | 0     | 🔴 [item1] <fetch-finished (value: 0)
    825ms | 0     | 0     | 🟠 [item2] <fetch-finished (value: 0)
    "
  `);
});

test('error on one item does not affect other items', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: 1, item2: 2 },
    { forceInitialDataInvalidation: true },
  );

  env.errorInNextFetch('item1', 'Network error');

  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item2');

  await vi.runAllTimersAsync();

  const item1State = env.getItemState('item1');
  const item2State = env.getItemState('item2');

  expect(item1State?.status).toBe('error');
  expect(item1State?.error?.error).toBe('Network error');

  expect(item2State?.status).toBe('success');
  expect(item2State?.data?.value).toBe(2);
});

test('coalesces multiple fetches for the same item', async () => {
  const env = createCollectionStoreTestEnv(
    { item1: 1 },
    { forceInitialDataInvalidation: true },
  );

  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item1');
  env.scheduleFetch('highPriority', 'item1');

  await vi.runAllTimersAsync();

  expect(env.numOfFinishedFetches).toBe(1);
  expect(env.getItemState('item1')?.data?.value).toBe(1);
});
