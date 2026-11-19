import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CollectionOfflineOperationDefinition,
  ListQueryOfflineOperationDefinition,
} from '../../src/main';
import { createStoreManager } from '../../src/storeManager';
import { createFocusChangeCoordinator } from '../browser-tabs/browser-tabs-test-helpers';
import { createInMemoryBrowserTabsTransportFactory } from '../mocks/browserTabsTestUtils';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  createSharedListQueryServerTableState,
  type ListQueryParams,
} from '../mocks/listQueryStoreTestEnv';
import { createSharedServerTableState } from '../mocks/serverTableMock';
import { TEST_INITIAL_TIME, normalizeError } from '../mocks/testEnvUtils';
import { advanceTime, flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
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

type Tab = 'creator' | 'other';

/**
 * What two tabs of the same session share: the store id, the session, the
 * channel between tabs, the server and which tab has the focus.
 *
 * Both tabs run in this test process, so they also share the offline session
 * coordinator, which a real browser gives to each tab separately and keeps in
 * sync through the same channel. Because of that, the tab created last is
 * the one that replays the queue: tests create the tabs in the order that
 * makes the intended tab send the creation. Two real tabs are covered by
 * `tests/playwright/offline-reconcile-across-tabs.spec.ts`.
 */
function createSharedBrowser<TServerState>(
  name: string,
  serverState: TServerState,
) {
  return {
    storeId: `${name}-store`,
    sessionKey: `${name}-session`,
    transportFactory: createInMemoryBrowserTabsTransportFactory(),
    tabs: createFocusChangeCoordinator<Tab>(['creator', 'other'], 'creator'),
    serverState,
  };
}

function createTabStoreManager(sessionKey: string) {
  return createStoreManager({
    errorNormalizer: normalizeError,
    getSessionKey: () => sessionKey,
    offlineSession: { network: network.config },
  });
}

type TaskRow = { id: number; name: string };
type TasksOperations = {
  createTask: ListQueryOfflineOperationDefinition<
    TaskRow,
    ListQueryParams,
    string,
    { name: string },
    unknown,
    TaskRow
  >;
};

const taskRowSchema = rc_object({ id: rc_number, name: rc_string });
const tasksQuery = { tableId: 'tasks' } as const;

function createTasksTable() {
  return {
    tasks: [
      { id: 1, name: 'Write report' },
      { id: 2, name: 'Review budget' },
    ],
  };
}

type TasksBrowser = ReturnType<
  typeof createSharedBrowser<
    ReturnType<typeof createSharedListQueryServerTableState<TaskRow>>
  >
>;

/**
 * One tab of an app with a task list (list-query store) where tasks can be
 * created offline: the row is `temp:<name>` until the server assigns
 * `tasks||3`.
 */
function createTasksTab(
  browser: TasksBrowser,
  tab: Tab,
  testScenario: 'idle' | 'loaded',
) {
  const env = createListQueryStoreTestEnv<
    TaskRow,
    false,
    false,
    TasksOperations
  >(createTasksTable(), {
    id: browser.storeId,
    getSessionKey: () => browser.sessionKey,
    storeManager: createTabStoreManager(browser.sessionKey),
    sharedServerTableState: browser.serverState,
    browserTabsTransportFactory: browser.transportFactory,
    bindFocusController: browser.tabs.bind(tab),
    testScenario:
      testScenario === 'loaded'
        ? { loaded: { queries: [tasksQuery] } }
        : 'idle',
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
              const result = { id: 3, name: input.name };
              await env.serverTable.delayedSetItem('tasks||3', result);
              return result;
            },
          },
        },
      },
    },
  });

  // What an app does to follow a record it holds by its temporary id.
  const reconciledTasks: string[] = [];
  env.apiStore.storeEvents.on('tempEntityReconciled', ({ payload }) => {
    reconciledTasks.push(`${payload.tempId} -> ${payload.finalPayload}`);
  });

  return {
    env,
    reconciledTasks,
    /** Mounts the task list of the tab. */
    renderList: () =>
      renderHook(() =>
        env.apiStore.useListQuery(tasksQuery, {
          itemSelector: (item) => item.name,
        }),
      ),
    createTask(name: string) {
      return act(async () => {
        await env.apiStore.performMutation(`temp:${name}`, {
          optimisticUpdate: () => {
            env.apiStore.addItemToState(
              `temp:${name}`,
              { id: -1, name },
              { addItemToQueries: { queries: [tasksQuery], appendTo: 'end' } },
            );
          },
          mutation: async () => {
            const result = { id: 3, name };
            await env.serverTable.delayedSetItem('tasks||3', result);
            return result;
          },
          offline: { operation: 'createTask', input: { name } },
        });
      });
    },
  };
}

