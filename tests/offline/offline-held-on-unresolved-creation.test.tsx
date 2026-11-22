import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test } from 'vitest';
import { advanceTime, flushAllTimers, pick } from '../utils/genericTestUtils';
import { resetSessionForTests } from '../utils/resetSessionForTests';
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
    options?: Parameters<typeof createTasksEnv>[3],
  ) {
    network.setOffline();
    const env = createTasksEnv(sessionKey, storeName, undefined, options);
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
    // The rename merged into the held move shows right away, like any other
    // queued edit.
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write final report', 'Review budget', 'Plan trip']`,
    );

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

  test('when moves and renames are kept apart, a rename made after a held move is sent first, and a later move is merged into the held move', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'refused-merge-held-move-session',
        'refused-merge-held-move-store',
        { keepMovesAndRenamesApart: true },
      );

    act(() => {
      network.goOffline();
    });
    await flushAllTimers();

    // Offline: move an existing task under the task whose creation waits for
    // a decision (held behind it), rename it, then move it again with another
    // name. The app never merges a move with a rename.
    await env.editTask({ itemId: 'tasks||1', parentId: 'temp:Plan trip' });
    await env.editTask({ itemId: 'tasks||1', name: 'Write draft' });
    await env.editTask({
      itemId: 'tasks||1',
      name: 'Write trip report',
      parentId: 'temp:Plan trip',
    });

    // The rename cannot be merged into the held move. It does not need the
    // waiting task, so it is queued on its own, and is sent before the move.
    // The last move is merged into the held move, not into the queued rename.
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
          input: 'itemId: "tasks||1", name: "Write trip report", parentId: "temp:Plan trip"'
          kind: 'retry-exhausted'
          on: 'item:tasks||1'
          op: 'editTask'
      `);

    // Back online the rename is sent; then the user sends the creation again,
    // and the held move follows it with the id the server assigned.
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

    expect(env.sentRequests.slice(3)).toMatchInlineSnapshot(`
      - 'editTask tasks||1 {"name":"Write draft"}'
      - 'createTask "Plan trip"'
      - 'editTask tasks||1 {"name":"Write trip report","parentId":"tasks||3"}'
    `);
    // The server ends with the last move and name the user made
    expect(pick(env.serverTable.getAll()['tasks||1'], ['name', 'parentId']))
      .toMatchInlineSnapshot(`
      name: 'Write trip report'
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

  test('a rename made after a held move was moved back out is merged into that move, not into an earlier queued rename', async () => {
    const { env, list } = await createTaskWhoseCreationKeepsFailing(
      'edit-after-released-move-session',
      'edit-after-released-move-store',
    );

    act(() => {
      network.goOffline();
    });
    await flushAllTimers();

    // Offline: rename an existing task, then rename it again while moving it
    // under the task whose creation waits for a decision (held), then move it
    // under a server task instead (the held edit is queued again, after the
    // first rename), and rename it a last time.
    await env.editTask({ itemId: 'tasks||1', name: 'Write draft' });
    await env.editTask({
      itemId: 'tasks||1',
      name: 'Write trip report',
      parentId: 'temp:Plan trip',
    });
    await env.editTask({ itemId: 'tasks||1', parentId: 'tasks||2' });
    await env.editTask({ itemId: 'tasks||1', name: 'Write final report' });

    // The last rename is merged into the newest queued edit: merged into the
    // first one, it would be sent before the edit that still carries the
    // second name, and the server would end up with that older name.
    expect(env.getQueue()).toMatchInlineSnapshot(`
      - input: { itemId: 'tasks||1', name: 'Write draft' }
        operation: 'editTask'
        syncState: 'pending'
      - input: { itemId: 'tasks||1', name: 'Write final report', parentId: 'tasks||2' }
        operation: 'editTask'
        syncState: 'pending'
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(env.sentRequests.slice(3)).toMatchInlineSnapshot(`
      - 'editTask tasks||1 {"name":"Write draft"}'
      - 'editTask tasks||1 {"name":"Write final report","parentId":"tasks||2"}'
    `);
    // The server ends with what the user sees.
    expect(pick(env.serverTable.getAll()['tasks||1'], ['name', 'parentId']))
      .toMatchInlineSnapshot(`
      name: 'Write final report'
      parentId: 'tasks||2'
    `);
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write final report', 'Review budget', 'Plan trip']`,
    );

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

  test('a held subtask the user sends again on its own, after its parent was sent alone, still counts as never sent', async () => {
    const { env, list, failedCreation } =
      await createTaskWhoseCreationKeepsFailing(
        'retry-held-subtask-alone-session',
        'retry-held-subtask-alone-store',
      );

    // The subtask creation waits behind the creation of its parent.
    await env.createSubtask('Book flights', 'temp:Plan trip');
    await flushAllTimers();

    // The user sends only the parent creation again: the subtask stays a
    // decision of its own, which no longer waits for anything.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTask',
        { action: 'retry', scope: 'self' },
      );
    });
    await flushAllTimers();
    const heldSubtask = env.apiStore.getOfflineResolutions()[0];
    if (!heldSubtask) throw new Error('Expected the held subtask creation');

    // Offline, the user sends the subtask creation again: it is queued, and it
    // was still never sent.
    act(() => {
      network.goOffline();
    });
    await flushAllTimers();
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        heldSubtask.id,
        'createSubtask',
        { action: 'retry' },
      );
    });
    expect(
      pick(env.apiStore.getItemOfflineState('temp:Book flights'), [
        'isUnsentCreation',
        'creationAttempted',
      ]),
    ).toMatchInlineSnapshot(`
      creationAttempted: '❌'
      isUnsentCreation: '✅'
    `);

    // So deleting it cancels the creation instead of sending it and then
    // deleting it.
    await env.deleteTask('temp:Book flights');
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    expect(env.sentRequests.slice(3)).toMatchInlineSnapshot(
      `['createTask "Plan trip"']`,
    );
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);

    list.unmount();
  });

  test('after a restart, opening the screen of the waiting task shows it without fetching it from the server', async () => {
    const sessionKey = 'open-unresolved-task-after-restart-session';
    const storeName = 'open-unresolved-task-after-restart-store';
    const { env: first, list } = await createTaskWhoseCreationKeepsFailing(
      sessionKey,
      storeName,
    );
    list.unmount();
    first.apiStore.dispose();

    // The app restarts online on the screen of the task: the task is restored
    // from storage as stale data, which a screen normally refetches when it
    // mounts
    resetSessionForTests();
    const env = createTasksEnv(sessionKey, storeName);
    const taskScreen = renderHook(() =>
      env.apiStore.useItem('temp:Plan trip', {
        selector: (task) => task?.name ?? null,
      }),
    );
    // A screen that requires fresh data always fetches the task when it
    // mounts
    const freshTaskScreen = renderHook(() =>
      env.apiStore.useItem('temp:Plan trip', {
        selector: (task) => task?.name ?? null,
        requireFreshData: true,
      }),
    );
    await flushAllTimers();

    // The server doesn't know the task until its creation is sent again, so
    // it is not fetched, not even by the screen that requires fresh data:
    // both screens show the local task instead of a not-found error, and the
    // one that requires fresh data doesn't keep loading
    expect(
      env.serverTable.getRequestHistory('item', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
    expect(pick(taskScreen.result.current, ['status', 'data', 'error']))
      .toMatchInlineSnapshot(`
      data: 'Plan trip'
      error: null
      status: 'success'
    `);
    expect(pick(freshTaskScreen.result.current, ['status', 'data', 'error']))
      .toMatchInlineSnapshot(`
      data: 'Plan trip'
      error: null
      status: 'success'
    `);

    taskScreen.unmount();
    freshTaskScreen.unmount();
  });
});

