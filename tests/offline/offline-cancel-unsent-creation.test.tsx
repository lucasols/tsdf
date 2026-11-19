import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
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
  summarizeResolution,
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

function createStoreManagerForSession(sessionKey: string) {
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
type TasksOperations = {
  createTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { name: string },
    unknown,
    TaskRow
  >;
  createSubtask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { name: string; parentId: string },
    unknown,
    TaskRow
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
const tasksQuery = { tableId: 'tasks' } as const;

/**
 * A task list (list-query store) the way an app would configure it:
 *
 * - tasks and subtasks can be created offline (temp rows `temp:<name>`, the
 *   server assigns `tasks||<id>` starting at 3)
 * - a subtask declares its parent task with `dependsOn`
 * - deleting a task supersedes its queued edits and, when the task was
 *   created offline and never sent, cancels the creation instead of deleting
 * - the delete treats a not-found answer as success
 *
 * `sentRequests` logs every mutation request sent to the server, by the
 * offline replay or directly while online.
 */
function createTasksEnv(
  sessionKey: string,
  storeName: string,
  storeManager = createStoreManagerForSession(sessionKey),
) {
  let nextTaskId = 3;
  const sentRequests: string[] = [];
  const faults: Record<'createTask' | 'deleteTask', NetworkFault[]> = {
    createTask: [],
    deleteTask: [],
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
              execute: ({ input }) => {
                sentRequests.push(
                  `createSubtask "${input.name}" of ${input.parentId}`,
                );
                return createOnServer(input);
              },
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
    createTask,
    createSubtask,
    renameTask,
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

describe('list-query rows', () => {
  test('deleting a task created offline drops its creation, its edits and the subtasks queued under it, without sending anything', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'cancel-unsent-task-session',
      'cancel-unsent-task-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'offline: create a task, rename it, and add a subtask that is renamed too',
    ]);
    await env.createTask('Plan trip');
    await env.renameTask('temp:Plan trip', 'Plan summer trip');
    await env.createSubtask('Book flights', 'temp:Plan trip');
    await env.renameTask('temp:Book flights', 'Book cheap flights');

    // An edit of a task the server already has: it must survive the cancel.
    env.addTimelineComments('beforeNextAction', [
      'offline: rename a task that already exists on the server',
    ]);
    await env.renameTask('tasks||1', 'Write final report');

    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
        syncState: 'pending'
      - input: { itemId: 'temp:Plan trip', name: 'Plan summer trip' }
        operation: 'renameTask'
        syncState: 'pending'
      - input: { name: 'Book flights', parentId: 'temp:Plan trip' }
        operation: 'createSubtask'
        syncState: 'pending'
      - input: { itemId: 'temp:Book flights', name: 'Book cheap flights' }
        operation: 'renameTask'
        syncState: 'pending'
      - input: { itemId: 'tasks||1', name: 'Write final report' }
        operation: 'renameTask'
        syncState: 'pending'
    `);

    // The app only removes the deleted task row. The subtask row is removed
    // by the store, because its creation is cancelled with its parent.
    env.addTimelineComments('beforeNextAction', [
      'offline: delete the task that was never sent',
    ]);
    await env.deleteTask('temp:Plan trip');

    // Nothing about the cancelled task is left to send: its creation, its
    // rename, its subtask (creation + rename) and the delete itself are gone.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { itemId: 'tasks||1', name: 'Write final report' }
        operation: 'renameTask'
        syncState: 'pending'
    `);
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write final report', 'Review budget']
    `);
    expect({
      task: env.apiStore.getItemState('temp:Plan trip'),
      subtask: env.apiStore.getItemState('temp:Book flights'),
      taskOfflineState: env.apiStore.getItemOfflineState('temp:Plan trip'),
      subtaskOfflineState:
        env.apiStore.getItemOfflineState('temp:Book flights'),
    }).toMatchInlineSnapshot(`
      subtask: null
      subtaskOfflineState: null
      task: null
      taskOfflineState: null
    `);

    env.addTimelineComments('beforeNextAction', [
      'back online: only the rename of the existing task is sent',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(`
      ['renameTask tasks||1 to "Write final report"']
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['1: Write final report', '2: Review budget']
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | tasks                                                                   |
      0      | Write report, Review budget                                             | [tasks] ui-initialized
      12s    | Write report, Review budget                                             | -- offline: create a task, rename it, and add a subtask that is renamed too
      .      | Write report, Review budget, Plan trip                                  | [tasks] ui-changed
      .      | Write report, Review budget, Plan trip                                  | offline:createTask queued
      .      | Write report, Review budget, Plan summer trip                           | [tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip                           | offline:renameTask queued
      .      | Write report, Review budget, Plan summer trip, Book flights             | [tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip, Book flights             | offline:createSubtask queued
      .      | Write report, Review budget, Plan summer trip, Book cheap flights       | [tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip, Book cheap flights       | offline:renameTask queued
      .      | Write report, Review budget, Plan summer trip, Book cheap flights       | -- offline: rename a task that already exists on the server
      .      | Write final report, Review budget, Plan summer trip, Book cheap flights | [tasks] ui-changed
      .      | Write final report, Review budget, Plan summer trip, Book cheap flights | offline:renameTask queued
      .      | Write final report, Review budget, Plan summer trip, Book cheap flights | -- offline: delete the task that was never sent
      .      | Write final report, Review budget                                       | [tasks] ui-changed
      .      | Write final report, Review budget                                       | offline:deleteTask queued
      .      | Write final report, Review budget                                       | -- back online: only the rename of the existing task is sent
      .      | Write final report, Review budget                                       | offline:renameTask replay-started
      13.2s  | Write final report, Review budget                                       | [tasks||1] server-data-changed (value: {"name":"Write final report"})
      .      | Write final report, Review budget                                       | offline:renameTask replay-finished
      13.21s | Write final report, Review budget                                       | 🔴 >list-fetch-started
      14.01s | Write final report, Review budget                                       | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('deleting a task while its creation is being sent waits for the server id, then deletes the task on the server', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'delete-task-in-flight-session',
      'delete-task-in-flight-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'offline: create a task and rename it',
    ]);
    await env.createTask('Plan trip');
    await env.renameTask('temp:Plan trip', 'Plan summer trip');

    env.addTimelineComments('beforeNextAction', [
      'back online: the creation request is sent',
    ]);
    act(() => {
      network.goOnline();
    });
    // The creation request takes 1.2s: it is in flight now.
    await advanceTime(300);

    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
        syncState: 'syncing'
      - input: { itemId: 'temp:Plan trip', name: 'Plan summer trip' }
        operation: 'renameTask'
        syncState: 'pending'
    `);

    env.addTimelineComments('beforeNextAction', [
      'delete the task while its creation is in flight',
    ]);
    await env.deleteTask('temp:Plan trip');

    // The creation may already be on the server, so it is not dropped. The
    // delete waits behind it (it cannot be sent before the server id is
    // known), and only the rename, never sent, is superseded by the delete.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
        syncState: 'syncing'
      - input: { itemId: 'temp:Plan trip' }
        operation: 'deleteTask'
        syncState: 'pending'
    `);

    await flushAllTimers();

    // The delete was sent with the id the server assigned, never the temp id.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      ['createTask "Plan trip"', 'deleteTask tasks||3']
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['1: Write report', '2: Review budget']
    `);
    expect({
      tempPayload: env.apiStore.getItemState('temp:Plan trip'),
      finalPayload: env.apiStore.getItemState('tasks||3'),
    }).toMatchInlineSnapshot(`
      finalPayload: null
      tempPayload: null
    `);
    // The deleted row never comes back to the list while the creation and the
    // delete are replayed.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | tasks                                         |
      0     | Write report, Review budget                   | [tasks] ui-initialized
      3.01s | Write report, Review budget                   | -- offline: create a task and rename it
      .     | Write report, Review budget, Plan trip        | [tasks] ui-changed
      .     | Write report, Review budget, Plan trip        | offline:createTask queued
      .     | Write report, Review budget, Plan summer trip | [tasks] ui-changed
      .     | Write report, Review budget, Plan summer trip | offline:renameTask queued
      .     | Write report, Review budget, Plan summer trip | -- back online: the creation request is sent
      .     | Write report, Review budget, Plan summer trip | offline:createTask replay-started
      3.31s | Write report, Review budget, Plan summer trip | -- delete the task while its creation is in flight
      .     | Write report, Review budget                   | [tasks] ui-changed
      .     | Write report, Review budget                   | offline:deleteTask queued
      4.21s | Write report, Review budget                   | [tasks||3] server-data-changed (value: {"id":3,"name":"Plan trip"})
      .     | Write report, Review budget                   | offline:createTask replay-finished
      .     | Write report, Review budget                   | offline:deleteTask replay-started
      .     | Write report, Review budget                   | [tasks||3] >delete-item-started (value: {"id":3,"name":"Plan trip"})
      5.05s | Write report, Review budget                   | [tasks||3] <delete-item-persisted (value: {"id":3,"name":"Plan trip"})
      5.41s | Write report, Review budget                   | offline:deleteTask replay-finished
      5.42s | Write report, Review budget                   | 🔴 >list-fetch-started
      6.22s | Write report, Review budget                   | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('deleting a task whose creation may have reached the server keeps the creation, and a not-found answer to the delete counts as done', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'delete-task-unconfirmed-session',
      'delete-task-unconfirmed-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', ['offline: create a task']);
    await env.createTask('Plan trip');

    // The creation fails in a way that does not tell whether the server got
    // it. The delete request will reach the server but its answer is lost.
    env.faults.createTask.push('request-lost');
    env.faults.deleteTask.push('response-lost');

    env.addTimelineComments('beforeNextAction', [
      'back online: the creation request fails with an unknown outcome',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(100);

    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
        syncState: 'needs-confirmation'
    `);

    env.addTimelineComments('beforeNextAction', [
      'delete the task while its creation is unconfirmed',
    ]);
    await env.deleteTask('temp:Plan trip');

    // Dropping the creation here could leave a task on the server that the
    // user deleted. Both stay queued: the delete is sent once the creation
    // is confirmed and the server id is known.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
        syncState: 'needs-confirmation'
      - input: { itemId: 'temp:Plan trip' }
        operation: 'deleteTask'
        syncState: 'pending'
    `);
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"']`,
    );

    env.addTimelineComments('beforeNextAction', [
      'the creation is retried and confirmed, then the delete is sent',
    ]);
    await flushAllTimers();

    // 1. the creation is retried and the server assigns `tasks||3`
    // 2. the delete is sent with that id; the server deletes the task but the
    //    answer is lost
    // 3. the delete is retried: the server answers not-found, which the
    //    operation treats as success instead of asking the user what to do
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'deleteTask tasks||3'
      - 'deleteTask tasks||3'
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore.getOfflineResolutions().map(summarizeResolution),
    ).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['1: Write report', '2: Review budget']
    `);
    expect({
      tempPayload: env.apiStore.getItemState('temp:Plan trip'),
      finalPayload: env.apiStore.getItemState('tasks||3'),
    }).toMatchInlineSnapshot(`
      finalPayload: null
      tempPayload: null
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | tasks                                  |
      0      | Write report, Review budget            | [tasks] ui-initialized
      3.01s  | Write report, Review budget            | -- offline: create a task
      .      | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | Write report, Review budget, Plan trip | offline:createTask queued
      .      | Write report, Review budget, Plan trip | -- back online: the creation request fails with an unknown outcome
      .      | Write report, Review budget, Plan trip | offline:createTask replay-started
      3.11s  | Write report, Review budget, Plan trip | -- delete the task while its creation is unconfirmed
      .      | Write report, Review budget            | [tasks] ui-changed
      .      | Write report, Review budget            | offline:deleteTask queued
      8.01s  | Write report, Review budget            | -- the creation is retried and confirmed, then the delete is sent
      .      | Write report, Review budget            | offline:createTask replay-started
      9.21s  | Write report, Review budget            | [tasks||3] server-data-changed (value: {"id":3,"name":"Plan trip"})
      .      | Write report, Review budget            | offline:createTask replay-finished
      .      | Write report, Review budget            | offline:deleteTask replay-started
      .      | Write report, Review budget            | [tasks||3] >delete-item-started (value: {"id":3,"name":"Plan trip"})
      10.05s | Write report, Review budget            | [tasks||3] <delete-item-persisted (value: {"id":3,"name":"Plan trip"})
      15.41s | Write report, Review budget            | offline:deleteTask replay-started
      .      | Write report, Review budget            | offline:deleteTask replay-finished
      15.42s | Write report, Review budget            | 🔴 >list-fetch-started
      16.22s | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('deleting a task whose failed creation was sent again by the user still keeps the creation', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'delete-task-retried-creation-session',
      'delete-task-retried-creation-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    await env.createTask('Plan trip');

    // Before anything was sent the creation can still be cancelled locally.
    expect(env.apiStore.getItemOfflineState('temp:Plan trip'))
      .toMatchInlineSnapshot(`
        creationAttempted: '❌'
        isUnsentCreation: '✅'
        pendingMutations: 1
        requiresResolution: '❌'
        syncState: 'pending'
      `);

    // The creation fails on every attempt (3) without telling whether the
    // server got it, and asks for a manual decision.
    env.faults.createTask.push('request-lost', 'request-lost', 'request-lost');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const failedCreation = env.apiStore.getOfflineResolutions()[0];
    if (!failedCreation) throw new Error('Expected the failed task creation');

    // The user loses the connection again and asks to send the creation
    // again: it goes back to the queue, waiting for the connection.
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry' },
      );
    });

    // Waiting in the queue again does not make the creation "never sent".
    expect(env.apiStore.getItemOfflineState('temp:Plan trip'))
      .toMatchInlineSnapshot(`
        creationAttempted: '✅'
        isUnsentCreation: '✅'
        pendingMutations: 1
        requiresResolution: '❌'
        syncState: 'pending'
      `);

    await env.deleteTask('temp:Plan trip');

    // One of the failed attempts may have reached the server, so the creation
    // is not dropped: the delete waits for it.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
        syncState: 'pending'
      - input: { itemId: 'temp:Plan trip' }
        operation: 'deleteTask'
        syncState: 'pending'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // 3 failed attempts, the attempt asked by the user, then the delete with
    // the id assigned by the server.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'deleteTask tasks||3'
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['1: Write report', '2: Review budget']
    `);

    list.unmount();
  });
});

describe('collection items', () => {
  type NoteItem = { name: string };
  type NotesOperations = {
    createNote: CollectionOfflineOperationDefinition<
      { value: NoteItem },
      string,
      { name: string },
      unknown,
      { id: string; name: string }
    >;
    renameNote: CollectionOfflineOperationDefinition<
      { value: NoteItem },
      string,
      { itemId: string; name: string },
      unknown
    >;
    deleteNote: CollectionOfflineOperationDefinition<
      { value: NoteItem },
      string,
      { itemId: string },
      unknown
    >;
  };
  type NotesEnv = ReturnType<
    typeof createCollectionStoreTestEnv<NoteItem, NotesOperations>
  >;

  const noteSchema = rc_object({ value: rc_object({ name: rc_string }) });

  /**
   * A notes collection with offline create (temp items `temp:<name>`, the
   * server assigns `notes||2`), rename and delete. The delete cancels the
   * creation of a note that was never sent.
   *
   * Unlike the task list above, this app does not remove a deleted note from
   * its state by itself: it waits for the delete to be confirmed.
   */
  function createNotesEnv(sessionKey: string, storeName: string) {
    const sentRequests: string[] = [];

    const env: NotesEnv = createCollectionStoreTestEnv<
      NoteItem,
      NotesOperations
    >(
      { 'notes||1': { name: 'Groceries' } },
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        storeManager: createStoreManagerForSession(sessionKey),
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: noteSchema,
          payloadSchema: rc_string,
          offline: {
            operations: {
              createNote: {
                inputSchema: collectionCreateInputSchema,
                kind: 'create',
                getEntityRefs: ({ input }) => [`temp:${input.name}`],
                tempEntity: {
                  buildPendingEntity: (input) => ({
                    value: { name: input.name },
                  }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: result.id,
                    finalData: { value: { name: result.name } },
                  }),
                },
                execute: async ({ input }) => {
                  sentRequests.push(`createNote "${input.name}"`);
                  const result = { id: 'notes||2', name: input.name };
                  await env.serverTable.delayedSetItem(result.id, {
                    name: result.name,
                  });
                  return result;
                },
              },
              renameNote: {
                inputSchema: userPatchSchema,
                kind: 'update',
                getEntityRefs: ({ input }) => [input.itemId],
                execute: async ({ input }) => {
                  sentRequests.push(
                    `renameNote ${input.itemId} to "${input.name}"`,
                  );
                  await env.serverTable.delayedUpdateItem(input.itemId, {
                    name: input.name,
                  });
                  return { value: { name: input.name } };
                },
                onSuccessExecute: ({ input }) => {
                  env.apiStore.updateItemState(input.itemId, (draft) => {
                    draft.value.name = input.name;
                  });
                },
              },
              deleteNote: {
                inputSchema: deleteItemInputSchema,
                kind: 'delete',
                getEntityRefs: ({ input }) => [input.itemId],
                supersedes: {
                  scope: 'same-entity',
                  dropSelfIfTempLifecycleCancelled: true,
                },
                execute: async ({ input }) => {
                  sentRequests.push(`deleteNote ${input.itemId}`);
                  await env.serverTable.deleteItem(input.itemId);
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

    function createNote(name: string) {
      return act(async () => {
        await env.apiStore.performMutation(null, {
          mutation: async () => {
            const result = { id: 'notes||2', name };
            await env.serverTable.delayedSetItem(result.id, { name });
            return result;
          },
          offline: { operation: 'createNote', input: { name } },
        });
      });
    }

    function renameNote(itemId: string, name: string) {
      return act(async () => {
        await env.apiStore.performMutation(itemId, {
          optimisticUpdate: () => {
            env.apiStore.updateItemState(itemId, (draft) => {
              draft.value.name = name;
            });
          },
          mutation: async () => {
            await env.serverTable.delayedUpdateItem(itemId, { name });
            return { value: { name } };
          },
          offline: { operation: 'renameNote', input: { itemId, name } },
        });
      });
    }

    /** No optimistic update: the note stays until the delete is confirmed. */
    function deleteNote(itemId: string) {
      return act(async () => {
        await env.apiStore.performMutation(itemId, {
          mutation: () => env.serverTable.deleteItem(itemId),
          offline: { operation: 'deleteNote', input: { itemId } },
        });
      });
    }

    /**
     * Tracks in the timeline the note the store holds under its temp payload
     * and under its final payload (read from the store, without fetching).
     */
    function trackNote() {
      return renderHook(() => {
        const notes = env.store.useSelector(() =>
          ['temp:Ideas', 'notes||2'].map(
            (payload) =>
              env.apiStore.getItemState(payload)?.data?.value.name ?? 'no note',
          ),
        );

        env.trackItemUI('temp:Ideas', notes[0]);
        env.trackItemUI('notes||2', notes[1]);
      });
    }

    return {
      ...env,
      // `timelineString` is a getter: spreading `env` would freeze its value.
      get timelineString() {
        return env.timelineString;
      },
      sentRequests,
      createNote,
      renameNote,
      deleteNote,
      trackNote,
      getQueue: () =>
        getSortedQueueSummary(sessionKey, storeName, [
          'operation',
          'input',
          'syncState',
        ]),
    };
  }

  test('deleting an item created offline drops its creation and its edits without sending anything, and removes the item', async () => {
    network.setOffline();
    const env = createNotesEnv(
      'cancel-unsent-note-session',
      'cancel-unsent-note-store',
    );
    const note = env.trackNote();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'offline: create a note and rename it',
    ]);
    await env.createNote('Ideas');
    await env.renameNote('temp:Ideas', 'Ideas for the trip');

    env.addTimelineComments('beforeNextAction', [
      'offline: delete the note that was never sent',
    ]);
    await env.deleteNote('temp:Ideas');

    // No delete will ever be confirmed by the server, since nothing is sent:
    // the store removes the note that only existed locally.
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect({
      note: env.apiStore.getItemState('temp:Ideas'),
      offlineState: env.apiStore.getItemOfflineState('temp:Ideas'),
    }).toMatchInlineSnapshot(`
      note: null
      offlineState: null
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.addTimelineComments('afterLastAction', [
      'back online: there was nothing to send',
    ]);

    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.serverTable.getAll()).toMatchInlineSnapshot(
      `notes||1: { name: 'Groceries' }`,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time | notes||2 | temp:Ideas         |
      0    | no note  | no note            | [temp:Ideas, notes||2] ui-initialized
      .    | no note  | no note            | -- offline: create a note and rename it
      .    | no note  | Ideas              | [temp:Ideas] ui-changed
      .    | no note  | Ideas              | offline:createNote queued
      .    | no note  | Ideas for the trip | [temp:Ideas] ui-changed
      .    | no note  | Ideas for the trip | offline:renameNote queued
      .    | no note  | Ideas for the trip | -- offline: delete the note that was never sent
      .    | no note  | no note            | [temp:Ideas] ui-changed
      .    | no note  | no note            | offline:deleteNote queued
      .    | no note  | no note            | -- back online: there was nothing to send
      "
    `);

    note.unmount();
  });

  test('deleting an item while its creation is being sent deletes it on the server once its id is known', async () => {
    network.setOffline();
    const env = createNotesEnv(
      'delete-note-in-flight-session',
      'delete-note-in-flight-store',
    );
    const note = env.trackNote();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'offline: create a note and rename it',
    ]);
    await env.createNote('Ideas');
    await env.renameNote('temp:Ideas', 'Ideas for the trip');

    env.addTimelineComments('beforeNextAction', [
      'back online: the creation request is sent',
    ]);
    act(() => {
      network.goOnline();
    });
    // The creation request takes 1.2s: it is in flight now.
    await advanceTime(300);

    env.addTimelineComments('beforeNextAction', [
      'delete the note while its creation is in flight',
    ]);
    await env.deleteNote('temp:Ideas');

    // The creation is kept, the delete waits for the server id, and the
    // rename, never sent, is superseded by the delete.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Ideas' }
        operation: 'createNote'
        syncState: 'syncing'
      - input: { itemId: 'temp:Ideas' }
        operation: 'deleteNote'
        syncState: 'pending'
    `);

    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(`
      ['createNote "Ideas"', 'deleteNote notes||2']
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.serverTable.getAll()).toMatchInlineSnapshot(
      `notes||1: { name: 'Groceries' }`,
    );
    // The note shows under its server id while the delete is sent, then it
    // is removed when the server confirms the delete.
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | notes||2 | temp:Ideas         |
      0     | no note  | no note            | [temp:Ideas, notes||2] ui-initialized
      .     | no note  | no note            | -- offline: create a note and rename it
      .     | no note  | Ideas              | [temp:Ideas] ui-changed
      .     | no note  | Ideas              | offline:createNote queued
      .     | no note  | Ideas for the trip | [temp:Ideas] ui-changed
      .     | no note  | Ideas for the trip | offline:renameNote queued
      .     | no note  | Ideas for the trip | -- back online: the creation request is sent
      .     | no note  | Ideas for the trip | offline:createNote replay-started
      300ms | no note  | Ideas for the trip | -- delete the note while its creation is in flight
      .     | no note  | Ideas for the trip | offline:deleteNote queued
      1.2s  | no note  | Ideas for the trip | [notes||2] server-data-changed (value: {"name":"Ideas"})
      .     | no note  | Ideas for the trip | offline:createNote replay-finished
      .     | Ideas    | no note            | [temp:Ideas, notes||2] ui-changed
      .     | Ideas    | no note            | offline:deleteNote replay-started
      .     | Ideas    | no note            | [notes||2] >delete-item-started (value: {"name":"Ideas"})
      2.04s | Ideas    | no note            | [notes||2] <delete-item-persisted (value: {"name":"Ideas"})
      2.4s  | Ideas    | no note            | offline:deleteNote replay-finished
      .     | no note  | no note            | [notes||2] ui-changed
      "
    `);

    note.unmount();
  });
});

