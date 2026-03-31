import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  type CreateListQueryUserOperations,
  getOfflineQueueEntries,
  getOfflineQueueEntryData,
  type PatchUserOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

test('list-query offline replay keeps the queued patch anchored to the original row', async () => {
  network.setOffline();
  const sessionKey = 'offline-replay-mutation-payload-session';
  const storeName = 'offline-replay-mutation-payload-store';
  const execute = vi.fn(
    ({
      input,
      enqueuedAt,
    }: {
      input: { itemId: string; name: string };
      enqueuedAt: number;
    }) => {
      expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
      env.apiStore.updateItemState(input.itemId, (item) => ({
        ...item,
        name: input.name,
      }));

      return { name: input.name };
    },
  );

  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute,
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    );

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Keep the row offline-visible while the replayed patch is queued.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada pending',
        }));
      },
      mutation: () => Promise.resolve({ name: 'Ada replayed' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada replayed' },
      },
    });
  });

  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada pending']
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map(({ entityKey, pendingMutations, storeType, syncState }) => ({
        entityKey,
        pendingMutations,
        storeType,
        syncState,
      })),
  ).toMatchInlineSnapshot(`
    - entityKey: '"users||1'
      pendingMutations: 1
      storeType: 'listQuery'
      syncState: 'pending'
  `);
  expect(
    getOfflineQueueEntries(sessionKey, storeName).map((entry) => {
      const data = getOfflineQueueEntryData(entry);

      return {
        entityRefs: data.entityRefs,
        input: data.input,
        operation: data.operation,
        storeName: data.storeName,
        storeType: data.storeType,
        syncState: data.syncState,
      };
    }),
  ).toMatchInlineSnapshot(`
    - entityRefs:
        - entityKey: '"users||1'
          entityKind: 'item'
      input: { itemId: 'users||1', name: 'Ada replayed' }
      operation: 'patchUserName'
      storeName: 'offline-replay-mutation-payload-store'
      storeType: 'listQuery'
      syncState: 'pending'
  `);

  // Restoring connectivity should replay the queued patch without changing the
  // entity reference, and the queue should disappear once that replay succeeds.
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
    await flushAllTimers();
    await Promise.resolve();
  });

  expect(execute).toHaveBeenCalledTimes(5);
  expect(execute.mock.calls.map(([ctx]) => ctx.input)).toMatchInlineSnapshot(`
    - { itemId: 'users||1', name: 'Ada replayed' }
    - { itemId: 'users||1', name: 'Ada replayed' }
    - { itemId: 'users||1', name: 'Ada replayed' }
    - { itemId: 'users||1', name: 'Ada replayed' }
    - { itemId: 'users||1', name: 'Ada replayed' }
  `);
  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada pending']
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map(({ entityKey, pendingMutations, storeType, syncState }) => ({
        entityKey,
        pendingMutations,
        storeType,
        syncState,
      })),
  ).toMatchInlineSnapshot(`
    - entityKey: '"users||1'
      pendingMutations: 0
      storeType: 'listQuery'
      syncState: 'resolution-required'
  `);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time | query-items | query-status |
    0    | Ada         | success      | [query-status, query-items] ui-initialized
    10ms | Ada         | error        | [query-status] ui-changed
    2s   | Ada pending | error        | [query-items] ui-changed
    "
  `);

  hook.unmount();
});

type CreateAndPatchListQueryUserOperations = CreateListQueryUserOperations &
  PatchUserOperations;

test('list-query replay runs temp create before the queued edit and remaps the edit to the final id', async () => {
  network.setOffline();
  const sessionKey = 'offline-replay-temp-create-then-edit-session';
  const storeName = 'offline-replay-temp-create-then-edit-store';
  const usersQuery = { tableId: 'users' } as const;
  let nextUserId = 3;
  const replayedOperations: Array<{
    operation: 'createUser' | 'patchUserName';
    input: { itemId: string; name: string } | { name: string };
  }> = [];

  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateAndPatchListQueryUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: ({ input }) => {
                replayedOperations.push({ operation: 'createUser', input });
                const result = { id: nextUserId, name: input.name };
                nextUserId += 1;
                return result;
              },
            },
            patchUserName: {
              inputSchema: userPatchSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute: ({ input }) => {
                replayedOperations.push({ operation: 'patchUserName', input });
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
                return { name: input.name };
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Queue an offline temp create so later mutations have to follow that
  // temporary payload until replay can reconcile it to a real server id.
  env.addTimelineComments('beforeNextAction', [
    'queue a temp create while offline',
  ]);
  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus offline',
          { id: -1, name: 'Linus offline' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });

  // Edit the same temp row before reconnecting. Replay should keep this edit
  // behind the create and retarget it to the final server-backed payload.
  env.addTimelineComments('beforeNextAction', [
    'edit the same temp row before reconnecting',
  ]);
  await act(async () => {
    await env.apiStore.performMutation('temp:Linus offline', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('temp:Linus offline', (item) => ({
          ...item,
          name: 'Linus edited',
        }));
      },
      mutation: () => Promise.resolve({ name: 'Linus edited' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'temp:Linus offline', name: 'Linus edited' },
      },
    });
  });

  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus edited']
  `);
  expect(
    getOfflineQueueEntries(sessionKey, storeName)
      .map((entry) => {
        const data = getOfflineQueueEntryData(entry);

        return {
          input: data.input,
          operation: data.operation,
          queueOrder: data.queueOrder,
        };
      })
      .sort((left, right) => Number(left.queueOrder) - Number(right.queueOrder))
      .map(({ queueOrder: _queueOrder, ...entry }) => entry),
  ).toMatchInlineSnapshot(`
    - input: { name: 'Linus offline' }
      operation: 'createUser'
    - input: { itemId: 'temp:Linus offline', name: 'Linus edited' }
      operation: 'patchUserName'
  `);

  // Reconnect and drain replay. The create must run first, and the edit must
  // target the final payload produced by that create instead of the temp one.
  env.addTimelineComments('beforeNextAction', [
    'go back online and replay both queued mutations',
  ]);
  await act(async () => {
    network.goOnline();
    await Promise.resolve();
    await flushAllTimers();
    await Promise.resolve();
  });

  expect(replayedOperations).toMatchInlineSnapshot(`
    - input: { name: 'Linus offline' }
      operation: 'createUser'
    - input: { itemId: 'users||3', name: 'Linus edited' }
      operation: 'patchUserName'
  `);
  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus edited']
  `);
  expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
    id: 3
    name: 'Linus edited'
  `);
  expect(env.apiStore.getItemState('temp:Linus offline')).toBeNull();
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getOfflineQueueEntries(sessionKey, storeName)).toMatchInlineSnapshot(
    `[]`,
  );
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items               | query-status |
    0     | Ada, Grace                | success      | [query-status, query-items] ui-initialized
    10ms  | Ada, Grace                | error        | [query-status] ui-changed
    1.01s | Ada, Grace                | error        | -- queue a temp create while offline
    .     | Ada, Grace, Linus offline | error        | [query-items] ui-changed
    .     | Ada, Grace, Linus offline | error        | -- edit the same temp row before reconnecting
    .     | Ada, Grace, Linus edited  | error        | [query-items] ui-changed
    .     | Ada, Grace, Linus edited  | error        | -- go back online and replay both queued mutations
    .     | Ada, Grace, Linus edited  | error        | [query-items, query-items, query-items] ui-changed
    "
  `);

  hook.unmount();
});

test('repeatability: list-query invalidation keeps a pending patched row visible until replay settles', async () => {
  network.setOffline();
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'offline-overlay-patch-store',
      getSessionKey: () => 'offline-overlay-patch-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute: ({ input }) =>
                new Promise((resolve) => {
                  setTimeout(() => {
                    resolve({ name: input.name });
                  }, 2_000);
                }),
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Start from an optimistic pending row that is still waiting for replay.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada pending',
        }));
      },
      mutation: () => Promise.resolve({ name: 'Ada replayed' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada replayed' },
      },
    });
  });

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: { code: 0, id: 'offline', message: 'Offline' }
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada pending']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'error'
  `);

  // A refetch that finishes before replay should not blank or revert the row.
  act(() => {
    network.goOnline();
    env.scheduleFetch('highPriority', usersQuery);
  });
  await advanceTime(810);

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada pending']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);

  // Once replay succeeds, the derived overlay should disappear.
  await advanceTime(2_000);
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);

  hook.unmount();
});

