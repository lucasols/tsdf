import { renderHook } from '@testing-library/react';
import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { act } from 'react';
import { rc_literals, rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createListQueryStore,
  type DefineListQueryOfflineOperations,
  type DefineOfflineOperation,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  localPersistentStorage,
} from '../../src/main';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

const userSchema = rc_object({ id: rc_number, name: rc_string });
const userInputSchema = rc_object({ id: rc_number, name: rc_string });
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

type DirectListQueryOfflineOperations = DefineListQueryOfflineOperations<
  User,
  UsersQueryPayload,
  UserPayload,
  {
    renameUser: DefineOfflineOperation<RenameUserInput>;
    skipSyncUser: DefineOfflineOperation<RenameUserInput>;
    conflictUser: DefineOfflineOperation<RenameUserInput, UserConflict>;
    createUser: DefineOfflineOperation<CreateUserInput, unknown, User>;
  }
>;

test('direct list-query store offline public api supports the main operation hooks in one flow', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-list-query-offline-session';
  network.install();

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
      storeName: 'direct-list-query-offline',
      adapter: localPersistentStorage,
      schema: userSchema,
      itemPayloadSchema: userPayloadSchema,
      queryPayloadSchema: usersQueryPayloadSchema,
      offlineMode: {
        network: network.config,
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
          skipSyncUser: {
            inputSchema: userInputSchema,
            getEntityRefs: ({ input }) => [getUserItemPayload(input.id)],
            execute: ({ input }) => {
              throw new Error(`dispatch failed after send ${input.name}`);
            },
            shouldSkipSync: ({ input, enqueuedAt, updatedAt }) => {
              expect(input).toMatchObject({ id: 1, name: 'Ada skip' });
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
              resolveConflict: ({
                input,
                conflict,
                resolution,
                enqueuedAt,
                updatedAt,
              }) => {
                expect(input.id).toBe(1);
                expect(conflict).toMatchObject({ reason: 'server-changed' });
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                const parsedResolution =
                  conflictResolutionSchema.parse(resolution);

                return {
                  requeue: {
                    input: { id: input.id, name: parsedResolution.name },
                  },
                };
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
            getEntityRefs: () => [],
            tempEntity: {
              createTempId: (input) => `temp:${input.name}`,
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
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
  });

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

  await act(async () => {
    await listQueryStore.performMutation(userOnePayload, {
      optimisticUpdate: (payload) => {
        if (Array.isArray(payload) || typeof payload === 'function') return;
        listQueryStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Ada second',
        }));
      },
      mutation: () => Promise.resolve({ id: 1, name: 'Ada second' }),
      offline: {
        operation: 'renameUser',
        input: { id: 1, name: 'Ada second' },
      },
    });
  });

  await act(async () => {
    await listQueryStore.performMutation(userTwoPayload, {
      optimisticUpdate: (payload) => {
        if (Array.isArray(payload) || typeof payload === 'function') return;
        listQueryStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Grace offline',
        }));
      },
      mutation: () => Promise.resolve({ id: 2, name: 'Grace offline' }),
      offline: {
        operation: 'renameUser',
        input: { id: 2, name: 'Grace offline' },
      },
    });
  });

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

  expect(listQueryStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  await listQueryStore.resolveOfflineConflict('missing', {
    resolution: 'noop',
  });
  expect(
    pick(listHook.result.current, ['items', 'status', 'isPendingOfflineSync']),
  ).toMatchInlineSnapshot(`
    isPendingOfflineSync: '✅'
    items: ['Ada conflict', 'Grace offline']
    status: 'success'
  `);
  const firstQuery = multiHook.result.current[0];
  expect(firstQuery).toMatchObject({
    isPendingOfflineSync: true,
    items: ['Ada conflict', 'Grace offline'],
    status: 'success',
  });
  expect(listQueryStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: getCompositeKey(getUserEntityKey(1)),
      pendingMutations: 3,
      storeType: 'listQuery',
    },
    {
      entityKey: getCompositeKey(getUserEntityKey(2)),
      pendingMutations: 1,
      storeType: 'listQuery',
    },
    {
      entityKey: 'temp:Linus offline',
      pendingMutations: 1,
      storeType: 'listQuery',
      tempId: 'temp:Linus offline',
    },
  ]);
  expect(getGlobalOfflineEntities(sessionKey)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ storeName: 'direct-list-query-offline' }),
    ]),
  );
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    network: { active: true, enabled: true },
  });

  await act(async () => {
    network.goOnline();
    await advanceTime(250);
    await flushAllTimers();
  });

  const [conflict] = listQueryStore.getOfflineConflicts();
  expect(conflict).toMatchObject({
    conflict: { reason: 'server-changed' },
    input: { id: 1, name: 'Ada conflict' },
    operation: 'conflictUser',
    sessionKey,
    storeName: 'direct-list-query-offline',
    storeType: 'listQuery',
  });
  expect(listQueryStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: getCompositeKey(getUserEntityKey(1)),
      hasConflict: true,
      pendingMutations: 0,
      storeType: 'listQuery',
      syncState: 'conflict',
    },
  ]);

  const createdUserHook = renderHook(() =>
    listQueryStore.useItem(getUserItemPayload(3)),
  );
  await flushAllTimers();
  expect(
    pick(createdUserHook.result.current, [
      'data',
      'status',
      'isPendingOfflineSync',
    ]),
  ).toMatchInlineSnapshot(`
    data: { id: 3, name: 'Linus offline' }
    isPendingOfflineSync: '❌'
    status: 'success'
  `);

  await act(async () => {
    await listQueryStore.resolveOfflineConflict(conflict!.id, {
      name: 'Ada resolved',
    });
    await flushAllTimers();
  });

  expect(listQueryStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  expect(listQueryStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(
    pick(listHook.result.current, ['items', 'status', 'isPendingOfflineSync']),
  ).toMatchInlineSnapshot(`
    isPendingOfflineSync: '❌'
    items: ['Ada resolved', 'Grace offline']
    status: 'success'
  `);
  expect(multiHook.result.current[0]).toMatchObject({
    isPendingOfflineSync: false,
    items: ['Ada resolved', 'Grace offline'],
    status: 'success',
  });
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });

  listHook.unmount();
  multiHook.unmount();
  createdUserHook.unmount();
});
