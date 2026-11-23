import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_array, rc_object, rc_string } from 'runcheck';
import { describe, expect, test } from 'vitest';
import type { CollectionOfflineOperationDefinition } from '../../src/main';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  advanceTime,
  flushAllTimers,
  pick,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import {
  createStoreManagerForSession,
  createTasksAndCommentsEnv,
  createTasksEnv,
  network,
  setupCancelUnsentCreationTests,
  tasksQuery,
} from './offlineCancelUnsentCreationShared';
import {
  deleteItemInputSchema,
  getSortedQueueSummary,
  userPatchSchema,
} from './offlineReplayTestShared';
import {
  collectionCreateInputSchema,
  summarizeResolution,
} from './offlineTestShared';

setupCancelUnsentCreationTests();

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
      .      | Write final report, Review budget                                       | [tasks, tasks] ui-changed
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

  test('deleting a subtask created offline with a client-generated id drops its creation, the subtask added under it and its edits, without sending anything', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'cancel-unsent-client-id-task-session',
      'cancel-unsent-client-id-task-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    // Offline: add a subtask with an id the app generates under a server
    // task, add another one under it, and rename the nested one.
    await env.createSubtaskWithId(50, 'Book flights', 'tasks||1');
    await env.createSubtaskWithId(51, 'Compare prices', 'tasks||50');
    await env.renameTask('tasks||51', 'Compare flight prices');

    // The subtask was never sent: its offline state tells the app that it
    // only exists locally, so deleting it sends nothing.
    expect(
      pick(env.apiStore.getItemOfflineState('tasks||50'), [
        'isUnsentCreation',
        'creationAttempted',
      ]),
    ).toMatchInlineSnapshot(`
      creationAttempted: '❌'
      isUnsentCreation: '✅'
    `);

    await env.deleteTask('tasks||50');
    await flushAllTimers();

    // The server never got the subtask: the delete cancels its creation
    // instead of being sent for an id the server does not know, and the
    // nested subtask and its rename, which depend on it, are dropped with it.
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget']
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Nothing is sent, and nothing is left for the user to resolve.
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    list.unmount();
  });

  test('deleting a task created offline while its debounced edit waits sends nothing once the app cancels the edit', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'cancel-debounced-edit-session',
      'cancel-debounced-edit-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    await env.createTaskWithId(50, 'Plan trip');

    // The task editor saves the name 5s after the last change
    const editDebounce = {
      context: 'edit-task',
      payload: 'tasks||50',
      ms: 5_000,
    };
    act(() => {
      void env.apiStore.performMutation('tasks||50', {
        debounce: editDebounce,
        optimisticUpdate: () => {
          env.apiStore.updateItemState('tasks||50', (item) => ({
            ...item,
            name: 'Plan trip to Rome',
          }));
        },
        mutation: async () => {
          await env.serverTable.delayedUpdateItem('tasks||50', {
            name: 'Plan trip to Rome',
          });
        },
        offline: {
          operation: 'editTask',
          input: { itemId: 'tasks||50', name: 'Plan trip to Rome' },
        },
      });
    });
    await advanceTime(1_000);

    // The edit is applied right away, and waits for the debounce window
    expect(pick(env.apiStore.getItemState('tasks||50'), ['name']))
      .toMatchInlineSnapshot(`
      name: 'Plan trip to Rome'
    `);

    // Within the debounce window the user deletes the task: the app cancels
    // the edit that is still waiting, so it is never queued, then deletes it
    act(() => {
      expect(env.apiStore.cancelDebouncedMutation(editDebounce)).toBe(true);
    });
    // The cancelled edit is reverted
    expect(pick(env.apiStore.getItemState('tasks||50'), ['name']))
      .toMatchInlineSnapshot(`
      name: 'Plan trip'
    `);

    await env.deleteTask('tasks||50');
    await flushAllTimers();

    // The delete cancelled the unsent creation, and the edit was never queued
    // for the task the server never got
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Review budget']`,
    );

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Nothing is sent, and nothing is left for the user to resolve
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    list.unmount();
  });

  test('deleting a subtask with a client-generated id whose direct creation request failed still deletes it on the server', async () => {
    const env = createTasksEnv(
      'delete-client-id-after-direct-attempt-session',
      'delete-client-id-after-direct-attempt-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    // Online: the subtask is created with a direct request. The server
    // creates it, but the connection drops before the answer arrives, so the
    // creation is queued for replay.
    let directCreation = Promise.resolve<unknown>(null);
    act(() => {
      directCreation = env.apiStore.performMutation('tasks||50', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'tasks||50',
            { id: 50, name: 'Book flights', parentId: 'tasks||1' },
            { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
          );
        },
        mutation: async () => {
          await env.serverTable.delayedSetItem('tasks||50', {
            id: 50,
            name: 'Book flights',
            parentId: 'tasks||1',
          });
          network.goOffline();
          throw new Error('connection lost');
        },
        offline: {
          operation: 'createSubtaskWithId',
          input: { id: 50, name: 'Book flights', parentId: 'tasks||1' },
        },
      });
    });
    await resolveAfterAllTimers(directCreation);
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { id: 50, name: 'Book flights', parentId: 'tasks||1' }
        operation: 'createSubtaskWithId'
        syncState: 'pending'
    `);
    // The server has not confirmed the subtask yet, but the failed request
    // may have created it: its creation counts as attempted.
    expect(
      pick(env.apiStore.getItemOfflineState('tasks||50'), [
        'isUnsentCreation',
        'creationAttempted',
      ]),
    ).toMatchInlineSnapshot(`
      creationAttempted: '✅'
      isUnsentCreation: '✅'
    `);

    // Still offline, the user deletes the subtask.
    await env.deleteTask('tasks||50');
    await flushAllTimers();

    // Cancelling the creation locally would leave the subtask on the server:
    // the delete is queued behind it instead.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { id: 50, name: 'Book flights', parentId: 'tasks||1' }
        operation: 'createSubtaskWithId'
        syncState: 'pending'
      - input: { itemId: 'tasks||50' }
        operation: 'deleteTask'
        syncState: 'pending'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The creation is sent again (it writes the same item), then the delete:
    // the server no longer has the subtask.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createSubtaskWithId tasks||50', 'deleteTask tasks||50']`,
    );
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget']`,
    );
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Review budget']`,
    );

    list.unmount();
  });

  test('deleting a subtask with a client-generated id whose creation the user sent again after a conflict still deletes it on the server', async () => {
    const env = createTasksEnv(
      'delete-client-id-after-conflict-requeue-session',
      'delete-client-id-after-conflict-requeue-store',
    );
    const list = env.renderTaskList();
    await flushAllTimers();

    // Online: the server creates the subtask, but the connection drops
    // before the answer arrives, so the creation is queued for replay.
    let directCreation = Promise.resolve<unknown>(null);
    act(() => {
      directCreation = env.apiStore.performMutation('tasks||50', {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'tasks||50',
            { id: 50, name: 'Book flights', parentId: 'tasks||1' },
            { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
          );
        },
        mutation: async () => {
          await env.serverTable.delayedSetItem('tasks||50', {
            id: 50,
            name: 'Book flights',
            parentId: 'tasks||1',
          });
          network.goOffline();
          throw new Error('connection lost');
        },
        offline: {
          operation: 'createSubtaskWithId',
          input: { id: 50, name: 'Book flights', parentId: 'tasks||1' },
        },
      });
    });
    await resolveAfterAllTimers(directCreation);

    // On reconnect the replay finds a task with that id on the server and
    // reports a conflict instead of sending the creation.
    env.conflicts.createSubtaskWithId = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.conflicts.createSubtaskWithId = false;
    const conflict = env.apiStore.getOfflineResolutions()[0];
    if (conflict?.kind !== 'conflict') {
      throw new Error('Expected the subtask creation conflict');
    }

    // Offline again, the user sends the creation again with the same id, then
    // deletes the subtask.
    act(() => {
      network.goOffline();
    });
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        conflict.id,
        'createSubtaskWithId',
        {
          action: 'requeue',
          input: { id: 50, name: 'Book flights', parentId: 'tasks||1' },
        },
      );
    });
    await env.deleteTask('tasks||50');
    await flushAllTimers();

    // The server may have the subtask (an earlier request created it), so the
    // creation sent again is not cancelled locally: the delete is queued
    // behind it.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { id: 50, name: 'Book flights', parentId: 'tasks||1' }
        operation: 'createSubtaskWithId'
        syncState: 'pending'
      - input: { itemId: 'tasks||50' }
        operation: 'deleteTask'
        syncState: 'pending'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // The creation is sent again (it writes the same item), then the delete:
    // the server no longer has the subtask.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createSubtaskWithId tasks||50', 'deleteTask tasks||50']`,
    );
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget']`,
    );
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Review budget']`,
    );

    list.unmount();
  });

  test('deleting a task created offline puts an existing task moved under it back under its server parent', async () => {
    network.setOffline();
    const env = createTasksEnv(
      'cancel-unsent-task-moved-session',
      'cancel-unsent-task-moved-store',
    );
    const list = env.renderTaskList();
    // Tracks where the existing task "Write report" is shown.
    const movedTask = renderHook(() => {
      const task = env.apiStore.useItem('tasks||1');
      env.trackItemUI(
        'tasks||1 parent',
        task.data ? (task.data.parentId ?? 'no parent') : '-',
      );
    });
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'offline: create a task and move an existing task under it',
    ]);
    await env.createTask('Plan trip');
    await env.moveTask('tasks||1', 'temp:Plan trip');

    env.addTimelineComments('beforeNextAction', [
      'offline: delete the task that was never sent',
    ]);
    await env.deleteTask('temp:Plan trip');

    // The move only made sense under the cancelled task: it is dropped with
    // it and never sent.
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);

    env.addTimelineComments('beforeNextAction', ['back online']);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Nothing was sent. The moved task cannot be rolled back locally, so it
    // is refetched as soon as the server is reachable: it shows its server
    // parent again instead of the task that never existed.
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getItemState('tasks||1')).toMatchInlineSnapshot(`
      id: 1
      name: 'Write report'
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | tasks                                  | tasks||1 parent |
      0     | Write report, Review budget            | no parent       | [tasks, tasks||1 parent] ui-initialized
      3.01s | Write report, Review budget            | no parent       | -- offline: create a task and move an existing task under it
      .     | Write report, Review budget, Plan trip | no parent       | [tasks] ui-changed
      .     | Write report, Review budget, Plan trip | no parent       | offline:createTask queued
      .     | Write report, Review budget, Plan trip | temp:Plan trip  | [tasks||1 parent] ui-changed
      .     | Write report, Review budget, Plan trip | temp:Plan trip  | offline:moveTask queued
      .     | Write report, Review budget, Plan trip | temp:Plan trip  | -- offline: delete the task that was never sent
      .     | Write report, Review budget            | temp:Plan trip  | [tasks] ui-changed
      .     | Write report, Review budget            | temp:Plan trip  | offline:deleteTask queued
      3.02s | Write report, Review budget            | temp:Plan trip  | -- back online
      .     | Write report, Review budget            | temp:Plan trip  | 🔴 [tasks||1] >fetch-started
      .     | Write report, Review budget            | temp:Plan trip  | 🟠 >list-fetch-started
      3.82s | Write report, Review budget            | temp:Plan trip  | 🔴 [tasks||1] <fetch-finished (value: {"id":1,"name":"Write report"})
      .     | Write report, Review budget            | no parent       | [tasks||1 parent] ui-changed
      .     | Write report, Review budget            | no parent       | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);

    movedTask.unmount();
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

  test('after a restart, opening the screen of a note created offline shows it without fetching it from the server', async () => {
    const sessionKey = 'open-unsent-note-after-restart-session';
    const storeName = 'open-unsent-note-after-restart-store';
    network.setOffline();
    const first = createNotesEnv(sessionKey, storeName);
    await first.createNote('Ideas');
    await flushAllTimers();
    first.apiStore.dispose();

    // The app restarts online on the screen of the note: the note is restored
    // from storage as stale data, which a screen normally refetches when it
    // mounts
    resetSessionForTests();
    network.setOnline();
    const env = createNotesEnv(sessionKey, storeName);
    const noteScreen = renderHook(() =>
      env.apiStore.useItem('temp:Ideas', {
        selector: (item) => item?.value.name ?? null,
      }),
    );
    // A screen that requires fresh data always fetches the item when it mounts
    const freshNoteScreen = renderHook(() =>
      env.apiStore.useItem('temp:Ideas', {
        selector: (item) => item?.value.name ?? null,
        requireFreshData: true,
      }),
    );
    // A screen that requires fresh data only for data restored from storage
    // fetches the note too, since it was restored from storage
    const restoredNoteScreen = renderHook(() =>
      env.apiStore.useItem('temp:Ideas', {
        selector: (item) => item?.value.name ?? null,
        requireFreshData: 'ifFromStorage',
      }),
    );
    await flushAllTimers();

    // The server doesn't know the note until its creation is confirmed, so it
    // is not fetched, not even by the screens that require fresh data: all
    // screens show the local note instead of a not-found error, and the ones
    // that require fresh data don't keep loading
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
    expect(pick(noteScreen.result.current, ['status', 'data', 'error']))
      .toMatchInlineSnapshot(`
      data: 'Ideas'
      error: null
      status: 'success'
    `);
    expect(pick(freshNoteScreen.result.current, ['status', 'data', 'error']))
      .toMatchInlineSnapshot(`
      data: 'Ideas'
      error: null
      status: 'success'
    `);

    expect(pick(restoredNoteScreen.result.current, ['status', 'data', 'error']))
      .toMatchInlineSnapshot(`
      data: 'Ideas'
      error: null
      status: 'success'
    `);

    noteScreen.unmount();
    freshNoteScreen.unmount();
    restoredNoteScreen.unmount();
  });
});

describe('items of other stores', () => {
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

  test('deleting a task created offline also drops the edits of a comment added to it with a client-generated id', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('cancel-unsent-task-with-id-comment');
    const list = env.renderTasksAndComments();
    await flushAllTimers();

    // Offline: create a task, add a comment to it with an id generated by the
    // app, then edit the comment.
    await env.tasks.createTask('Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'temp:Plan trip',
    );
    await env.editComment('comments||c1', 'Ask Ana about the dates');

    expect(env.getSessionQueue()).toMatchInlineSnapshot(`
      - input: { name: 'Plan trip' }
        operation: 'createTask'
      - input: { id: 'comments||c1', taskId: 'temp:Plan trip', text: 'Ask Ana about dates' }
        operation: 'addCommentWithId'
      - input: { itemId: 'comments||c1', text: 'Ask Ana about the dates' }
        operation: 'editComment'
    `);

    await env.tasks.deleteTask('temp:Plan trip');
    await flushAllTimers();

    // The comment is cancelled with the task. Its edit would be sent for a
    // comment the server never gets: it is dropped with it.
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.getLocalComments(['comments||c1'])).toMatchInlineSnapshot(
      `comments||c1: null`,
    );

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Nothing is sent, and nothing is left for the user to resolve.
    expect([
      ...env.tasks.sentRequests,
      ...env.sentRequests,
    ]).toMatchInlineSnapshot(`[]`);
    expect(env.comments.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );

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

    // The task now only lives in its resolution record, and the user comments
    // on it (e.g. from a screen listing the work waiting for a decision)
    // after losing the connection again.
    env.tasks.addTimelineComments('beforeNextAction', [
      'offline again: comment on the task whose creation failed',
    ]);
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await env.addComment('Ask Ana about dates', 'temp:Plan trip');

    // The comment could not be sent before the task exists: instead of the
    // queue, it waits behind the creation of the task, in the comments store,
    // and like it only lives in its resolution record: it is not shown.
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      env.comments.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`- { blockedBy: 1, op: 'addComment' }`);

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
    expect(env.comments.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
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
      time   | comments    | tasks                                  |
      0      | no comments | Write report, Review budget            | [tasks, comments] ui-initialized
      3.01s  | no comments | Write report, Review budget            | -- offline: create a task
      .      | no comments | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | no comments | Write report, Review budget, Plan trip | offline:createTask queued
      .      | no comments | Write report, Review budget, Plan trip | -- back online: the creation keeps failing until it needs a manual decision
      .      | no comments | Write report, Review budget, Plan trip | offline:createTask replay-started
      8.01s  | no comments | Write report, Review budget, Plan trip | offline:createTask replay-started
      13.01s | no comments | Write report, Review budget, Plan trip | offline:createTask replay-started
      .      | no comments | Write report, Review budget, Plan trip | offline:createTask resolution-required
      .      | no comments | Write report, Review budget            | [tasks] ui-changed
      13.02s | no comments | Write report, Review budget            | 🔴 >list-fetch-started
      13.82s | no comments | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      15.83s | no comments | Write report, Review budget            | -- offline again: comment on the task whose creation failed
      .      | no comments | Write report, Review budget            | -- discard the failed task creation
      .      | no comments | Write report, Review budget            | 🟠 >list-fetch-started
      16.63s | no comments | Write report, Review budget            | 🟠 <list-fetch-finished (value: {"count":2})
      "
    `);

    list.unmount();
  });

  /**
   * Offline: creates task 50 with an id the app generates, then adds comment
   * c1 to it (also with a client-generated id, declared `cancelledWith` the
   * task) and edits the comment. Back online, the creation of the task fails
   * on every attempt (3) until it asks for a manual decision.
   */
  async function commentOnTaskWhoseCreationKeepsFailing(sessionKey: string) {
    network.setOffline();
    const env = createTasksAndCommentsEnv(sessionKey);
    const list = env.renderTasksAndComments();
    await flushAllTimers();

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: create task 50, add a comment to it and edit the comment',
    ]);
    await env.tasks.createTaskWithId(50, 'Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'tasks||50',
    );
    await advanceTime(1_000);
    await env.editComment('comments||c1', 'Ask Ana about the dates');

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

    return { env, list, failedCreation };
  }

  test('the comments of a task whose creation with a client-generated id keeps failing are not sent before it: they wait for its decision and are sent after it once the user sends it again', async () => {
    const { env, list, failedCreation } =
      await commentOnTaskWhoseCreationKeepsFailing('held-comments-retry');

    // Online, the user adds another comment to the task.
    env.tasks.addTimelineComments('beforeNextAction', [
      'online: add another comment to the task',
    ]);
    await env.addCommentWithId('comments||c2', 'Book flights', 'tasks||50');
    await flushAllTimers();

    // The comments would be sent for a task the server does not have: they
    // are held behind the creation of the task, in the comments store (also
    // the one added online, which is not sent directly), and the edit waits
    // behind its comment. Like the task, they only live in their resolution
    // records, so they are not shown. The only decision the user can make is
    // the creation of the task.
    expect(env.tasks.sentRequests).toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
    `);
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      env.comments.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - { blockedBy: 1, op: 'addCommentWithId' }
      - { blockedBy: 1, op: 'editComment' }
      - { blockedBy: 1, op: 'addCommentWithId' }
    `);

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

    // The task is created first, then the comments and the edit, in the
    // order they were made.
    expect([...env.tasks.sentRequests.slice(3), ...env.sentRequests])
      .toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'addCommentWithId comments||c1 "Ask Ana about dates" to tasks||50'
      - 'editComment comments||c1 to "Ask Ana about the dates"'
      - 'addCommentWithId comments||c2 "Book flights" to tasks||50'
    `);
    expect(env.comments.serverTable.getAll()).toMatchInlineSnapshot(`
      comments||c1: { taskId: 'tasks||50', text: 'Ask Ana about the dates' }
      comments||c2: { taskId: 'tasks||50', text: 'Book flights' }
    `);
    // Nothing waits for a decision anymore, in either store.
    expect([
      ...env.tasks.apiStore.getOfflineResolutions(),
      ...env.comments.apiStore.getOfflineResolutions(),
    ]).toMatchInlineSnapshot(`[]`);
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time   | comments                              | tasks                                  |
      0      | no comments                           | Write report, Review budget            | [tasks, comments] ui-initialized
      3.01s  | no comments                           | Write report, Review budget            | -- offline: create task 50, add a comment to it and edit the comment
      .      | no comments                           | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | no comments                           | Write report, Review budget, Plan trip | offline:createTaskWithId queued
      4.01s  | Ask Ana about dates                   | Write report, Review budget, Plan trip | [comments] ui-changed
      5.01s  | Ask Ana about the dates               | Write report, Review budget, Plan trip | [comments] ui-changed
      .      | Ask Ana about the dates               | Write report, Review budget, Plan trip | -- back online: the task creation keeps failing until it needs a decision
      .      | Ask Ana about the dates               | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      10.01s | Ask Ana about the dates               | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      15.01s | Ask Ana about the dates               | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      .      | Ask Ana about the dates               | Write report, Review budget, Plan trip | offline:createTaskWithId resolution-required
      .      | no comments                           | Write report, Review budget            | [tasks, comments] ui-changed
      15.02s | no comments                           | Write report, Review budget            | 🔴 >list-fetch-started
      15.82s | no comments                           | Write report, Review budget            | 🔴 <list-fetch-finished (value: {"count":2})
      16.82s | no comments                           | Write report, Review budget            | -- online: add another comment to the task
      .      | no comments                           | Write report, Review budget            | [comments, comments] ui-changed
      17.82s | no comments                           | Write report, Review budget            | -- the user asks to send the task creation again
      .      | no comments                           | Write report, Review budget            | offline:createTaskWithId replay-started
      19.02s | no comments                           | Write report, Review budget            | [tasks||50] server-data-changed (value: {"id":50,"name":"Plan trip"})
      .      | no comments                           | Write report, Review budget            | offline:createTaskWithId replay-finished
      19.03s | no comments                           | Write report, Review budget            | 🟠 [tasks||50] >fetch-started
      19.83s | no comments                           | Write report, Review budget            | 🟠 [tasks||50] <fetch-finished (value: {"id":50,"name":"Plan trip"})
      21.03s | Ask Ana about dates                   | Write report, Review budget            | [comments] ui-changed
      21.42s | Ask Ana about the dates               | Write report, Review budget            | [comments] ui-changed
      22.63s | Ask Ana about the dates               | Write report, Review budget            | 🟡 >list-fetch-started
      23.43s | Ask Ana about the dates, Book flights | Write report, Review budget            | [comments] ui-changed
      .      | Ask Ana about the dates, Book flights | Write report, Review budget            | 🟡 <list-fetch-finished (value: {"count":3})
      .      | Ask Ana about the dates, Book flights | Write report, Review budget, Plan trip | [tasks] ui-changed
      "
    `);

    list.unmount();
  });

  test('discarding the failed creation of a task with a client-generated id drops the comments held behind it, without sending them', async () => {
    const { env, list, failedCreation } =
      await commentOnTaskWhoseCreationKeepsFailing('held-comments-discard');

    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    // The comment and its edit go with the task: nothing is sent for them,
    // nothing is left to decide, and the comment is removed locally.
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.comments.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(env.getLocalComments(['comments||c1'])).toMatchInlineSnapshot(
      `comments||c1: null`,
    );
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Review budget']`,
    );

    list.unmount();
  });

  test('a comment held while the creation of its task waits for a conflict decision is sent once the user keeps the task the server has', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('held-comment-commit');
    await env.tasks.createTaskWithId(50, 'Plan trip');
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'tasks||50',
    );

    // On reconnect the server already has a task with that id: the creation
    // reports a conflict, and the comment waits behind it.
    env.tasks.conflicts.createTaskWithId = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.tasks.conflicts.createTaskWithId = false;
    const conflict = env.tasks.apiStore.getOfflineResolutions()[0];
    if (conflict?.kind !== 'conflict') {
      throw new Error('Expected the task creation conflict');
    }
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);

    // The user keeps the task of the server: the comment is sent to it.
    env.tasks.serverTable.setItem('tasks||50', { id: 50, name: 'Plan trip' });
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        conflict.id,
        'createTaskWithId',
        { action: 'commit' },
      );
    });
    await flushAllTimers();

    // Keeping the task sends nothing for it, and the comment held behind its
    // creation is queued again and sent to it.
    expect([
      ...env.tasks.sentRequests,
      ...env.sentRequests,
    ]).toMatchInlineSnapshot(
      `['addCommentWithId comments||c1 "Ask Ana about dates" to tasks||50']`,
    );
    expect(env.comments.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('a comment added online while the creation of its task is still queued is not sent before it: it joins the queue and is sent after the task', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('online-comment-behind-queued-task');
    const list = env.renderTasksAndComments();
    await flushAllTimers();

    env.tasks.addTimelineComments('beforeNextAction', [
      'offline: create task 50',
    ]);
    await env.tasks.createTaskWithId(50, 'Plan trip');

    // Back online, the first request of the creation is lost: the creation
    // stays queued and is sent again after the retry interval (5s).
    env.tasks.faults.createTaskWithId.push('request-lost');
    env.tasks.addTimelineComments('beforeNextAction', [
      'back online: the first request of the task creation is lost',
    ]);
    act(() => {
      network.goOnline();
    });
    await advanceTime(1_000);

    // Online, before the creation is sent again, the user comments on the
    // task. Sent directly (1.2s), the comment would reach the server before
    // its task exists there.
    env.tasks.addTimelineComments('beforeNextAction', [
      'online: comment on the task while its creation waits to be sent again',
    ]);
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'tasks||50',
    );
    await advanceTime(2_000);

    // The comment was queued behind the creation of its task instead: nothing
    // was sent for it yet.
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`
      - input: { id: 50, name: 'Plan trip' }
        operation: 'createTaskWithId'
      - input: { id: 'comments||c1', taskId: 'tasks||50', text: 'Ask Ana about dates' }
        operation: 'addCommentWithId'
    `);
    expect(env.comments.serverTable.getAll()).toMatchInlineSnapshot(`{}`);

    await flushAllTimers();

    // The creation is sent again and succeeds, then the comment is sent by
    // the replay of the queue.
    expect([...env.tasks.sentRequests, ...env.sentRequests])
      .toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'addCommentWithId comments||c1 "Ask Ana about dates" to tasks||50'
    `);
    expect(env.getSessionQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.comments.serverTable.getAll()).toMatchInlineSnapshot(
      `comments||c1: { taskId: 'tasks||50', text: 'Ask Ana about dates' }`,
    );
    expect(env.tasks.timelineString).toMatchInlineSnapshot(`
      "
      time   | comments            | tasks                                  |
      0      | no comments         | Write report, Review budget            | [tasks, comments] ui-initialized
      3.01s  | no comments         | Write report, Review budget            | -- offline: create task 50
      .      | no comments         | Write report, Review budget, Plan trip | [tasks] ui-changed
      .      | no comments         | Write report, Review budget, Plan trip | offline:createTaskWithId queued
      .      | no comments         | Write report, Review budget, Plan trip | -- back online: the first request of the task creation is lost
      .      | no comments         | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      4.01s  | no comments         | Write report, Review budget, Plan trip | -- online: comment on the task while its creation waits to be sent again
      .      | Ask Ana about dates | Write report, Review budget, Plan trip | [comments] ui-changed
      8.01s  | Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-started
      9.21s  | Ask Ana about dates | Write report, Review budget, Plan trip | [tasks||50] server-data-changed (value: {"id":50,"name":"Plan trip"})
      .      | Ask Ana about dates | Write report, Review budget, Plan trip | offline:createTaskWithId replay-finished
      10.42s | Ask Ana about dates | Write report, Review budget, Plan trip | 🔴 >list-fetch-started
      11.22s | Ask Ana about dates | Write report, Review budget, Plan trip | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    list.unmount();
  });

  test('a comment added online while the creation of its task is still queued waits for the decision about that creation once it fails for good', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('online-comment-held-with-task');
    await env.tasks.createTaskWithId(50, 'Plan trip');

    // Back online, the creation fails on every attempt (3), 5s apart.
    env.tasks.faults.createTaskWithId.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    act(() => {
      network.goOnline();
    });
    await advanceTime(1_000);

    // Online, between two attempts, the user comments on the task.
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'tasks||50',
    );
    await flushAllTimers();

    // The creation now waits for a manual decision. The comment was never
    // sent: it is held behind the creation, and follows its decision.
    expect(
      env.tasks.apiStore
        .getOfflineResolutions()
        .map((resolution) => resolution.operation),
    ).toMatchInlineSnapshot(`['createTaskWithId']`);
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.comments.serverTable.getAll()).toMatchInlineSnapshot(`{}`);
    expect(
      env.comments.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`- { blockedBy: 1, op: 'addCommentWithId' }`);
  });

  /**
   * What a sync-problems screen listing the resolutions of every store of
   * the session (`storeManager.getOfflineResolutions()`) shows for the
   * comments store.
   */
  function getSessionWideCommentResolutions(
    env: ReturnType<typeof createTasksAndCommentsEnv>,
  ) {
    return env.storeManager
      .getOfflineResolutions()
      .filter((resolution) => resolution.storeName === env.commentsStoreName)
      .map((resolution) =>
        pick(summarizeResolution(resolution), ['op', 'blockedBy']),
      );
  }

  test('once the user sends only the failed task creation again, the session-wide list stops showing its held comments as blocked', async () => {
    const { env, list, failedCreation } =
      await commentOnTaskWhoseCreationKeepsFailing('held-comments-retry-self');

    // While the creation waits for a decision, the session-wide list shows
    // the comment and its edit as blocked: nothing can be decided on them.
    expect(getSessionWideCommentResolutions(env)).toMatchInlineSnapshot(`
      - { blockedBy: 1, op: 'addCommentWithId' }
      - { blockedBy: 1, op: 'editComment' }
    `);

    // The user sends only the task creation again (`scope: 'self'`): the
    // work held behind it is left for them to decide.
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry', scope: 'self' },
      );
    });
    await flushAllTimers();

    // Only the task was sent. Its resolution is gone, so the comment is not
    // blocked anymore in the session-wide list either (a screen that only
    // offers actions for unblocked resolutions would otherwise never let the
    // user send it), and its edit only waits for the comment.
    expect(env.tasks.sentRequests.slice(3)).toMatchInlineSnapshot(
      `['createTaskWithId tasks||50']`,
    );
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(env.tasks.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
    expect(getSessionWideCommentResolutions(env)).toMatchInlineSnapshot(`
      - op: 'addCommentWithId'
      - { blockedBy: 1, op: 'editComment' }
    `);

    list.unmount();
  });

  test('once the user creates the conflicted task under another id, the session-wide list stops showing its held comment as blocked', async () => {
    network.setOffline();
    const env = createTasksAndCommentsEnv('held-comment-requeue-new-id');
    await env.tasks.createTaskWithId(50, 'Plan trip');
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'tasks||50',
    );

    // On reconnect the server already has a task with that id: the creation
    // reports a conflict, and the comment waits behind it.
    env.tasks.conflicts.createTaskWithId = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.tasks.conflicts.createTaskWithId = false;
    const conflict = env.tasks.apiStore.getOfflineResolutions()[0];
    if (conflict?.kind !== 'conflict') {
      throw new Error('Expected the task creation conflict');
    }
    expect(getSessionWideCommentResolutions(env)).toMatchInlineSnapshot(
      `- { blockedBy: 1, op: 'addCommentWithId' }`,
    );

    // The user creates the task again, with a new id.
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        conflict.id,
        'createTaskWithId',
        { action: 'requeue', input: { id: 51, name: 'Plan trip' } },
      );
    });
    await flushAllTimers();

    // The comment targets task 50, which the replacement does not create: it
    // is not sent, and is left for the user to send or discard. The
    // session-wide list shows it as no longer waiting for anything.
    expect(env.tasks.sentRequests).toMatchInlineSnapshot(
      `['createTaskWithId tasks||51']`,
    );
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(getSessionWideCommentResolutions(env)).toMatchInlineSnapshot(
      `- op: 'addCommentWithId'`,
    );
  });

  test('a reaction to a comment held behind the failed creation of its task is sent after both once the user sends the task creation again', async () => {
    type ReactionItem = { emoji: string; commentId: string };
    type ReactionInput = { id: string; emoji: string; commentId: string };
    type ReactionsOperations = {
      addReactionWithId: CollectionOfflineOperationDefinition<
        { value: ReactionItem },
        string,
        ReactionInput,
        unknown
      >;
    };

    network.setOffline();
    const sessionKey = 'held-reaction-retry';
    const env = createTasksAndCommentsEnv(sessionKey);

    // A third store of the session: reactions to comments, added with a
    // client-generated id and declared `cancelledWith` their comment, like
    // the comments are with their task. Its requests are logged with the
    // ones of the comments store, to assert the order they are sent in.
    const reactions = createCollectionStoreTestEnv<
      ReactionItem,
      ReactionsOperations
    >(
      {},
      {
        id: `${sessionKey}-reactions`,
        getSessionKey: () => sessionKey,
        storeManager: env.storeManager,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: rc_object({
            value: rc_object({ emoji: rc_string, commentId: rc_string }),
          }),
          payloadSchema: rc_string,
          offline: {
            operations: {
              addReactionWithId: {
                inputSchema: rc_object({
                  id: rc_string,
                  emoji: rc_string,
                  commentId: rc_string,
                }),
                kind: 'create',
                getEntityRefs: ({ input }) => [input.id],
                cancelledWith: ({ input }) => [
                  {
                    storeName: env.commentsStoreName,
                    entityRef: input.commentId,
                  },
                ],
                execute: async ({ input: { id, emoji, commentId } }) => {
                  env.sentRequests.push(
                    `addReactionWithId ${id} "${emoji}" to ${commentId}`,
                  );
                  await reactions.serverTable.delayedSetItem(id, {
                    emoji,
                    commentId,
                  });
                },
                onSuccessExecute: () => {},
              },
            },
          },
        },
      },
    );

    function addReactionWithId({ id, emoji, commentId }: ReactionInput) {
      return act(async () => {
        await reactions.apiStore.performMutation(id, {
          optimisticUpdate: () => {
            reactions.apiStore.addItemToState(id, {
              value: { emoji, commentId },
            });
          },
          mutation: () =>
            reactions.serverTable.delayedSetItem(id, { emoji, commentId }),
          offline: {
            operation: 'addReactionWithId',
            input: { id, emoji, commentId },
          },
        });
      });
    }

    // Offline: create task 50, comment on it and react to the comment.
    await env.tasks.createTaskWithId(50, 'Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c1',
      'Ask Ana about dates',
      'tasks||50',
    );
    await advanceTime(1_000);
    await addReactionWithId({
      id: 'reactions||r1',
      emoji: 'thumbs-up',
      commentId: 'comments||c1',
    });

    // Back online, the task creation fails on every attempt (3) until it
    // asks for a manual decision.
    env.tasks.faults.createTaskWithId.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    const failedCreation = env.tasks.apiStore.getOfflineResolutions()[0];
    if (failedCreation?.operation !== 'createTaskWithId') {
      throw new Error('Expected the failed task creation');
    }

    // Nothing is sent for a task the server does not have: the comment waits
    // for the task, and the reaction for the comment.
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(
      [
        ...env.comments.apiStore.getOfflineResolutions(),
        ...reactions.apiStore.getOfflineResolutions(),
      ].map((resolution) =>
        pick(summarizeResolution(resolution), ['op', 'blockedBy']),
      ),
    ).toMatchInlineSnapshot(`
      - { blockedBy: 1, op: 'addCommentWithId' }
      - { blockedBy: 1, op: 'addReactionWithId' }
    `);

    // The user asks to send the task creation again.
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The whole chain follows the decision: the task is created, then its
    // comment, then the reaction to that comment, and nothing is left for
    // the user to decide.
    expect([...env.tasks.sentRequests.slice(3), ...env.sentRequests])
      .toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'addCommentWithId comments||c1 "Ask Ana about dates" to tasks||50'
      - 'addReactionWithId reactions||r1 "thumbs-up" to comments||c1'
    `);
    expect(reactions.serverTable.getAll()).toMatchInlineSnapshot(
      `reactions||r1: { commentId: 'comments||c1', emoji: 'thumbs-up' }`,
    );
    expect(env.storeManager.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
  });

  type LinkedItem = { belongsTo: string[] };
  type LinkedItemInput = {
    id: string;
    belongsTo: { storeName: string; id: string }[];
  };
  type LinkedItemsOperations = {
    addWithId: CollectionOfflineOperationDefinition<
      { value: LinkedItem },
      string,
      LinkedItemInput,
      unknown
    >;
  };

  /**
   * One more store of the session, whose items are added with a
   * client-generated id and declared `cancelledWith` the items of other
   * stores they belong to. Its requests are logged with the ones of the
   * comments store, to assert the order they are sent in.
   */
  function createLinkedItemsStore(
    env: ReturnType<typeof createTasksAndCommentsEnv>,
    sessionKey: string,
    name: string,
  ) {
    const storeName = `${sessionKey}-${name}`;
    const linkedItems = createCollectionStoreTestEnv<
      LinkedItem,
      LinkedItemsOperations
    >(
      {},
      {
        id: storeName,
        getSessionKey: () => sessionKey,
        storeManager: env.storeManager,
        testScenario: 'loaded',
        persistentStorage: {
          adapter: 'local-sync',
          schema: rc_object({
            value: rc_object({ belongsTo: rc_array(rc_string) }),
          }),
          payloadSchema: rc_string,
          offline: {
            operations: {
              addWithId: {
                inputSchema: rc_object({
                  id: rc_string,
                  belongsTo: rc_array(
                    rc_object({ storeName: rc_string, id: rc_string }),
                  ),
                }),
                kind: 'create',
                getEntityRefs: ({ input }) => [input.id],
                cancelledWith: ({ input }) =>
                  input.belongsTo.map((parent) => ({
                    storeName: parent.storeName,
                    entityRef: parent.id,
                  })),
                execute: async ({ input }) => {
                  env.sentRequests.push(`add ${input.id}`);
                  await linkedItems.serverTable.delayedSetItem(input.id, {
                    belongsTo: input.belongsTo.map((parent) => parent.id),
                  });
                },
                onSuccessExecute: () => {},
              },
            },
          },
        },
      },
    );

    function add(id: string, belongsTo: LinkedItemInput['belongsTo']) {
      const value = { belongsTo: belongsTo.map((parent) => parent.id) };
      return act(async () => {
        await linkedItems.apiStore.performMutation(id, {
          optimisticUpdate: () => {
            linkedItems.apiStore.addItemToState(id, { value });
          },
          mutation: () => linkedItems.serverTable.delayedSetItem(id, value),
          offline: { operation: 'addWithId', input: { id, belongsTo } },
        });
      });
    }

    return { storeName, add, env: linkedItems };
  }

  test('work that belongs to items of two stores, both held behind the same failed task creation, is sent only once after the user sends the task creation again', async () => {
    network.setOffline();
    const sessionKey = 'held-shared-descendant-retry';
    const env = createTasksAndCommentsEnv(sessionKey);

    // Files attached to a task, and quotes of a file inside a comment: a
    // quote belongs to both its comment and its file.
    const files = createLinkedItemsStore(env, sessionKey, 'files');
    const quotes = createLinkedItemsStore(env, sessionKey, 'quotes');

    // Offline: create task 50, comment on it, attach a file to it and quote
    // the file in the comment.
    await env.tasks.createTaskWithId(50, 'Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c1',
      'See the itinerary',
      'tasks||50',
    );
    await advanceTime(1_000);
    await files.add('files||f1', [
      { storeName: env.tasksStoreName, id: 'tasks||50' },
    ]);
    await advanceTime(1_000);
    await quotes.add('quotes||q1', [
      { storeName: env.commentsStoreName, id: 'comments||c1' },
      { storeName: files.storeName, id: 'files||f1' },
    ]);

    // Back online, the task creation fails on every attempt (3) until it
    // asks for a manual decision.
    env.tasks.faults.createTaskWithId.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    const failedCreation = env.tasks.apiStore.getOfflineResolutions()[0];
    if (failedCreation?.operation !== 'createTaskWithId') {
      throw new Error('Expected the failed task creation');
    }

    // Nothing is sent for a task the server does not have: the comment and
    // the file wait for the task, and the quote for both of them.
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(
      [
        ...files.env.apiStore.getOfflineResolutions(),
        ...quotes.env.apiStore.getOfflineResolutions(),
      ].map((resolution) =>
        pick(summarizeResolution(resolution), ['op', 'blockedBy']),
      ),
    ).toMatchInlineSnapshot(`
      - { blockedBy: 1, op: 'addWithId' }
      - { blockedBy: 2, op: 'addWithId' }
    `);

    // The user asks to send the task creation again.
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The comment and the file are released together by the task, and each
    // of them releases the quote: the quote is still sent only once, after
    // both.
    expect([...env.tasks.sentRequests.slice(3), ...env.sentRequests])
      .toMatchInlineSnapshot(`
        - 'createTaskWithId tasks||50'
        - 'addCommentWithId comments||c1 "See the itinerary" to tasks||50'
        - 'add files||f1'
        - 'add quotes||q1'
      `);
    expect(quotes.env.serverTable.getAll()).toMatchInlineSnapshot(`
      quotes||q1:
        belongsTo: ['comments||c1', 'files||f1']
    `);
    expect(env.storeManager.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('work that belongs to items of two stores is sent after both of them, even when one of the stores sends more held work than the other', async () => {
    network.setOffline();
    const sessionKey = 'held-shared-descendant-order';
    const env = createTasksAndCommentsEnv(sessionKey);
    const files = createLinkedItemsStore(env, sessionKey, 'files');
    const quotes = createLinkedItemsStore(env, sessionKey, 'quotes');

    // Offline: create task 50, add three comments and one file to it, and
    // quote the file in the last comment.
    await env.tasks.createTaskWithId(50, 'Plan trip');
    // Mutations of different stores replay in the order they were made.
    await advanceTime(1_000);
    await env.addCommentWithId('comments||c1', 'Dates?', 'tasks||50');
    await advanceTime(1_000);
    await env.addCommentWithId('comments||c2', 'Budget?', 'tasks||50');
    await advanceTime(1_000);
    await env.addCommentWithId(
      'comments||c3',
      'See the itinerary',
      'tasks||50',
    );
    await advanceTime(1_000);
    await files.add('files||f1', [
      { storeName: env.tasksStoreName, id: 'tasks||50' },
    ]);
    await advanceTime(1_000);
    await quotes.add('quotes||q1', [
      { storeName: env.commentsStoreName, id: 'comments||c3' },
      { storeName: files.storeName, id: 'files||f1' },
    ]);

    // Back online, the task creation fails on every attempt (3) until it
    // asks for a manual decision, with everything else held behind it.
    env.tasks.faults.createTaskWithId.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    const failedCreation = env.tasks.apiStore.getOfflineResolutions()[0];
    if (failedCreation?.operation !== 'createTaskWithId') {
      throw new Error('Expected the failed task creation');
    }
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);

    // The user asks to send the task creation again.
    await act(async () => {
      await env.tasks.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The quote is sent after its comment, although the comments store had
    // three items to send again and the files store, which released the
    // quote, only one: a server that checks the comment exists would
    // otherwise refuse the quote.
    expect([...env.tasks.sentRequests.slice(3), ...env.sentRequests])
      .toMatchInlineSnapshot(`
        - 'createTaskWithId tasks||50'
        - 'addCommentWithId comments||c1 "Dates?" to tasks||50'
        - 'addCommentWithId comments||c2 "Budget?" to tasks||50'
        - 'addCommentWithId comments||c3 "See the itinerary" to tasks||50'
        - 'add files||f1'
        - 'add quotes||q1'
      `);
    expect(env.storeManager.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
  });

  test('work held behind two task creations that both wait for a decision is sent only once when the user decides both at the same time', async () => {
    network.setOffline();
    const sessionKey = 'held-shared-descendant-bulk-decision';
    const env = createTasksAndCommentsEnv(sessionKey);
    // Links between two tasks: a link belongs to both of them.
    const links = createLinkedItemsStore(env, sessionKey, 'links');

    // Offline: create tasks 50 and 51, and link them.
    await env.tasks.createTaskWithId(50, 'Plan trip');
    await advanceTime(1_000);
    await env.tasks.createTaskWithId(51, 'Book flights');
    await advanceTime(1_000);
    await links.add('links||l1', [
      { storeName: env.tasksStoreName, id: 'tasks||50' },
      { storeName: env.tasksStoreName, id: 'tasks||51' },
    ]);

    // On reconnect the server already has tasks with those ids: both
    // creations report a conflict, and the link waits behind both.
    env.tasks.conflicts.createTaskWithId = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.tasks.conflicts.createTaskWithId = false;
    const conflicts = env.tasks.apiStore.getOfflineResolutions();
    expect(
      [...conflicts, ...links.env.apiStore.getOfflineResolutions()].map(
        (resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy']),
      ),
    ).toMatchInlineSnapshot(`
      - op: 'createTaskWithId'
      - op: 'createTaskWithId'
      - { blockedBy: 2, op: 'addWithId' }
    `);
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);

    // The user keeps the tasks of the server with a "keep all" action, which
    // decides both conflicts at the same time.
    env.tasks.serverTable.setItem('tasks||50', { id: 50, name: 'Plan trip' });
    env.tasks.serverTable.setItem('tasks||51', {
      id: 51,
      name: 'Book flights',
    });
    await act(async () => {
      await Promise.all(
        conflicts.map(async (conflict) => {
          await env.tasks.apiStore.resolveOfflineResolution(
            conflict.id,
            'createTaskWithId',
            { action: 'commit' },
          );
        }),
      );
    });
    await flushAllTimers();

    // Each decision releases the link, which waits for nothing else once
    // both are made: it is still sent only once.
    expect(env.sentRequests).toMatchInlineSnapshot(`['add links||l1']`);
    expect(env.storeManager.getOfflineResolutions()).toMatchInlineSnapshot(
      `[]`,
    );
  });
});
