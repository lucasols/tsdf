import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_literals, rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ListQueryOfflineOperationDefinition,
  OptimisticListUpdate,
} from '../../src/main';
import { opfsPersistentStorage } from '../../src/persistentStorage/storageAdapter';
import { createStoreManager } from '../../src/storeManager';
import { createOfflineNetworkMock } from '../../src/testing';
import {
  createListQueryStoreTestEnv,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import {
  flushAllTimers,
  resolveAfterAllTimers,
} from '../utils/genericTestUtils';
import { createOpfsPersistentStorageTestStore } from '../utils/opfsPersistentStorageTestStore';
import { resetSessionForTests } from '../utils/resetSessionForTests';
import { listQueryQueryPayloadSchema } from './offlineTestShared';

// A task board keeps one list per status column. Lists the user opened before
// are saved on the device, and after a restart a column stays only in storage
// until a screen opens it. When the user moves or creates a card offline,
// the column it goes to must show it once opened, even though it can't be
// refetched while offline.

let network = createOfflineNetworkMock();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  network = createOfflineNetworkMock();
  network.install();
  resetSessionForTests({ clearStorage: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  resetSessionForTests({ clearStorage: true });
});

const taskRowSchema = rc_object({
  id: rc_number,
  name: rc_string,
  status: rc_literals('todo', 'done'),
});
const moveTaskInputSchema = rc_object({
  itemId: rc_string,
  status: rc_literals('todo', 'done'),
});
const createTaskInputSchema = rc_object({
  itemId: rc_string,
  id: rc_number,
  name: rc_string,
  status: rc_literals('todo', 'done'),
});

type Status = 'todo' | 'done';

type TaskRow = { id: number; name: string; status: Status };

type TaskBoardOperations = {
  moveTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { itemId: string; status: Status }
  >;
  createTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { itemId: string; id: number; name: string; status: Status }
  >;
};

function statusColumn(status: Status): ListQueryParams {
  return {
    tableId: 'tasks',
    filters: [{ op: 'eq', field: 'status', value: status }],
  };
}

const todoColumn = statusColumn('todo');
const doneColumn = statusColumn('done');

function columnStatus(column: ListQueryParams): Status | null {
  const filter = column.filters?.[0];
  if (filter?.op !== 'eq' || filter.field !== 'status') return null;
  return filter.value === 'todo' || filter.value === 'done'
    ? filter.value
    : null;
}

const storages = [
  { storage: 'local storage', adapter: 'local-sync' },
  { storage: 'async storage', adapter: opfsPersistentStorage },
] as const;

type StorageAdapter = (typeof storages)[number]['adapter'];

/**
 * The column rules of the board: declared by the column payloads, or by one
 * filter that matches every column. `none` leaves the columns to the
 * `addItemToQueries` of each creation.
 */
const columnRules = {
  none: [],
  payloads: [
    { queries: todoColumn, filterItem: (task) => task.status === 'todo' },
    { queries: doneColumn, filterItem: (task) => task.status === 'done' },
  ],
  filter: [
    {
      queries: (query) => query.tableId === 'tasks',
      filterItem: (task, { queryPayload }) => {
        const status = columnStatus(queryPayload);
        return status && task.status === status;
      },
    },
  ],
} satisfies Record<
  string,
  OptimisticListUpdate<TaskRow, ListQueryParams, string>[]
>;

function createBoardEnv(
  adapter: StorageAdapter,
  rules: keyof typeof columnRules,
) {
  const sessionKey = 'task-board-session';
  // Async storage writes need the timers to run
  const settle = <T,>(value: T | Promise<T>) =>
    adapter === 'local-sync'
      ? value
      : resolveAfterAllTimers(Promise.resolve(value));

  const env = createListQueryStoreTestEnv<
    TaskRow,
    false,
    false,
    TaskBoardOperations
  >(
    {
      tasks: [
        { id: 1, name: 'Write report', status: 'todo' },
        { id: 2, name: 'Pay invoice', status: 'done' },
      ],
    },
    {
      id: 'task-board',
      getSessionKey: () => sessionKey,
      storeManager: createStoreManager({
        errorNormalizer: normalizeError,
        getSessionKey: () => sessionKey,
        offlineSession: { network: network.config },
      }),
      optimisticListUpdates: columnRules[rules],
      persistentStorage: {
        adapter,
        schema: taskRowSchema,
        itemPayloadSchema: rc_string,
        queryPayloadSchema: listQueryQueryPayloadSchema,
        offline: {
          operations: {
            moveTask: {
              inputSchema: moveTaskInputSchema,
              kind: 'update',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedUpdateItem(input.itemId, {
                  status: input.status,
                });
              },
              onSuccessExecute: () => {},
            },
            createTask: {
              inputSchema: createTaskInputSchema,
              kind: 'create',
              getEntityRefs: ({ input }) => [input.itemId],
              execute: async ({ input }) => {
                await env.serverTable.delayedSetItem(input.itemId, {
                  id: input.id,
                  name: input.name,
                  status: input.status,
                });
              },
              onSuccessExecute: () => {},
            },
          },
        },
      },
    },
  );

  function renderColumn(column: ListQueryParams) {
    return renderHook(() =>
      env.apiStore.useListQuery(column, { itemSelector: (task) => task.name }),
    );
  }

  /** Moves a card from its own screen, which shows only that card. */
  async function moveTask(itemId: string, status: Status) {
    const cardScreen = renderHook(() => env.apiStore.useItem(itemId));
    await flushAllTimers();
    await act(async () => {
      await settle(
        env.apiStore.performMutation(itemId, {
          optimisticUpdate: () => {
            env.apiStore.updateItemState(itemId, (task) => ({
              ...task,
              status,
            }));
          },
          mutation: () => Promise.reject(new Error('unreachable offline')),
          offline: { operation: 'moveTask', input: { itemId, status } },
        }),
      );
    });
    await flushAllTimers();
    cardScreen.unmount();
  }

  /**
   * Creates a card with an id the app generates, adding it to the columns of
   * its status with a filter, like a global "quick add" that can't name the
   * lists the board saved.
   */
  async function createTask(id: number, name: string, status: Status) {
    const itemId = `tasks||${id}`;
    await act(async () => {
      await settle(
        env.apiStore.performMutation(itemId, {
          optimisticUpdate: () => {
            env.apiStore.addItemToState(
              itemId,
              { id, name, status },
              {
                addItemToQueries: {
                  queries: (query) => columnStatus(query) === status,
                  appendTo: 'start',
                },
              },
            );
          },
          mutation: () => Promise.reject(new Error('unreachable offline')),
          offline: {
            operation: 'createTask',
            input: { itemId, id, name, status },
          },
        }),
      );
    });
    await flushAllTimers();
  }

  return { env, renderColumn, moveTask, createTask };
}

