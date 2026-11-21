import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_object, rc_string } from 'runcheck';
import { describe, expect, test } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import {
  createStoreManagerForSession,
  createTasksEnv,
  network,
  setupCancelUnsentCreationTests,
  tasksQuery,
} from './offlineCancelUnsentCreationShared';
import { getSortedSessionQueueSummary } from './offlineReplayTestShared';
import { summarizeResolution } from './offlineTestShared';

setupCancelUnsentCreationTests();

const notesInputSchema = rc_object({ taskId: rc_string, text: rc_string });
const notesSchema = rc_object({ value: rc_object({ text: rc_string }) });

type NotesItem = { text: string };

type TasksEnvOptions = Parameters<typeof createTasksEnv>[3];

type NotesOperations = {
  saveNotes: CollectionOfflineOperationDefinition<
    { value: NotesItem },
    string,
    { taskId: string; text: string },
    unknown
  >;
};

type NotesEnv = ReturnType<
  typeof createCollectionStoreTestEnv<NotesItem, NotesOperations>
>;

/**
 * A task list plus a separate notes collection in the same offline session,
 * like an app that keeps the content of a document apart from the list of
 * documents. The notes of a task are keyed by the task id, and `saveNotes`
 * declares the task it belongs to with `cancelledWith`.
 *
 * - saving the notes of a task the server does not have fails with a
 *   not-found answer
 * - `notesFaults` makes the next notes saves fail with a server error
 */