test('repeatability: list-query invalidation keeps a pending temp row at its last known position', async () => {
  network.setOffline();
  let nextUserId = 3;
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateListQueryUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-overlay-create-store',
      getSessionKey: () => 'offline-overlay-create-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: ({ input }) =>
                new Promise((resolve) => {
                  setTimeout(() => {
                    resolve({ id: nextUserId, name: input.name });
                    nextUserId += 1;
                  }, 2_000);
                }),
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Add a temp row optimistically to the end of the list while offline.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus offline',
          { id: -1, name: 'Linus offline' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: { code: 0, id: 'offline', message: 'Offline' }
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace', 'Linus offline']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'error'
  `);

  // A stale refetch should keep the temp row visible in the same slot.
  act(() => {
    network.goOnline();
    env.scheduleFetch('highPriority', usersQuery);
  });
  await advanceTime(810);

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace', 'Linus offline']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);

  // After replay succeeds, the derived overlay disappears and the list falls
  // back to the last server-derived membership until another list refresh runs.
  await advanceTime(2_000);
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);
  expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
    id: 3
    name: 'Linus offline'
  `);

  hook.unmount();
});

test('repeatability: list-query overlay stops deriving temp rows once replay needs manual resolution', async () => {
  network.setOffline();
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateListQueryUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-overlay-resolution-store',
      getSessionKey: () => 'offline-overlay-resolution-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          replayRetry: { maxFailures: 1, intervalMs: 1 },
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: () => {
                  throw new Error('Should not reconcile after replay failure');
                },
              },
              execute: () => {
                throw new Error('Replay failed');
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Keep the temp row visible while it is still actively pending.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus blocked',
          { id: -1, name: 'Linus blocked' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () => Promise.resolve({ id: 3, name: 'Linus blocked' }),
      offline: { operation: 'createUser', input: { name: 'Linus blocked' } },
    });
  });

  act(() => {
    network.goOnline();
    env.scheduleFetch('highPriority', usersQuery);
  });
  await flushAllTimers();

  // Once the queue entry becomes a resolution, the derived row should disappear.
  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map(({ entityKey, requiresResolution, syncState }) => ({
        entityKey,
        requiresResolution,
        syncState,
      })),
  ).toMatchInlineSnapshot(`
    - entityKey: '"temp:Linus blocked'
      requiresResolution: '✅'
      syncState: 'resolution-required'
  `);

  hook.unmount();
});

