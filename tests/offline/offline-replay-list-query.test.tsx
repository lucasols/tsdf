import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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

  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    input: { itemId: 'users||1', name: 'Ada replayed' },
  });
  expect(execute.mock.calls[0]?.[0]?.enqueuedAt).toBeGreaterThan(
    TEST_INITIAL_TIME,
  );
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
    1.01s | Ada, Grace, Linus offline | error        | [query-items] ui-changed
    "
  `);

  hook.unmount();
});
