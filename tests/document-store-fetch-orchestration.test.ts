import { expect, test } from 'vitest';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';

test('simple mutation with revalidation and optimistic update', async () => {
  const store = createDocumentStoreTestEnv(0);

  await store.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await store.waitForNoPendingRequests();

  expect(store.storeHistory).toEqual([0, 1, 1]);

  expect(store.actions).toMatchInlineSnapshot(`
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
