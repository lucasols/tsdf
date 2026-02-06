import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(0);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
});

type StoreValue = {
  hello: string;
};

test('disable should keep the selected data and not be affected by invalidation', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    {
      useLoadedSnapshot: true,
      disableInitialInvalidation: true,
    },
  );

  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ disabled }: { disabled: boolean }) => {
      const result = env.apiStore.useDocument({
        disabled,
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({
        data: result.data?.value ?? null,
        error: result.error,
        status: result.status,
        isLoading: result.isLoading,
      });
    },
    { initialProps: { disabled: false } },
  );

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('first update (✅)');

  act(() => {
    env.emulateExternalRTU({ hello: '✅' });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('set disabled');

  act(() => {
    rerender({ disabled: true });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('ignored update (❌)');

  act(() => {
    env.emulateExternalRTU({ hello: '❌' });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('enabled again');

  act(() => {
    rerender({ disabled: false });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> data: {hello:world} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌

    >>> first update (✅)

    -> data: {hello:world} ⋅ error: null ⋅ status: refetching ⋅ isLoading: ❌
    -> data: {hello:✅} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌

    >>> set disabled

    -> data: {hello:✅} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌

    >>> ignored update (❌)

    >>> enabled again

    -> data: {hello:✅} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌
    -> data: {hello:✅} ⋅ error: null ⋅ status: refetching ⋅ isLoading: ❌
    -> data: {hello:❌} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌
    "
  `);
});

test('isOffScreen should keep the selected data and not be affected by invalidation', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    {
      useLoadedSnapshot: true,
      disableInitialInvalidation: true,
    },
  );

  const renders = createLoggerStore();

  const { rerender } = renderHook(
    ({ isOffScreen }: { isOffScreen: boolean }) => {
      const result = env.apiStore.useDocument({
        isOffScreen,
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({
        data: result.data?.value ?? null,
        error: result.error,
        status: result.status,
        isLoading: result.isLoading,
      });
    },
    { initialProps: { isOffScreen: false } },
  );

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('first update (✅)');

  act(() => {
    env.emulateExternalRTU({ hello: '✅' });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('set disabled');

  act(() => {
    rerender({ isOffScreen: true });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('ignored update (❌)');

  act(() => {
    env.emulateExternalRTU({ hello: '❌' });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('enabled again');

  act(() => {
    rerender({ isOffScreen: false });
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> data: {hello:world} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌

    >>> first update (✅)

    -> data: {hello:world} ⋅ error: null ⋅ status: refetching ⋅ isLoading: ❌
    -> data: {hello:✅} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌

    >>> set disabled

    -> data: {hello:✅} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌

    >>> ignored update (❌)

    >>> enabled again

    -> data: {hello:✅} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌
    -> data: {hello:✅} ⋅ error: null ⋅ status: refetching ⋅ isLoading: ❌
    -> data: {hello:❌} ⋅ error: null ⋅ status: success ⋅ isLoading: ❌
    "
  `);
});

test('useDocument selector result should remain stable across rerenders', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    {
      useLoadedSnapshot: true,
      disableInitialInvalidation: true,
    },
  );

  const renders = createLoggerStore();

  let prevData: unknown;

  const { rerender } = renderHook(() => {
    const { data, status } = env.apiStore.useDocument({
      selector: () => ({}),
    });

    renders.add({ status, changed: prevData !== data });
    prevData = data;
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  renders.addMark('Rerenders');

  rerender();
  rerender();
  rerender();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ changed: ✅

    >>> Rerenders

    -> status: success ⋅ changed: ❌
    -> status: success ⋅ changed: ❌
    -> status: success ⋅ changed: ❌
    "
  `);
});