/**
 * The user sees both columns online once, so they are saved to storage, then
 * the app restarts offline on another screen: no column is read from storage
 * yet.
 */
async function restartOfflineWithSavedColumns(
  adapter: StorageAdapter,
  rules: keyof typeof columnRules,
) {
  if (adapter !== 'local-sync') createOpfsPersistentStorageTestStore();

  const first = createBoardEnv(adapter, rules);
  const firstTodo = first.renderColumn(todoColumn);
  const firstDone = first.renderColumn(doneColumn);
  await flushAllTimers();
  expect({
    todo: firstTodo.result.current.items,
    done: firstDone.result.current.items,
  }).toMatchInlineSnapshot(`
    done: ['Pay invoice']
    todo: ['Write report']
  `);
  firstTodo.unmount();
  firstDone.unmount();
  first.env.apiStore.dispose();

  network.setOffline();
  resetSessionForTests();
  const board = createBoardEnv(adapter, rules);
  await flushAllTimers();

  return board;
}

/** The app restarts again, still offline, with the changes still queued. */
async function restartOfflineAgain(
  board: ReturnType<typeof createBoardEnv>,
  adapter: StorageAdapter,
  rules: keyof typeof columnRules,
) {
  board.env.apiStore.dispose();
  resetSessionForTests();
  const restarted = createBoardEnv(adapter, rules);
  await flushAllTimers();
  return restarted;
}