describe('list-query store', () => {
  test('a task created offline in one tab keeps its row in the other tab once it is saved, and both tabs learn its final id', async () => {
    network.setOffline();
    const browser = createSharedBrowser(
      'reconcile-tasks',
      createSharedListQueryServerTableState(createTasksTable()),
    );
    const other = createTasksTab(browser, 'other', 'loaded');
    const creator = createTasksTab(browser, 'creator', 'loaded');
    const otherList = other.renderList();
    const creatorList = creator.renderList();
    await flushAllTimers();

    await creator.createTask('Plan trip');
    await flushAllTimers();

    // The other tab shows the new row too, and has a page open on the record
    // (it only knows the temporary id).
    const openRecord = renderHook(() =>
      other.env.apiStore.useItem('temp:Plan trip', {
        selector: (item) => item?.name ?? null,
      }),
    );
    expect({
      list: otherList.result.current.items,
      openRecord: openRecord.result.current.data,
    }).toMatchInlineSnapshot(`
      list: ['Write report', 'Review budget', 'Plan trip']
      openRecord: 'Plan trip'
    `);

    // Back online: the tab that created the task sends it and the server
    // assigns `tasks||3`.
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    // Both tabs replaced the temporary row with the final one, in the same
    // position of the list.
    expect({
      creator: creatorList.result.current.items,
      other: otherList.result.current.items,
    }).toMatchInlineSnapshot(`
      creator: ['Write report', 'Review budget', 'Plan trip']
      other: ['Write report', 'Review budget', 'Plan trip']
    `);
    expect({
      creator: {
        temp: creator.env.apiStore.getItemState('temp:Plan trip'),
        final: creator.env.apiStore.getItemState('tasks||3'),
      },
      other: {
        temp: other.env.apiStore.getItemState('temp:Plan trip'),
        final: other.env.apiStore.getItemState('tasks||3'),
      },
    }).toMatchInlineSnapshot(`
      creator:
        final: { id: 3, name: 'Plan trip' }
        temp: null

      other:
        final: { id: 3, name: 'Plan trip' }
        temp: null
    `);

    // Both tabs are told which final id replaced the temporary one, so the
    // page open on the record in the other tab can follow it...
    expect({ creator: creator.reconciledTasks, other: other.reconciledTasks })
      .toMatchInlineSnapshot(`
      creator: ['temp:Plan trip -> tasks||3']
      other: ['temp:Plan trip -> tasks||3']
    `);
    // ...and code that still holds the temporary id later can resolve it.
    expect({
      creator: creator.env.apiStore.resolveTempItemPayload('temp:Plan trip'),
      other: other.env.apiStore.resolveTempItemPayload('temp:Plan trip'),
      unknown: other.env.apiStore.resolveTempItemPayload('temp:Unknown'),
    }).toMatchInlineSnapshot(`
      creator: 'tasks||3'
      other: 'tasks||3'
      unknown: 'temp:Unknown'
    `);

    openRecord.unmount();
    creatorList.unmount();
    otherList.unmount();
  });

  test('a tab that has no task data still learns the final id of the task', async () => {
    network.setOffline();
    const browser = createSharedBrowser(
      'reconcile-tasks-idle-tab',
      createSharedListQueryServerTableState(createTasksTable()),
    );
    // This tab has no task data: for example it only holds the temporary id
    // in a link to the record.
    const other = createTasksTab(browser, 'other', 'idle');
    const creator = createTasksTab(browser, 'creator', 'loaded');
    const creatorList = creator.renderList();
    await flushAllTimers();

    await creator.createTask('Plan trip');
    await flushAllTimers();
    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(other.reconciledTasks).toMatchInlineSnapshot(
      `['temp:Plan trip -> tasks||3']`,
    );
    expect(
      other.env.apiStore.resolveTempItemPayload('temp:Plan trip'),
    ).toMatchInlineSnapshot(`"tasks||3"`);
    creatorList.unmount();
  });

  test('a task created offline in one tab and saved by a tab opened later keeps its place in the list of the tab that created it', async () => {
    network.setOffline();
    const browser = createSharedBrowser(
      'reconcile-tasks-saved-by-other-tab',
      createSharedListQueryServerTableState(createTasksTable()),
    );
    const creator = createTasksTab(browser, 'creator', 'loaded');
    const creatorList = creator.renderList();
    await flushAllTimers();

    await creator.createTask('Plan trip');
    await flushAllTimers();
    const openRecord = renderHook(() =>
      creator.env.apiStore.useItem('temp:Plan trip', {
        selector: (item) => item?.name ?? null,
      }),
    );

    // The user opens the app in another tab, which becomes the one that
    // sends the queued creation once the connection is back. That tab has no
    // list mounted: only the tab that created the task shows it.
    const other = await act(async () => {
      const openedTab = createTasksTab(browser, 'other', 'idle');
      await browser.tabs.focusTab('other');
      return openedTab;
    });
    await flushAllTimers();
    act(() => {
      network.goOnline();
    });
    // The creation takes 1.2s on the server. Stop right after it, before the
    // lists are fetched again.
    await advanceTime(1_300);

    // The saved task took the place of the temporary row.
    expect({
      list: creatorList.result.current.items,
      temp: creator.env.apiStore.getItemState('temp:Plan trip'),
      final: creator.env.apiStore.getItemState('tasks||3'),
    }).toMatchInlineSnapshot(`
      final: { id: 3, name: 'Plan trip' }
      list: ['Write report', 'Review budget', 'Plan trip']
      temp: null
    `);
    expect({ creator: creator.reconciledTasks, other: other.reconciledTasks })
      .toMatchInlineSnapshot(`
      creator: ['temp:Plan trip -> tasks||3']
      other: ['temp:Plan trip -> tasks||3']
    `);
    expect(
      creator.env.apiStore.resolveTempItemPayload('temp:Plan trip'),
    ).toMatchInlineSnapshot(`"tasks||3"`);

    await flushAllTimers();
    expect(creatorList.result.current.items).toMatchInlineSnapshot(`
      ['Write report', 'Review budget', 'Plan trip']
    `);

    openRecord.unmount();
    creatorList.unmount();
  });
});

