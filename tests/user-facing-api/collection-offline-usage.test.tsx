import { getCompositeKey } from '@ls-stack/utils/getCompositeKey';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_boolean, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createCollectionStore,
  type DefineCollectionOfflineOperations,
  type DefineOfflineOperation,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
} from '../../src/main';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

const todoSchema = rc_object({ title: rc_string, completed: rc_boolean });
const todoPayloadSchema = rc_string;
const todoInputSchema = rc_object({ id: rc_string, title: rc_string });
const createTodoInputSchema = rc_object({ title: rc_string });
const todoConflictSchema = rc_object({ reason: rc_string });
const conflictResolutionSchema = z.object({ title: z.string() });
const FETCH_DELAY_MS = 30;

type TodoPayload = string;
type TodoItem = { title: string; completed: boolean };
type RenameTodoInput = { id: string; title: string };
type CreateTodoInput = { title: string };
type TodoConflict = { reason: string };

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
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

type DirectCollectionOfflineOperations = DefineCollectionOfflineOperations<
  TodoItem,
  TodoPayload,
  {
    renameTodo: DefineOfflineOperation<RenameTodoInput>;
    skipSyncTodo: DefineOfflineOperation<RenameTodoInput>;
    conflictTodo: DefineOfflineOperation<RenameTodoInput, TodoConflict>;
    createTodo: DefineOfflineOperation<
      CreateTodoInput,
      unknown,
      { id: string; title: string; completed: boolean }
    >;
  }
>;

