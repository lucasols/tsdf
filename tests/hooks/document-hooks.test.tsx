import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import React, { useEffect, useState } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { DocumentStatus } from '../../src/documentStore';
import type { StoreError } from '../../src/utils/storeShared';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  getDefaultLowPriorityThrottleMs,
  TEST_INITIAL_TIME,
} from '../mocks/testEnvUtils';
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

type StoreValue = { hello: string };

test('load data', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

  expect(env.apiStore.store.state).toMatchInlineSnapshot(`
    data: null
    error: null
    refetchOnMount: '❌'
    status: 'idle'
  `);

  const { result, unmount } = renderHook(() => env.apiStore.useDocument());

  expect(result.current.status).toBe('loading');
  expect(result.current.isLoading).toBe(true);
  expect(result.current.data).toBeNull();

  await flushAllTimers();

  expect(result.current.status).toBe('success');
  expect(result.current.isLoading).toBe(false);
  expect(result.current.data?.value).toMatchInlineSnapshot(`hello: 'world'`);

  unmount();
});

test('invalidate data', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const { result } = renderHook(() => env.apiStore.useDocument());

  expect(result.current.data?.value).toMatchInlineSnapshot(`hello: 'world'`);

  act(() => {
    env.setServerData({ hello: 'was invalidated' });
    env.apiStore.invalidateData();
  });

  await flushAllTimers();

  expect(result.current.data?.value).toMatchInlineSnapshot(
    `hello: 'was invalidated'`,
  );
});

test('revalidation with multiple components do not trigger multiple fetches', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  for (let i = 0; i < 27; i += 1) {
    renderHook(() => env.apiStore.useDocument());
  }

  const { result } = renderHook(() => env.apiStore.useDocument());

  act(() => {
    env.setServerData({ hello: 'was invalidated' });
    env.apiStore.invalidateData();
  });

  await flushAllTimers();

  expect(result.current.data?.value).toMatchInlineSnapshot(
    `hello: 'was invalidated'`,
  );
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('data selector', () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const { result } = renderHook(() =>
    env.apiStore.useDocument({ selector: (data) => data?.value.hello }),
  );

  expect(result.current.data).toBe('world');
});

describe('disable', () => {
  test('disable initial fetch', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const { result } = renderHook(() =>
      env.apiStore.useDocument({ disabled: true }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 3);
      await flushAllTimers();
    });

    expect(env.serverMock.numOfFinishedFetches).toBe(0);

    expect(result.current).toMatchInlineSnapshot(`
      data: null
      error: null
      isLoading: '❌'
      pendingSync: '❌'
      status: 'idle'
    `);
  });

  test('disable then enable fetch', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const renders: Array<{
      data: StoreValue | null;
      disabled: boolean;
      status: DocumentStatus;
    }> = [];

    const { rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) => {
        const data = env.apiStore.useDocument({ disabled });

        renders.push({
          data: data.data?.value ?? null,
          status: data.status,
          disabled,
        });
      },
      { initialProps: { disabled: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 3);
    });

    expect(env.serverMock.numOfFinishedFetches).toBe(0);
    expect(renders).toMatchInlineSnapshot(
      `- { data: null, disabled: '✅', status: 'idle' }`,
    );

    act(() => {
      rerender({ disabled: false });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(env.serverMock.numOfFinishedFetches).toBe(1);
    expect(renders).toMatchInlineSnapshot(`
      - { data: null, disabled: '✅', status: 'idle' }
      - { data: null, disabled: '❌', status: 'loading' }
      - data: { hello: 'world' }
        disabled: '❌'
        status: 'success'
    `);
  });
});