type Note = { name: string };
type NotesOperations = {
  createNote: CollectionOfflineOperationDefinition<
    { value: Note },
    string,
    { name: string },
    unknown,
    Note
  >;
};

const noteSchema = rc_object({ value: rc_object({ name: rc_string }) });

function createNotes() {
  return { 'notes||1': { name: 'Groceries' } };
}

type NotesBrowser = ReturnType<
  typeof createSharedBrowser<
    ReturnType<typeof createSharedServerTableState<Note>>
  >
>;

/**
 * One tab of an app with notes (collection store) that can be created
 * offline: the note is `temp:<name>` until the server assigns `notes||2`.
 */
function createNotesTab(browser: NotesBrowser, tab: Tab) {
  const env = createCollectionStoreTestEnv<Note, NotesOperations>(
    createNotes(),
    {
      id: browser.storeId,
      getSessionKey: () => browser.sessionKey,
      storeManager: createTabStoreManager(browser.sessionKey),
      sharedServerTableState: browser.serverState,
      browserTabsTransportFactory: browser.transportFactory,
      bindFocusController: browser.tabs.bind(tab),
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
                  finalPayload: 'notes||2',
                  finalData: { value: result },
                }),
              },
              execute: async ({ input }) => {
                const result = { name: input.name };
                await env.serverTable.delayedSetItem('notes||2', result);
                return result;
              },
            },
          },
        },
      },
    },
  );

  const reconciledNotes: string[] = [];
  env.apiStore.storeEvents.on('tempEntityReconciled', ({ payload }) => {
    reconciledNotes.push(`${payload.tempId} -> ${payload.finalPayload}`);
  });

  return {
    env,
    reconciledNotes,
    createNote(name: string) {
      return act(async () => {
        // The pending note is added by the store (`buildPendingEntity`).
        await env.apiStore.performMutation(null, {
          mutation: async () => {
            const result = { name };
            await env.serverTable.delayedSetItem('notes||2', result);
            return result;
          },
          offline: { operation: 'createNote', input: { name } },
        });
      });
    },
  };
}

describe('collection store', () => {
  test('a note created offline in one tab is replaced by the saved note in the other tab, and both tabs learn its final id', async () => {
    network.setOffline();
    const browser = createSharedBrowser(
      'reconcile-notes',
      createSharedServerTableState(createNotes()),
    );
    const other = createNotesTab(browser, 'other');
    const creator = createNotesTab(browser, 'creator');
    await flushAllTimers();

    // The other tab has a page open on the note as soon as it is created.
    const openNote = renderHook(() =>
      other.env.apiStore.useItem('temp:Ideas', {
        selector: (note) => note?.value.name ?? null,
      }),
    );
    await creator.createNote('Ideas');
    await flushAllTimers();

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect({
      creator: {
        temp: creator.env.apiStore.getItemState('temp:Ideas')?.data ?? null,
        final: creator.env.apiStore.getItemState('notes||2')?.data ?? null,
      },
      other: {
        temp: other.env.apiStore.getItemState('temp:Ideas')?.data ?? null,
        final: other.env.apiStore.getItemState('notes||2')?.data ?? null,
      },
    }).toMatchInlineSnapshot(`
      creator:
        final:
          value: { name: 'Ideas' }
        temp: null

      other:
        final:
          value: { name: 'Ideas' }
        temp: null
    `);
    expect({ creator: creator.reconciledNotes, other: other.reconciledNotes })
      .toMatchInlineSnapshot(`
      creator: ['temp:Ideas -> notes||2']
      other: ['temp:Ideas -> notes||2']
    `);
    expect({
      creator: creator.env.apiStore.resolveTempItemPayload('temp:Ideas'),
      other: other.env.apiStore.resolveTempItemPayload('temp:Ideas'),
    }).toMatchInlineSnapshot(`
      creator: 'notes||2'
      other: 'notes||2'
    `);

    openNote.unmount();
  });
});
