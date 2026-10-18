import { act, cleanup, renderHook } from '@testing-library/react';
import {
  afterEach,
  assert,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

describe('documentStore performMutation debounce', () => {
  test('skips previous mutation when debounce key matches', async () => {
    const env = createDocumentStoreTestEnv(1);
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls).toMatchInlineSnapshot(`['second']`);
    assert(!firstResult.ok);
    expect(firstResult.error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });

  test('does not deduplicate mutations with different debounce payload', async () => {
    const env = createDocumentStoreTestEnv(1);
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    const secondPromise = env.apiStore.performMutation({
      debounce: { context: 'document:set-value', payload: 'doc-2', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls.toSorted()).toMatchInlineSnapshot(
      `['first', 'second']`,
    );
    assert(firstResult.ok);
    expect(firstResult.value).toBe('first');
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });
});

describe('collectionStore performMutation debounce', () => {
  test('skips previous mutation when debounce key matches', async () => {
    const env = createCollectionStoreTestEnv({ 'item-1': { name: 'Item 1' } });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls).toMatchInlineSnapshot(`['second']`);
    assert(!firstResult.ok);
    expect(firstResult.error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });

  test('does not deduplicate mutations with different debounce payload', async () => {
    const env = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
      'item-2': { name: 'Item 2' },
    });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('item-1', {
      debounce: { context: 'collection:update', payload: 'item-1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    const secondPromise = env.apiStore.performMutation('item-2', {
      debounce: { context: 'collection:update', payload: 'item-2', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls.toSorted()).toMatchInlineSnapshot(
      `['first', 'second']`,
    );
    assert(firstResult.ok);
    expect(firstResult.value).toBe('first');
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });
});

describe('listQueryStore performMutation debounce', () => {
  test('skips previous mutation when debounce key matches', async () => {
    const env = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list-query:update', payload: 'users||1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    await advanceTime(100);

    const secondPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list-query:update', payload: 'users||1', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls).toMatchInlineSnapshot(`['second']`);
    assert(!firstResult.ok);
    expect(firstResult.error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });

  test('does not deduplicate mutations with different debounce payload', async () => {
    const env = createListQueryStoreTestEnv({
      users: [
        { id: 1, name: 'User 1' },
        { id: 2, name: 'User 2' },
      ],
    });
    const mutationCalls: string[] = [];

    const firstPromise = env.apiStore.performMutation('users||1', {
      debounce: { context: 'list-query:update', payload: 'users||1', ms: 300 },
      mutation: () => {
        mutationCalls.push('first');
        return Promise.resolve('first');
      },
    });

    const secondPromise = env.apiStore.performMutation('users||2', {
      debounce: { context: 'list-query:update', payload: 'users||2', ms: 300 },
      mutation: () => {
        mutationCalls.push('second');
        return Promise.resolve('second');
      },
    });

    await advanceTime(299);
    expect(mutationCalls).toMatchInlineSnapshot(`[]`);

    await advanceTime(1);

    const [firstResult, secondResult] = await Promise.all([
      firstPromise,
      secondPromise,
    ]);

    expect(mutationCalls.toSorted()).toMatchInlineSnapshot(
      `['first', 'second']`,
    );
    assert(firstResult.ok);
    expect(firstResult.value).toBe('first');
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
  });
});

// A name edited twice within the debounce window only sends the last call. If
// that call fails, the name must go back to what it was before the first edit,
// which is what the server still has: not to the superseded edit, and not left
// on the failed one.
describe('failed debounced mutations roll back to the state before the first superseded call', () => {
  const renameDebounce = { context: 'rename', payload: 'name', ms: 300 };

  test('documentStore', async () => {
    const env = createDocumentStoreTestEnv(
      { name: 'Ada' },
      { testScenario: 'loaded' },
    );

    function rename(name: string, fail: boolean) {
      return env.apiStore.performMutation({
        debounce: renameDebounce,
        optimisticUpdate: () => {
          env.apiStore.updateState((draft) => {
            draft.value.name = name;
          });
        },
        mutation: () =>
          fail
            ? Promise.reject(new Error('rename failed'))
            : env.serverMock.delayedSetData({ name }),
      });
    }

    const first = rename('Ada L', false);
    await advanceTime(100);
    const second = rename('Ada Lovelace', true);
    await advanceTime(300);

    expect((await first).error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    expect((await second).ok).toBe(false);
    expect(env.serverMock.current).toMatchInlineSnapshot(`name: 'Ada'`);
    expect(env.apiStore.store.state.data?.value).toMatchInlineSnapshot(
      `name: 'Ada'`,
    );
  });

  test('collectionStore', async () => {
    const env = createCollectionStoreTestEnv(
      { 'item-1': { name: 'Ada' } },
      { testScenario: 'loaded' },
    );

    function rename(name: string, fail: boolean) {
      return env.apiStore.performMutation('item-1', {
        debounce: renameDebounce,
        optimisticUpdate: () => {
          env.apiStore.updateItemState('item-1', (draft) => {
            draft.value.name = name;
          });
        },
        mutation: () =>
          fail
            ? Promise.reject(new Error('rename failed'))
            : env.serverTable.delayedUpdateItem('item-1', { name }),
      });
    }

    const first = rename('Ada L', false);
    await advanceTime(100);
    const second = rename('Ada Lovelace', true);
    await advanceTime(300);

    expect((await first).error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    expect((await second).ok).toBe(false);
    expect(env.serverTable.get('item-1')).toMatchInlineSnapshot(`name: 'Ada'`);
    expect(
      env.apiStore.getItemState('item-1')?.data?.value,
    ).toMatchInlineSnapshot(`name: 'Ada'`);
  });

  test('listQueryStore', async () => {
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      { testScenario: { loaded: { items: ['users||1'] } } },
    );

    function rename(name: string, fail: boolean) {
      return env.apiStore.performMutation('users||1', {
        debounce: renameDebounce,
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => {
            draft.name = name;
          });
        },
        mutation: () =>
          fail
            ? Promise.reject(new Error('rename failed'))
            : env.serverTable.delayedUpdateItem('users||1', { name }),
      });
    }

    const first = rename('Ada L', false);
    await advanceTime(100);
    const second = rename('Ada Lovelace', true);
    await advanceTime(300);

    expect((await first).error).toMatchInlineSnapshot(`
      kind: 'skipped'
    `);
    expect((await second).ok).toBe(false);
    expect(
      pick(env.apiStore.getItemState('users||1'), ['name']),
    ).toMatchInlineSnapshot(`name: 'Ada'`);
  });
});

// The name is edited twice within the debounce window, and between the two
// edits another save of the first edit's value succeeds (e.g. from another
// field bound to the same value). That save leaves the state as it was, so
// when the last debounced call fails, reverting both edits contradicts the
// server: the store must revalidate and end on the saved value.
describe('failed debounced mutations revalidate when a save between their calls succeeded', () => {
  const renameDebounce = { context: 'rename', payload: 'name', ms: 300 };

  afterEach(() => {
    cleanup();
  });

  test('documentStore', async () => {
    const env = createDocumentStoreTestEnv(
      { name: 'Ada' },
      { testScenario: 'loaded' },
    );
    renderHook(() => env.apiStore.useDocument({ disableRefetchOnMount: true }));

    function rename(
      name: string,
      { debounce, fail }: { debounce: boolean; fail?: boolean },
    ) {
      act(() => {
        void env.apiStore.performMutation({
          debounce: debounce ? renameDebounce : undefined,
          // Only the rollback can bring the saved value back
          revalidateOnSuccess: false,
          optimisticUpdate: () => {
            env.apiStore.updateState((draft) => {
              draft.value.name = name;
            });
          },
          mutation: () =>
            fail
              ? Promise.reject(new Error('rename failed'))
              : env.serverMock.delayedSetData({ name }, { durationMs: 100 }),
        });
      });
    }

    rename('Grace', { debounce: true });
    await advanceTime(100);
    // Independent save of the same value, which succeeds
    rename('Grace', { debounce: false });
    await advanceTime(100);
    // Supersedes the first edit, then fails
    rename('Grace Hopper', { debounce: true, fail: true });

    await flushAllTimers();

    expect(env.serverMock.current).toMatchInlineSnapshot(`name: 'Grace'`);
    expect(env.apiStore.store.state.data?.value).toMatchInlineSnapshot(
      `name: 'Grace'`,
    );
  });

  test('collectionStore', async () => {
    const env = createCollectionStoreTestEnv(
      { 'item-1': { name: 'Ada' } },
      { testScenario: 'loaded' },
    );
    renderHook(() =>
      env.apiStore.useItem('item-1', { disableRefetchOnMount: true }),
    );

    function rename(
      name: string,
      { debounce, fail }: { debounce: boolean; fail?: boolean },
    ) {
      act(() => {
        void env.apiStore.performMutation('item-1', {
          debounce: debounce ? renameDebounce : undefined,
          // Only the rollback can bring the saved value back
          revalidateOnSuccess: false,
          optimisticUpdate: () => {
            env.apiStore.updateItemState('item-1', (draft) => {
              draft.value.name = name;
            });
          },
          mutation: () =>
            fail
              ? Promise.reject(new Error('rename failed'))
              : env.serverTable.delayedUpdateItem(
                  'item-1',
                  { name },
                  { durationMs: 100 },
                ),
        });
      });
    }

    rename('Grace', { debounce: true });
    await advanceTime(100);
    // Independent save of the same value, which succeeds
    rename('Grace', { debounce: false });
    await advanceTime(100);
    // Supersedes the first edit, then fails
    rename('Grace Hopper', { debounce: true, fail: true });

    await flushAllTimers();

    expect(env.serverTable.get('item-1')).toMatchInlineSnapshot(
      `name: 'Grace'`,
    );
    expect(
      env.apiStore.getItemState('item-1')?.data?.value,
    ).toMatchInlineSnapshot(`name: 'Grace'`);
  });

  test('listQueryStore', async () => {
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'Ada' }] },
      { testScenario: { loaded: { items: ['users||1'] } } },
    );
    renderHook(() =>
      env.apiStore.useItem('users||1', { disableRefetchOnMount: true }),
    );

    function rename(
      name: string,
      { debounce, fail }: { debounce: boolean; fail?: boolean },
    ) {
      act(() => {
        void env.apiStore.performMutation('users||1', {
          debounce: debounce ? renameDebounce : undefined,
          // Only the rollback can bring the saved value back
          revalidateOnSuccess: false,
          optimisticUpdate: () => {
            env.apiStore.updateItemState('users||1', (draft) => {
              draft.name = name;
            });
          },
          mutation: () =>
            fail
              ? Promise.reject(new Error('rename failed'))
              : env.serverTable.delayedUpdateItem(
                  'users||1',
                  { name },
                  { durationMs: 100 },
                ),
        });
      });
    }

    rename('Grace', { debounce: true });
    await advanceTime(100);
    // Independent save of the same value, which succeeds
    rename('Grace', { debounce: false });
    await advanceTime(100);
    // Supersedes the first edit, then fails
    rename('Grace Hopper', { debounce: true, fail: true });

    await flushAllTimers();

    expect(
      pick(env.apiStore.getItemState('users||1'), ['name']),
    ).toMatchInlineSnapshot(`name: 'Grace'`);
  });
});