test('disableRefetchOnMount', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

  const renders: Array<{ data: StoreValue | null; status: DocumentStatus }> =
    [];
  const comp2Renders: Array<{
    data: StoreValue | null;
    status: DocumentStatus;
  }> = [];

  function Comp2() {
    const data = env.apiStore.useDocument({ disableRefetchOnMount: true });

    comp2Renders.push({ data: data.data?.value ?? null, status: data.status });

    return <div />;
  }

  function Comp() {
    const [mountComp2, setMountComp2] = useState(false);

    const data = env.apiStore.useDocument({ disableRefetchOnMount: true });

    renders.push({ data: data.data?.value ?? null, status: data.status });

    useEffect(() => {
      if (data.status === 'success') {
        setMountComp2(true);
      }
    }, [data.status]);

    return <>{mountComp2 && <Comp2 />}</>;
  }

  render(<Comp />);

  await flushAllTimers();

  expect(renders).toMatchInlineSnapshot(`
    - { data: null, status: 'loading' }
    - data: { hello: 'world' }
      status: 'success'
    - data: { hello: 'world' }
      status: 'success'
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  await flushAllTimers();

  expect(comp2Renders).toMatchInlineSnapshot(`
    - data: { hello: 'world' }
      status: 'success'
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('do not return refetching status by default', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const renders: Array<[string | null, DocumentStatus]> = [];

  renderHook(() => {
    const { data, status } = env.apiStore.useDocument();

    renders.push([data?.value.hello ?? null, status]);
  });

  act(() => {
    env.setServerData({ hello: 'was invalidated' });
    env.apiStore.invalidateData();
  });

  await flushAllTimers();

  expect(renders).toMatchInlineSnapshot(`
    - ['world', 'success']
    - ['was invalidated', 'success']
  `);
});

describe('action types', () => {
  test('action with optimistic update', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders: Array<[string | null, DocumentStatus]> = [];

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument();

      renders.push([data?.value.hello ?? null, status]);
    });

    act(() => {
      void env.performClientUpdateAction(
        { hello: 'was updated' },
        { withOptimisticUpdate: true, withRevalidation: false },
      );
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders).toMatchInlineSnapshot(`
      - ['world', 'success']
      - ['was updated', 'success']
    `);
  });

  test('action with optimistic update and revalidation', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders: Array<[string | null, DocumentStatus]> = [];

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.push([data?.value.hello ?? null, status]);
    });

    act(() => {
      void env.performClientUpdateAction(
        { hello: 'was updated' },
        { withOptimisticUpdate: true, withRevalidation: true },
      );
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders).toMatchInlineSnapshot(`
      - ['world', 'success']
      - ['was updated', 'success']
      - ['was updated', 'refetching']
      - ['was updated', 'success']
    `);
  });

  test('action without optimistic update', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders: Array<[string | null, DocumentStatus]> = [];

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument();

      renders.push([data?.value.hello ?? null, status]);
    });

    act(() => {
      void env.performClientUpdateAction(
        { hello: 'was updated' },
        {
          withOptimisticUpdate: false,
          withRevalidation: false,
          updateStateWithMutationResult: true,
        },
      );
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders).toMatchInlineSnapshot(`
      - ['world', 'success']
      - ['was updated', 'success']
    `);
  });

  test('action with revalidation and without optimistic update', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders: Array<[string | null, DocumentStatus]> = [];

    renderHook(() => {
      const { data, status } = env.apiStore.useDocument({
        returnRefetchingStatus: true,
      });

      renders.push([data?.value.hello ?? null, status]);
    });

    act(() => {
      void env.performClientUpdateAction(
        { hello: 'was updated' },
        { withOptimisticUpdate: false, withRevalidation: true },
      );
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders).toMatchInlineSnapshot(`
      - ['world', 'success']
      - ['world', 'refetching']
      - ['was updated', 'success']
    `);
  });
});

test('rollback on error', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const renders: Array<[string | null, DocumentStatus, StoreError | null]> = [];

  renderHook(() => {
    const { data, status, error } = env.apiStore.useDocument({
      returnRefetchingStatus: true,
    });

    renders.push([data?.value.hello ?? null, status, error]);
  });

  act(() => {
    void env.performClientUpdateAction(
      { hello: 'was updated' },
      { withOptimisticUpdate: true, withRevalidation: false, error: 'error' },
    );
  });

  await flushAllTimers();

  expect(renders).toMatchInlineSnapshot(`
    - ['world', 'success', null]
    - ['was updated', 'success', null]
    - ['world', 'success', null]
  `);
});

