import { afterEach, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('simple mutation with revalidation and optimistic update', async () => {
  vi.useFakeTimers();

  const store = createDocumentStoreTestEnv(0);

  store.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(store.storeHistory).toEqual([0, 1, 1]);

  expect(store.actionsString).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started : 1
    1 - fetch-finished : 1
    1 - fetch-ui-commit
    "
  `);
});
