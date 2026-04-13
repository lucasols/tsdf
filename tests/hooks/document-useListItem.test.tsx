import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
});

type StoreValue = { items: Record<string, { name: string }> };

const defaultValue: StoreValue = {
  items: { a: { name: 'item-a' }, b: { name: 'item-b' } },
};

describe('document store useListItemIsDeleted', () => {
  test('item exists after load: returns false', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue);

    const renders = createLoggerStore();

    renderHook(() => {
      const isDeleted = env.apiStore.useListItemIsDeleted({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({ isDeleted });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isDeleted: ❌
      "
    `);
  });

  test('item removed after successful load: returns true, calls onDelete', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue, {
      testScenario: 'loaded',
    });

    const onDelete = vi.fn();
    const renders = createLoggerStore();

    renderHook(() => {
      const isDeleted = env.apiStore.useListItemIsDeleted({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
        onDelete,
      });

      renders.add({ isDeleted });
    });

    await flushAllTimers();

    // Remove item 'a' from the document's data
    act(() => {
      env.apiStore.updateState((draft) => {
        const { a: _, ...rest } = draft.value.items;
        draft.value.items = rest;
      });
    });

    await flushAllTimers();

    expect(onDelete).toHaveBeenCalledTimes(1);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isDeleted: ❌
      -> isDeleted: ✅
      "
    `);
  });

  test('not found during initial load: does NOT return true', async () => {
    const valueWithoutA: StoreValue = { items: { b: { name: 'item-b' } } };

    const env = createDocumentStoreTestEnv<StoreValue>(valueWithoutA);

    const onDelete = vi.fn();
    const renders = createLoggerStore();

    renderHook(() => {
      const isDeleted = env.apiStore.useListItemIsDeleted({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
        onDelete,
      });

      renders.add({ isDeleted });
    });

    await flushAllTimers();

    expect(onDelete).not.toHaveBeenCalled();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isDeleted: ❌
      "
    `);
  });

  test('switching to another missing item does NOT return true', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue, {
      testScenario: 'loaded',
    });

    const onDelete = vi.fn();
    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ itemId }: { itemId: string }) => {
        const isDeleted = env.apiStore.useListItemIsDeleted({
          itemId,
          selector: (data) => data?.value.items[itemId],
          onDelete,
        });

        renders.add({ itemId, isDeleted });
      },
      { initialProps: { itemId: 'a' } },
    );

    await flushAllTimers();

    rerender({ itemId: 'missing-item' });

    await flushAllTimers();

    expect(onDelete).not.toHaveBeenCalled();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> itemId: a ⋅ isDeleted: ❌
      -> itemId: missing-item ⋅ isDeleted: ❌
      "
    `);
  });
});

describe('document store useListItemIsLoading', () => {
  test('item exists after load: returns false', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue, {
      testScenario: 'loaded',
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const isLoading = env.apiStore.useListItemIsLoading({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({ isLoading });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ❌
      "
    `);
  });

  test('document loading: returns true then false', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue);

    const renders = createLoggerStore();

    renderHook(() => {
      const isLoading = env.apiStore.useListItemIsLoading({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({ isLoading });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ✅
      -> isLoading: ❌
      "
    `);
  });

  test('ensureIsLoaded forces a fetch and shows loading', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue);

    // Pre-load the data
    env.apiStore.scheduleFetch('highPriority');
    await flushAllTimers();

    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    const renders = createLoggerStore();

    renderHook(() => {
      const isLoading = env.apiStore.useListItemIsLoading({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
        ensureIsLoaded: true,
      });

      renders.add({ isLoading });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ✅
      -> isLoading: ❌
      "
    `);

    expect(env.serverMock.numOfFinishedFetches).toBe(2);
  });

  test('item not found triggers fallback after timeout', async () => {
    const valueWithoutA: StoreValue = { items: { b: { name: 'item-b' } } };

    // Use usesRealTimeUpdates to prevent automatic refetch-on-mount,
    // so we can test the fallback behavior independently
    const env = createDocumentStoreTestEnv<StoreValue>(valueWithoutA, {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
    });

    expect(env.serverMock.numOfFinishedFetches).toBe(0);

    const renders = createLoggerStore();

    renderHook(() => {
      const isLoading = env.apiStore.useListItemIsLoading({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({ isLoading });
    });

    // Initially shows loading because item 'a' not found
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ✅
      "
    `);

    // After 100ms the default fallback (invalidateData) triggers a fetch
    await advanceTime(150);
    await flushAllTimers();

    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ✅
      ⋅⋅⋅
      -> isLoading: ✅
      -> isLoading: ❌
      "
    `);
  });

  test('item found during refetch: returns false', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue, {
      testScenario: 'loaded',
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const isLoading = env.apiStore.useListItemIsLoading({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({ isLoading });
    });

    await flushAllTimers();

    // Invalidate to trigger refetch
    env.apiStore.invalidateData();

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ❌
      "
    `);
  });
});

describe('document store useListItem (combined)', () => {
  test('returns isLoading, isDeleted, and data correctly after load', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue);

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListItem({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({
        isLoading: result.isLoading,
        isDeleted: result.isDeleted,
        data: result.data,
      });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ✅ ⋅ isDeleted: ❌ ⋅ data: undefined
      -> isLoading: ❌ ⋅ isDeleted: ❌ ⋅ data: {name:item-a}
      "
    `);
  });

  test('returns isDeleted true after item removal', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(defaultValue, {
      testScenario: 'loaded',
    });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useListItem({
        itemId: 'a',
        selector: (data) => data?.value.items['a'],
      });

      renders.add({
        isLoading: result.isLoading,
        isDeleted: result.isDeleted,
        name: result.data?.name,
      });
    });

    await flushAllTimers();

    // Remove item 'a'
    act(() => {
      env.apiStore.updateState((draft) => {
        const { a: _, ...rest } = draft.value.items;
        draft.value.items = rest;
      });
    });

    await flushAllTimers();

    // After the initial mount+refetch cycle, itemWasRefetched already includes 'a',
    // so isLoading stays false even when the item disappears. The deletion is
    // detected on the next render cycle by useListItemIsDeleted.
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> isLoading: ❌ ⋅ isDeleted: ❌ ⋅ name: item-a
      -> isLoading: ❌ ⋅ isDeleted: ❌ ⋅ name: undefined
      -> isLoading: ❌ ⋅ isDeleted: ✅ ⋅ name: undefined
      "
    `);
  });
});
