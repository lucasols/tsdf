import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_boolean, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createCollectionStore,
  createStoreManager,
  type DefineCollectionOfflineOperations,
  type DefineOfflineOperation,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
} from '../../src/main';
import { createServerTableMock } from '../mocks/serverTableMock';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';

const todoSchema = rc_object({ title: rc_string, completed: rc_boolean });
const todoPayloadSchema = rc_string;
const todoInputSchema = rc_object({ id: rc_string, title: rc_string });
const renameManyTodosInputSchema = rc_array(todoInputSchema);
const createTodoInputSchema = rc_object({ title: rc_string });
const todoConflictSchema = rc_object({ reason: rc_string });
const conflictResolutionSchema = z.object({ title: z.string() });
const FETCH_DELAY_MS = 30;

type TodoPayload = string;
type TodoItem = { title: string; completed: boolean };
type RenameTodoInput = { id: string; title: string };
type CreateTodoInput = { title: string };
type TodoConflict = { reason: string };
type CreateTodoResult = { id: string; title: string; completed: boolean };

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

const validCollectionTempEntity: NonNullable<
  DirectCollectionOfflineOperations['createTodo']['tempEntity']
> = {
  buildPendingEntity: (input, tempId) => ({
    title: input.title,
    completed: tempId.length > 0,
  }),
  reconcileServerEntity: (result, tempId) => ({
    finalPayload: tempId === '__temp__' ? tempId : result.id,
    finalData: { title: result.title, completed: result.completed },
  }),
};

void validCollectionTempEntity;

const invalidCollectionPendingTempEntity: NonNullable<
  DirectCollectionOfflineOperations['createTodo']['tempEntity']
> = {
  // @ts-expect-error - buildPendingEntity must return TodoItem
  buildPendingEntity: (input) => ({ title: input.title }),
  reconcileServerEntity: (result) => ({
    finalPayload: result.id,
    finalData: { title: result.title, completed: result.completed },
  }),
};

void invalidCollectionPendingTempEntity;

const invalidCollectionFinalPayloadTempEntity: NonNullable<
  DirectCollectionOfflineOperations['createTodo']['tempEntity']
> = {
  buildPendingEntity: (input) => ({ title: input.title, completed: false }),
  reconcileServerEntity: (result) => ({
    // @ts-expect-error - finalPayload must match TodoPayload
    finalPayload: 123,
    finalData: { title: result.title, completed: result.completed },
  }),
};

void invalidCollectionFinalPayloadTempEntity;

const invalidCollectionFinalDataTempEntity: NonNullable<
  DirectCollectionOfflineOperations['createTodo']['tempEntity']
> = {
  buildPendingEntity: (input) => ({ title: input.title, completed: false }),
  reconcileServerEntity: (result) => ({
    finalPayload: result.id,
    // @ts-expect-error - finalData must match TodoItem
    finalData: { title: result.title },
  }),
};

void invalidCollectionFinalDataTempEntity;

type DirectCollectionOfflineOperations = DefineCollectionOfflineOperations<
  TodoItem,
  TodoPayload,
  {
    renameTodo: DefineOfflineOperation<RenameTodoInput>;
    renameManyTodos: DefineOfflineOperation<RenameTodoInput[]>;
    skipSyncTodo: DefineOfflineOperation<RenameTodoInput>;
    conflictTodo: DefineOfflineOperation<RenameTodoInput, TodoConflict>;
    createTodo: DefineOfflineOperation<
      CreateTodoInput,
      unknown,
      CreateTodoResult
    >;
  }
>;

type InvalidCollectionTempSuccessOperations = DefineCollectionOfflineOperations<
  TodoItem,
  TodoPayload,
  {
    createTodo: DefineOfflineOperation<
      CreateTodoInput,
      unknown,
      CreateTodoResult
    >;
  }
>;

// @ts-expect-error - tempEntity operations cannot configure accumulation
const invalidCollectionAccumulationTempEntity: NonNullable<
  DirectCollectionOfflineOperations['createTodo']
> = {
  inputSchema: createTodoInputSchema,
  kind: 'create',
  getEntityRefs: ({ input }) => [`temp:${input.title}`],
  accumulation: {
    mergeInput: ({ incomingInput }: { incomingInput: CreateTodoInput }) =>
      incomingInput,
  },
  tempEntity: {
    buildPendingEntity: (input) => ({ title: input.title, completed: false }),
    reconcileServerEntity: (result) => ({
      finalPayload: result.id,
      finalData: { title: result.title, completed: result.completed },
    }),
  },
  execute: ({ input }) => ({ id: '3', title: input.title, completed: false }),
};

