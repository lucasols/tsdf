import { renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from './mocks/documentStoreTestEnv';
import { trackChangedValues } from './utils/trackChangedValues';

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('simple mutation with revalidation and optimistic update', async () => {
  vi.useFakeTimers();

  const store = createDocumentStoreTestEnv(0);

  const uiChanges = trackChangedValues();

  renderHook(() => {
    uiChanges.track(store.useDocument().data?.value);
  });

  // Wait for initial fetch
  await vi.runAllTimersAsync();

  store.performClientUpdateAction(1, {
    withRevalidation: true,
    withOptimisticUpdate: true,
  });

  await vi.runAllTimersAsync();

  expect(uiChanges.changes).toEqual([0, 1]);

  expect(store.actionsString).toMatchInlineSnapshot(`
    "
    1 - optimistic-ui-commit
    1 - mutation-started
    1 - mutation-finished
    fetch-started #1
    1 - fetch-finished #1
    "
  `);
});
