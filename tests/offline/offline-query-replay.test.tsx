import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
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

describe('list-query replay', () => {
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
});