describe('isolated tests', () => {
  test('use ensureIsLoaded prop', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    // trigger a load before the hook is rendered
    env.apiStore.scheduleFetch('highPriority');

    await flushAllTimers();

    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    const renders = createLoggerStore();

    renderHook(() => {
      const selectionResult = env.apiStore.useDocument({
        ensureIsLoaded: true,
      });

      renders.add({
        status: selectionResult.status,
        isLoading: selectionResult.isLoading,
        data: selectionResult.data?.value ?? null,
      });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ data: {hello:world}
      -> status: success ⋅ isLoading: ❌ ⋅ data: {hello:world}
      "
    `);

    expect(env.serverMock.numOfFinishedFetches).toBe(2);

    renders.reset();

    expect(env.apiStore.scheduleFetch('highPriority')).toBe('triggered');

    await act(async () => {
      await flushAllTimers();
    });

    expect(env.serverMock.numOfFinishedFetches).toBe(3);

    // ignore refetching status
    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ isLoading: ❌ ⋅ data: {hello:world}
      "
    `);
  });

  test('ensureIsLoaded stops forcing loading when the first fetch fails', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });
    const renders = createLoggerStore();

    // Make the mount-triggered ensureIsLoaded fetch fail immediately so the hook
    // must react to the first terminal state without relying on a later retry.
    env.errorInNextFetch('Fetch error');

    renderHook(() => {
      const selectionResult = env.apiStore.useDocument({
        ensureIsLoaded: true,
      });

      renders.add({
        status: selectionResult.status,
        isLoading: selectionResult.isLoading,
        data: selectionResult.data?.value ?? null,
        error: selectionResult.error?.message ?? null,
      });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: loading ⋅ isLoading: ✅ ⋅ data: null ⋅ error: null
      -> status: error ⋅ isLoading: ❌ ⋅ data: null ⋅ error: Fetch error
      "
    `);
  });

  test('automatic error retries suppress immediate rerender loops', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    env.errorInNextFetch('automatic failure');

    const { rerender, result } = renderHook(
      ({ version }: { version: number }) =>
        env.apiStore.useDocument({
          selector: (data) => (data ? `${data.value.hello}-${version}` : null),
        }),
      { initialProps: { version: 0 } },
    );

    await flushAllTimers();

    expect(result.current.status).toBe('error');
    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    for (const version of [1, 2, 3]) {
      rerender({ version });
      await flushAllTimers();
    }

    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('automatic document errors do not block invalidations and manual fetches', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { transportReconnectCooldownMs: 0, usesRealTimeUpdates: true },
    );

    env.errorInNextFetch('automatic failure');

    const { result } = renderHook(() => env.apiStore.useDocument());

    await flushAllTimers();

    expect(result.current.status).toBe('error');
    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    env.errorInNextFetch('reconnect failure');

    act(() => {
      env.apiStore.onTransportReconnect();
    });

    await flushAllTimers();

    // Lifecycle invalidation is a real refresh signal and bypasses the retry lock.
    expect(result.current.status).toBe('error');
    expect(env.serverMock.numOfFinishedFetches).toBe(2);

    env.errorInNextFetch('manual failure');

    act(() => {
      env.apiStore.invalidateData();
    });

    await flushAllTimers();

    // Public invalidation is an intentional manual operation and bypasses the lock.
    expect(result.current.status).toBe('error');
    expect(env.serverMock.numOfFinishedFetches).toBe(3);

    act(() => {
      env.apiStore.scheduleFetch('highPriority');
    });

    await flushAllTimers();

    expect(result.current.status).toBe('success');
    expect(env.serverMock.numOfFinishedFetches).toBe(4);

    act(() => {
      env.setServerData({ hello: 'after-success' });
      env.apiStore.onTransportReconnect();
    });

    await flushAllTimers();

    // A successful response clears the lock and the hook reflects later refreshes.
    expect(result.current.data?.value).toMatchInlineSnapshot(
      `hello: 'after-success'`,
    );
    expect(env.serverMock.numOfFinishedFetches).toBe(5);
  });

  test('disabled document hooks re-enable like a fresh mount after a fast error', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    env.errorInNextFetch('automatic failure');

    const { rerender, result } = renderHook(
      ({ disabled }: { disabled: boolean }) =>
        env.apiStore.useDocument({ disabled }),
      { initialProps: { disabled: false } },
    );

    await flushAllTimers();

    expect(result.current.status).toBe('error');
    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    // Disabling the hook is equivalent to unmounting this subscription, so the
    // hook-local automatic retry lock should not survive re-enable.
    rerender({ disabled: true });
    await flushAllTimers();

    // Wait only for the normal low-priority scheduler throttle. This is still
    // inside the automatic retry lockout window, so a refetch here proves the
    // disabled subscription re-entered like a fresh mount.
    await advanceTime(getDefaultLowPriorityThrottleMs() + 1);

    rerender({ disabled: false });
    await flushAllTimers();

    expect(result.current.status).toBe('success');
    expect(env.serverMock.numOfFinishedFetches).toBe(2);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    // trigger a load before the hook is rendered
    env.apiStore.scheduleFetch('highPriority');

    await flushAllTimers();

    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    const renders = createLoggerStore();

    const { rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) => {
        const res = env.apiStore.useDocument({
          ensureIsLoaded: true,
          disabled,
        });

        renders.add({
          status: res.status,
          isLoading: res.isLoading,
          data: res.data?.value ?? null,
        });
      },
      { initialProps: { disabled: true } },
    );

    expect(env.serverMock.numOfFinishedFetches).toBe(1);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(
      `
        "
        -> status: success ⋅ isLoading: ❌ ⋅ data: {hello:world}
        "
      `,
    );

    act(() => {
      // enable loading
      rerender({ disabled: false });
    });

    await act(async () => {
      await flushAllTimers();
    });

    expect(env.serverMock.numOfFinishedFetches).toBe(2);

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ isLoading: ❌ ⋅ data: {hello:world}
      ⋅⋅⋅
      -> status: loading ⋅ isLoading: ✅ ⋅ data: {hello:world}
      -> status: success ⋅ isLoading: ❌ ⋅ data: {hello:world}
      "
    `);
  });
});