function createTasksAndNotesEnv(
  sessionKey: string,
  tasksOptions?: TasksEnvOptions,
) {
  const tasksStoreName = `${sessionKey}-tasks`;
  const notesStoreName = `${sessionKey}-notes`;
  const storeManager = createStoreManagerForSession(sessionKey);
  const tasks = createTasksEnv(
    sessionKey,
    tasksStoreName,
    storeManager,
    tasksOptions,
  );
  const sentRequests: string[] = [];
  const notesFaults: 'server-error'[] = [];

  const notes: NotesEnv = createCollectionStoreTestEnv<
    NotesItem,
    NotesOperations
  >(
    { 'tasks||1': { text: 'Outline' } },
    {
      id: notesStoreName,
      getSessionKey: () => sessionKey,
      storeManager,
      testScenario: 'loaded',
      persistentStorage: {
        adapter: 'local-sync',
        schema: notesSchema,
        payloadSchema: rc_string,
        offline: {
          operations: {
            saveNotes: {
              inputSchema: notesInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.taskId],
              cancelledWith: ({ input }) => [
                { storeName: tasksStoreName, entityRef: input.taskId },
              ],
              execute: async ({ input }) => {
                sentRequests.push(`saveNotes ${input.taskId} "${input.text}"`);
                if (notesFaults.shift() === 'server-error') {
                  throw new Error('server error');
                }
                if (tasks.serverTable.get(input.taskId) === undefined) {
                  throw new Error(`Item not found: ${input.taskId}`);
                }
                await notes.serverTable.delayedSetItem(input.taskId, {
                  text: input.text,
                });
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  function saveNotes(taskId: string, text: string) {
    return act(async () => {
      await notes.apiStore.performMutation(taskId, {
        optimisticUpdate: () => {
          notes.apiStore.addItemToState(taskId, { value: { text } });
        },
        mutation: async () => {
          sentRequests.push(`saveNotes ${taskId} "${text}"`);
          await notes.serverTable.delayedSetItem(taskId, { text });
        },
        offline: { operation: 'saveNotes', input: { taskId, text } },
      });
    });
  }

  /**
   * Mounts the task list and tracks, in the timeline of the tasks store, the
   * visible tasks and the notes the notes store holds locally.
   */
  function renderTasksAndNotes() {
    return renderHook(() => {
      const query = tasks.apiStore.useListQuery(tasksQuery, {
        itemSelector: (item) => item.name,
      });
      const localNotes = notes.store.useSelector((state) =>
        // The state is keyed by the serialized payload (`"tasks||1`).
        Object.entries(state)
          .flatMap(([payload, entry]) =>
            entry?.data
              ? [`${payload.replace('"', '')}: ${entry.data.value.text}`]
              : [],
          )
          .join(', '),
      );

      tasks.trackItemUI('tasks', query.items.join(', '));
      tasks.trackItemUI('notes', localNotes || 'no notes');
      return query;
    });
  }

  return {
    tasks,
    notes,
    sentRequests,
    notesFaults,
    saveNotes,
    renderTasksAndNotes,
    /** Queued mutations of both stores, in replay order. */
    getSessionQueue: () =>
      getSortedSessionQueueSummary(sessionKey, ['operation', 'input']),
    /** Requests sent to the server by both stores, tasks first. */
    getSentRequests: () => [...tasks.sentRequests, ...sentRequests],
  };
}

describe('work of other stores declared cancelledWith a deleted entity', () => {
  /**
   * Offline: creates task 50 with an id the app generates and writes its
   * notes. Back online, the creation fails on every attempt (3) until it asks
   * for a manual decision: the notes are held behind it. The user then
   * deletes the task, which waits behind its creation too.
   */
  async function deleteTaskWhoseCreationKeepsFailing(
    sessionKey: string,
    tasksOptions?: TasksEnvOptions,
  ) {
    network.setOffline();
    const env = createTasksAndNotesEnv(sessionKey, tasksOptions);
    const list = env.renderTasksAndNotes();
    await flushAllTimers();

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: create task 50 and write its notes',
    ]);
    await env.tasks.createTaskWithId(50, 'Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.saveNotes('tasks||50', 'Ask Ana about dates');

    env.tasks.faults.createTaskWithId.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    env.tasks.addTimelineComments('beforeNextAction', [
      'back online: the task creation keeps failing until it needs a decision',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const failedCreation = env.tasks.apiStore.getOfflineResolutions()[0];
    if (failedCreation?.operation !== 'createTaskWithId') {
      throw new Error('Expected the failed task creation');
    }

    // The creation may have reached the server, so the delete can't cancel
    // it locally: it waits behind the creation, like the notes.
    env.tasks.addTimelineComments('beforeNextAction', [
      'the user deletes the task',
    ]);
    await env.tasks.deleteTask('tasks||50');
    await flushAllTimers();

    // Nothing is queued: the delete and the notes are both held behind the
    // failed creation, the only decision the user can make.
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      [
        ...env.tasks.apiStore.getOfflineResolutions(),
        ...env.notes.apiStore.getOfflineResolutions(),
      ].map((resolution) =>
        pick(summarizeResolution(resolution), ['op', 'blockedBy']),
      ),
    ).toMatchInlineSnapshot(`
      - op: 'createTaskWithId'
      - { blockedBy: 1, op: 'deleteTask' }
      - { blockedBy: 1, op: 'saveNotes' }
    `);

    return { env, list, failedCreation };
  }

  test('a delete of a task whose creation was attempted drops the notes queued for it in another store once it succeeds: the notes are never sent', async () => {
    const { env, list, failedCreation } =
      await deleteTaskWhoseCreationKeepsFailing('delete-drops-notes');

    env.tasks.addTimelineComments('beforeNextAction', [
      'the user asks to send the task creation again',
    ]);
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The retry queues the creation and the delete held behind it, then the
    // notes the creation released, so the notes come after the delete. Sent
    // then, they would be saved for a task the server no longer has (a
    // not-found error asking for a decision). Once the delete succeeds they
    // are dropped instead: after the 3 failed attempts, only the creation and
    // the delete are sent, and nothing is left for the user to resolve.
    expect(env.getSentRequests().slice(3)).toMatchInlineSnapshot(
      `['createTaskWithId tasks||50', 'deleteTask tasks||50']`,
    );
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.tasks.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.notes.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.tasks.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget']`,
    );
    expect(env.notes.serverTable.getAll()).toMatchInlineSnapshot(
      `tasks||1: { text: 'Outline' }`,
    );
    // The optimistic notes can't be rolled back locally: like any discarded
    // work, they are refetched the next time they are shown.
    expect(
      env.notes.apiStore.getItemState('tasks||50')?.refetchOnMount,
    ).toMatchInlineSnapshot(`"highPriority"`);
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time   | notes                                             | tasks                                  |
      0      | tasks||1: Outline                                 | Write report, Review budget            | [tasks, notes] ui-initialized
      12s    | tasks||1: Outline                                 | Write report, Review budget            | -- offline: create task 50 and write its notes
      .      | tasks||1: Outline                                 | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | tasks||1: Outline                                 | Write report, Review budget, Plan trip | offline:createTaskWithId queued
      13s    | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | [notes] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | -- back online: the task creation keeps failing until it needs a decision
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      18s    | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      23s    | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId resolution-required
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | -- the user deletes the task
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask resolution-required
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask queued
      24s    | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | -- the user asks to send the task creation again
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:createTaskWithId replay-started
      25.2s  | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] server-data-changed (value: {"id":50,"name":"Plan trip"})
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:createTaskWithId replay-finished
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask replay-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] >delete-item-started (value: {"id":50,"name":"Plan trip"})
      26.04s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] <delete-item-persisted (value: {"id":50,"name":"Plan trip"})
      26.4s  | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask replay-finished
      26.41s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🔴 >list-fetch-started
      27.21s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('a delete that fails until it needs a decision keeps the notes queued for the task, which are sent, and discarding it keeps the task', async () => {
    const { env, list, failedCreation } =
      await deleteTaskWhoseCreationKeepsFailing('failed-delete-keeps-notes');

    // The delete fails on every attempt (3) once it is sent.
    env.tasks.faults.deleteTask.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    env.tasks.addTimelineComments('beforeNextAction', [
      'the user asks to send the task creation again: the delete keeps failing',
    ]);
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // After the 3 failed creation attempts: the creation, then the 3 failed
    // delete attempts. The task still exists on the server, so the notes
    // queued after the delete are kept, and saved once the delete leaves the
    // queue for a decision.
    expect(env.getSentRequests().slice(3)).toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'deleteTask tasks||50'
      - 'deleteTask tasks||50'
      - 'deleteTask tasks||50'
      - 'saveNotes tasks||50 "Ask Ana about dates"'
    `);
    expect(env.notes.serverTable.getAll()).toMatchInlineSnapshot(`
      tasks||1: { text: 'Outline' }
      tasks||50: { text: 'Ask Ana about dates' }
    `);
    const failedDelete = env.tasks.apiStore.getOfflineResolutions()[0];
    if (failedDelete?.operation !== 'deleteTask') {
      throw new Error('Expected the failed delete');
    }

    env.tasks.addTimelineComments('beforeNextAction', [
      'the user discards the delete',
    ]);
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedDelete.id,
        'deleteTask',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    // The task and its notes stay, on the server and in the app.
    expect(env.tasks.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget', '50: Plan trip']`,
    );
    expect(env.notes.serverTable.getAll()).toMatchInlineSnapshot(`
      tasks||1: { text: 'Outline' }
      tasks||50: { text: 'Ask Ana about dates' }
    `);
    expect(env.notes.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time   | notes                                             | tasks                                  |
      0      | tasks||1: Outline                                 | Write report, Review budget            | [tasks, notes] ui-initialized
      3.01s  | tasks||1: Outline                                 | Write report, Review budget            | -- offline: create task 50 and write its notes
      .      | tasks||1: Outline                                 | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | tasks||1: Outline                                 | Write report, Review budget, Plan trip | offline:createTaskWithId queued
      4.01s  | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | [notes] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | -- back online: the task creation keeps failing until it needs a decision
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      9.01s  | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      14.01s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId resolution-required
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | -- the user deletes the task
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask resolution-required
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask queued
      15.01s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | -- the user asks to send the task creation again: the delete keeps failing
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:createTaskWithId replay-started
      16.21s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] server-data-changed (value: {"id":50,"name":"Plan trip"})
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:createTaskWithId replay-finished
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask replay-started
      21.21s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask replay-started
      26.21s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask replay-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask resolution-required
      28.42s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | -- the user discards the delete
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🔴 >list-fetch-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🟠 [tasks||50] >fetch-started
      29.22s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":3})
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | 🟠 [tasks||50] <fetch-finished (value: {"id":50,"name":"Plan trip"})
      "
    `);

    list.unmount();
  });

  test('a delete whose answer was lost drops the notes queued for the task once the server confirms the task is gone', async () => {
    const { env, list, failedCreation } =
      await deleteTaskWhoseCreationKeepsFailing(
        'confirmed-delete-drops-notes',
        // Before sending a delete again, this app asks the server whether the
        // task is already gone (`shouldSkipSync`).
        { deleteChecksServerBeforeRetry: true },
      );

    // The delete reaches the server, but its answer never arrives.
    env.tasks.faults.deleteTask.push('response-lost');
    env.tasks.addTimelineComments('beforeNextAction', [
      'the user asks to send the task creation again: the answer of the delete is lost',
    ]);
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // After the 3 failed creation attempts: the creation, then a single
    // delete request. Before sending it again the app finds the task gone
    // from the server, which completes the delete without another request.
    // A delete confirmed this way drops the notes like one that was answered:
    // they are never sent for the task the server no longer has.
    expect(env.getSentRequests().slice(3)).toMatchInlineSnapshot(
      `['createTaskWithId tasks||50', 'deleteTask tasks||50']`,
    );
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    // Nothing is left for the user to resolve, in either store.
    expect(env.tasks.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.notes.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.tasks.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget']`,
    );
    expect(env.notes.serverTable.getAll()).toMatchInlineSnapshot(
      `tasks||1: { text: 'Outline' }`,
    );
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time   | notes                                             | tasks                                  |
      0      | tasks||1: Outline                                 | Write report, Review budget            | [tasks, notes] ui-initialized
      3.01s  | tasks||1: Outline                                 | Write report, Review budget            | -- offline: create task 50 and write its notes
      .      | tasks||1: Outline                                 | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | tasks||1: Outline                                 | Write report, Review budget, Plan trip | offline:createTaskWithId queued
      4.01s  | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | [notes] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | -- back online: the task creation keeps failing until it needs a decision
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      9.01s  | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      14.01s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId resolution-required
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget, Plan trip | -- the user deletes the task
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks] ui-changed
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask resolution-required
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask queued
      15.01s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | -- the user asks to send the task creation again: the answer of the delete is lost
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:createTaskWithId replay-started
      16.21s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] server-data-changed (value: {"id":50,"name":"Plan trip"})
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:createTaskWithId replay-finished
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | offline:deleteTask replay-started
      .      | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] >delete-item-started (value: {"id":50,"name":"Plan trip"})
      17.05s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | [tasks||50] <delete-item-persisted (value: {"id":50,"name":"Plan trip"})
      22.42s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🔴 >list-fetch-started
      23.22s | tasks||1: Outline, tasks||50: Ask Ana about dates | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  test('a delete sent online drops the notes another store still has queued for the task', async () => {
    network.setOffline();
    const env = createTasksAndNotesEnv('online-delete-drops-notes');
    const list = env.renderTasksAndNotes();
    await flushAllTimers();

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: edit the notes of task 1',
    ]);
    await env.saveNotes('tasks||1', 'Outline and budget');

    // Back online, the notes save fails once and waits to be sent again
    // (after 5s).
    env.notesFaults.push('server-error');
    env.tasks.addTimelineComments('beforeNextAction', [
      'back online: the notes save fails once and waits to be sent again',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(1_000);
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`
      - input: { taskId: 'tasks||1', text: 'Outline and budget' }
        operation: 'saveNotes'
    `);

    // Meanwhile the user deletes the task: nothing of the tasks store is
    // queued, so the delete is sent right away.
    env.tasks.addTimelineComments('beforeNextAction', [
      'the user deletes task 1 online',
    ]);
    let directDelete = Promise.resolve<unknown>(null);
    act(() => {
      directDelete = env.tasks.apiStore.performMutation('tasks||1', {
        optimisticUpdate: () => {
          env.tasks.apiStore.deleteItemState('tasks||1');
        },
        mutation: () => {
          env.tasks.sentRequests.push('deleteTask tasks||1');
          return env.tasks.serverTable.deleteItem('tasks||1');
        },
        offline: { operation: 'deleteTask', input: { itemId: 'tasks||1' } },
      });
    });
    await resolveAfterAllTimers(directDelete);
    await flushAllTimers();

    // The delete was sent directly (no "queued" step in the timeline below).
    // The only notes request is the failed attempt made before it: the task is
    // gone from the server, so the queued notes are dropped instead of being
    // sent again 5s later, and nothing is left for the user to resolve.
    expect(env.getSentRequests()).toMatchInlineSnapshot(
      `['deleteTask tasks||1', 'saveNotes tasks||1 "Outline and budget"']`,
    );
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.notes.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.tasks.getServerTasks()).toMatchInlineSnapshot(
      `['2: Review budget']`,
    );
    expect(
      env.notes.apiStore.getItemState('tasks||1')?.refetchOnMount,
    ).toMatchInlineSnapshot(`"highPriority"`);
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time  | notes                        | tasks                       |
      0     | tasks||1: Outline            | Write report, Review budget | [tasks, notes] ui-initialized
      3.01s | tasks||1: Outline            | Write report, Review budget | -- offline: edit the notes of task 1
      .     | tasks||1: Outline and budget | Write report, Review budget | [notes] ui-changed
      4.01s | tasks||1: Outline and budget | Write report, Review budget | -- back online: the notes save fails once and waits to be sent again
      .     | tasks||1: Outline and budget | Write report, Review budget | -- the user deletes task 1 online
      .     | tasks||1: Outline and budget | Review budget               | [tasks] ui-changed
      .     | tasks||1: Outline and budget | Review budget               | [tasks||1] >delete-item-started (value: {"id":1,"name":"Write report"})
      4.85s | tasks||1: Outline and budget | Review budget               | [tasks||1] <delete-item-persisted (value: {"id":1,"name":"Write report"})
      5.22s | tasks||1: Outline and budget | Review budget               | 🔴 >list-fetch-started
      6.02s | tasks||1: Outline and budget | Review budget               | 🔴 <list-fetch-finished (value: {"count":1})
      "
    `);

    list.unmount();
  });
});
