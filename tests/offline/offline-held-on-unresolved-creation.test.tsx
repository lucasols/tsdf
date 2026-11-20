import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { flushAllTimers, pick } from '../utils/genericTestUtils';
import {
  createTasksEnv,
  network,
  setupCancelUnsentCreationTests,
} from './offlineCancelUnsentCreationShared';
import { summarizeResolution } from './offlineTestShared';

setupCancelUnsentCreationTests();

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
      12s    | Write report, Review budget, Plan trip        | [tasks] ui-changed
      .      | Write report, Review budget, Plan trip        | offline:createTask queued
      .      | Write report, Review budget, Plan trip        | offline:createTask replay-started
      17s    | Write report, Review budget, Plan trip        | offline:createTask replay-started
      22s    | Write report, Review budget, Plan trip        | offline:createTask replay-started
      .      | Write report, Review budget, Plan trip        | offline:createTask resolution-required
      .      | Write report, Review budget, Plan trip        | -- offline: rename the task whose creation waits for a decision
      .      | Write report, Review budget, Plan summer trip | [tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip | offline:renameTask resolution-required
      .      | Write report, Review budget, Plan summer trip | offline:renameTask queued
      23s    | Write report, Review budget, Plan summer trip | -- back online: nothing can be sent for the task yet
      .      | Write report, Review budget, Plan summer trip | -- the user asks to send the creation again
      .      | Write report, Review budget, Plan summer trip | offline:createTask replay-started
      24.2s  | Write report, Review budget, Plan summer trip | [tasks||3] server-data-changed (value: {"id":3,"name":"Plan trip"})
      .      | Write report, Review budget, Plan summer trip | offline:createTask replay-finished
      .      | Write report, Review budget, Plan summer trip | [tasks, tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip | offline:renameTask replay-started
      25.4s  | Write report, Review budget, Plan summer trip | [tasks||3] server-data-changed (value: {"name":"Plan summer trip"})
      .      | Write report, Review budget, Plan summer trip | offline:renameTask replay-finished
      25.41s | Write report, Review budget, Plan summer trip | 🔴 >list-fetch-started
      26.21s | Write report, Review budget, Plan summer trip | 🔴 <list-fetch-finished (value: {"count":3})
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

  test('moving a task under the waiting task holds only the move, and a later rename is merged into the held move: each edit is sent in the order the user made it', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'merged-edit-unresolved-task-session',
        'merged-edit-unresolved-task-store',
      );

    act(() => {
      network.goOffline();
    });
    await flushAllTimers();

    // Offline: rename an existing task, move it under the task whose creation
    // waits for a decision, then rename it again. The edits of a task are
    // normally merged into one request.
    await env.editTask({ itemId: 'tasks||1', name: 'Write draft' });
    await env.editTask({ itemId: 'tasks||1', parentId: 'temp:Plan trip' });
    await env.editTask({ itemId: 'tasks||1', name: 'Write final report' });

    // The move cannot be sent before the waiting task exists: it waits with
    // the creation, on its own, leaving the first rename queued. The second
    // rename is newer than the move, so it is merged into the held move
    // rather than into the queued rename, which would be sent before the move
    // and then overwritten by it.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { itemId: 'tasks||1', name: 'Write draft' }
        operation: 'editTask'
        syncState: 'pending'
    `);
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
          input: 'itemId: "tasks||1", name: "Write final report", parentId: "temp:Plan trip"'
          kind: 'retry-exhausted'
          on: 'item:tasks||1'
          op: 'editTask'
      `);

    // Back online the rename is sent; then the user sends the creation again,
    // and the move follows it with the id the server assigned.
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'editTask tasks||1 {"name":"Write draft"}'
      - 'createTask "Plan trip"'
      - 'editTask tasks||1 {"name":"Write final report","parentId":"tasks||3"}'
    `);
    // The task keeps its last name: the held move carries it, and the
    // earlier rename sent first is not replayed after it.
    expect(pick(env.serverTable.getAll()['tasks||1'], ['name', 'parentId']))
      .toMatchInlineSnapshot(`
      name: 'Write final report'
      parentId: 'tasks||3'
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    list.unmount();
  });

  test('moving a task back out of the waiting task replaces the held move: sending the creation again does not move the task back under it', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'move-out-of-unresolved-task-session',
        'move-out-of-unresolved-task-store',
      );

    // Online: move an existing task under the task whose creation waits for a
    // decision. The move is held behind the creation.
    await env.editTask({ itemId: 'tasks||1', parentId: 'temp:Plan trip' });
    await flushAllTimers();

    // The user changes their mind and moves it under a server task instead.
    // The new move is merged into the held one, which no longer waits for
    // anything: it is sent right away.
    await env.editTask({ itemId: 'tasks||1', parentId: 'tasks||2' });
    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'createTask "Plan trip"'
      - 'editTask tasks||1 {"parentId":"tasks||2"}'
    `);
    // Only the creation is left for the user to decide.
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) => pick(summarizeResolution(resolution), ['op'])),
    ).toMatchInlineSnapshot(`- op: 'createTask'`);

    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // Sending the creation again does not replay the first move after the
    // second: the task stays where the user last put it.
    expect(env.sentRequests.slice(4)).toMatchInlineSnapshot(
      `['createTask "Plan trip"']`,
    );
    expect(
      pick(env.serverTable.getAll()['tasks||1'], ['parentId']),
    ).toMatchInlineSnapshot(`parentId: 'tasks||2'`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    list.unmount();
  });

  test('deleting a task whose move waits for the creation drops the held move: the delete is sent, and sending the creation again does not move the deleted task', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'delete-moved-task-session',
        'delete-moved-task-store',
      );

    // Online: move an existing task under the waiting task (held), then
    // delete the moved task.
    await env.editTask({ itemId: 'tasks||1', parentId: 'temp:Plan trip' });
    await env.deleteTask('tasks||1');
    await flushAllTimers();

    // The delete supersedes the held move, like a queued edit of the task:
    // the delete is sent, and only the creation is left to decide.
    expect(env.sentRequests.slice(3)).toMatchInlineSnapshot(
      `['deleteTask tasks||1']`,
    );
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) => pick(summarizeResolution(resolution), ['op'])),
    ).toMatchInlineSnapshot(`- op: 'createTask'`);

    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // Only the creation is sent: no move of the deleted task follows it.
    expect(env.sentRequests.slice(4)).toMatchInlineSnapshot(
      `['createTask "Plan trip"']`,
    );
    expect(env.getServerTasks()).toMatchInlineSnapshot(`
      ['2: Review budget', '3: Plan trip']
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

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

  test('discarding a failed creation also drops a subtask added to it with a client-generated id, and the edits of that subtask', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'discard-client-id-subtask-session',
        'discard-client-id-subtask-store',
      );

    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    // The subtask is held behind the creation of its parent. Its rename only
    // targets the subtask, which the server does not know yet either.
    await env.createSubtaskWithId(50, 'Book flights', 'temp:Plan trip');
    await env.renameTask('tasks||50', 'Book cheap flights');

    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    // The subtask will never be created, so its rename is dropped with it
    // instead of being sent later for a task the server does not have:
    // nothing is left to send or decide.
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(list.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget']
    `);

    list.unmount();
  });

  test('a subtask added to the waiting task reports its creation as never sent, and deleting it sends nothing', async () => {
    const { env, list } = await createTaskWhoseCreationKeepsFailing(
      'delete-held-subtask-session',
      'delete-held-subtask-store',
    );

    // The subtask creation waits behind the creation of its parent: it was
    // never sent, so the app can treat deleting it as a local-only change.
    await env.createSubtask('Book flights', 'temp:Plan trip');
    await flushAllTimers();
    expect(env.apiStore.getItemOfflineState('temp:Book flights'))
      .toMatchInlineSnapshot(`
      creationAttempted: '❌'
      isUnsentCreation: '✅'
      pendingMutations: 0
      requiresResolution: '✅'
      syncState: 'resolution-required'
    `);

    // Deleting it cancels the creation: nothing is sent for the subtask, and
    // only the decision about "Plan trip" is left.
    await env.deleteTask('temp:Book flights');
    await flushAllTimers();
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"', 'createTask "Plan trip"', 'createTask "Plan trip"']`,
    );
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['kind', 'op', 'tempIds']),
        ),
    ).toMatchInlineSnapshot(`
      - kind: 'retry-exhausted'
        op: 'createTask'
        tempIds: ['temp:Plan trip']
    `);
    expect(list.result.current.items).not.toContain('Book flights');

    list.unmount();
  });
});

