import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import {
  deleteItemInputSchema,
  getSortedQueueSummary,
  getSortedSessionQueueSummary,
  userPatchSchema,
} from './offlineReplayTestShared';
import {
  classifyRetryableReplayFailure,
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';

/**
 * Network mock of the current test, recreated before each test by
 * `setupCancelUnsentCreationTests`.
 */
export let network = createOfflineNetworkMock();

/**
 * Registers the fake timers, network mock and storage reset shared by the
 * tests of offline creations that are cancelled or wait for a decision.
 */
export function setupCancelUnsentCreationTests(): void {
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
}

/**
 * A network fault applied to one request of an operation:
 *
 * - `request-lost`: the request never reaches the server
 * - `response-lost`: the server applies the request, but the answer is lost
 *
 * In both cases the client only sees a failed request and cannot tell which
 * of the two happened.
 */
type NetworkFault = 'request-lost' | 'response-lost';

export function createStoreManagerForSession(sessionKey: string) {
  return createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: {
      network: network.config,
      // Failed replays are sent again after the retry interval (5s).
      classifyRetryableFailure: (error, ctx) =>
        classifyRetryableReplayFailure(error, ctx.phase),
    },
  });
}

/** The answer of the server mock when the item of a request does not exist. */
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Item not found');
}

type TaskRow = { id: number; name: string; parentId?: string };
type TaskPatch = { itemId: string; name?: string; parentId?: string };

type TasksOperations = {
  createTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { name: string },
    { reason: string },
    TaskRow
  >;
  createSubtask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { name: string; parentId: string },
    { reason: string },
    TaskRow
  >;
  createSubtaskWithId: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { id: number; name: string; parentId: string },
    { reason: string }
  >;
  createTaskWithId: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { id: number; name: string },
    { reason: string }
  >;
  renameTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { itemId: string; name: string },
    unknown
  >;
  deleteTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { itemId: string },
    unknown
  >;
  moveTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { itemId: string; parentId: string },
    unknown
  >;
  editTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    TaskPatch,
    unknown
  >;
};

type TasksEnv = ReturnType<
  typeof createListQueryStoreTestEnv<TaskRow, false, false, TasksOperations>
>;

const taskRowSchema = rc_object({
  id: rc_number,
  name: rc_string,
  parentId: rc_string.optionalKey(),
});
const subtaskInputSchema = rc_object({ name: rc_string, parentId: rc_string });
const taskWithIdInputSchema = rc_object({ id: rc_number, name: rc_string });
const subtaskWithIdInputSchema = rc_object({
  id: rc_number,
  name: rc_string,
  parentId: rc_string,
});
const taskPatchSchema = rc_object({
  itemId: rc_string,
  name: rc_string.optionalKey(),
  parentId: rc_string.optionalKey(),
});
export const tasksQuery = { tableId: 'tasks' } as const;

/**
 * A task list (list-query store) the way an app would configure it:
 *
 * - tasks and subtasks can be created offline (temp rows `temp:<name>`, the
 *   server assigns `tasks||<id>` starting at 3)
 * - a subtask, or an existing task moved under another one, declares its
 *   parent task with `dependsOn`
 * - `createSubtaskWithId` creates a subtask whose id (`tasks||<id>`) the app
 *   generates on the client, so it needs no temp row; `createTaskWithId` does
 *   the same for a top-level task
 * - when `conflicts.createTask` (or `conflicts.createSubtask`) is set, the
 *   replay of a task (or subtask) creation reports a conflict (the server
 *   already has a task with that name) instead of sending it; with
 *   `conflicts.createSubtaskWithId` (or `conflicts.createTaskWithId`) the
 *   replay of `createSubtaskWithId` (or `createTaskWithId`) reports that the
 *   server already has a task with that id
 * - `editTask` sends a partial change of a task (name and/or parent); the
 *   offline edits of the same task are merged into one request
 * - deleting a task supersedes its queued edits and, when the task was
 *   created offline and never sent, cancels the creation instead of deleting
 * - the delete treats a not-found answer as success
 *
 * `sentRequests` logs every mutation request sent to the server, by the
 * offline replay or directly while online.
 */
