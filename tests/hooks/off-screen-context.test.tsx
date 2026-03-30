import { createLoggerStore } from '@ls-stack/utils/testUtils';
import { act, cleanup, renderHook } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { IsOffScreenContext } from '../../src/isOffScreenContext';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, range } from '../utils/genericTestUtils';

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

type Todo = { title: string; completed: boolean };
const defaultTodo: Todo = { title: 'todo', completed: false };

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 3).map((id) => ({ id, name: `Product ${id}` })),
};

function createWrapper(isOffScreen: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <IsOffScreenContext.Provider value={isOffScreen}>
        {children}
      </IsOffScreenContext.Provider>
    );
  };
}

type StoreValue = { hello: string };

describe('document store', () => {
  test('context isOffScreen=true prevents fetching', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const renders = createLoggerStore();

    renderHook(
      () => {
        const result = env.apiStore.useDocument({ returnIdleStatus: true });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: idle
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(0);
  });

  test('explicit isOffScreen: false overrides context isOffScreen=true', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const renders = createLoggerStore();

    renderHook(
      () => {
        const result = env.apiStore.useDocument({ isOffScreen: false });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: loading
      -> data: {hello:world} ⋅ status: success
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });

  test('context isOffScreen=true skips invalidation events', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>(
      { hello: 'world' },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders = createLoggerStore();

    renderHook(
      () => {
        const result = env.apiStore.useDocument({
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    renders.addMark('server update (should be ignored)');

    act(() => {
      env.emulateExternalRTU({ hello: 'updated' });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: {hello:world} ⋅ status: success

      >>> server update (should be ignored)
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(0);
  });
});

describe('collection store', () => {
  test('context isOffScreen=true prevents fetching', async () => {
    const env = createCollectionStoreTestEnv<Todo>({ '1': defaultTodo });

    const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

    renderHook(
      () => {
        const result = env.apiStore.useItem('1', { returnIdleStatus: true });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: idle
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('explicit isOffScreen: false overrides context isOffScreen=true', async () => {
    const env = createCollectionStoreTestEnv<Todo>({ '1': defaultTodo });

    const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

    renderHook(
      () => {
        const result = env.apiStore.useItem('1', { isOffScreen: false });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: loading
      -> data: {title:todo, completed:❌} ⋅ status: success
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('context isOffScreen=true skips invalidation events', async () => {
    const env = createCollectionStoreTestEnv<Todo>(
      { '1': defaultTodo },
      { testScenario: 'loaded', usesRealTimeUpdates: true },
    );

    const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

    renderHook(
      () => {
        const result = env.apiStore.useItem('1', {
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
        });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    renders.addMark('server update (should be ignored)');

    act(() => {
      env.serverTable.setItem(
        '1',
        { title: '✅', completed: true },
        { triggerRTUEvent: true },
      );
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: {title:todo, completed:❌} ⋅ status: success

      >>> server update (should be ignored)
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('list query store', () => {
  test('context isOffScreen=true prevents useListQuery fetching', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

    renderHook(
      () => {
        const result = env.apiStore.useListQuery(
          { tableId: 'users' },
          { returnIdleStatus: true },
        );
        renders.add({ items: result.items.length, status: result.status });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> items: 0 ⋅ status: idle
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });

  test('explicit isOffScreen: false overrides context for useListQuery', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

    renderHook(
      () => {
        const result = env.apiStore.useListQuery(
          { tableId: 'users' },
          { isOffScreen: false },
        );
        renders.add({ items: result.items.length, status: result.status });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> items: 0 ⋅ status: loading
      -> items: 5 ⋅ status: success
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(1);
  });

  test('context isOffScreen=true prevents useItem fetching', async () => {
    const env = createListQueryStoreTestEnv(initialServerData);

    const renders = createLoggerStore({ rejectKeys: ['queryMetadata'] });

    renderHook(
      () => {
        const result = env.apiStore.useItem('users||1', {
          returnIdleStatus: true,
        });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: idle
      "
    `);
    expect(env.serverTable.numOfFinishedFetches).toBe(0);
  });
});

describe('dynamic toggle', () => {
  test('switching context from true to false resumes fetching', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const renders = createLoggerStore();

    renderHook(
      () => {
        const result = env.apiStore.useDocument({ returnIdleStatus: true });
        renders.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(true) },
    );

    await flushAllTimers();

    renders.addMark('enable fetching');

    // We need to re-render with a new wrapper that provides false
    cleanup();

    const renders2 = createLoggerStore();

    renderHook(
      () => {
        const result = env.apiStore.useDocument();
        renders2.add({
          data: result.data?.value ?? null,
          status: result.status,
        });
      },
      { wrapper: createWrapper(false) },
    );

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: idle

      >>> enable fetching
      "
    `);

    expect(renders2.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: loading
      -> data: {hello:world} ⋅ status: success
      "
    `);
  });
});

describe('no provider', () => {
  test('hooks work normally without context provider (backward compatibility)', async () => {
    const env = createDocumentStoreTestEnv<StoreValue>({ hello: 'world' });

    const renders = createLoggerStore();

    renderHook(() => {
      const result = env.apiStore.useDocument();
      renders.add({ data: result.data?.value ?? null, status: result.status });
    });

    await flushAllTimers();

    expect(renders.changesSnapshot).toMatchInlineSnapshot(`
      "
      -> data: null ⋅ status: loading
      -> data: {hello:world} ⋅ status: success
      "
    `);
    expect(env.serverMock.numOfFinishedFetches).toBe(1);
  });
});
