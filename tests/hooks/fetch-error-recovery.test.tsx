import { cleanup, renderHook } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import {
  createListQueryStoreTestEnv,
  type Tables,
} from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
});

beforeEach(() => {
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
});

type DocumentValue = { hello: string };
type Todo = { title: string; completed: boolean };

const listQueryServerData: Tables = {
  users: [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ],
};

describe('fetch error recovery', () => {
  test('document store can force a retry after entering an error state', async () => {
    const env = createDocumentStoreTestEnv<DocumentValue>({ hello: 'world' });

    // Make the first load fail so the retry starts from a real error state.
    env.errorInNextFetch('Fetch error');

    renderHook(() => {
      const document = env.apiStore.useDocument();
      env.trackUIChanges(
        `status:${document.status} data:${document.data?.value.hello ?? 'null'}`,
      );
    });

    // Let the initial mount fetch fail before forcing a retry.
    await flushAllTimers();

    expect({ error: env.store.state.error, status: env.store.state.status })
      .toMatchInlineSnapshot(`
        error: { code: 500, id: 'fetch-error', message: 'Fetch error' }
        status: 'error'
      `);

    // Force a fresh fetch after the visible error state; recovery should go
    // through loading and settle on the server data again.
    env.addTimelineComments('beforeNextAction', [
      'force a retry after the first failure; the document should leave the error state and recover',
    ]);
    env.scheduleFetch('highPriority');

    await flushAllTimers();

    expect(env.serverMock.numOfFinishedFetches).toBe(2);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | ui                          |
      0     | "status:loading data:null"  | ui-initialized
      10ms  | "status:loading data:null"  | 🔴 >fetch-started
      .     | "status:loading data:null"  | 🔴 <fetch-error (value: "error")
      .     | "status:error data:null"    | ui-changed
      .     | "status:error data:null"    | -- force a retry after the first failure; the document should leave the error state and recover
      .     | "status:error data:null"    | scheduled-fetch-triggered
      20ms  | "status:loading data:null"  | ui-changed
      .     | "status:loading data:null"  | 🟠 >fetch-started
      820ms | "status:loading data:null"  | 🟠 <fetch-finished (value: {"hello":"world"})
      .     | "status:success data:world" | ui-changed
      "
    `);
  });

  test('collection store item can force a retry after entering an error state', async () => {
    const env = createCollectionStoreTestEnv<Todo>({
      '1': { title: 'todo', completed: false },
    });

    // Fail the first item fetch so the explicit retry has to recover from error.
    env.serverTable.setNextFetchError('1', 'Fetch error');

    renderHook(() => {
      const item = env.apiStore.useItem('1');
      env.trackItemUI('item-status', item.status);
      env.trackItemUI('item-data', item.data?.value.title ?? null);
    });

    // Let the hook mount settle into the error state first.
    await flushAllTimers();

    expect(env.apiStore.getItemState('1')).toMatchInlineSnapshot(`
      data: null
      error: { code: 500, id: 'fetch-error', message: 'Fetch error' }
      payload: '1'
      refetchOnMount: '❌'
      status: 'error'
      wasLoaded: '❌'
    `);

    // Force a new fetch for the same item; the hook should recover instead of
    // staying stuck in the previous failure.
    env.addTimelineComments('beforeNextAction', [
      'force a retry for the failed item; the same hook should recover with the real server row',
    ]);
    env.scheduleFetch('highPriority', '1');

    await flushAllTimers();

    expect(env.serverTable.getRequestHistory('item', { includeTime: false }))
      .toMatchInlineSnapshot(`
        - _type: 'item'
          payload: { itemId: '1' }
        - _type: 'item'
          payload: { itemId: '1' }
      `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item-data | item-status |
      0     | ···       | loading     | [item-status, item-data] ui-initialized
      10ms  | ···       | loading     | 🔴 [1] >fetch-started
      .     | ···       | loading     | 🔴 [1] <fetch-error (value: "error")
      .     | ···       | error       | [item-status] ui-changed
      .     | ···       | error       | -- force a retry for the failed item; the same hook should recover with the real server row
      .     | ···       | error       | [1] scheduled-fetch-triggered
      20ms  | ···       | loading     | [item-status] ui-changed
      .     | ···       | loading     | 🟠 [1] >fetch-started
      820ms | ···       | loading     | 🟠 [1] <fetch-finished (value: {"title":"todo","completed":false})
      .     | todo      | success     | [item-status, item-data] ui-changed
      "
    `);
  });

  test('list-query queries can force a retry after entering an error state', async () => {
    const env = createListQueryStoreTestEnv(listQueryServerData);
    const usersQuery = { tableId: 'users' } as const;

    // Fail the first query load so recovery must happen from a real query error.
    env.serverTable.setNextListFetchError('Fetch error');

    renderHook(() => {
      const query = env.apiStore.useListQuery(usersQuery, {
        disableRefetchOnMount: true,
      });
      env.trackItemUI('query-status', query.status);
      env.trackItemUI('query-count', query.items.length);
    });

    // Drive the first request explicitly so the retry path starts from a
    // visible query error instead of from mount-specific scheduling.
    env.scheduleFetch('highPriority', usersQuery);

    // Let the explicit first request fail and expose the error state.
    await flushAllTimers();

    expect({
      error: env.apiStore.getQueryState(usersQuery)?.error,
      items: env.apiStore.getQueryState(usersQuery)?.items.length,
      status: env.apiStore.getQueryState(usersQuery)?.status,
    }).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'Fetch error' }
      items: 0
      status: 'error'
    `);

    // Force the same query to fetch again; it should recover and repopulate its items.
    env.addTimelineComments('beforeNextAction', [
      'force a retry for the failed query; it should leave the error state and repopulate the list',
    ]);
    env.scheduleFetch('highPriority', usersQuery);

    await flushAllTimers();

    expect(
      env.serverTable
        .getRequestHistory('list', { includeTime: false })
        .map((entry) => entry.payload),
    ).toMatchInlineSnapshot(`
      - fields: '*'
        pos: { limit: 50, offset: 0 }
      - fields: '*'
        pos: { limit: 50, offset: 0 }
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | query-count | query-status |
      0     | 0           | loading      | [query-status, query-count] ui-initialized
      .     | 0           | loading      | scheduled-fetch-coalesced
      10ms  | 0           | loading      | 🔴 >list-fetch-started
      810ms | 0           | loading      | 🔴 <list-fetch-error (value: "error")
      .     | 0           | error        | [query-status] ui-changed
      .     | 0           | error        | -- force a retry for the failed query; it should leave the error state and repopulate the list
      .     | 0           | error        | scheduled-fetch-triggered
      820ms | 0           | loading      | [query-status] ui-changed
      .     | 0           | loading      | 🟠 >list-fetch-started
      1.62s | 0           | loading      | 🟠 <list-fetch-finished (value: {"count":2})
      .     | 2           | success      | [query-status, query-count] ui-changed
      "
    `);
  });

  test('list-query items can force a retry after entering an error state', async () => {
    const env = createListQueryStoreTestEnv(listQueryServerData);
    const itemPayload = 'users||1';

    // Fail the first item load so the explicit retry proves item-level recovery too.
    env.serverTable.setNextFetchError(itemPayload, 'Fetch error');

    renderHook(() => {
      const item = env.apiStore.useItem(itemPayload, {
        disableRefetchOnMount: true,
      });
      env.trackItemUI('item-status', item.status);
      env.trackItemUI('item-data', item.data?.name ?? null);
    });

    // Drive the first request explicitly so the recovery path starts from a
    // visible item error, not from an implicit mount fetch.
    env.scheduleItemFetch('highPriority', itemPayload);

    // Let the first item request fail before asking for the retry.
    await flushAllTimers();

    expect({
      error: env.getItemQueryState(itemPayload)?.error,
      status: env.getItemQueryState(itemPayload)?.status,
      wasLoaded: env.getItemQueryState(itemPayload)?.wasLoaded,
    }).toMatchInlineSnapshot(`
      error: { code: 500, id: 'fetch-error', message: 'Fetch error' }
      status: 'error'
      wasLoaded: '❌'
    `);

    // Force a retry for the failed item; it should recover through loading and
    // settle back on the server value.
    env.addTimelineComments('beforeNextAction', [
      'force a retry for the failed list-query item; the item hook should recover with server data',
    ]);
    env.scheduleItemFetch('highPriority', itemPayload);

    await flushAllTimers();

    expect(
      env.serverTable
        .getRequestHistory('item', { includeTime: false })
        .map((entry) => entry.payload),
    ).toMatchInlineSnapshot(`
      - itemId: 'users||1'
      - itemId: 'users||1'
    `);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time  | item-data | item-status |
      0     | ···       | loading     | [item-status, item-data] ui-initialized
      .     | ···       | loading     | [users||1] scheduled-fetch-coalesced
      10ms  | ···       | loading     | 🔴 [users||1] >fetch-started
      .     | ···       | loading     | 🔴 [users||1] <fetch-error (value: "error")
      .     | ···       | error       | [item-status] ui-changed
      .     | ···       | error       | -- force a retry for the failed list-query item; the item hook should recover with server data
      .     | ···       | error       | [users||1] scheduled-fetch-triggered
      20ms  | ···       | loading     | [item-status] ui-changed
      .     | ···       | loading     | 🟠 [users||1] >fetch-started
      820ms | ···       | loading     | 🟠 [users||1] <fetch-finished (value: {"id":1,"name":"Ada"})
      .     | Ada       | success     | [item-status, item-data] ui-changed
      "
    `);
  });
});
