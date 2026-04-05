import { renderHook } from '@testing-library/react';
import { act } from 'react';
import {
  rc_array,
  rc_literals,
  rc_number,
  rc_object,
  rc_string,
} from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  createOfflineSession,
  createListQueryStore,
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
} from '../../src/main';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

const userSchema = rc_object({ id: rc_number, name: rc_string });
const userInputSchema = rc_object({ id: rc_number, name: rc_string });
const renameManyUsersInputSchema = rc_array(userInputSchema);
const createUserInputSchema = rc_object({ name: rc_string });
const userConflictSchema = rc_object({ reason: rc_string });
const usersQueryPayloadSchema = rc_object({ tableId: rc_literals('users') });
const userPayloadSchema = z.union([
  z.string(),
  z.object({ tableId: z.literal('users'), id: z.number() }),
]);
const conflictResolutionSchema = z.object({ name: z.string() });
const FETCH_DELAY_MS = 30;

type UsersQueryPayload = { tableId: 'users' };

type User = { id: number; name: string };
type RenameUserInput = { id: number; name: string };
type CreateUserInput = { name: string };
type UserConflict = { reason: string };

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type UserPayload = { tableId: 'users'; id: number } | string;

function getUserItemPayload(id: number): Extract<UserPayload, { id: number }> {
  return { tableId: 'users', id };
}

