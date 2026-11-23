import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
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
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'pending-offline-items-live',
        offlineSession: { network: network.config },
      }),
      testScenario: { loaded: { tables: ['users'] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
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

type FailingCreationOperations = DefineListQueryOfflineOperations<
  UserRow,
  ListQueryParams,
  string,
  { createUser: DefineOfflineOperation<{ name: string }, unknown, UserRow> }
>;

test('usePendingOfflineItems leaves out a failed creation, and does not list it as deleted once it is sent again', async () => {
  const env = createListQueryStoreTestEnv<
    UserRow,
    false,
    false,
    FailingCreationOperations
  >(
    { users: [{ id: 1, name: 'Ada' }] },
    {
      getSessionKey: () => 'pending-offline-items-failed-creation',
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => 'pending-offline-items-failed-creation',
        offlineSession: {
          network: network.config,
          replayRetry: { intervalMs: 1, maxFailures: 1 },
          classifyRetryableFailure: (error, ctx) =>
            ctx.phase === 'sync' && error instanceof Error,
        },
      }),
      testScenario: { loaded: { tables: ['users'] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: userRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
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
              execute: () => {
                throw new Error('create rejected');
              },
            },
          },
        },
      },
    },
  );

  const hook = renderHook(() =>
    env.apiStore.usePendingOfflineItems({ selector: (item) => item.name }),
  );
  const log: unknown[] = [];

  await flushAllTimers();

  // Create a user offline: it shows as a pending item.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  await act(async () => {
    await env.apiStore.performMutation('temp:Linus', {
      optimisticUpdate: () => {
        env.apiStore.addItemToState(
          'temp:Linus',
          { id: -1, name: 'Linus' },
          {
            addItemToQueries: {
              queries: [{ tableId: 'users' }],
              appendTo: 'end',
            },
          },
        );
      },
      mutation: () => {
        throw new Error('create rejected');
      },
      offline: { operation: 'createUser', input: { name: 'Linus' } },
    });
  });
  log.push({ phase: 'queued offline', ...hook.result.current });

  // Back online, the creation keeps failing until it waits for a decision:
  // it is removed locally and is no longer pending.
  act(() => {
    network.goOnline();
  });
  await withSuppressedActError(async () => {
    await flushAllTimers();
  });
  log.push({ phase: 'waits for a decision', ...hook.result.current });

  // The user sends it again while offline: it has no local data until it is
  // saved, so it is neither a pending item nor a pending delete.
  act(() => {
    network.goOffline();
  });
  await flushAllTimers();

  const [failedCreation] = env.apiStore.getOfflineResolutions();
  if (!failedCreation) throw new Error('expected a failed creation');
  await act(async () => {
    await env.apiStore.resolveOfflineResolution(
      failedCreation.id,
      'createUser',
      { action: 'retry' },
    );
  });
  await flushAllTimers();
  log.push({ phase: 'sent again offline', ...hook.result.current });

  expect(log).toMatchInlineSnapshot(`
    - deletedItems: []
      items: ['Linus']
      phase: 'queued offline'
    - deletedItems: []
      items: []
      phase: 'waits for a decision'
    - deletedItems: []
      items: []
      phase: 'sent again offline'
  `);
});