describe('tasks created with a client-generated id whose creation waits for a manual decision', () => {
  /**
   * Creates task 50 offline with an id the app generates on the client (no
   * temp row) and renames it before it is sent. Back online, its creation
   * fails on every attempt (3) until it asks for a manual decision: the
   * server never got the task.
   */
  async function createTaskWithIdWhoseCreationKeepsFailing(sessionKey: string) {
    network.setOffline();
    const env = createTasksEnv(sessionKey, `${sessionKey}-tasks`);
    const list = env.renderTaskList();
    await flushAllTimers();

    env.addTimelineComments('beforeNextAction', [
      'offline: create task 50 and rename it',
    ]);
    await env.createTaskWithId(50, 'Plan trip');
    await advanceTime(1_000);
    await env.renameTask('tasks||50', 'Plan summer trip');

    env.faults.createTaskWithId.push(
      'request-lost',
      'request-lost',
      'request-lost',
    );
    env.addTimelineComments('beforeNextAction', [
      'back online: the creation keeps failing until it needs a decision',
    ]);
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    const failedCreation = env.apiStore
      .getOfflineResolutions()
      .find((resolution) => resolution.operation === 'createTaskWithId');
    if (!failedCreation) throw new Error('Expected the failed task creation');

    return { env, list, failedCreation };
  }

  test('the edits of a task created with a client-generated id wait for its failed creation, made before or after the failure, and are sent after it once the user sends it again', async () => {
    const { env, list, failedCreation } =
      await createTaskWithIdWhoseCreationKeepsFailing('client-id-retry');

    // Online again, the user renames the task a second time.
    env.addTimelineComments('beforeNextAction', [
      'online: rename the task whose creation waits for a decision',
    ]);
    await env.renameTask('tasks||50', 'Plan winter trip');
    await flushAllTimers();

    // The server does not have task 50: neither rename is sent (the first
    // one was queued behind the creation, the second one is made after it
    // failed). Both wait for the decision about the creation, so the user
    // has one thing to decide: the creation, which holds the renames.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions().map(summarizeResolution))
      .toMatchInlineSnapshot(`
        - blocks: 2
          error: 'connection lost'
          input: 'id: 50, name: "Plan trip"'
          kind: 'retry-exhausted'
          on: 'item:tasks||50'
          op: 'createTaskWithId'
        - blockedBy: 1
          error: 'Blocked by unresolved dependency'
          input: 'itemId: "tasks||50", name: "Plan summer trip"'
          kind: 'retry-exhausted'
          on: 'item:tasks||50'
          op: 'renameTask'
        - blockedBy: 1
          error: 'Blocked by unresolved dependency'
          input: 'itemId: "tasks||50", name: "Plan winter trip"'
          kind: 'retry-exhausted'
          on: 'item:tasks||50'
          op: 'renameTask'
      `);
    // The user keeps seeing the last name, and the task reports that its
    // creation was sent but the server has not confirmed it.
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Review budget', 'Plan winter trip']`,
    );
    expect(env.apiStore.getItemOfflineState('tasks||50'))
      .toMatchInlineSnapshot(`
        creationAttempted: '✅'
        isUnsentCreation: '✅'
        pendingMutations: 0
        requiresResolution: '✅'
        syncState: 'resolution-required'
      `);

    env.addTimelineComments('beforeNextAction', [
      'the user asks to send the creation again',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // The creation goes first, then the renames in the order they were made.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'renameTask tasks||50 to "Plan summer trip"'
      - 'renameTask tasks||50 to "Plan winter trip"'
    `);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget', '50: Plan winter trip']`,
    );
    expect(env.apiStore.getItemOfflineState('tasks||50')).toMatchInlineSnapshot(
      `null`,
    );
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time   | tasks                                         |
      0      | Write report, Review budget                   | [tasks] ui-initialized
      3.01s  | Write report, Review budget                   | -- offline: create task 50 and rename it
      .      | Write report, Review budget, Plan trip        | [tasks] ui-changed
      .      | Write report, Review budget, Plan trip        | offline:createTaskWithId queued
      4.01s  | Write report, Review budget, Plan summer trip | [tasks] ui-changed
      .      | Write report, Review budget, Plan summer trip | offline:renameTask queued
      .      | Write report, Review budget, Plan summer trip | -- back online: the creation keeps failing until it needs a decision
      .      | Write report, Review budget, Plan summer trip | offline:createTaskWithId replay-started
      9.01s  | Write report, Review budget, Plan summer trip | offline:createTaskWithId replay-started
      14.01s | Write report, Review budget, Plan summer trip | offline:createTaskWithId replay-started
      .      | Write report, Review budget, Plan summer trip | offline:createTaskWithId resolution-required
      .      | Write report, Review budget, Plan summer trip | offline:renameTask resolution-required
      .      | Write report, Review budget, Plan summer trip | -- online: rename the task whose creation waits for a decision
      .      | Write report, Review budget, Plan winter trip | [tasks] ui-changed
      .      | Write report, Review budget, Plan winter trip | offline:renameTask resolution-required
      .      | Write report, Review budget, Plan winter trip | offline:renameTask queued
      15.01s | Write report, Review budget, Plan winter trip | -- the user asks to send the creation again
      .      | Write report, Review budget, Plan winter trip | offline:createTaskWithId replay-started
      16.21s | Write report, Review budget, Plan winter trip | [tasks||50] server-data-changed (value: {"id":50,"name":"Plan trip"})
      .      | Write report, Review budget, Plan winter trip | offline:createTaskWithId replay-finished
      .      | Write report, Review budget, Plan winter trip | offline:renameTask replay-started
      17.41s | Write report, Review budget, Plan winter trip | [tasks||50] server-data-changed (value: {"name":"Plan summer trip"})
      .      | Write report, Review budget, Plan winter trip | offline:renameTask replay-finished
      .      | Write report, Review budget, Plan winter trip | offline:renameTask replay-started
      18.61s | Write report, Review budget, Plan winter trip | [tasks||50] server-data-changed (value: {"name":"Plan winter trip"})
      .      | Write report, Review budget, Plan winter trip | offline:renameTask replay-finished
      18.62s | Write report, Review budget, Plan winter trip | 🔴 >list-fetch-started
      19.42s | Write report, Review budget, Plan winter trip | 🔴 <list-fetch-finished (value: {"count":3})
      "
    `);

    list.unmount();
  });

  test('discarding the failed creation of a task with a client-generated id drops the renames held behind it and removes the task, without sending or fetching anything for it', async () => {
    const { env, list, failedCreation } =
      await createTaskWithIdWhoseCreationKeepsFailing('client-id-discard');
    await env.renameTask('tasks||50', 'Plan winter trip');
    await flushAllTimers();
    env.serverTable.clearFetchHistory();

    env.addTimelineComments('beforeNextAction', [
      'the user discards the creation',
    ]);
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'discard' },
      );
    });
    await flushAllTimers();

    // Only the 3 failed creation attempts were ever sent, and nothing is left
    // to send or decide: the renames went with the creation.
    expect(env.sentRequests).toMatchInlineSnapshot(`
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
      - 'createTaskWithId tasks||50'
    `);
    expect(env.getQueue()).toMatchInlineSnapshot(`[]`);
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    // The task is removed instead of being refetched: the server does not
    // have it, so a refetch would only fail.
    expect(env.serverTable.getRequestHistory('item')).toMatchInlineSnapshot(
      `[]`,
    );
    expect(list.result.current.items).toMatchInlineSnapshot(
      `['Write report', 'Review budget']`,
    );
    expect(env.apiStore.getItemOfflineState('tasks||50')).toMatchInlineSnapshot(
      `null`,
    );

    list.unmount();
  });

  test('an edit made while the creation waits is merged into the held edit, and a delete replaces both: sent again, the task is created and then deleted', async () => {
    const { env, list, failedCreation } =
      await createTaskWithIdWhoseCreationKeepsFailing('client-id-merge');

    // Online: two edits of the task, which are normally merged into one
    // request. The second one is merged into the first, held one.
    await env.editTask({ itemId: 'tasks||50', name: 'Plan summer trip' });
    await env.editTask({ itemId: 'tasks||50', parentId: 'tasks||1' });
    await flushAllTimers();

    expect(env.sentRequests.slice(3)).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'input', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - input: 'id: 50, name: "Plan trip"'
        op: 'createTaskWithId'
      - blockedBy: 1
        input: 'itemId: "tasks||50", name: "Plan summer trip"'
        op: 'renameTask'
      - blockedBy: 1
        input: 'itemId: "tasks||50", name: "Plan summer trip", parentId: "tasks||1"'
        op: 'editTask'
    `);

    // The delete supersedes the held edits of the task. The creation may have
    // reached the server, so it is kept: the delete waits behind it.
    await env.deleteTask('tasks||50');
    await flushAllTimers();
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - op: 'createTaskWithId'
      - { blockedBy: 1, op: 'deleteTask' }
    `);

    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        failedCreation.id,
        'createTaskWithId',
        { action: 'retry' },
      );
    });
    await flushAllTimers();

    // No edit is sent: only the creation and the delete.
    expect(env.sentRequests.slice(3)).toMatchInlineSnapshot(
      `['createTaskWithId tasks||50', 'deleteTask tasks||50']`,
    );
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget']`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);

    list.unmount();
  });

  test('a rename held while the creation waits for a conflict decision is sent to the task the user keeps from the server', async () => {
    network.setOffline();
    const env = createTasksEnv('client-id-commit', 'client-id-commit-tasks');
    await env.createTaskWithId(50, 'Plan trip');

    // On reconnect the replay finds a task with that id on the server and
    // reports a conflict instead of sending the creation.
    env.conflicts.createTaskWithId = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.conflicts.createTaskWithId = false;
    const conflict = env.apiStore.getOfflineResolutions()[0];
    if (conflict?.kind !== 'conflict') {
      throw new Error('Expected the task creation conflict');
    }

    // A rename made while the conflict waits for a decision is held behind it.
    await env.renameTask('tasks||50', 'Plan summer trip');
    await flushAllTimers();
    expect(env.sentRequests).toMatchInlineSnapshot(`[]`);
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['kind', 'op', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`
      - { kind: 'conflict', op: 'createTaskWithId' }
      - { blockedBy: 1, kind: 'retry-exhausted', op: 'renameTask' }
    `);

    // The task another device created with that id: the user keeps it.
    env.serverTable.setItem('tasks||50', { id: 50, name: 'Plan trip' });
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        conflict.id,
        'createTaskWithId',
        { action: 'commit' },
      );
    });
    await flushAllTimers();

    // Nothing is created: the held rename is sent to the server task.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['renameTask tasks||50 to "Plan summer trip"']`,
    );
    expect(env.apiStore.getOfflineResolutions()).toMatchInlineSnapshot(`[]`);
    expect(env.getServerTasks()).toMatchInlineSnapshot(
      `['1: Write report', '2: Review budget', '50: Plan summer trip']`,
    );
  });
  test('a rename held while the creation waits for a conflict decision is not sent when the user creates the task under another id', async () => {
    network.setOffline();
    const env = createTasksEnv('client-id-new-id', 'client-id-new-id-tasks');
    await env.createTaskWithId(50, 'Plan trip');
    await advanceTime(1_000);
    await env.renameTask('tasks||50', 'Plan summer trip');

    // On reconnect the server already has a task with id 50 (of another
    // user): the creation reports a conflict, and the rename waits behind it.
    env.conflicts.createTaskWithId = true;
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();
    env.conflicts.createTaskWithId = false;
    const conflict = env.apiStore.getOfflineResolutions()[0];
    if (conflict?.kind !== 'conflict') {
      throw new Error('Expected the task creation conflict');
    }

    // The user creates the task again, with a new id.
    await act(async () => {
      await env.apiStore.resolveOfflineResolution(
        conflict.id,
        'createTaskWithId',
        { action: 'requeue', input: { id: 51, name: 'Plan trip' } },
      );
    });
    await flushAllTimers();

    // The rename targets task 50, which the replacement does not create: it
    // is not sent to the task the server has under that id. It is left for
    // the user to send or discard, and no longer waits for anything.
    expect(env.sentRequests).toMatchInlineSnapshot(
      `['createTaskWithId tasks||51']`,
    );
    expect(
      env.apiStore
        .getOfflineResolutions()
        .map((resolution) =>
          pick(summarizeResolution(resolution), ['op', 'on', 'blockedBy']),
        ),
    ).toMatchInlineSnapshot(`- { on: 'item:tasks||50', op: 'renameTask' }`);
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