void invalidCollectionAccumulationTempEntity;

// tests using the collection store directly without test envs to verify the public API usage
test('direct collection store offline public api', async () => {
  const network = createOfflineNetworkMock();
  const sessionKey = 'direct-collection-offline-session';
  network.install();
  const storeManager = createStoreManager({
    getSessionKey: () => sessionKey,
    errorNormalizer: normalizeError,
    offlineSession: { network: network.config },
  });

  let nextTodoId = 3;
  const serverTable = createServerTableMock<TodoItem>({
    '1': { title: 'Todo 1', completed: false },
    '2': { title: 'Todo 2', completed: false },
  });

  const collectionStore = createCollectionStore<
    TodoItem,
    TodoPayload,
    DirectCollectionOfflineOperations
  >({
    id: 'direct-collection-offline',
    storeManager,
    fetchFn: async (payload: TodoPayload) => {
      await delay(FETCH_DELAY_MS);
      const item = serverTable.get(payload);
      if (!item) {
        throw new Error(`Missing todo ${payload}`);
      }
      return { ...item };
    },
    getCollectionItemKey: (payload: TodoPayload) => payload,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    persistentStorage: {
      adapter: 'local-sync',
      schema: todoSchema,
      payloadSchema: todoPayloadSchema,
      offline: {
        operations: {
          renameTodo: {
            inputSchema: todoInputSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => [input.id],
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute: ({ input }) => {
              serverTable.updateItem(input.id, {
                title: input.title,
                completed: false,
              });
            },
            onSuccessExecute: ({ input }) => {
              collectionStore.updateItemState(input.id, (item) => ({
                ...item,
                title: input.title,
              }));
            },
          },
          renameManyTodos: {
            inputSchema: renameManyTodosInputSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => input.map((item) => item.id),
            execute: ({ input }) => {
              for (const item of input) {
                serverTable.updateItem(item.id, {
                  title: item.title,
                  completed: false,
                });
              }
            },
            onSuccessExecute: ({ input }) => {
              for (const item of input) {
                collectionStore.updateItemState(item.id, (currentItem) => ({
                  ...currentItem,
                  title: item.title,
                }));
              }
            },
          },
          skipSyncTodo: {
            inputSchema: todoInputSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => [input.id],
            execute: ({ input }) => {
              throw new Error(`dispatch failed after send ${input.title}`);
            },
            onSuccessExecute: ({ input }) => {
              collectionStore.updateItemState(input.id, (item) => ({
                ...item,
                title: input.title,
              }));
            },
            shouldSkipSync: ({ input, enqueuedAt, updatedAt }) => {
              expect(input).toMatchInlineSnapshot(`
                id: '1'
                title: 'Todo 1 skip'
              `);
              expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
              return true;
            },
          },
          conflictTodo: {
            inputSchema: todoInputSchema,
            kind: 'update',
            getEntityRefs: ({ input }) => [input.id],
            conflictHandling: {
              schema: todoConflictSchema,
              detectConflict: ({ input, enqueuedAt, updatedAt }) => {
                expect(updatedAt).toBeGreaterThanOrEqual(enqueuedAt);
                if (input.title !== 'Todo 1 conflict') return false;
                return { reason: 'server-changed' };
              },
            },
            execute: ({ input }) => {
              serverTable.updateItem(input.id, {
                title: input.title,
                completed: false,
              });
            },
            onSuccessExecute: ({ input }) => {
              collectionStore.updateItemState(input.id, (item) => ({
                ...item,
                title: input.title,
              }));
            },
          },
          createTodo: {
            inputSchema: createTodoInputSchema,
            kind: 'create',
            getEntityRefs: ({ input }) => [`temp:${input.title}`],
            tempEntity: {
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
              serverTable.setItem(result.id, {
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

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-collection-offline-session'
    updatedAt: 1735689600010
  `);

  const invalidTempSuccessServerTable = createServerTableMock<TodoItem>({});
  const invalidTempSuccessCollectionStore = createCollectionStore<
    TodoItem,
    TodoPayload,
    InvalidCollectionTempSuccessOperations
  >({
    id: 'invalid-temp-success-callback-collection',
    storeManager,
    fetchFn: () => Promise.resolve({ title: 'Todo', completed: false }),
    getCollectionItemKey: (payload: TodoPayload) => payload,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    persistentStorage: {
      adapter: 'local-sync',
      schema: todoSchema,
      payloadSchema: todoPayloadSchema,
      offline: {
        operations: {
          // @ts-expect-error - runtime validation should reject tempEntity plus success callback
          createTodo: {
            inputSchema: createTodoInputSchema,
            kind: 'create',
            getEntityRefs: ({ input }: { input: CreateTodoInput }) => [
              `temp:${input.title}`,
            ],
            tempEntity: {
              buildPendingEntity: (input: CreateTodoInput) => ({
                title: input.title,
                completed: false,
              }),
              reconcileServerEntity: (result: CreateTodoResult) => ({
                finalPayload: result.id,
                finalData: { title: result.title, completed: result.completed },
              }),
            },
            execute: ({ input }: { input: CreateTodoInput }) => {
              invalidTempSuccessServerTable.setItem('3', {
                title: input.title,
                completed: false,
              });
              return { id: '3', title: input.title, completed: false };
            },
            onSuccessExecute: ({ input }) => {
              collectionStore.addItemToState('3', {
                title: input.title,
                completed: false,
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
    await invalidTempSuccessCollectionStore.performMutation(null, {
      mutation: () => Promise.resolve({ title: 'Todo', completed: false }),
      offline: { operation: 'createTodo', input: { title: 'Invalid temp' } },
    });

  expect({
    error: invalidTempSuccessResult.ok ? null : invalidTempSuccessResult.error,
    ok: invalidTempSuccessResult.ok,
  }).toMatchInlineSnapshot(`
    error{Error}:
      message: 'Offline operation "createTodo" cannot configure onSuccessExecute when tempEntity or tempEntities is present'
      name: 'StoreMutationError'
      kind: 'error'
      code: 500
      id: 'fetch-error'
      cause:
        Error#:
          message: 'Offline operation "createTodo" cannot configure onSuccessExecute when tempEntity or tempEntities is present'
          name: 'Error'

    ok: '❌'
  `);

  act(() => {
    network.goOffline();
  });
  await Promise.resolve();

  function renameTodo(id: string, title: string) {
    return collectionStore.performMutation(todoOnePayload, {
      optimisticUpdate: (payload) => {
        collectionStore.updateItemState(payload, (item) => ({
          ...item,
          title,
        }));
      },
      mutation: () => Promise.resolve({ title, completed: false }),
      offline: { operation: 'renameTodo', input: { id, title } },
    });
  }

  const todoUpdateResult = await act(async () => {
    return await renameTodo('1', 'Todo 1 first');
  });

  assert(todoUpdateResult.ok);
  expect(todoUpdateResult.value).toMatchInlineSnapshot(`kind: 'queued'`);

  const multiRenameResult = await act(async () => {
    return collectionStore.performMutation(todoOnePayload, {
      optimisticUpdate: () => {
        collectionStore.updateItemState(todoOnePayload, (item) => ({
          ...item,
          title: 'Todo 1 second',
        }));
        collectionStore.updateItemState(todoTwoPayload, (item) => ({
          ...item,
          title: 'Todo 2 offline',
        }));
      },
      mutation: () => Promise.resolve({ ok: true }),
      offline: {
        operation: 'renameManyTodos',
        input: [
          { id: '1', title: 'Todo 1 second' },
          { id: '2', title: 'Todo 2 offline' },
        ],
      },
    });
  });

  assert(multiRenameResult.ok);
  expect(multiRenameResult.value).toMatchInlineSnapshot(`kind: 'queued'`);

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

  expect(collectionStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  await collectionStore.resolveOfflineResolution('missing', 'conflictTodo', {
    action: 'discard',
  });
  expect(pick(todoOneHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 1 conflict' }
      pendingSync: '✅'
      status: 'success'
    `);

  expect(collectionStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689612000
      entityKey: '"1'
      entityKind: 'item'
      id: 'direct-collection-offline-session:direct-collection-offline:"1'
      kind: 'update'
      pendingMutations: 4
      requiresResolution: '❌'
      sessionKey: 'direct-collection-offline-session'
      storeName: 'direct-collection-offline'
      storeType: 'collection'
      syncState: 'pending'
      updatedAt: 1735689612000
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689612000
      entityKey: '"2'
      entityKind: 'item'
      id: 'direct-collection-offline-session:direct-collection-offline:"2'
      kind: 'update'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'direct-collection-offline-session'
      storeName: 'direct-collection-offline'
      storeType: 'collection'
      syncState: 'pending'
      updatedAt: 1735689612000
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689612000
      entityKey: '"temp:Todo 3 offline'
      entityKind: 'item'
      id: 'direct-collection-offline-session:direct-collection-offline:"temp:Todo 3 offline'
      kind: 'create'
      pendingMutations: 1
      requiresResolution: '❌'
      sessionKey: 'direct-collection-offline-session'
      storeName: 'direct-collection-offline'
      storeType: 'collection'
      syncState: 'pending'
      tempId: 'temp:Todo 3 offline'
      updatedAt: 1735689612000
  `);
  expect(getGlobalOfflineEntities(sessionKey)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ storeName: 'direct-collection-offline' }),
    ]),
  );

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '✅'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '✅', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-collection-offline-session'
    updatedAt: 1735689612000
  `);

  await act(async () => {
    network.goOnline();
    await advanceTime(250);
    await flushAllTimers();
  });

  const [conflict] = collectionStore.getOfflineResolutions();
  if (
    !conflict ||
    conflict.kind !== 'conflict' ||
    conflict.operation !== 'conflictTodo'
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
    createdAt: 1735689617000
    enqueuedAt: 1735689612000
    entityRefs:
      - entityKey: '"1'
        entityKind: 'item'
    input: { id: '1', title: 'Todo 1 conflict' }
    kind: 'conflict'
    operation: 'conflictTodo'
    sessionKey: 'direct-collection-offline-session'
    storeName: 'direct-collection-offline'
    storeType: 'collection'
    updatedAt: 1735689617000
  `);
  const parsedConflict =
    collectionStore.parseOfflineResolutionConflict(conflict);
  expect({
    ok: parsedConflict.ok,
    value: parsedConflict.ok ? parsedConflict.value : null,
  }).toMatchInlineSnapshot(`
    ok: '✅'
    value: { reason: 'server-changed' }
  `);

  expect(collectionStore.getOfflineEntities()).toMatchInlineSnapshot(`
    - blockedByResolutionIds: []
      blockedResolutionCount: 0
      childResolutionCount: 0
      childResolutionIds: []
      createdAt: 1735689617000
      entityKey: '"1'
      entityKind: 'item'
      id: 'direct-collection-offline-session:direct-collection-offline:"1'
      kind: 'update'
      pendingMutations: 0
      requiresResolution: '✅'
      sessionKey: 'direct-collection-offline-session'
      storeName: 'direct-collection-offline'
      storeType: 'collection'
      syncState: 'resolution-required'
      updatedAt: 1735689617000
  `);
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
    await collectionStore.resolveOfflineResolution(
      conflict.id,
      'conflictTodo',
      {
        action: 'requeue',
        input: {
          id: '1',
          title: conflictResolutionSchema.parse({ title: 'Todo 1 resolved' })
            .title,
        },
      },
    );
    await flushAllTimers();
  });

  expect(collectionStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  expect(collectionStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(pick(todoOneHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 1 resolved' }
      pendingSync: '❌'
      status: 'success'
    `);
  expect(pick(todoTwoHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 2 offline' }
      pendingSync: '❌'
      status: 'success'
    `);
  expect(pick(todoThreeHook.result.current, ['data', 'status', 'pendingSync']))
    .toMatchInlineSnapshot(`
      data: { completed: '❌', title: 'Todo 3 offline' }
      pendingSync: '❌'
      status: 'success'
    `);

  expect(getGlobalOfflineStatus(sessionKey)).toMatchInlineSnapshot(`
    isLeader: '✅'
    isOfflineMode: '❌'
    lastFailureAt: null
    lastRecoveryCheckAt: null
    network: { active: '❌', enabled: '✅' }
    outage: { active: '❌', enabled: '❌' }
    sessionKey: 'direct-collection-offline-session'
    updatedAt: 1735689618010
  `);

  const onlineRenameResult = await act(async () => {
    return await renameTodo('1', 'Todo 1 online');
  });

  assert(onlineRenameResult.ok);
  expect(onlineRenameResult.value).toMatchInlineSnapshot(`
    data: { completed: '❌', title: 'Todo 1 online' }
    kind: 'online'
  `);

  todoOneHook.unmount();
  todoTwoHook.unmount();
  todoThreeHook.unmount();
});
