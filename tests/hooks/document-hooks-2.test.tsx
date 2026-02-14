import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

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

type StoreValue = {
  hello: string;
};

test('disable should keep the selected data and not be affected by invalidation', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
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

  await flushAllTimers();

  renders.addMark('first update (✅)');

  act(() => {
    env.emulateExternalRTU({ hello: '✅' });
  });

  await flushAllTimers();

  renders.addMark('set disabled');

  act(() => {
    rerender({ disabled: true });
  });

  await flushAllTimers();

  renders.addMark('ignored update (❌)');

  act(() => {
    env.emulateExternalRTU({ hello: '❌' });
  });

  await flushAllTimers();

  renders.addMark('enabled again');

  act(() => {
    rerender({ disabled: false });
  });

  await flushAllTimers();

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
    { testScenario: 'loaded', usesRealTimeUpdates: true },
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

  await flushAllTimers();

  renders.addMark('first update (✅)');

  act(() => {
    env.emulateExternalRTU({ hello: '✅' });
  });

  await flushAllTimers();

  renders.addMark('set disabled');

  act(() => {
    rerender({ isOffScreen: true });
  });

  await flushAllTimers();

  renders.addMark('ignored update (❌)');

  act(() => {
    env.emulateExternalRTU({ hello: '❌' });
  });

  await flushAllTimers();

  renders.addMark('enabled again');

  act(() => {
    rerender({ isOffScreen: false });
  });

  await flushAllTimers();

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
    { testScenario: 'loaded', usesRealTimeUpdates: true },
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

  await flushAllTimers();

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