test('list-query invalidation keeps a pending patched row visible until replay settles', async () => {
  network.setOffline();
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      id: 'offline-overlay-patch-store',
      getSessionKey: () => 'offline-overlay-patch-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              getEntityRefs: ({ input }) => [input.itemId],
              execute: ({ input }) =>
                new Promise((resolve) => {
                  setTimeout(() => {
                    resolve({ name: input.name });
                  }, 2_000);
                }),
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Start from an optimistic pending row that is still waiting for replay.
  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada pending',
        }));
      },
      mutation: () => Promise.resolve({ name: 'Ada replayed' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada replayed' },
      },
    });
  });

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: { code: 0, id: 'offline', message: 'Offline' }
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada pending']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'error'
  `);

  // A refetch that finishes before replay should not blank or revert the row.
  act(() => {
    network.goOnline();
    env.scheduleFetch('highPriority', usersQuery);
  });
  await advanceTime(810);

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada pending']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);

  // Once replay succeeds, the derived overlay should disappear.
  await advanceTime(2_000);
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);

  hook.unmount();
});

test('list-query invalidation keeps a pending temp row at its last known position', async () => {
  network.setOffline();
  let nextUserId = 3;
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateListQueryUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-overlay-create-store',
      getSessionKey: () => 'offline-overlay-create-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: ({ input }) =>
                new Promise((resolve) => {
                  setTimeout(() => {
                    resolve({ id: nextUserId, name: input.name });
                    nextUserId += 1;
                  }, 2_000);
                }),
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Add a temp row optimistically to the end of the list while offline.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus offline',
          { id: -1, name: 'Linus offline' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: { code: 0, id: 'offline', message: 'Offline' }
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace', 'Linus offline']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'error'
  `);

  // A stale refetch should keep the temp row visible in the same slot.
  act(() => {
    network.goOnline();
    env.scheduleFetch('highPriority', usersQuery);
  });
  await advanceTime(810);

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace', 'Linus offline']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);

  // After replay succeeds, the derived overlay disappears and the list falls
  // back to the last server-derived membership until another list refresh runs.
  await advanceTime(2_000);
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);
  expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
    id: 3
    name: 'Linus offline'
  `);

  hook.unmount();
});

test('list-query overlay stops deriving temp rows once replay needs manual resolution', async () => {
  network.setOffline();
  const usersQuery = { tableId: 'users' } as const;
  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateListQueryUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      id: 'offline-overlay-resolution-store',
      getSessionKey: () => 'offline-overlay-resolution-session',
      testScenario: { loaded: { queries: [usersQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          replayRetry: { maxFailures: 1, intervalMs: 1 },
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: () => {
                  throw new Error('Should not reconcile after replay failure');
                },
              },
              execute: () => {
                throw new Error('Replay failed');
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(usersQuery, {
      itemSelector: (item) => item.name,
    });

    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  // Keep the temp row visible while it is still actively pending.
  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus blocked',
          { id: -1, name: 'Linus blocked' },
          { addItemToQueries: { queries: [usersQuery], appendTo: 'end' } },
        );
      },
      mutation: () => Promise.resolve({ id: 3, name: 'Linus blocked' }),
      offline: { operation: 'createUser', input: { name: 'Linus blocked' } },
    });
  });

  act(() => {
    network.goOnline();
    env.scheduleFetch('highPriority', usersQuery);
  });
  await flushAllTimers();

  // Once the queue entry becomes a resolution, the derived row should disappear.
  expect(hook.result.current).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada', 'Grace']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '{tableId:"users"}'
    status: 'success'
  `);
  expect(
    env.apiStore
      .getOfflineEntities()
      .map(({ entityKey, requiresResolution, syncState }) => ({
        entityKey,
        requiresResolution,
        syncState,
      })),
  ).toMatchInlineSnapshot(`
    - entityKey: '"temp:Linus blocked'
      requiresResolution: '✅'
      syncState: 'resolution-required'
  `);

  hook.unmount();
});