function getUserEntityKey(id: number) {
  return JSON.stringify(['users', id]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

const validListQueryTempEntity: NonNullable<
  DirectListQueryOfflineOperations['createUser']['tempEntity']
> = {
  buildPendingEntity: (input, tempId) => ({
    id: typeof tempId === 'string' ? -1 : tempId.id,
    name: input.name,
  }),
  reconcileServerEntity: (result, tempId) => ({
    finalPayload:
      typeof tempId === 'string' ? getUserItemPayload(result.id) : tempId,
    finalData: { ...result },
  }),
};

void validListQueryTempEntity;

const invalidListQueryPendingTempEntity: NonNullable<
  DirectListQueryOfflineOperations['createUser']['tempEntity']
> = {
  // @ts-expect-error - buildPendingEntity must return User
  buildPendingEntity: (input) => ({ name: input.name }),
  reconcileServerEntity: (result) => ({
    finalPayload: getUserItemPayload(result.id),
    finalData: { ...result },
  }),
};

void invalidListQueryPendingTempEntity;

const invalidListQueryFinalPayloadTempEntity: NonNullable<
  DirectListQueryOfflineOperations['createUser']['tempEntity']
> = {
  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
  reconcileServerEntity: (result) => ({
    // @ts-expect-error - finalPayload must match UserPayload
    finalPayload: 123,
    finalData: { ...result },
  }),
};

void invalidListQueryFinalPayloadTempEntity;

const invalidListQueryFinalDataTempEntity: NonNullable<
  DirectListQueryOfflineOperations['createUser']['tempEntity']
> = {
  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
  reconcileServerEntity: (result) => ({
    finalPayload: getUserItemPayload(result.id),
    // @ts-expect-error - finalData must match User
    finalData: { name: result.name },
  }),
};

void invalidListQueryFinalDataTempEntity;

type DirectListQueryOfflineOperations = DefineListQueryOfflineOperations<
  User,
  UsersQueryPayload,
  UserPayload,
  {
    renameUser: DefineOfflineOperation<RenameUserInput>;
    renameManyUsers: DefineOfflineOperation<RenameUserInput[]>;
    skipSyncUser: DefineOfflineOperation<RenameUserInput>;
    conflictUser: DefineOfflineOperation<RenameUserInput, UserConflict>;
    createUser: DefineOfflineOperation<CreateUserInput, unknown, User>;
  }
>;

// tests using the list-query store directly without test envs to verify the public API usage
test('direct list-query store offline public api', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-list-query-offline-session';
  network.install();
  const offlineSession = createOfflineSession({
    getSessionKey: () => sessionKey,
    config: { network: network.config },
  });

  let nextUserId = 3;
  const userState = new Map<number, User>([
    [1, { id: 1, name: 'Ada' }],
    [2, { id: 2, name: 'Grace' }],
  ]);

  const listQueryStore = createListQueryStore<
    User,
    UsersQueryPayload,
    UserPayload,
    false,
    false,
    DirectListQueryOfflineOperations
  >({
    id: 'direct-list-query-offline',
    getSessionKey: () => sessionKey,
    fetchListFn: async (_payload_, size: number) => {
      await delay(FETCH_DELAY_MS);
      return {
        items: [...userState.values()]
          .slice(0, size)
          .map((user) => ({
            itemPayload: getUserItemPayload(user.id),
            data: { ...user },
          })),
        hasMore: userState.size > size,
      };
    },
    fetchItemFn: async (payload: UserPayload) => {
      await delay(FETCH_DELAY_MS);
      if (typeof payload === 'string') {
        throw new Error(`Missing user ${payload}`);
      }

      const item = userState.get(payload.id);
      if (!item) {
        throw new Error(`Missing user ${payload.id}`);
      }
      return { ...item };
    },
    getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
    getItemKey: (payload: UserPayload) =>
      typeof payload === 'string' ? payload : getUserEntityKey(payload.id),
    errorNormalizer: normalizeError,
    defaultQuerySize: 3,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      adapter: 'local-sync',
      schema: userSchema,
      itemPayloadSchema: userPayloadSchema,
      queryPayloadSchema: usersQueryPayloadSchema,
      offline: {
        session: offlineSession,
        operations: {
          renameUser: {
            inputSchema: userInputSchema,
            getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute: ({ input }) => {
              userState.set(input.id, { id: input.id, name: input.name });
              listQueryStore.updateItemState(
                getUserItemPayload(input.id),
                (item) => ({ ...item, name: input.name }),
              );
            },
          },
          renameManyUsers: {
            inputSchema: renameManyUsersInputSchema,
            getEntityRefs: ({ input }) =>
              input.map((item) => getUserItemPayload(item.id)),
            execute: ({ input }) => {
              for (const item of input) {
                userState.set(item.id, { id: item.id, name: item.name });
                listQueryStore.updateItemState(
                  getUserItemPayload(item.id),
                  (currentItem) => ({ ...currentItem, name: item.name }),
                );
              }
            },
          },
          skipSyncUser: {
            inputSchema: userInputSchema,
            getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
            execute: ({ input }) => {
              throw new Error(`dispatch failed after send ${input.name}`);
            },
            shouldSkipSync: ({ input, enqueuedAt, updatedAt }) => {
              expect(input).toMatchInlineSnapshot(`
                id: 1
                name: 'Ada skip'
              `);
              expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
              return true;
            },
          },
          conflictUser: {
            inputSchema: userInputSchema,
            getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
            conflictHandling: {
              schema: userConflictSchema,
              detectConflict: ({ input, enqueuedAt, updatedAt }) => {
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                if (input.name !== 'Ada conflict') return false;
                return { reason: 'server-changed' };
              },
            },
            execute: ({ input }) => {
              userState.set(input.id, { id: input.id, name: input.name });
              listQueryStore.updateItemState(
                getUserItemPayload(input.id),
                (item) => ({ ...item, name: input.name }),
              );
            },
          },
          createUser: {
            inputSchema: createUserInputSchema,
            getEntityRefs: ({ input }) => [`temp:${input.name}`],
            tempEntity: {
              buildPendingEntity: (input) => ({ id: -1, name: input.name }),
              reconcileServerEntity: (result) => ({
                finalPayload: getUserItemPayload(result.id),
                finalData: { ...result },
              }),
            },
            execute: ({ input }) => {
              const result = { id: nextUserId, name: input.name };
              nextUserId += 1;
              userState.set(result.id, result);
              return result;
            },
          },
        },
      },
    },
  });

  const queryPayload = { tableId: 'users' as const };
  const userOnePayload = getUserItemPayload(1);
  const userTwoPayload = getUserItemPayload(2);

  const listHook = renderHook(() =>
    listQueryStore.useListQuery(queryPayload, {
      loadSize: 3,
      itemSelector: (item) => item.name,
    }),
  );
  const multiHook = renderHook(() =>
    listQueryStore.useMultipleListQueries(
      [{ payload: queryPayload, loadSize: 3 }],
      { itemSelector: (item) => item.name },
    ),
  );
  await flushAllTimers();

  expect(
    pick(listHook.result.current, ['items', 'payload', 'queryKey', 'status']),
  ).toMatchInlineSnapshot(`
    items: ['Ada', 'Grace']
    payload: { tableId: 'users' }
    queryKey: '["users"]'
    status: 'success'
  `);

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-list-query-offline-session'
    updatedAt: 1735689600010
  `);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await act(async () => {
    await listQueryStore.performMutation(userOnePayload, {
      optimisticUpdate: (payload) => {
        if (Array.isArray(payload) || typeof payload === 'function') return;
        listQueryStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Ada first',
        }));
      },
      mutation: () => Promise.resolve({ id: 1, name: 'Ada first' }),
      offline: { operation: 'renameUser', input: { id: 1, name: 'Ada first' } },
    });
  });

  const multiRenameResult = await act(async () => {
    return listQueryStore.performMutation(userOnePayload, {
      optimisticUpdate: () => {
        listQueryStore.updateItemState(userOnePayload, (item) => ({
          ...item,
          name: 'Ada second',
        }));
        listQueryStore.updateItemState(userTwoPayload, (item) => ({
          ...item,
          name: 'Grace offline',
        }));
      },
      mutation: () => Promise.resolve({ ok: true }),
      offline: {
        operation: 'renameManyUsers',
        input: [
          { id: 1, name: 'Ada second' },
          { id: 2, name: 'Grace offline' },
        ],
      },
    });
  });

  expect({
    ok: multiRenameResult.ok,
    value: multiRenameResult.ok ? multiRenameResult.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { kind: 'queued' }
  `);

  await act(async () => {
    await listQueryStore.performMutation(userOnePayload, {
      optimisticUpdate: (payload) => {
        if (Array.isArray(payload) || typeof payload === 'function') return;
        listQueryStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Ada skip',
        }));
      },
      mutation: () => Promise.resolve({ id: 1, name: 'Ada skip' }),
      offline: {
        operation: 'skipSyncUser',
        input: { id: 1, name: 'Ada skip' },
      },
    });
  });

  await act(async () => {
    await listQueryStore.performMutation(userOnePayload, {
      optimisticUpdate: (payload) => {
        if (Array.isArray(payload) || typeof payload === 'function') return;
        listQueryStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Ada conflict',
        }));
      },
      mutation: () => Promise.resolve({ id: 1, name: 'Ada conflict' }),
      offline: {
        operation: 'conflictUser',
        input: { id: 1, name: 'Ada conflict' },
      },
    });
  });

  await act(async () => {
    await listQueryStore.performMutation('__create__', {
      mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
      offline: { operation: 'createUser', input: { name: 'Linus offline' } },
    });
  });
  await Promise.resolve();

  expect(listQueryStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  await listQueryStore.resolveOfflineResolution('missing', 'conflictUser', {
    action: 'discard',
  });
  expect(pick(listHook.result.current, ['items', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      items: ['Ada conflict', 'Grace offline']
      pendingSync: '✅'
      status: 'success'
    `);
  const firstQuery = multiHook.result.current[0];

  expect(firstQuery).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada conflict', 'Grace offline']
    payload: { tableId: 'users' }
    pendingSync: '✅'
    queryKey: '["users"]'
    status: 'success'
  `);

  expect(listQueryStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689602000
      entityKey: '"["users",1]'
      entityKind: 'item'
      id: 'direct-list-query-offline-session:direct-list-query-offline:"["users",1]'
      pendingMutations: 4
      requiresResolution: '❌'
      sessionKey: 'direct-list-query-offline-session'
      storeName: 'direct-list-query-offline'
      storeType: 'listQuery'
      syncState: 'pending'
      updatedAt: 1735689602000
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689602000
      entityKey: '"["users",2]'
      entityKind: 'item'
      id: 'direct-list-query-offline-session:direct-list-query-offline:"["users",2]'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'direct-list-query-offline-session'
      storeName: 'direct-list-query-offline'
      storeType: 'listQuery'
      syncState: 'pending'
      updatedAt: 1735689602000
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689602000
      entityKey: '"temp:Linus offline'
      entityKind: 'item'
      id: 'direct-list-query-offline-session:direct-list-query-offline:"temp:Linus offline'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'direct-list-query-offline-session'
      storeName: 'direct-list-query-offline'
      storeType: 'listQuery'
      syncState: 'pending'
      tempId: 'temp:Linus offline'
      updatedAt: 1735689602000
  `);
  expect(getGlobalOfflineEntities(sessionKey)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ storeName: 'direct-list-query-offline' }),
    ]),
  );

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-list-query-offline-session'
    updatedAt: 1735689602000
  `);

  await act(async () => {
    network.goOnline();
    await advanceTime(250);
    await flushAllTimers();
  });

  const [conflict] = listQueryStore.getOfflineResolutions();
  if (
    !conflict ||
    conflict.kind !== 'conflict' ||
    conflict.operation !== 'conflictUser'
  ) {
    throw new Error('Expected a conflict resolution');
  }

  expect({
    ...pick(conflict, [
      'blockedByResolutionIds',
      'blockedResolutionCount',
      'childResolutionCount',
      'childResolutionIds',
      'createdAt',
      'enqueuedAt',
      'entityRefs',
      'input',
      'kind',
      'operation',
      'sessionKey',
      'storeName',
      'storeType',
      'updatedAt',
    ]),
    conflict: conflict.conflict,
  }).toMatchInlineSnapshot(`
    blockedByResolutionIds: []
    blockedResolutionCount: 0
    childResolutionCount: 0
    childResolutionIds: []
    conflict: { reason: 'server-changed' }
    createdAt: 1735689607000
    enqueuedAt: 1735689602000
    entityRefs:
      - entityKey: '"["users",1]'
        entityKind: 'item'
    input: { id: 1, name: 'Ada conflict' }
    kind: 'conflict'
    operation: 'conflictUser'
    sessionKey: 'direct-list-query-offline-session'
    storeName: 'direct-list-query-offline'
    storeType: 'listQuery'
    updatedAt: 1735689607000
  `);
  const parsedConflict =
    listQueryStore.parseOfflineResolutionConflict(conflict);
  expect({
    ok: parsedConflict.ok,
    value: parsedConflict.ok ? parsedConflict.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { reason: 'server-changed' }
  `);

  expect(listQueryStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689607000
      entityKey: '"["users",1]'
      entityKind: 'item'
      id: 'direct-list-query-offline-session:direct-list-query-offline:"["users",1]'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'direct-list-query-offline-session'
      storeName: 'direct-list-query-offline'
      storeType: 'listQuery'
      syncState: 'resolution-required'
      updatedAt: 1735689607000
  `);

  const createdUserHook = renderHook(() =>
    listQueryStore.useItem(getUserItemPayload(3)),
  );
  await flushAllTimers();
  expect(
    pick(createdUserHook.result.current, ['data', 'status', 'pendingSync']),
  ).toMatchInlineSnapshot(`
    data: { id: 3, name: 'Linus offline' }
    pendingSync: '❌'
    status: 'success'
  `);

  await act(async () => {
    await listQueryStore.resolveOfflineResolution(conflict.id, 'conflictUser', {
      action: 'requeue',
      input: {
        id: 1,
        name: conflictResolutionSchema.parse({ name: 'Ada resolved' }).name,
      },
    });
    await flushAllTimers();
  });

  expect(listQueryStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(listQueryStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(pick(listHook.result.current, ['items', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      items: ['Ada resolved', 'Grace offline']
      pendingSync: '❌'
      status: 'success'
    `);

  expect(multiHook.result.current[0]).toMatchInlineSnapshot(`
    error: null
    hasMore: '❌'
    isLoading: '❌'
    isLoadingMore: '❌'
    items: ['Ada resolved', 'Grace offline']
    payload: { tableId: 'users' }
    pendingSync: '❌'
    queryKey: '["users"]'
    status: 'success'
  `);

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-list-query-offline-session'
    updatedAt: 1735689608010
  `);

  listHook.unmount();
  multiHook.unmount();
  createdUserHook.unmount();
});
