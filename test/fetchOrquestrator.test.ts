import { test, expect } from 'vitest';
import { createTestStore, TestStore } from './mocks/fetchOrquestratorEnv';
import { delayCall } from './utils/delayCall';
import { sleep } from './utils/sleep';

async function action(
  store: TestStore,
  newValue: number,
  {
    withRevalidation,
    withOptimisticUpdate,
  }: {
    withRevalidation?: boolean;
    withOptimisticUpdate?: boolean;
  } = {},
) {
  if (withOptimisticUpdate) {
    store.optimisticUpdate(newValue);
  }

  const endMutation = store.startMutation();

  await store.mutateData(newValue);

  endMutation();

  if (withRevalidation) {
    store.scheduleFetch('medium');
  }
}

test('simple mutation with revalidation and optimistic update', async () => {
  const store = createTestStore(0);

  await action(store, 1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await store.waitForNoPendingRequests();

  expect(store.ui.history).toEqual([0, 1, 1]);

  expect(store.actions).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started
    1 - fetch-finished
    1 - fetch-ui-commit
    "
  `);
});

test('simple mutation with optimistic update', async () => {
  const store = createTestStore(0);

  await action(store, 1, {
    withOptimisticUpdate: true,
  });

  await store.waitForNoPendingRequests();

  expect(store.ui.history).toEqual([0, 1]);

  expect(store.actions).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    "
  `);
});

test('simple mutation without optimistic update', async () => {
  const store = createTestStore(0);

  await action(store, 1, {
    withRevalidation: true,
  });

  await store.waitForNoPendingRequests();

  expect(store.ui.history).toEqual([0, 1]);

  expect(store.actions).toMatchInlineSnapshot(`
    "
    1 - mutation-started
    1 - mutation-finished
    fetch-started
    1 - fetch-finished
    1 - fetch-ui-commit
    "
  `);
});

test('prevent overfetch of low priority fetchs', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () => store.scheduleFetch('low')),
    delayCall(10, () => store.scheduleFetch('low')),
    delayCall(20, () => store.scheduleFetch('low')),
    delayCall(30, () => store.scheduleFetch('low')),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(1);
  expect(store.actions).toMatchInlineSnapshot(`
    "
    fetch-started
    fetch-skipped
    fetch-skipped
    fetch-skipped
    fetch-finished
    fetch-ui-commit
    "
  `);
});

test('multiple mutations with revalidation in sequence', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () =>
      action(store, 1, { withOptimisticUpdate: true, withRevalidation: true }),
    ),
    delayCall(110, () =>
      action(store, 2, { withOptimisticUpdate: true, withRevalidation: true }),
    ),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.ui.changesHistory).toEqual([0, 1, 2]);
  expect(store.actions).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started
    1 - fetch-finished
    1 - fetch-ui-commit
      2 - optimistic-ui-commit
      2 - mutation-started
      2 - mutation-finished
    fetch-started
      2 - fetch-finished
      2 - fetch-ui-commit
    "
  `);
});

test('multiple mutations with revalidation in sequence, causing concurrent updates', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () =>
      action(store, 1, { withOptimisticUpdate: true, withRevalidation: true }),
    ),
    delayCall(70, () =>
      action(store, 2, { withOptimisticUpdate: true, withRevalidation: true }),
    ),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.ui.changesHistory).toEqual([0, 1, 2]);
  expect(store.actions).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started
      2 - optimistic-ui-commit
      2 - mutation-started
    1 - fetch-aborted
      2 - mutation-finished
    fetch-started
      2 - fetch-finished
      2 - fetch-ui-commit
    "
  `);
});

test('multiple concurrent mutations with revalidation ', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () =>
      action(store, 1, { withOptimisticUpdate: true, withRevalidation: true }),
    ),
    delayCall(50, () =>
      action(store, 2, { withOptimisticUpdate: true, withRevalidation: true }),
    ),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(1);

  expect(store.ui.changesHistory).toEqual([0, 1, 2]);
  expect(store.server.history).toEqual([0, 1, 2]);
  expect(store.actions).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
      2 - optimistic-ui-commit
      2 - mutation-started
    1 - mutation-finished
    fetch-scheduled
      2 - mutation-finished
    scheduled-fetch-started
    fetch-skipped
      2 - fetch-finished
      2 - fetch-ui-commit
    "
  `);
});

test('multiple high priority fetchs', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () => store.scheduleFetch('high')),
    delayCall(5, () => store.scheduleFetch('high')),
    delayCall(10, () => store.scheduleFetch('high')),
    delayCall(15, () => store.scheduleFetch('high')),
    delayCall(20, () => store.scheduleFetch('high')),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(2);
  expect(store.actions).toMatchInlineSnapshot(`
    "
    fetch-started
    fetch-scheduled
    fetch-scheduled
    fetch-scheduled
    fetch-scheduled
    fetch-finished
    fetch-ui-commit
    scheduled-fetch-started
    fetch-finished
    fetch-ui-commit
    "
  `);
});

test('throttle low priority updates', async () => {
  const store = createTestStore(0);

  const promises = [
    delayCall(0, () => store.scheduleFetch('low')),
    delayCall(100, () => store.scheduleFetch('low')),
    delayCall(110, () => store.scheduleFetch('low')),
    delayCall(120, () => store.scheduleFetch('low')),
    delayCall(210, () => store.scheduleFetch('low')),
  ];

  await Promise.all(promises);

  await store.waitForNoPendingRequests();

  expect(store.numOfFetchs).toBe(2);

  expect(store.actions).toMatchInlineSnapshot(`
    "
    fetch-started
    fetch-finished
    fetch-ui-commit
    fetch-skipped
    fetch-skipped
    fetch-skipped
    fetch-started
    fetch-finished
    fetch-ui-commit
    "
  `);
});

// FIX: test errors