/** Opens both columns, as the board screen does, and reads their cards. */
async function readColumns(board: ReturnType<typeof createBoardEnv>) {
  const todo = board.renderColumn(todoColumn);
  const done = board.renderColumn(doneColumn);
  await flushAllTimers();
  const columns = {
    todo: todo.result.current.items,
    done: done.result.current.items,
  };
  todo.unmount();
  done.unmount();
  return columns;
}

describe('optimisticListUpdates', () => {
  test.each(
    storages.flatMap(({ storage, adapter }) =>
      (['payloads', 'filter'] as const).map((rules) => ({
        storage,
        adapter,
        rules,
      })),
    ),
  )(
    'a card moved offline shows in the column it moved to, which was only in storage ($storage, rules by $rules)',
    async ({ adapter, rules }) => {
      const board = await restartOfflineWithSavedColumns(adapter, rules);

      // Offline, the user moves "Write report" to done from the card's
      // screen, which doesn't show the columns. The move is queued.
      await board.moveTask('tasks||1', 'done');
      expect(board.env.apiStore.getOfflineEntities().length).toBe(1);

      // Opening the board shows the card in the done column, instead of
      // the saved columns without the move until the connection is back.
      expect(await readColumns(board)).toMatchInlineSnapshot(`
        done: ['Pay invoice', 'Write report']
        todo: []
      `);

      // The app restarts again while the move is still queued: the columns
      // read back from storage still show it.
      const restarted = await restartOfflineAgain(board, adapter, rules);
      expect(await readColumns(restarted)).toMatchInlineSnapshot(`
        done: ['Pay invoice', 'Write report']
        todo: []
      `);
    },
  );

  test.each(storages)(
    'a card moved offline before a restart shows in the column it moved to, which was only in storage ($storage)',
    async ({ adapter }) => {
      const board = await restartOfflineWithSavedColumns(adapter, 'filter');

      // Offline, the user moves "Write report" to done, then the app
      // restarts before the board is opened.
      await board.moveTask('tasks||1', 'done');
      const restarted = await restartOfflineAgain(board, adapter, 'filter');

      // Opening the board shows the queued move.
      expect(await readColumns(restarted)).toMatchInlineSnapshot(`
        done: ['Pay invoice', 'Write report']
        todo: []
      `);
    },
  );

  test.each(storages)(
    'a board open while the app restarts shows a card moved offline before the restart ($storage)',
    async ({ adapter }) => {
      const board = await restartOfflineWithSavedColumns(adapter, 'filter');
      await board.moveTask('tasks||1', 'done');
      board.env.apiStore.dispose();

      // The app restarts on the board: the columns are read back from
      // storage before the queued move is read from the device. They get the
      // move once it is.
      resetSessionForTests();
      const restarted = createBoardEnv(adapter, 'filter');
      expect(await readColumns(restarted)).toMatchInlineSnapshot(`
        done: ['Pay invoice', 'Write report']
        todo: []
      `);
    },
  );
});

describe('addItemToQueries', () => {
  test.each(storages)(
    'a card created offline shows in the columns its filter declares, which were only in storage ($storage)',
    async ({ adapter }) => {
      const board = await restartOfflineWithSavedColumns(adapter, 'none');

      // Offline, the user creates "Book flight" from a quick add screen.
      // The creation is queued.
      await board.createTask(3, 'Book flight', 'todo');
      expect(board.env.apiStore.getOfflineEntities().length).toBe(1);

      // Opening the board shows the card at the top of the todo column.
      expect(await readColumns(board)).toMatchInlineSnapshot(`
        done: ['Pay invoice']
        todo: ['Book flight', 'Write report']
      `);

      // The app restarts again while the creation is still queued: the
      // column read back from storage still shows it.
      const restarted = await restartOfflineAgain(board, adapter, 'none');
      expect(await readColumns(restarted)).toMatchInlineSnapshot(`
        done: ['Pay invoice']
        todo: ['Book flight', 'Write report']
      `);
    },
  );
});