test('type safety: list-query test env requires explicit offline operation typing', () => {
  const initialTables = { users: [{ id: 1, name: 'Ada' }] };
  const plainEnv = createListQueryStoreTestEnv(initialTables);
  const typedEnv = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    PatchUserOperations
  >(initialTables);

  function typeCheck_() {
    void plainEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      // @ts-expect-error - offline mutations should not be available by default
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada offline' },
      },
    });

    void plainEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      // @ts-expect-error - offline mutations should not be available by default
      offline: [
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued again' },
        },
      ],
    });

    void typedEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada offline' },
      },
    });

    void typedEnv.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      offline: [
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
        {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada queued again' },
        },
      ],
    });

    async function queuedOfflineResultType_() {
      const queued = await typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada offline' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
      });

      if (queued.ok) {
        const queuedValue:
          | { kind: 'online'; data: { name: string } }
          | { kind: 'queued' } = queued.value;
        void queuedValue;

        if (queued.value.kind === 'online') {
          const serverValue: { name: string } = queued.value.data;
          void serverValue;
        }

        // @ts-expect-error - queued offline mutations do not always expose a server payload directly
        const serverValue: { name: string } = queued.value.data;
        void serverValue;
      }
    }

    async function onlineResultType_() {
      const result = await typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada offline' }),
      });

      if (result.ok) {
        const serverValue: { name: string } = result.value;
        void serverValue;
      }
    }

    void queuedOfflineResultType_;
    void onlineResultType_;
  }

  void typeCheck_;
  expect(true).toBe(true);
});

test('list-query temp creates keep manually inserted query items visible after replay', async () => {
  network.setOffline();
  let nextUserId = 3;

  const env = createListQueryStoreTestEnv<
    { id: number; name: string },
    false,
    false,
    CreateListQueryUserOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      getSessionKey: () => 'offline-replay-temp-list-query-session',
      testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offlineMode: {
          network: network.config,
          operations: {
            createUser: {
              inputSchema: collectionCreateInputSchema,
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: ({ input }) => {
                const result = { id: nextUserId, name: input.name };
                nextUserId += 1;
                return result;
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const query = env.apiStore.useListQuery(
      { tableId: 'users' },
      { itemSelector: (item) => item.name },
    );
    env.trackItemUI('query-status', query.status);
    env.trackItemUI('query-items', query.items.join(', '));
    return query;
  });
  await flushAllTimers();

  await act(async () => {
    await env.apiStore.performMutation(null, {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus offline',
          { id: -1, name: 'Linus offline' },
          {
            addItemToQueries: {
              queries: [{ tableId: 'users' }],
              appendTo: 'end',
            },
          },
        );
      },
      mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });

  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus offline']
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: env.getStoreItemKeyFromRaw('temp:Linus offline'),
      pendingMutations: 1,
      storeType: 'listQuery',
    },
  ]);

  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(hook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace', 'Linus offline']
  `);
  expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
    id: 3
    name: 'Linus offline'
  `);
  expect(env.apiStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(
    env.serverTable.getRequestHistory('list', { includeTime: false }),
  ).toMatchInlineSnapshot(`[]`);
  expect(env.timelineString).toMatchInlineSnapshot(`
    "
    time  | query-items               | query-status |
    0     | Ada, Grace                | success      | [query-status, query-items] ui-initialized
    10ms  | Ada, Grace                | error        | [query-status] ui-changed
    1.01s | Ada, Grace, Linus offline | error        | [query-items, query-items, query-items] ui-changed
    "
  `);

  hook.unmount();
});