describe('items of other stores', () => {
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
  };
  type CommentsEnv = ReturnType<
    typeof createCollectionStoreTestEnv<CommentItem, CommentsOperations>
  >;

  const commentInputSchema = rc_object({ text: rc_string, taskId: rc_string });
  const commentSchema = rc_object({ value: commentInputSchema });
  const editCommentInputSchema = rc_object({
    itemId: rc_string,
    text: rc_string,
  });

  /**
   * A task list plus a separate comments collection in the same offline
   * session. Comments can be added offline (temp items `temp:<text>`), also
   * to a task that was itself created offline: `cancelledWith` tells the
   * comments store which task of the tasks store a queued comment belongs to.
   */
  function createTasksAndCommentsEnv(sessionKey: string) {
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
      sentRequests,
      addComment,
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

  test('deleting a task created offline also drops the comments queued on it in the comments store', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('cancel-unsent-task-with-comments');
    const list = env.renderTasksAndComments();
    await flushAllTimers();

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: create a task, comment on it and on an existing task',
    ]);
    await env.tasks.createTask('Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.addComment('Ask Ana about dates', 'temp:Plan trip');
    await env.editComment(
      'temp:Ask Ana about dates',
      'Ask Ana about the dates',
    );
    await env.addComment('Due on friday', 'tasks||1');

    expect(env.getSessionQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
      - input: { taskId: 'temp:Plan trip', text: 'Ask Ana about dates' }
        operation: 'addComment'
      - input: { itemId: 'temp:Ask Ana about dates', text: 'Ask Ana about the dates' }
        operation: 'editComment'
      - input: { taskId: 'tasks||1', text: 'Due on friday' }
        operation: 'addComment'
    `);

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: delete the task that was never sent',
    ]);
    await env.tasks.deleteTask('temp:Plan trip');
    await flushAllTimers();

    // The comment written on the cancelled task (and its edit) would be sent
    // for a task that will never exist: both are dropped and the comment is
    // removed locally. The comment on the existing task is untouched.
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`
      - input: { taskId: 'tasks||1', text: 'Due on friday' }
        operation: 'addComment'
    `);
    expect(
      env.getLocalComments(['temp:Ask Ana about dates', 'temp:Due on friday']),
    ).toMatchInlineSnapshot(`
      temp:Ask Ana about dates: null
      temp:Due on friday: 'Due on friday'
    `);
    expect(
      env.comments.apiStore.getOfflineEntities().map((e) => e.entityKey),
    ).toMatchInlineSnapshot(`['"temp:Due on friday']`);

    env.tasks.addTimelineComments('beforeNextAction', [
      'back online: only the comment on the existing task is sent',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect([
      ...env.tasks.sentRequests,
      ...env.sentRequests,
    ]).toMatchInlineSnapshot(`['addComment "Due on friday" to tasks||1']`);
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time  | comments                               | tasks                                  |
      0     | no comments                            | Write report, Review budget            | [tasks, comments] ui-initialized
      3.01s | no comments                            | Write report, Review budget            | -- offline: create a task, comment on it and on an existing task
      .     | no comments                            | Write report, Review budget, Plan trip | [tasks] ui-changed
      .     | no comments                            | Write report, Review budget, Plan trip | offline:createTask queued
      4.01s | Ask Ana about the dates, Due on friday | Write report, Review budget, Plan trip | [comments, comments, comments] ui-changed
      .     | Ask Ana about the dates, Due on friday | Write report, Review budget, Plan trip | -- offline: delete the task that was never sent
      .     | Due on friday                          | Write report, Review budget            | [tasks, comments] ui-changed
      .     | Due on friday                          | Write report, Review budget            | offline:deleteTask queued
      6.22s | Due on friday                          | Write report, Review budget            | -- back online: only the comment on the existing task is sent
      .     | Due on friday                          | Write report, Review budget            | 🔴 >list-fetch-started
      7.02s | Due on friday                          | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('discarding a task creation the server keeps refusing also drops the comments queued on it afterwards', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('discard-failed-task-with-comments');
    const list = env.renderTasksAndComments();
    await flushAllTimers();

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: create a task',
    ]);
    await env.tasks.createTask('Plan trip');

    // The creation fails on every attempt (3) and asks for a manual decision.
    env.tasks.faults.createTask.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    env.tasks.addTimelineComments('beforeNextAction', [
      'back online: the creation keeps failing until it needs a manual decision',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const failedCreation = env.tasks.apiStore.getOfflineResolutions()[0];
    if (!failedCreation) throw new Error('Expected the failed task creation');
    expect(summarizeResolution(failedCreation)).toMatchInlineSnapshot(`
      error: 'connection lost'
      input: 'name: "Plan trip"'
      kind: 'retry-exhausted'
      on: 'item:temp:Plan trip'
      op: 'createTask'
      tempIds: ['temp:Plan trip']
    `);

    // The task row is still visible, waiting for the decision, and the user
    // comments on it after losing the connection again.
    env.tasks.addTimelineComments('beforeNextAction', [
      'offline again: comment on the task whose creation failed',
    ]);
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await env.addComment('Ask Ana about dates', 'temp:Plan trip');

    expect(env.getSessionQueue()).toMatchInlineSnapshot(`
      - input: { taskId: 'temp:Plan trip', text: 'Ask Ana about dates' }
        operation: 'addComment'
    `);

    env.tasks.addTimelineComments('beforeNextAction', [
      'discard the failed task creation',
    ]);
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    // The task will never exist, so its comment is dropped with it.
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      env.getLocalComments(['temp:Ask Ana about dates']),
    ).toMatchInlineSnapshot(`temp:Ask Ana about dates: null`);
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget']
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time   | comments            | tasks                                  |
      0      | no comments         | Write report, Review budget            | [tasks, comments] ui-initialized
      3.01s  | no comments         | Write report, Review budget            | -- offline: create a task
      .      | no comments         | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | no comments         | Write report, Review budget, Plan trip | offline:createTask queued
      .      | no comments         | Write report, Review budget, Plan trip | -- back online: the creation keeps failing until it needs a manual decision
      .      | no comments         | Write report, Review budget, Plan trip | offline:createTask replay-started
      8.01s  | no comments         | Write report, Review budget, Plan trip | offline:createTask replay-started
      13.01s | no comments         | Write report, Review budget, Plan trip | offline:createTask replay-started
      .      | no comments         | Write report, Review budget, Plan trip | offline:createTask resolution-required
      .      | no comments         | Write report, Review budget, Plan trip | -- offline again: comment on the task whose creation failed
      .      | Ask Ana about dates | Write report, Review budget, Plan trip | [comments] ui-changed
      .      | Ask Ana about dates | Write report, Review budget, Plan trip | -- discard the failed task creation
      .      | no comments         | Write report, Review budget            | [tasks, comments] ui-changed
      14.02s | no comments         | Write report, Review budget            | 🔴 >list-fetch-started
      14.82s | no comments         | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });
});

describe('tasks whose creation waits for a manual decision', () => {
  /**
   * Creates "Plan trip" offline, then lets its creation fail on every attempt
   * (3) until it asks for a manual decision. The server never got the task,
   * so the row still only has its temporary id.
   */
  async function createTaskWhoseCreationKeepsFailing(
    sessionKey: string,
    storeName: string,
  ) {
    network.setOffline();
    const env = createTasksEnv(sessionKey, storeName);
    const list = env.renderTaskList();
    await flushAllTimers();

    await env.createTask('Plan trip');
    env.faults.createTask.push('request-lost', 'request-lost', 'request-lost');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const failedCreation = env.apiStore.getOfflineResolutions()[0];
    if (!failedCreation) throw new Error('Expected the failed task creation');

    return { env, list, failedCreation };
  }

  test('a task renamed offline after its creation failed is not sent with its temporary id: the rename waits for the creation and is sent after it', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'rename-unresolved-task-session',
        'rename-unresolved-task-store',
      );

    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    env.addTimelineComments('beforeNextAction', [
      'offline: rename the task whose creation waits for a decision',
    ]);
    await env.renameTask('temp:Plan trip', 'Plan summer trip');

    env.addTimelineComments('beforeNextAction', [
      'back online: nothing can be sent for the task yet',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The server does not know `temp:Plan trip`: the rename is not sent. It
    // is held behind the creation, like an edit made before the creation
    // failed.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"', 'createTask "Plan trip"', 'createTask "Plan trip"']`,
    );
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
      .toMatchInlineSnapshot(`
        - blocks: 1
          error: 'connection lost'
          input: 'name: "Plan trip"'
          kind: 'retry-exhausted'
          on: 'item:temp:Plan trip'
          op: 'createTask'
          tempIds: ['temp:Plan trip']
        - blockedBy: 1
          error: 'Blocked by unresolved dependency'
          input: 'itemId: "temp:Plan trip", name: "Plan summer trip"'
          kind: 'retry-exhausted'
          on: 'item:temp:Plan trip'
          op: 'renameTask'
      `);
    // The user keeps seeing the edit.
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget', 'Plan summer trip']
    `);

    env.addTimelineComments('beforeNextAction', [
      'the user asks to send the creation again',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The creation goes first, then the rename with the id the server
    // assigned.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'renameTask tasks||3 to "Plan summer trip"'
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['1: Write report', '2: Review budget', '3: Plan summer trip']
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | tasks                                         |
      0      | Write report, Review budget                   | [tasks] ui-initialized
      3.01s  | Write report, Review budget, Plan trip        | [tasks] ui-changed
      .      | Write report, Review budget, Plan trip        | offline:createTask queued
      .      | Write report, Review budget, Plan trip        | offline:createTask replay-started
      8.01s  | Write report, Review budget, Plan trip        | offline:createTask replay-started
      13.01s | Write report, Review budget, Plan trip        | offline:createTask replay-started
      .      | Write report, Review budget, Plan trip        | offline:createTask resolution-required
      .      | Write report, Review budget, Plan trip        | -- offline: rename the task whose creation waits for a decision
      .      | Write report, Review budget, Plan summer trip | [tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip | offline:renameTask resolution-required
      .      | Write report, Review budget, Plan summer trip | offline:renameTask queued
      14.01s | Write report, Review budget, Plan summer trip | -- back online: nothing can be sent for the task yet
      .      | Write report, Review budget, Plan summer trip | -- the user asks to send the creation again
      .      | Write report, Review budget, Plan summer trip | offline:createTask replay-started
      15.21s | Write report, Review budget, Plan summer trip | [tasks||3] server-data-changed (value: {"id":3,"name":"Plan trip"})
      .      | Write report, Review budget, Plan summer trip | offline:createTask replay-finished
      .      | Write report, Review budget, Plan summer trip | [tasks, tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip | offline:renameTask replay-started
      16.41s | Write report, Review budget, Plan summer trip | [tasks||3] server-data-changed (value: {"name":"Plan summer trip"})
      .      | Write report, Review budget, Plan summer trip | offline:renameTask replay-finished
      16.42s | Write report, Review budget, Plan summer trip | 🔴 >list-fetch-started
      17.22s | Write report, Review budget, Plan summer trip | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    list.unmount();
  });

  test('a task renamed while online after its creation failed is not sent with its temporary id either', async () => {
    const { env, list } = await createTaskWhoseCreationKeepsFailing(
      'rename-online-unresolved-task-session',
      'rename-online-unresolved-task-store',
    );

    // The connection is fine, but the server does not know the task yet.
    await env.renameTask('temp:Plan trip', 'Plan summer trip');
    await flushAllTimers();

    // No update request was sent for the temporary id (neither by the replay
    // nor directly): the rename waits for the decision about the creation.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"', 'createTask "Plan trip"', 'createTask "Plan trip"']`,
    );
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy', 'blocks']),
        ),
    ).toMatchInlineSnapshot(`
      - { blocks: 1, op: 'createTask' }
      - { blockedBy: 1, op: 'renameTask' }
    `);
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget', 'Plan summer trip']
    `);

    list.unmount();
  });

  test('deleting a task whose creation failed keeps the creation: once the user sends it again, the task is created and then deleted on the server', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'delete-unresolved-task-session',
        'delete-unresolved-task-store',
      );

    env.addTimelineComments('beforeNextAction', [
      'delete the task whose creation waits for a decision',
    ]);
    await env.deleteTask('temp:Plan trip');
    await flushAllTimers();

    // One of the failed attempts may have reached the server, so the creation
    // is not dropped silently, and the delete cannot be sent with the
    // temporary id: it is held behind the creation.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"', 'createTask "Plan trip"', 'createTask "Plan trip"']`,
    );
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy', 'blocks']),
        ),
    ).toMatchInlineSnapshot(`
      - { blocks: 1, op: 'createTask' }
      - { blockedBy: 1, op: 'deleteTask' }
    `);

    env.addTimelineComments('beforeNextAction', [
      'the user asks to send the creation again',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The delete follows the creation, with the id the server assigned.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'deleteTask tasks||3'
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['1: Write report', '2: Review budget']
    `);
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget']
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | tasks                                  |
      0      | Write report, Review budget            | [tasks] ui-initialized
      3.01s  | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | Write report, Review budget, Plan trip | offline:createTask queued
      .      | Write report, Review budget, Plan trip | offline:createTask replay-started
      8.01s  | Write report, Review budget, Plan trip | offline:createTask replay-started
      13.01s | Write report, Review budget, Plan trip | offline:createTask replay-started
      .      | Write report, Review budget, Plan trip | offline:createTask resolution-required
      .      | Write report, Review budget, Plan trip | -- delete the task whose creation waits for a decision
      .      | Write report, Review budget            | [tasks] ui-changed
      .      | Write report, Review budget            | offline:deleteTask resolution-required
      .      | Write report, Review budget            | offline:deleteTask queued
      14.01s | Write report, Review budget            | -- the user asks to send the creation again
      .      | Write report, Review budget            | offline:createTask replay-started
      15.21s | Write report, Review budget            | [tasks||3] server-data-changed (value: {"id":3,"name":"Plan trip"})
      .      | Write report, Review budget            | offline:createTask replay-finished
      .      | Write report, Review budget            | offline:deleteTask replay-started
      .      | Write report, Review budget            | [tasks||3] >delete-item-started (value: {"id":3,"name":"Plan trip"})
      16.05s | Write report, Review budget            | [tasks||3] <delete-item-persisted (value: {"id":3,"name":"Plan trip"})
      16.41s | Write report, Review budget            | offline:deleteTask replay-finished
      16.42s | Write report, Review budget            | 🔴 >list-fetch-started
      17.22s | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('discarding a failed creation also drops the edit and the delete made after it failed, without sending anything', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'discard-unresolved-task-session',
        'discard-unresolved-task-store',
      );

    await env.renameTask('temp:Plan trip', 'Plan summer trip');
    await env.deleteTask('temp:Plan trip');
    await flushAllTimers();

    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    // Only the 3 failed creation attempts were ever sent.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"', 'createTask "Plan trip"', 'createTask "Plan trip"']`,
    );
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getItemState('temp:Plan trip')).toMatchInlineSnapshot(
      `null`,
    );
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget']
    `);

    list.unmount();
  });
});