export function createTasksEnv(
  sessionKey: string,
  storeName: string,
  storeManager = createStoreManagerForSession(sessionKey),
  options: {
    /**
     * Before sending a delete again after an attempt whose outcome is
     * unknown, the app asks the server whether the task is already gone
     * (`shouldSkipSync`), instead of relying on the not-found answer.
     */
    deleteChecksServerBeforeRetry?: boolean;
  } = {},
) {
  let nextTaskId = 3;
  const sentRequests: string[] = [];
  const faults: Record<
    'createTask' | 'createTaskWithId' | 'deleteTask',
    NetworkFault[]
  > = { createTask: [], createTaskWithId: [], deleteTask: [] };
  const conflicts = {
    createTask: false,
    createSubtask: false,
    createSubtaskWithId: false,
    createTaskWithId: false,
  };

  async function createOnServer(input: { name: string; parentId?: string }) {
    const result: TaskRow = { id: nextTaskId, ...input };
    nextTaskId += 1;
    await env.serverTable.delayedSetItem(`tasks||${result.id}`, result);
    return result;
  }

  const env: TasksEnv = createListQueryStoreTestEnv<
    TaskRow,
    false,
    false,
    TasksOperations
  >(
    {
      tasks: [
        { id: 1, name: 'Write report' },
        { id: 2, name: 'Review budget' },
      ],
    },
    {
      id: storeName,
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: { loaded: { queries: [tasksQuery] } },
      persistentStorage: {
        adapter: 'local-sync',
        schema: taskRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            createTask: {
              inputSchema: collectionCreateInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              tempEntity: {
                buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `tasks||${result.id}`,
                  finalData: result,
                }),
              },
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () =>
                  conflicts.createTask ? { reason: 'name-taken' } : false,
              },
              execute: async ({ input }) => {
                sentRequests.push(`createTask "${input.name}"`);
                const fault = faults.createTask.shift();
                if (fault === 'request-lost') {
                  throw new Error('connection lost');
                }

                const result = await createOnServer(input);
                if (fault === 'response-lost') {
                  throw new Error('connection lost');
                }
                return result;
              },
            },
            createSubtask: {
              inputSchema: subtaskInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.name}`],
              dependsOn: ({ input }) => [input.parentId],
              tempEntity: {
                buildPendingEntity: (input) => ({
                  id: -1,
                  name: input.name,
                  parentId: input.parentId,
                }),
                reconcileServerEntity: (result) => ({
                  finalPayload: `tasks||${result.id}`,
                  finalData: result,
                }),
              },
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () =>
                  conflicts.createSubtask ? { reason: 'name-taken' } : false,
              },
              execute: ({ input }) => {
                sentRequests.push(
                  `createSubtask "${input.name}" of ${input.parentId}`,
                );
                return createOnServer(input);
              },
            },
            createSubtaskWithId: {
              inputSchema: subtaskWithIdInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`tasks||${input.id}`],
              dependsOn: ({ input }) => [input.parentId],
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () =>
                  conflicts.createSubtaskWithId
                    ? { reason: 'id-taken' }
                    : false,
              },
              execute: async ({ input }) => {
                const itemId = `tasks||${input.id}`;
                sentRequests.push(`createSubtaskWithId ${itemId}`);
                await env.serverTable.delayedSetItem(itemId, input);
              },
              onSuccessExecute: () => {},
            },
            createTaskWithId: {
              inputSchema: taskWithIdInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`tasks||${input.id}`],
              conflictHandling: {
                schema: rc_object({ reason: rc_string }),
                detectConflict: () =>
                  conflicts.createTaskWithId ? { reason: 'id-taken' } : false,
              },
              execute: async ({ input }) => {
                const itemId = `tasks||${input.id}`;
                sentRequests.push(`createTaskWithId ${itemId}`);
                const fault = faults.createTaskWithId.shift();
                if (fault === 'request-lost') {
                  throw new Error('connection lost');
                }

                await env.serverTable.delayedSetItem(itemId, input);
                if (fault === 'response-lost') {
                  throw new Error('connection lost');
                }
              },
              onSuccessExecute: () => {},
            },
            renameTask: {
              inputSchema: userPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                sentRequests.push(
                  `renameTask ${input.itemId} to "${input.name}"`,
                );
                await env.serverTable.delayedUpdateItem(input.itemId, {
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
            deleteTask: {
              inputSchema: deleteItemInputSchema,
              kind: 'delete',
              getEntityRefs: ({ input }) => [input.itemId],
              supersedes: {
                scope: 'same-entity',
                dropSelfIfTempLifecycleCancelled: true,
              },
              shouldSkipSync: options.deleteChecksServerBeforeRetry
                ? ({ input }) => env.serverTable.get(input.itemId) === undefined
                : undefined,
              execute: async ({ input }) => {
                sentRequests.push(`deleteTask ${input.itemId}`);
                const fault = faults.deleteTask.shift();
                if (fault === 'request-lost') {
                  throw new Error('connection lost');
                }

                try {
                  await env.serverTable.deleteItem(input.itemId);
                } catch (error) {
                  // The task is already gone from the server, which is what
                  // the delete wanted: returning makes the replay succeed.
                  if (isNotFoundError(error)) return;
                  throw error;
                }

                if (fault === 'response-lost') {
                  throw new Error('connection lost');
                }
              },
              onSuccessExecute: ({ input }) => {
                env.apiStore.deleteItemState(input.itemId);
              },
            },
            moveTask: {
              inputSchema: rc_object({
                itemId: rc_string,
                parentId: rc_string,
              }),
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOn: ({ input }) => [input.parentId],
              execute: async ({ input }) => {
                sentRequests.push(
                  `moveTask ${input.itemId} under ${input.parentId}`,
                );
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  parentId: input.parentId,
                });
              },
              onSuccessExecute: () => {},
            },
            editTask: {
              inputSchema: taskPatchSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              dependsOn: ({ input }) =>
                input.parentId === undefined ? [] : [input.parentId],
              accumulation: {
                // The fields the incoming edit does not change keep their
                // queued value.
                mergeInput: ({ existingInput, incomingInput }) => ({
                  itemId: incomingInput.itemId,
                  name: incomingInput.name ?? existingInput.name,
                  parentId: incomingInput.parentId ?? existingInput.parentId,
                }),
              },
              execute: async ({ input: { itemId, name, parentId } }) => {
                // Only the fields the edit changes are sent.
                const patch = {
                  ...(name === undefined ? {} : { name }),
                  ...(parentId === undefined ? {} : { parentId }),
                };
                sentRequests.push(
                  `editTask ${itemId} ${JSON.stringify(patch)}`,
                );
                await env.serverTable.delayedUpdateItem(itemId, patch);
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  function createTask(name: string) {
    return act(async () => {
      await env.apiStore.performMutation(`temp:${name}`, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            `temp:${name}`,
            { id: -1, name },
            { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
          );
        },
        mutation: () => createOnServer({ name }),
        offline: { operation: 'createTask', input: { name } },
      });
    });
  }

  function createSubtask(name: string, parentId: string) {
    return act(async () => {
      await env.apiStore.performMutation(`temp:${name}`, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            `temp:${name}`,
            { id: -1, name, parentId },
            { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
          );
        },
        mutation: () => createOnServer({ name, parentId }),
        offline: { operation: 'createSubtask', input: { name, parentId } },
      });
    });
  }

  function createSubtaskWithId(id: number, name: string, parentId: string) {
    return act(async () => {
      await env.apiStore.performMutation(`tasks||${id}`, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            `tasks||${id}`,
            { id, name, parentId },
            { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
          );
        },
        mutation: () =>
          env.serverTable.delayedSetItem(`tasks||${id}`, {
            id,
            name,
            parentId,
          }),
        offline: {
          operation: 'createSubtaskWithId',
          input: { id, name, parentId },
        },
      });
    });
  }

  function createTaskWithId(id: number, name: string) {
    return act(async () => {
      await env.apiStore.performMutation(`tasks||${id}`, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            `tasks||${id}`,
            { id, name },
            { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
          );
        },
        mutation: () =>
          env.serverTable.delayedSetItem(`tasks||${id}`, { id, name }),
        offline: { operation: 'createTaskWithId', input: { id, name } },
      });
    });
  }

  function renameTask(itemId: string, name: string) {
    return act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (item) => ({ ...item, name }));
        },
        mutation: async () => {
          sentRequests.push(`renameTask ${itemId} to "${name}"`);
          await env.serverTable.delayedUpdateItem(itemId, { name });
          return { name };
        },
        offline: { operation: 'renameTask', input: { itemId, name } },
      });
    });
  }

  function moveTask(itemId: string, parentId: string) {
    return act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (item) => ({
            ...item,
            parentId,
          }));
        },
        mutation: async () => {
          sentRequests.push(`moveTask ${itemId} under ${parentId}`);
          await env.serverTable.delayedUpdateItem(itemId, { parentId });
        },
        offline: { operation: 'moveTask', input: { itemId, parentId } },
      });
    });
  }

  function editTask(patch: TaskPatch) {
    const { itemId, ...changes } = patch;
    return act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.updateItemState(itemId, (item) => ({
            ...item,
            ...changes,
          }));
        },
        mutation: async () => {
          sentRequests.push(`editTask ${itemId} ${JSON.stringify(changes)}`);
          await env.serverTable.delayedUpdateItem(itemId, changes);
        },
        offline: { operation: 'editTask', input: patch },
      });
    });
  }

  /** The app removes only the deleted row from its lists right away. */
  function deleteTask(itemId: string) {
    return act(async () => {
      await env.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          env.apiStore.deleteItemState(itemId);
        },
        mutation: () => {
          sentRequests.push(`deleteTask ${itemId}`);
          return env.serverTable.deleteItem(itemId);
        },
        offline: { operation: 'deleteTask', input: { itemId } },
      });
    });
  }

  /** Mounts the task list and tracks the visible task names in the timeline. */
  function renderTaskList() {
    return renderHook(() => {
      const query = env.apiStore.useListQuery(tasksQuery, {
        itemSelector: (item) => item.name,
      });

      env.trackItemUI('tasks', query.items.join(', '));
      return query;
    });
  }

  return {
    ...env,
    // `timelineString` is a getter: spreading `env` would freeze its value.
    get timelineString() {
      return env.timelineString;
    },
    sentRequests,
    faults,
    conflicts,
    createTask,
    createSubtask,
    createSubtaskWithId,
    createTaskWithId,
    renameTask,
    moveTask,
    editTask,
    deleteTask,
    renderTaskList,
    /** Queued mutations of the store, in replay order. */
    getQueue: () =>
      getSortedQueueSummary(sessionKey, storeName, [
        'operation',
        'input',
        'syncState',
      ]),
    getServerTasks: () =>
      Object.values(env.serverTable.getAll()).map(
        (task) => `${task.id}: ${task.name}`,
      ),
  };
}

const commentInputSchema = rc_object({ text: rc_string, taskId: rc_string });
const commentSchema = rc_object({ value: commentInputSchema });
const editCommentInputSchema = rc_object({
  itemId: rc_string,
  text: rc_string,
});
const commentWithIdInputSchema = rc_object({
  id: rc_string,
  text: rc_string,
  taskId: rc_string,
});

type CommentItem = { text: string; taskId: string };

type CommentsOperations = {
  addComment: CollectionOfflineOperationDefinition<
    { value: CommentItem },
    string,
    CommentItem,
    unknown,
    { id: string; text: string; taskId: string }
  >;
  editComment: CollectionOfflineOperationDefinition<
    { value: CommentItem },
    string,
    { itemId: string; text: string },
    unknown
  >;
  addCommentWithId: CollectionOfflineOperationDefinition<
    { value: CommentItem },
    string,
    { id: string; text: string; taskId: string },
    unknown
  >;
};

type CommentsEnv = ReturnType<
  typeof createCollectionStoreTestEnv<CommentItem, CommentsOperations>
>;

/**
 * A task list plus a separate comments collection in the same offline
 * session. Comments can be added offline (temp items `temp:<text>`), also
 * to a task that was itself created offline: `cancelledWith` tells the
 * comments store which task of the tasks store a queued comment belongs to.
 * `addCommentWithId` adds a comment whose id the app generates on the
 * client, so it needs no temp item.
 */
export function createTasksAndCommentsEnv(sessionKey: string) {
  const tasksStoreName = `${sessionKey}-tasks`;
  const commentsStoreName = `${sessionKey}-comments`;
  const storeManager = createStoreManagerForSession(sessionKey);
  const tasks = createTasksEnv(sessionKey, tasksStoreName, storeManager);
  const sentRequests: string[] = [];
  let nextCommentId = 1;

  const comments: CommentsEnv = createCollectionStoreTestEnv<
    CommentItem,
    CommentsOperations
  >(
    {},
    {
      id: commentsStoreName,
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: commentSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            addComment: {
              inputSchema: commentInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [`temp:${input.text}`],
              cancelledWith: ({ input }) => [
                { storeName: tasksStoreName, entityRef: input.taskId },
              ],
              tempEntity: {
                buildPendingEntity: (input) => ({ value: input }),
                reconcileServerEntity: (result) => ({
                  finalPayload: result.id,
                  finalData: {
                    value: { text: result.text, taskId: result.taskId },
                  },
                }),
              },
              execute: async ({ input }) => {
                sentRequests.push(
                  `addComment "${input.text}" to ${input.taskId}`,
                );
                const result = { id: `comments||${nextCommentId}`, ...input };
                nextCommentId += 1;
                await comments.serverTable.delayedSetItem(result.id, input);
                return result;
              },
            },
            editComment: {
              inputSchema: editCommentInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                sentRequests.push(
                  `editComment ${input.itemId} to "${input.text}"`,
                );
                await comments.serverTable.delayedUpdateItem(input.itemId, {
                  text: input.text,
                });
                return { text: input.text };
              },
              onSuccessExecute: ({ input }) => {
                comments.apiStore.updateItemState(input.itemId, (draft) => {
                  draft.value.text = input.text;
                });
              },
            },
            addCommentWithId: {
              inputSchema: commentWithIdInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.id],
              cancelledWith: ({ input }) => [
                { storeName: tasksStoreName, entityRef: input.taskId },
              ],
              execute: async ({ input: { id, text, taskId } }) => {
                sentRequests.push(
                  `addCommentWithId ${id} "${text}" to ${taskId}`,
                );
                await comments.serverTable.delayedSetItem(id, { text, taskId });
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  function addComment(text: string, taskId: string) {
    return act(async () => {
      await comments.apiStore.performMutation(null, {
        mutation: async () => {
          const result = { id: 'comments||online', text, taskId };
          await comments.serverTable.delayedSetItem(result.id, {
            text,
            taskId,
          });
          return result;
        },
        offline: { operation: 'addComment', input: { text, taskId } },
      });
    });
  }

  function addCommentWithId(id: string, text: string, taskId: string) {
    return act(async () => {
      await comments.apiStore.performMutation(id, {
        optimisticUpdate: () => {
          comments.apiStore.addItemToState(id, { value: { text, taskId } });
        },
        mutation: () =>
          comments.serverTable.delayedSetItem(id, { text, taskId }),
        offline: { operation: 'addCommentWithId', input: { id, text, taskId } },
      });
    });
  }

  function editComment(itemId: string, text: string) {
    return act(async () => {
      await comments.apiStore.performMutation(itemId, {
        optimisticUpdate: () => {
          comments.apiStore.updateItemState(itemId, (draft) => {
            draft.value.text = text;
          });
        },
        mutation: async () => {
          await comments.serverTable.delayedUpdateItem(itemId, { text });
          return { text };
        },
        offline: { operation: 'editComment', input: { itemId, text } },
      });
    });
  }

  /**
   * Mounts the task list and tracks, in the timeline of the tasks store,
   * the visible tasks and the comments the comments store holds locally.
   */
  function renderTasksAndComments() {
    return renderHook(() => {
      const query = tasks.apiStore.useListQuery(tasksQuery, {
        itemSelector: (item) => item.name,
      });
      const localComments = comments.store.useSelector((state) =>
        Object.values(state)
          .map((comment) => comment?.data?.value.text)
          .filter((text) => text !== undefined)
          .join(', '),
      );

      tasks.trackItemUI('tasks', query.items.join(', '));
      tasks.trackItemUI('comments', localComments || 'no comments');
      return query;
    });
  }

  return {
    tasks,
    comments,
    storeManager,
    tasksStoreName,
    commentsStoreName,
    sentRequests,
    addComment,
    addCommentWithId,
    editComment,
    renderTasksAndComments,
    /** Queued mutations of both stores, in replay order. */
    getSessionQueue: () =>
      getSortedSessionQueueSummary(sessionKey, ['operation', 'input']),
    /** Text of the comments that exist locally, by payload. */
    getLocalComments: (payloads: string[]) =>
      Object.fromEntries(
        payloads.map((payload) => [
          payload,
          comments.apiStore.getItemState(payload)?.data?.value.text ?? null,
        ]),
      ),
  };
}
