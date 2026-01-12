import { act, cleanup, renderHook } from '@testing-library/react';
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
import { trackChangedValues } from '../utils/trackChangedValues';

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

test('load data', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

  const { result, unmount } = renderHook(() => env.apiStore.useDocument());

  expect(result.current.status).toBe('loading');
  expect(result.current.isLoading).toBe(true);
  expect(result.current.data).toBeNull();

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(result.current.status).toBe('success');
  expect(result.current.isLoading).toBe(false);
  expect(result.current.data?.value).toEqual({ hello: 'world' });

  unmount();
});

test('invalidate data', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { useLoadedSnapshot: true },
  );

  const { result } = renderHook(() => env.apiStore.useDocument());

  expect(result.current.data?.value).toEqual({ hello: 'world' });

  act(() => {
    env.setServerData({ hello: 'was invalidated' });
    env.apiStore.invalidateData();
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(result.current.data?.value).toEqual({
    hello: 'was invalidated',
  });
});

test('revalidation with multiple components do not trigger multiple fetches', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    {
      disableInitialInvalidation: true,
      initialStateData: 'sameAsServer',
    },
  );

  for (let i = 0; i < 27; i += 1) {
    renderHook(() => env.apiStore.useDocument());
  }

  const { result } = renderHook(() => env.apiStore.useDocument());

  act(() => {
    env.setServerData({ hello: 'was invalidated' });
    env.apiStore.invalidateData();
  });

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(result.current.data?.value).toEqual({
    hello: 'was invalidated',
  });
  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('data selector', () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { useLoadedSnapshot: true },
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
      await vi.runAllTimersAsync();
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
      await vi.runAllTimersAsync();
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

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(renders).toMatchInlineSnapshot(`
    - { data: null, status: 'loading' }
    - data: { hello: 'world' }
      status: 'success'
    - data: { hello: 'world' }
      status: 'success'
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(comp2Renders).toMatchInlineSnapshot(`
    - data: { hello: 'world' }
      status: 'success'
  `);

  expect(env.serverMock.numOfFinishedFetches).toBe(1);
});

test('do not return refetching status by default', async () => {
  const env = createDocumentStoreTestEnv<StoreValue>(
    { hello: 'world' },
    { useLoadedSnapshot: true },
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

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(renders).toMatchInlineSnapshot(`
    - ['world', 'success']
    - ['was invalidated', 'success']
  `);
});

describe('action types', () => {
  test('action with optimistic update', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { useLoadedSnapshot: true },
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
      await vi.runAllTimersAsync();
    });

    expect(renders).toMatchInlineSnapshot(`
      - ['world', 'success']
      - ['was updated', 'success']
    `);
  });

  test('action with optimistic update and revalidation', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { useLoadedSnapshot: true },
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
      await vi.runAllTimersAsync();
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
      { useLoadedSnapshot: true },
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
      await vi.runAllTimersAsync();
    });

    expect(renders).toMatchInlineSnapshot(`
      - ['world', 'success']
      - ['was updated', 'success']
    `);
  });

  test('action with revalidation and without optimistic update', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { useLoadedSnapshot: true },
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
      await vi.runAllTimersAsync();
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
    {
    useLoadedSnapshot: true,
      disableInitialInvalidation: true,
    },
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

  await act(async () => {
    await vi.runAllTimersAsync();
  });

  expect(renders).toMatchInlineSnapshot(`
    - ['world', 'success', null]
    - ['was updated', 'success', null]
    - ['was updated', 'refetching', null]
    - ['world', 'success', null]
  `);
});

describe('isolated tests', () => {
  test('use ensureIsLoaded prop', async () => {
    const { serverMock, store: documentStore } = createDefaultDocumentStore({
      useLoadedSnapshot: false,
    });

    const renders = createRenderStore();

    renderHook(() => {
      const selectionResult = documentStore.useDocument({
        ensureIsLoaded: true,
      });

      renders.add(
        pick(selectionResult, ['status', 'isLoading', 'data'], {
          isLoading: 'L',
        }),
      );
    });

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: loading -- L: true -- data: null
      status: loading -- L: true -- data: {hello:world}
      status: success -- L: false -- data: {hello:world}
      "
    `);

    renders.reset();

    expect(documentStore.scheduleFetch('highPriority')).toBe('started');

    await serverMock.waitFetchIdle();

    // ignore refetching status
    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: success -- L: false -- data: {hello:world}
      "
    `);
  });

  test('use ensureIsLoaded prop with disabled', async () => {
    const { serverMock, store: documentStore } = createDefaultDocumentStore({
      useLoadedSnapshot: false,
    });

    const renders = createRenderStore();

    const disabled = createValueStore<boolean>(true);

    renderHook(() => {
      const res = documentStore.useDocument({
        ensureIsLoaded: true,
        disabled: disabled.useValue(),
      });

      renders.add(
        pick(res, ['status', 'isLoading', 'data'], { isLoading: 'L' }),
      );
    });

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- L: false -- data: null
      "
    `);

    // enable loading
    disabled.set(false);

    await serverMock.waitFetchIdle();

    expect(renders.snapshot).toMatchInlineSnapshot(`
      "
      status: idle -- L: false -- data: null
      ---
      status: loading -- L: true -- data: null
      status: loading -- L: true -- data: {hello:world}
      status: success -- L: false -- data: {hello:world}
      "
    `);
  });
});

test.concurrent('RTU update works', async () => {
  const env = createTestEnv({
    initialServerData: 'lucas',
    useLoadedSnapshot: true,
    emulateRTU: true,
    dynamicRTUThrottleMs() {
      return 300;
    },
  });

  const renders = createRenderStore();

  env.serverMock.produceData((draft) => {
    draft.hello = 'RTU Update';
  });

  await sleep(100);

  expect(env.store.store.state).toMatchInlineSnapshotString(`
    {
      "data": {
        "hello": "world",
      },
      "error": null,
      "refetchOnMount": "realtimeUpdate",
      "status": "success",
    }
  `);

  renderHook(() => {
    const { data, status } = env.store.useDocument({
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data });
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  env.serverMock.produceData((draft) => {
    draft.hello = 'Throttle update';
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchInlineSnapshotString(`
    "
    status: success -- data: {hello:world}
    status: refetching -- data: {hello:world}
    status: success -- data: {hello:RTU Update}
    status: refetching -- data: {hello:RTU Update}
    status: success -- data: {hello:Throttle update}
    "
  `);

  expect(
    env.serverMock.fetchs[1]!.time.start - env.serverMock.fetchs[0]!.time.end,
  ).toBeGreaterThanOrEqual(300);
});

test.concurrent('initial data is invalidated on first load', async () => {
  const env = createTestEnv({
    initialServerData: 'lucas',
    useLoadedSnapshot: true,
    disableInitialDataInvalidation: false,
  });

  env.serverMock.produceData((draft) => {
    draft.hello = 'update';
  });

  const renders = createRenderStore();

  renderHook(() => {
    const { data, status } = env.store.useDocument({
      returnRefetchingStatus: true,
      disableRefetchOnMount: true,
    });

    renders.add({ status, data });
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.snapshot).toMatchInlineSnapshotString(`
    "
    status: success -- data: {hello:world}
    status: refetching -- data: {hello:world}
    status: success -- data: {hello:update}
    "
  `);
});
