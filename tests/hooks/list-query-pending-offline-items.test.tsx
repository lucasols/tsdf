import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  createOfflineSession,
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
  type ListQueryOfflineOperationDefinition,
} from '../../src/main';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  deleteItemInputSchema,
  userPatchSchema,
  userRowSchema,
} from '../offline/offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
} from '../offline/offlineTestShared';
import { flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { withSuppressedActError } from '../utils/withSuppressedActError';

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

type UserRow = { id: number; name: string };

type PendingOfflineItemsOperations = DefineListQueryOfflineOperations<
  UserRow,
  ListQueryParams,
  string,
  {
    patchUserName: DefineOfflineOperation<{ itemId: string; name: string }>;
    createUser: DefineOfflineOperation<{ name: string }, unknown, UserRow>;
    deleteUser: DefineOfflineOperation<{ itemId: string }>;
  }
>;

test('usePendingOfflineItems exposes visible queued items, pending deletes, filters, and clears after replay', async () => {
  let nextUserId = 3;
  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    PendingOfflineItemsOperations
  >(
    {
      users: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    },
    {
      getSessionKey: () => 'pending-offline-items-live',
      testScenario: { loaded: { tables: ['users'] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'pending-offline-items-live',
            config: { network: network.config },
          }),
          operations: {
            patchUserName: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem(input.itemId, {
                  id: Number(input.itemId.split('||')[1]),
                  name: input.name,
                });
                return { name: input.name };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
            },
            createUser: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `users||${result.id}`,
                  finalData: result,
                }),
              },
              execute: async ({ input }) => {
                const data = { id: nextUserId, name: input.name };
                nextUserId += 1;
                await env.serverTable.delayedSetItem(`users||${data.id}`, data);
                return data;
              },
            },
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedRemoveItem(input.itemId);
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const pending = env.apiStore.usePendingOfflineItems({
      selector: (item) => item.name,
    });
    const tempOnly = env.apiStore.usePendingOfflineItems({
      selector: (item) => item.name,
      filterPayload: (payload) => payload.startsWith('temp:'),
    });

    return { pending, tempOnly };
  });

  await flushAllTimers();

  // Queue all three user-facing offline cases: one visible edit, one temp
  // create, and one delete that should move into `deletedItems`.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada queued',
        }));
      },
      mutation: async () => {
        await env.serverTable.delayedSetItem('users||1', {
          id: 1,
          name: 'Ada queued',
        });
        return { name: 'Ada queued' };
      },
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada queued' },
      },
    });
  });
  await act(async () => {
    await env.apiStore.performMutation(null, {
      mutation: async () => {
        const data = { id: nextUserId, name: 'Linus offline' };
        nextUserId += 1;
        await env.serverTable.delayedSetItem(`users||${data.id}`, data);
        return data;
      },
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });
  await act(async () => {
    await env.apiStore.performMutation('users||2', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||2');
      },
      mutation: async () => {
        await env.serverTable.delayedRemoveItem('users||2');
      },
      offline: { operation: 'deleteUser', input: { itemId: 'users||2' } },
    });
  });
  await Promise.resolve();

  // The main hook should surface visible item data plus deleted payloads, and
  // the filtered hook should narrow the result using only item payloads.
  expect({
    pending: {
      items: [...hook.result.current.pending.items].sort(),
      deletedItems: [...hook.result.current.pending.deletedItems].sort(),
    },
    tempOnly: {
      items: [...hook.result.current.tempOnly.items].sort(),
      deletedItems: hook.result.current.tempOnly.deletedItems,
    },
  }).toMatchInlineSnapshot(`
    pending:
      deletedItems: ['users||2']
      items: ['Ada queued', 'Linus offline']

    tempOnly:
      deletedItems: []
      items: ['Linus offline']
  `);

  // Once replay finishes successfully, the hook should empty back out.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(hook.result.current.pending).toMatchInlineSnapshot(`
    deletedItems: []
    items: []
  `);
});

type ResolutionRequiredItemsOperations = {
  conflictUser: ListQueryOfflineOperationDefinition<
    UserRow,
    ListQueryParams,
    string,
    { itemId: string; name: string },
    { reason: string }
  >;
};

test('usePendingOfflineItems can opt resolution-required visible items back in', async () => {
  const conflictSchema = rc_object({ reason: rc_string });
  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    ResolutionRequiredItemsOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'pending-offline-items-resolution-item',
      testScenario: { loaded: { tables: ['users'] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'pending-offline-items-resolution-item',
            config: { network: network.config },
          }),
          operations: {
            conflictUser: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem(input.itemId, {
                  id: 1,
                  name: input.name,
                });
                return { name: input.name };
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.updateItemState(input.itemId, (item) => ({
                  ...item,
                  name: input.name,
                }));
              },
              conflictHandling: {
                schema: conflictSchema,
                detectConflict: () => ({ reason: 'server-changed' }),
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const defaultPending = env.apiStore.usePendingOfflineItems({
      selector: (item) => item.name,
    });
    const includeResolutionRequired = env.apiStore.usePendingOfflineItems({
      selector: (item) => item.name,
      includeResolutionRequired: true,
    });

    return { defaultPending, includeResolutionRequired };
  });

  await flushAllTimers();

  // Queue a visible edit offline so replay can later convert it into a
  // resolution-required item without losing the optimistic row.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.updateItemState('users||1', (item) => ({
          ...item,
          name: 'Ada conflict',
        }));
      },
      mutation: async () => {
        await env.serverTable.delayedSetItem('users||1', {
          id: 1,
          name: 'Ada conflict',
        });
        return { name: 'Ada conflict' };
      },
      offline: {
        operation: 'conflictUser',
        input: { itemId: 'users||1', name: 'Ada conflict' },
      },
    });
  });

  // Replay should move the entity into manual resolution, which the default
  // hook hides while the opt-in hook keeps visible.
  act(() => {
    network.goOnline();
  });
  await flushAllTimers();

  expect(hook.result.current).toMatchInlineSnapshot(`
    defaultPending:
      deletedItems: []
      items: []

    includeResolutionRequired:
      deletedItems: []
      items: ['Ada']
  `);
});

type ResolutionRequiredDeletesOperations = DefineListQueryOfflineOperations<
  UserRow,
  ListQueryParams,
  string,
  { deleteUser: DefineOfflineOperation<{ itemId: string }> }
>;

test('usePendingOfflineItems can opt resolution-required deletes back into deletedItems', async () => {
  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    ResolutionRequiredDeletesOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'pending-offline-items-resolution-delete',
      testScenario: { loaded: { tables: ['users'] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          session: createOfflineSession({
            getSessionKey: () => 'pending-offline-items-resolution-delete',
            config: {
              network: network.config,
              replayRetry: { intervalMs: 1, maxFailures: 1 },
              classifyRetryableFailure: (error, ctx) =>
                ctx.phase === 'sync' && error instanceof Error,
            },
          }),
          operations: {
            deleteUser: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: () => {
                throw new Error('delete failed');
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() => {
    const defaultPending = env.apiStore.usePendingOfflineItems();
    const includeResolutionRequired = env.apiStore.usePendingOfflineItems({
      includeResolutionRequired: true,
    });

    return { defaultPending, includeResolutionRequired };
  });

  await flushAllTimers();

  // Start from a normal pending delete so replay has something to exhaust.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  await act(async () => {
    await env.apiStore.performMutation('users||1', {
      optimisticUpdate: () => {
        env.apiStore.deleteItemState('users||1');
      },
      mutation: () => {
        throw new Error('delete failed');
      },
      offline: { operation: 'deleteUser', input: { itemId: 'users||1' } },
    });
  });

  // Bring the browser back online and let the first retryable replay failure
  // spend the whole retry budget so the delete moves into manual resolution.
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await flushAllTimers();
  });

  expect(hook.result.current).toMatchInlineSnapshot(`
    defaultPending:
      deletedItems: []
      items: []

    includeResolutionRequired:
      deletedItems: ['users||1']
      items: []
  `);
});