describe('tasks whose creation waits for a conflict decision', () => {
  /**
   * Creates "Plan trip" offline, then reconnects while the server reports
   * that a task with that name already exists: the creation is not sent and
   * waits for the user's decision about the conflict.
   */
  async function createTaskWithConflict(sessionKey: string) {
    network.setOffline();
    const env = createTasksEnv(sessionKey, `${sessionKey}-tasks`);

    await env.createTask('Plan trip');
    env.conflicts.createTask = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.conflicts.createTask = false;

    const conflict = env.apiStore.getOfflineResolutions()[0];
    if (conflict?.kind !== 'conflict') {
      throw new Error('Expected the task creation conflict');
    }

    // The rename made while the creation waits for the decision cannot be
    // sent with the temporary id: it is held behind the creation.
    await env.renameTask('temp:Plan trip', 'Plan summer trip');
    await flushAllTimers();
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['kind', 'op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - { kind: 'conflict', op: 'createTask' }
      - { blockedBy: 1, kind: 'retry-exhausted', op: 'renameTask' }
    `);

    return { env, conflict };
  }

  test('a rename held while the creation waits for a conflict decision is sent after the creation the user sends again', async () => {
    const { env, conflict } = await createTaskWithConflict('requeue-conflict');

    // The user creates the task anyway, under another name.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(conflict.id, 'createTask', {
        action: 'requeue',
        input: { name: 'Plan trip again' },
      });
    });
    await flushAllTimers();

    // The creation goes first, then the held rename with the id the server
    // assigned, without asking the user to send it again.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip again"', 'renameTask tasks||3 to "Plan summer trip"']`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget', '3: Plan summer trip']`,
    );
  });

  test('a rename held while the creation waits for a conflict decision is sent to the task the user keeps from the server', async () => {
    const { env, conflict } = await createTaskWithConflict('commit-conflict');
    // The task another device created with that name.
    env.serverTable.setItem('tasks||9', { id: 9, name: 'Plan trip' });

    // The user keeps the task of the server instead of creating another one.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(conflict.id, 'createTask', {
        action: 'commit',
        result: { id: 9, name: 'Plan trip' },
      });
    });
    await flushAllTimers();

    // Nothing is created: the held rename is sent to the server task.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['renameTask tasks||9 to "Plan summer trip"']`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget', '9: Plan summer trip']`,
    );
  });

  test('a move held behind two waiting creations is sent only once the user decides both of them', async () => {
    // Offline, the user creates two tasks and moves the second under the
    // first.
    network.setOffline();
    const env = createTasksEnv('two-conflicts', 'two-conflicts-tasks');
    await env.createTask('Plan trip');
    await env.createTask('Book hotel');
    await env.moveTask('temp:Book hotel', 'temp:Plan trip');

    // On reconnect the server reports a conflict for both creations: the
    // move waits behind both of them.
    env.conflicts.createTask = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.conflicts.createTask = false;

    function getCreationConflict(name: string) {
      const conflict = env.apiStore
        .getOfflineResolutions()
        .find(
          (resolution) =>
            resolution.kind === 'conflict' &&
            resolution.tempIds?.includes(`temp:${name}`) === true,
        );
      if (!conflict) throw new Error(`Expected the "${name}" conflict`);
      return conflict;
    }
    const planTripConflict = getCreationConflict('Plan trip');
    const bookHotelConflict = getCreationConflict('Book hotel');
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['kind', 'op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - { kind: 'conflict', op: 'createTask' }
      - { kind: 'conflict', op: 'createTask' }
      - { blockedBy: 2, kind: 'retry-exhausted', op: 'moveTask' }
    `);

    // The user keeps the "Book hotel" task another device created.
    env.serverTable.setItem('tasks||9', { id: 9, name: 'Book hotel' });
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        bookHotelConflict.id,
        'createTask',
        { action: 'commit', result: { id: 9, name: 'Book hotel' } },
      );
    });
    await flushAllTimers();

    // "Plan trip" still has no server id: the move is not sent with its
    // temporary id, it keeps waiting for that decision.
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['kind', 'op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - { kind: 'conflict', op: 'createTask' }
      - { blockedBy: 1, kind: 'retry-exhausted', op: 'moveTask' }
    `);

    // The user creates "Plan trip" anyway: the move is sent after it, with
    // the ids of both tasks.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        planTripConflict.id,
        'createTask',
        { action: 'requeue', input: { name: 'Plan trip' } },
      );
    });
    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTask "Plan trip"', 'moveTask tasks||9 under tasks||3']`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  });

  test('a rename of a subtask whose creation the user sends again under a task still waiting for a decision keeps waiting for that task', async () => {
    // Offline, the user creates a task that will fail on every attempt (3),
    // a second task with a subtask, and renames the subtask.
    network.setOffline();
    const env = createTasksEnv(
      'requeue-under-held',
      'requeue-under-held-tasks',
    );
    await env.createTask('Holidays');
    await env.createTask('Plan trip');
    await env.createSubtask('Book flights', 'temp:Plan trip');
    await env.renameTask('temp:Book flights', 'Book cheap flights');

    // On reconnect "Holidays" never gets through and asks for a decision,
    // "Plan trip" is created, and the server reports a conflict for the
    // subtask: its rename waits behind that conflict.
    env.faults.createTask.push('request-lost', 'request-lost', 'request-lost');
    env.conflicts.createSubtask = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.conflicts.createSubtask = false;

    const resolutions = env.apiStore.getOfflineResolutions();
    const failedHolidays = resolutions.find(
      (resolution) => resolution.kind === 'retry-exhausted',
    );
    const subtaskConflict = resolutions.find(
      (resolution) => resolution.kind === 'conflict',
    );
    if (!failedHolidays || !subtaskConflict) {
      throw new Error('Expected the failed creation and the subtask conflict');
    }

    // The user creates the subtask anyway, under "Holidays" instead. That
    // creation cannot be sent before "Holidays" exists: it waits for it.
    env.sentRequests.length = 0;
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        subtaskConflict.id,
        'createSubtask',
        {
          action: 'requeue',
          input: { name: 'Book flights', parentId: 'temp:Holidays' },
        },
      );
    });
    await flushAllTimers();

    // The rename is not sent with the temporary id of the subtask: it keeps
    // waiting with the subtask creation, behind "Holidays".
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['kind', 'op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - { kind: 'retry-exhausted', op: 'createTask' }
      - { blockedBy: 1, kind: 'retry-exhausted', op: 'renameTask' }
      - { blockedBy: 1, kind: 'retry-exhausted', op: 'createSubtask' }
    `);

    // Once the user sends "Holidays" again, the subtask and its rename follow
    // it with the ids the server assigned.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedHolidays.id,
        'createTask',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTask "Holidays"'
      - 'createSubtask "Book flights" of tasks||4'
      - 'renameTask tasks||5 to "Book cheap flights"'
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
  });
});
