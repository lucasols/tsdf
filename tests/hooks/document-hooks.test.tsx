import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
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
  expect(result.current.data?.value).toEqual({ hello: 'world' });

  unmount();
});

test('invalidate data', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const { result } = renderHook(() => env.apiStore.useDocument());

  expect(result.current.data?.value).toEqual({ hello: 'world' });

  act(() => {
    env.setServerData({ hello: 'was invalidated' });
    env.apiStore.invalidateData();
  });

  await flushAllTimers();

  expect(result.current.data?.value).toEqual({
    hello: 'was invalidated',
  });
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

  expect(result.current.data?.value).toEqual({
    hello: 'was invalidated',
  });
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('data selector', () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: 'loaded', usesRealTimeUpdates: true },
  );

  const { result } = renderHook(() =>
    env.apiStore.useDocument({
      selector: (data) => data?.value.hello,
    }),
  );

  expect(result.current.data).toBe('world');
});

describe('disable', () => {
  test('disable initial fetch', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const { result } = renderHook(() =>
      env.apiStore.useDocument({
        disabled: true,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 3);
      await flushAllTimers();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(env.serverMock.numOfFinishedFetches).toBe(0);
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
        const data = env.apiStore.useDocument({
          disabled,
        });

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

  const renders: Array<{
    data: StoreValue | null;
    status: DocumentStatus;
  }> = [];
  const comp2Renders: Array<{
    data: StoreValue | null;
    status: DocumentStatus;
  }> = [];

  function Comp2() {
    const data = env.apiStore.useDocument({
      disableRefetchOnMount: true,
    });

    comp2Renders.push({ data: data.data?.value ?? null, status: data.status });

    return <div />;
  }

  function Comp() {
    const [mountComp2, setMountComp2] = useState(false);

    const data = env.apiStore.useDocument({
      disableRefetchOnMount: true,
    });

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
        {
          withOptimisticUpdate: true,
          withRevalidation: false,
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
        {
          withOptimisticUpdate: true,
          withRevalidation: true,
        },
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
        {
          withOptimisticUpdate: false,
          withRevalidation: true,
        },
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
      {
        withOptimisticUpdate: true,
        withRevalidation: false,
        error: 'error',
      },
    );
  });

  await flushAllTimers();

  expect(renders).toMatchInlineSnapshot(`
    - ['world', 'success', null]
    - ['was updated', 'success', null]
    - ['was updated', 'refetching', null]
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

    expect(renders.snapshot).toMatchInlineSnapshot(`
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
    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      -> status: success ⋅ isLoading: ❌ ⋅ data: {hello:world}
      "
    `);
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

    expect(renders.snapshot).toMatchInlineSnapshot(
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

    expect(renders.snapshot).toMatchInlineSnapshot(`
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

  const rtuTriggeredAt = Date.now();
  env.emulateExternalRTU({ hello: 'Throttle update' });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {hello:lucas}
    -> status: refetching ⋅ data: {hello:lucas}
    -> status: success ⋅ data: {hello:RTU Update}
    -> status: refetching ⋅ data: {hello:RTU Update}
    -> status: success ⋅ data: {hello:Throttle update}
    "
  `);

  const secondFetch = env.serverMock.fetches[1];

  expect(secondFetch).toBeDefined();
  expect(
    secondFetch ? secondFetch.startTime - rtuTriggeredAt : 0,
  ).toBeGreaterThanOrEqual(300);
});

test('initial data is invalidated on first load', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { testScenario: { idleWithLocalCache: 'sameAsServer' } },
  );

  env.setServerData({ hello: 'update' });

  const renders = createLoggerStore();

  renderHook(() => {
    const { data, status } = env.apiStore.useDocument({
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data: data?.value ?? null });
  });

  await flushAllTimers();

  expect(renders.snapshot).toMatchInlineSnapshot(`
    "
    -> status: success ⋅ data: {hello:world}
    -> status: refetching ⋅ data: {hello:world}
    -> status: success ⋅ data: {hello:update}
    "
  `);
});