// A debounced call moves an item into a list whose optimistic update asks for
// a revalidation on success (`invalidateQueries`). A newer debounced call
// supersedes it: the item is already in the list then, so only the superseded
// call asked for that revalidation, and the winning call must still run it.
test('debounced list-query calls keep the list revalidations of the calls they superseded', async () => {
  const userQuery = {
    tableId: 'users',
    filters: [{ op: 'eq' as const, field: 'type', value: 'user' }],
  };
  const env = createListQueryStoreTestEnv(
    { users: [{ id: 1, name: 'Ada', type: 'admin' }] },
    {
      testScenario: { loaded: { queries: [userQuery], items: ['users||1'] } },
      optimisticListUpdates: [
        {
          queries: userQuery,
          filterItem: (item) => item.type === 'user',
          invalidateQueries: true,
        },
      ],
    },
  );
  renderHook(() =>
    env.apiStore.useListQuery(userQuery, { disableRefetchOnMount: true }),
  );

  const editDebounce = { context: 'edit', payload: 'users||1', ms: 300 };

  function edit(changes: { name: string; type: string }) {
    act(() => {
      void env.apiStore.performMutation('users||1', {
        debounce: editDebounce,
        revalidateOnSuccess: false,
        optimisticUpdate: () => {
          env.apiStore.updateItemState('users||1', (draft) => ({
            ...draft,
            ...changes,
          }));
        },
        mutation: () => env.serverTable.delayedUpdateItem('users||1', changes),
      });
    });
  }

  // Moves Ada into the user list, then is superseded
  edit({ name: 'Ada', type: 'user' });
  await advanceTime(100);
  // Ada is already in the user list when this one runs
  edit({ name: 'Ada L', type: 'user' });

  await flushAllTimers();
  cleanup();

  // The user list is refetched once the winning call succeeds
  expect(env.serverTable.getRequestHistory('list', { includeTime: false }))
    .toMatchInlineSnapshot(`
      - _type: 'list'
        payload:
          fields: '*'
          filters:
            - { field: 'type', op: 'eq', value: 'user' }
          pos: { limit: 50, offset: 0 }
        returned_items: 1
    `);
});
