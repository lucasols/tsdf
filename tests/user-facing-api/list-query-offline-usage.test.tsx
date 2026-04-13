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
  createListQueryStore,
  createStoreManager,
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
} from '../../src/main';
import { createServerTableMock } from '../mocks/serverTableMock';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { withSuppressedActError } from '../utils/withSuppressedActError';

const userSchema = rc_object({ id: rc_number, name: rc_string });
const userInputSchema = rc_object({ id: rc_number, name: rc_string });
const renameManyUsersInputSchema = rc_array(userInputSchema);
const createUserInputSchema = rc_object({ name: rc_string });
const deleteUserInputSchema = rc_object({ id: rc_number });
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

function getUserServerItemId(id: number) {
  return `users||${id}`;
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
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
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

type InvalidListQueryTempSuccessOperations = DefineListQueryOfflineOperations<
  User,
  UsersQueryPayload,
  UserPayload,
  { createUser: DefineOfflineOperation<CreateUserInput, unknown, User> }
>;

// @ts-expect-error - tempEntity operations cannot configure accumulation
const invalidListQueryAccumulationTempEntity: NonNullable<
  DirectListQueryOfflineOperations['createUser']
> = {
  inputSchema: createUserInputSchema,
  kind: 'create',
  getEntityRefs: ({ input }) => [`temp:${input.name}`],
  accumulation: {
    mergeInput: ({ incomingInput }: { incomingInput: CreateUserInput }) =>
      incomingInput,
  },
  tempEntity: {
    buildPendingEntity: (input) => ({ id: -1, name: input.name }),
    reconcileServerEntity: (result) => ({
      finalPayload: getUserItemPayload(result.id),
      finalData: { ...result },
    }),
  },
  execute: ({ input }) => ({ id: 3, name: input.name }),
};

void invalidListQueryAccumulationTempEntity;

// tests using the list-query store directly without test envs to verify the public API usage
test('direct list-query store offline public api', async () => {
  await withSuppressedActError(async () => {
    const network = createOfflineNetworkMock();
    const sessionKey = 'direct-list-query-offline-session';
    network.install();
    const storeManager = createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: { network: network.config },
    });

    let nextUserId = 3;
    const serverTable = createServerTableMock<User>({
      [getUserServerItemId(1)]: { id: 1, name: 'Ada' },
      [getUserServerItemId(2)]: { id: 2, name: 'Grace' },
    });

    const listQueryStore = createListQueryStore<
      User,
      UsersQueryPayload,
      UserPayload,
      false,
      false,
      DirectListQueryOfflineOperations
    >({
      id: 'direct-list-query-offline',
      storeManager,
      fetchListFn: async (_payload_, size: number) => {
        await delay(FETCH_DELAY_MS);
        const listResult = serverTable.listSync({
          tableId: 'users',
          limit: size,
        });
        return {
          items: listResult.items.map(({ data }) => ({
            itemPayload: getUserItemPayload(data.id),
            data: { ...data },
          })),
          hasMore: listResult.hasMore,
        };
      },
      fetchItemFn: async (payload: UserPayload) => {
        await delay(FETCH_DELAY_MS);
        if (typeof payload === 'string') {
          throw new Error(`Missing user ${payload}`);
        }

        const item = serverTable.get(getUserServerItemId(payload.id));
        if (!item) {
          throw new Error(`Missing user ${payload.id}`);
        }
        return { ...item };
      },
      getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
      getItemKey: (payload: UserPayload) =>
        typeof payload === 'string' ? payload : getUserEntityKey(payload.id),
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
          operations: {
            renameUser: {
              inputSchema: userInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
              accumulation: {
                mergeInput: ({ incomingInput }) => incomingInput,
              },
              execute: ({ input }) => {
                serverTable.updateItem(getUserServerItemId(input.id), {
                  id: input.id,
                  name: input.name,
                });
              },
              onSuccessExecute: ({ input }) => {
                listQueryStore.updateItemState(
                  getUserItemPayload(input.id),
                  (item) => ({ ...item, name: input.name }),
                );
              },
            },
            renameManyUsers: {
              inputSchema: renameManyUsersInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) =>
                input.map((item) => getUserItemPayload(item.id)),
              execute: ({ input }) => {
                for (const item of input) {
                  serverTable.updateItem(getUserServerItemId(item.id), {
                    id: item.id,
                    name: item.name,
                  });
                }
              },
              onSuccessExecute: ({ input }) => {
                for (const item of input) {
                  listQueryStore.updateItemState(
                    getUserItemPayload(item.id),
                    (currentItem) => ({ ...currentItem, name: item.name }),
                  );
                }
              },
            },
            skipSyncUser: {
              inputSchema: userInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
              execute: ({ input }) => {
                throw new Error(`dispatch failed after send ${input.name}`);
              },
              onSuccessExecute: ({ input }) => {
                listQueryStore.updateItemState(
                  getUserItemPayload(input.id),
                  (item) => ({ ...item, name: input.name }),
                );
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
              kind: 'update',
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
                serverTable.updateItem(getUserServerItemId(input.id), {
                  id: input.id,
                  name: input.name,
                });
              },
              onSuccessExecute: ({ input }) => {
                listQueryStore.updateItemState(
                  getUserItemPayload(input.id),
                  (item) => ({ ...item, name: input.name }),
                );
              },
            },
            createUser: {
              inputSchema: createUserInputSchema,
              kind: 'create',
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
                serverTable.setItem(getUserServerItemId(result.id), result);
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

    const invalidTempSuccessServerTable = createServerTableMock<User>({});
    const invalidTempSuccessListQueryStore = createListQueryStore<
      User,
      UsersQueryPayload,
      UserPayload,
      false,
      false,
      InvalidListQueryTempSuccessOperations
    >({
      id: 'invalid-temp-success-callback-list-query',
      storeManager,
      fetchListFn: () => Promise.resolve({ items: [], hasMore: false }),
      fetchItemFn: () => Promise.resolve({ id: 1, name: 'Ada' }),
      getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
      getItemKey: (payload: UserPayload) =>
        typeof payload === 'string' ? payload : getUserEntityKey(payload.id),
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
          operations: {
            // @ts-expect-error - runtime validation should reject tempEntity plus success callback
            createUser: {
              inputSchema: createUserInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }: { input: CreateUserInput }) => [
                `temp:${input.name}`,
              ],
              tempEntity: {
                buildPendingEntity: (input: CreateUserInput) => ({
                  id: -1,
                  name: input.name,
                }),
                reconcileServerEntity: (result: User) => ({
                  finalPayload: getUserItemPayload(result.id),
                  finalData: { ...result },
                }),
              },
              execute: ({ input }: { input: CreateUserInput }) => {
                invalidTempSuccessServerTable.setItem(getUserServerItemId(3), {
                  id: 3,
                  name: input.name,
                });
                return { id: 3, name: input.name };
              },
              onSuccessExecute: ({ input }) => {
                listQueryStore.addItemToState(getUserItemPayload(3), {
                  id: 3,
                  name: input.name,
                });
              },
            },
          },
        },
      },
    });
    act(() => {
      network.goOffline();
    });
    await Promise.resolve();

    const invalidTempSuccessResult =
      await invalidTempSuccessListQueryStore.performMutation(null, {
        mutation: () => Promise.resolve({ id: 3, name: 'Invalid temp' }),
        offline: { operation: 'createUser', input: { name: 'Invalid temp' } },
      });

    expect({
      error: invalidTempSuccessResult.ok
        ? null
        : invalidTempSuccessResult.error,
      ok: invalidTempSuccessResult.ok,
    }).toMatchInlineSnapshot(`
      error{Error}:
        message: 'Offline operation "createUser" cannot configure onSuccessExecute when tempEntity or tempEntities is present'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#:
            message: 'Offline operation "createUser" cannot configure onSuccessExecute when tempEntity or tempEntities is present'
            name: 'Error'

      ok: '❌'
    `);

    act(() => {
      network.goOnline();
    });
    await Promise.resolve();

    expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
      isLeader: '✅'
      isOfflineMode: '❌'
      lastFailureAt: null
      lastRecoveryCheckAt: null
      network: { active: '❌', enabled: '✅' }
      outage: { active: '❌', enabled: '❌' }
      sessionKey: 'direct-list-query-offline-session'
      updatedAt: 1735689602000
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
        offline: {
          operation: 'renameUser',
          input: { id: 1, name: 'Ada first' },
        },
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
      await listQueryStore.performMutation(null, {
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
      isDerived: '❌'
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
        kind: 'update'
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
        kind: 'update'
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
        kind: 'create'
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
        kind: 'update'
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
      await listQueryStore.resolveOfflineResolution(
        conflict.id,
        'conflictUser',
        {
          action: 'requeue',
          input: {
            id: 1,
            name: conflictResolutionSchema.parse({ name: 'Ada resolved' }).name,
          },
        },
      );
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
      isDerived: '❌'
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
});

type DirectListQueryDeleteOfflineOperations = DefineListQueryOfflineOperations<
  User,
  UsersQueryPayload,
  UserPayload,
  { deleteUser: DefineOfflineOperation<{ id: number }> }
>;

test('usePendingOfflineItems restores deleted object payloads after offline restart', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-list-query-pending-delete-session';
  const storeId = 'direct-list-query-pending-delete';
  network.install();

  const createStore = () => {
    const storeManager = createStoreManager({
      getSessionKey: () => sessionKey,
      errorNormalizer: normalizeError,
      offlineSession: { network: network.config },
    });

    return createListQueryStore<
      User,
      UsersQueryPayload,
      UserPayload,
      false,
      false,
      DirectListQueryDeleteOfflineOperations
    >({
      id: storeId,
      storeManager,
      fetchListFn: async (_payload_, size: number) => {
        await delay(FETCH_DELAY_MS);
        const listResult = serverTable.listSync({
          tableId: 'users',
          limit: size,
        });
        return {
          items: listResult.items.map(({ data }) => ({
            itemPayload: getUserItemPayload(data.id),
            data: { ...data },
          })),
          hasMore: listResult.hasMore,
        };
      },
      fetchItemFn: async (payload: UserPayload) => {
        await delay(FETCH_DELAY_MS);
        if (typeof payload === 'string') {
          throw new Error(`Missing user ${payload}`);
        }

        const item = serverTable.get(getUserServerItemId(payload.id));
        if (!item) {
          throw new Error(`Missing user ${payload.id}`);
        }
        return { ...item };
      },
      getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
      getItemKey: (payload: UserPayload) =>
        typeof payload === 'string' ? payload : getUserEntityKey(payload.id),
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
          operations: {
            deleteUser: {
              inputSchema: deleteUserInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
              execute: ({ input }) => {
                serverTable.removeItem(getUserServerItemId(input.id));
              },
              onSuccessExecute: ({ input }) => {
                listQueryStore.deleteItemState(getUserItemPayload(input.id));
              },
            },
          },
        },
      },
    });
  };

  const serverTable = createServerTableMock<User>({
    [getUserServerItemId(1)]: { id: 1, name: 'Ada' },
    [getUserServerItemId(2)]: { id: 2, name: 'Grace' },
  });
  let listQueryStore = createStore();
  const queryPayload = { tableId: 'users' as const };
  const userOnePayload = getUserItemPayload(1);

  // Load the list once so persistence can later restore the deleted item from
  // offline metadata without needing a mounted query.
  const listHook = renderHook(() => listQueryStore.useListQuery(queryPayload));
  await flushAllTimers();

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  await act(async () => {
    await listQueryStore.performMutation(userOnePayload, {
      optimisticUpdate: () => {
        listQueryStore.deleteItemState(userOnePayload);
      },
      mutation: () => Promise.resolve(undefined),
      offline: { operation: 'deleteUser', input: { id: 1 } },
    });
  });
  await flushAllTimers();

  listHook.unmount();

  // Simulate a fresh app boot with only the pending-items hook mounted.
  resetSessionForTests();
  listQueryStore = createStore();

  const pendingHook = renderHook(() => listQueryStore.usePendingOfflineItems());
  await flushAllTimers();

  expect(pendingHook.result.current).toMatchInlineSnapshot(`
    deletedItems:
      - { id: 1, tableId: 'users' }
    items: []
  `);

  pendingHook.unmount();
});