test('direct collection store offline public api supports the main operation hooks in one flow', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-collection-offline-session';
  network.install();

  let nextTodoId = 3;
  const todoState = new Map<string, TodoItem>([
    ['1', { title: 'Todo 1', completed: false }],
    ['2', { title: 'Todo 2', completed: false }],
  ]);

  const collectionStore = createCollectionStore<
    TodoItem,
    TodoPayload,
    DirectCollectionOfflineOperations
  >({
    id: 'direct-collection-offline',
    getSessionKey: () => sessionKey,
    fetchFn: async (payload: TodoPayload) => {
      await delay(FETCH_DELAY_MS);
      const item = todoState.get(payload);
      if (!item) {
        throw new Error(`Missing todo ${payload}`);
      }
      return { ...item };
    },
    getCollectionItemKey: (payload: TodoPayload) => payload,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      storeName: 'direct-collection-offline',
      adapter: 'local-sync',
      schema: todoSchema,
      payloadSchema: todoPayloadSchema,
      offlineMode: {
        network: network.config,
        operations: {
          renameTodo: {
            inputSchema: todoInputSchema,
            getEntityRefs: ({ input }) => [input.id],
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute: ({ input }) => {
              todoState.set(input.id, { title: input.title, completed: false });
              collectionStore.updateItemState(input.id, (item) => ({
                ...item,
                title: input.title,
              }));
            },
          },
          skipSyncTodo: {
            inputSchema: todoInputSchema,
            getEntityRefs: ({ input }) => [input.id],
            execute: ({ input }) => {
              throw new Error(`dispatch failed after send ${input.title}`);
            },
            shouldSkipSync: ({ input, enqueuedAt, updatedAt }) => {
              expect(input).toMatchObject({ id: '1', title: 'Todo 1 skip' });
              expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
              return true;
            },
          },
          conflictTodo: {
            inputSchema: todoInputSchema,
            getEntityRefs: ({ input }) => [input.id],
            conflictHandling: {
              schema: todoConflictSchema,
              detectConflict: ({ input, enqueuedAt, updatedAt }) => {
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                if (input.title !== 'Todo 1 conflict') return false;
                return { reason: 'server-changed' };
              },
              resolveConflict: ({
                input,
                conflict,
                resolution,
                enqueuedAt,
                updatedAt,
              }) => {
                expect(input.id).toBe('1');
                expect(conflict).toMatchObject({ reason: 'server-changed' });
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                const parsedResolution =
                  conflictResolutionSchema.parse(resolution);

                return {
                  requeue: {
                    input: { id: input.id, title: parsedResolution.title },
                  },
                };
              },
            },
            execute: ({ input }) => {
              todoState.set(input.id, { title: input.title, completed: false });
              collectionStore.updateItemState(input.id, (item) => ({
                ...item,
                title: input.title,
              }));
            },
          },
          createTodo: {
            inputSchema: createTodoInputSchema,
            getEntityRefs: () => [],
            tempEntity: {
              createTempId: (input) => `temp:${input.title}`,
              buildPendingEntity: (input) => ({
                title: input.title,
                completed: false,
              }),
              reconcileServerEntity: (result) => ({
                finalPayload: result.id,
                finalData: { title: result.title, completed: result.completed },
              }),
            },
            execute: ({ input }) => {
              const id = String(nextTodoId);
              nextTodoId += 1;
              const result = { id, title: input.title, completed: false };
              todoState.set(result.id, {
                title: result.title,
                completed: result.completed,
              });
              return result;
            },
          },
        },
      },
    },
  });

  const todoOnePayload = '1';
  const todoTwoPayload = '2';
  const todoOneHook = renderHook(() => collectionStore.useItem(todoOnePayload));
  const todoTwoHook = renderHook(() => collectionStore.useItem(todoTwoPayload));
  await flushAllTimers();

  expect(pick(todoOneHook.result.current, ['data', 'payload', 'status']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 1' }
      payload: '1'
      status: 'success'
    `);
  expect(pick(todoTwoHook.result.current, ['data', 'payload', 'status']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 2' }
      payload: '2'
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
    await collectionStore.performMutation(todoOnePayload, {
      optimisticUpdate: (payload) => {
        collectionStore.updateItemState(payload, (item) => ({
          ...item,
          title: 'Todo 1 first',
        }));
      },
      mutation: () =>
        Promise.resolve({ title: 'Todo 1 first', completed: false }),
      offline: {
        operation: 'renameTodo',
        input: { id: '1', title: 'Todo 1 first' },
      },
    });
  });

  await act(async () => {
    await collectionStore.performMutation(todoOnePayload, {
      optimisticUpdate: (payload) => {
        collectionStore.updateItemState(payload, (item) => ({
          ...item,
          title: 'Todo 1 second',
        }));
      },
      mutation: () =>
        Promise.resolve({ title: 'Todo 1 second', completed: false }),
      offline: {
        operation: 'renameTodo',
        input: { id: '1', title: 'Todo 1 second' },
      },
    });
  });

  await act(async () => {
    await collectionStore.performMutation(todoTwoPayload, {
      optimisticUpdate: (payload) => {
        collectionStore.updateItemState(payload, (item) => ({
          ...item,
          title: 'Todo 2 offline',
        }));
      },
      mutation: () =>
        Promise.resolve({ title: 'Todo 2 offline', completed: false }),
      offline: {
        operation: 'renameTodo',
        input: { id: '2', title: 'Todo 2 offline' },
      },
    });
  });

  await act(async () => {
    await collectionStore.performMutation(todoOnePayload, {
      optimisticUpdate: (payload) => {
        collectionStore.updateItemState(payload, (item) => ({
          ...item,
          title: 'Todo 1 skip',
        }));
      },
      mutation: () =>
        Promise.resolve({ title: 'Todo 1 skip', completed: false }),
      offline: {
        operation: 'skipSyncTodo',
        input: { id: '1', title: 'Todo 1 skip' },
      },
    });
  });

  await act(async () => {
    await collectionStore.performMutation(todoOnePayload, {
      optimisticUpdate: (payload) => {
        collectionStore.updateItemState(payload, (item) => ({
          ...item,
          title: 'Todo 1 conflict',
        }));
      },
      mutation: () =>
        Promise.resolve({ title: 'Todo 1 conflict', completed: false }),
      offline: {
        operation: 'conflictTodo',
        input: { id: '1', title: 'Todo 1 conflict' },
      },
    });
  });

  await act(async () => {
    await collectionStore.performMutation(null, {
      mutation: () =>
        Promise.resolve({ title: 'Todo 3 offline', completed: false }),
      offline: { operation: 'createTodo', input: { title: 'Todo 3 offline' } },
    });
  });
  await Promise.resolve();

  expect(collectionStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  await collectionStore.resolveOfflineConflict('missing', {
    resolution: 'noop',
  });
  expect(
    pick(todoOneHook.result.current, [
      'data',
      'status',
      'isPendingOfflineSync',
    ]),
  ).toMatchInlineSnapshot(`
    data: { completed: '❌', title: 'Todo 1 conflict' }
    isPendingOfflineSync: '✅'
    status: 'success'
  `);
  expect(collectionStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: getCompositeKey('1'),
      pendingMutations: 3,
      storeType: 'collection',
    },
    {
      entityKey: getCompositeKey('2'),
      pendingMutations: 1,
      storeType: 'collection',
    },
    {
      entityKey: 'temp:Todo 3 offline',
      pendingMutations: 1,
      storeType: 'collection',
      tempId: 'temp:Todo 3 offline',
    },
  ]);
  expect(getGlobalOfflineEntities(sessionKey)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ storeName: 'direct-collection-offline' }),
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

  const [conflict] = collectionStore.getOfflineConflicts();
  expect(conflict).toMatchObject({
    conflict: { reason: 'server-changed' },
    input: { id: '1', title: 'Todo 1 conflict' },
    operation: 'conflictTodo',
    sessionKey,
    storeName: 'direct-collection-offline',
    storeType: 'collection',
  });
  expect(collectionStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: getCompositeKey('1'),
      hasConflict: true,
      pendingMutations: 0,
      storeType: 'collection',
      syncState: 'conflict',
    },
  ]);
  expect(todoTwoHook.result.current.data).toMatchInlineSnapshot(`
    completed: '❌'
    title: 'Todo 2 offline'
  `);

  const todoThreeHook = renderHook(() => collectionStore.useItem('3'));
  await flushAllTimers();
  expect(pick(todoThreeHook.result.current, ['data', 'payload', 'status']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 3 offline' }
      payload: '3'
      status: 'success'
    `);

  await act(async () => {
    await collectionStore.resolveOfflineConflict(conflict!.id, {
      title: 'Todo 1 resolved',
    });
    await flushAllTimers();
  });

  expect(collectionStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  expect(collectionStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(
    pick(todoOneHook.result.current, [
      'data',
      'status',
      'isPendingOfflineSync',
    ]),
  ).toMatchInlineSnapshot(`
    data: { completed: '❌', title: 'Todo 1 resolved' }
    isPendingOfflineSync: '❌'
    status: 'success'
  `);
  expect(
    pick(todoTwoHook.result.current, [
      'data',
      'status',
      'isPendingOfflineSync',
    ]),
  ).toMatchInlineSnapshot(`
    data: { completed: '❌', title: 'Todo 2 offline' }
    isPendingOfflineSync: '❌'
    status: 'success'
  `);
  expect(
    pick(todoThreeHook.result.current, [
      'data',
      'status',
      'isPendingOfflineSync',
    ]),
  ).toMatchInlineSnapshot(`
    data: { completed: '❌', title: 'Todo 3 offline' }
    isPendingOfflineSync: '❌'
    status: 'success'
  `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });

  todoOneHook.unmount();
  todoTwoHook.unmount();
  todoThreeHook.unmount();
});