test('RTU update works', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'lucas' },
    {
      testScenario: 'loaded',
      usesRealTimeUpdates: true,
      dynamicRealtimeThrottleMs() {
        return 300;
      },
    },
  );

  const renders = createLoggerStore();

  env.emulateExternalRTU({ hello: 'RTU Update' });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });

  expect(env.store.state).toMatchInlineSnapshot(`
    data:
      value: { hello: 'lucas' }

    error: null
    refetchOnMount: 'realtimeUpdate'
    status: 'success'
  `);

  renderHook(() => {
    const { data, status } = env.apiStore.useDocument({
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data: data?.value ?? null });
  });

  await flushAllTimers();

  const rtuTriggeredAt = Date.now() - TEST_INITIAL_TIME;
  env.emulateExternalRTU({ hello: 'Throttle update' });

  await flushAllTimers();

  expect(renders.changesSnapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {hello:lucas}
    -> status: refetching ⋅ data: {hello:lucas}
    -> status: success ⋅ data: {hello:RTU Update}
    -> status: refetching ⋅ data: {hello:RTU Update}
    -> status: success ⋅ data: {hello:Throttle update}
    "
  `);

  const secondFetch = env.serverMock.fetchHistory[1];

  expect(secondFetch).toBeDefined();
  expect(
    secondFetch ? secondFetch.startTime - rtuTriggeredAt : 0,
  ).toBeGreaterThanOrEqual(300);
});
