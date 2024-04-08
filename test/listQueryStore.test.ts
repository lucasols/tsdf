import { describe, expect, test } from 'vitest';
import {
  Tables,
  createDefaultListQueryStore,
} from './utils/createDefaultListQueryStore';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { simplifyArraySnapshot } from './utils/storeUtils';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

const createTestEnv = createDefaultListQueryStore;

const usersQueryParams = { tableId: 'users' };

describe.concurrent('test helpers', () => {
  test('snapshot is equal to loaded state', async () => {
    const loaded = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    loaded.forceListUpdate(usersQueryParams);

    await loaded.serverMock.waitFetchIdle();

    const withUserSnapshot = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    expect(loaded.store.store.state).toEqual(
      withUserSnapshot.store.store.state,
    );

    loaded.forceListUpdate({ tableId: 'products' });

    await loaded.serverMock.waitFetchIdle();

    const withSnapshot = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
      disableInitialDataInvalidation: true,
    });

    expect(loaded.store.store.state).toEqual(withSnapshot.store.store.state);
  });

  test('snapshot with filter is equal to loaded state', async () => {
    const loaded = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    loaded.forceListUpdate({
      tableId: 'users',
      filters: { idIsGreaterThan: 2 },
    });

    await loaded.serverMock.waitFetchIdle();

    const withUserSnapshot = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: {
        queries: [{ tableId: 'users', filters: { idIsGreaterThan: 2 } }],
      },
    });

    expect(loaded.store.store.state).toEqual(
      withUserSnapshot.store.store.state,
    );
  });
});

describe.concurrent('fetch query', () => {
  test('fetch query', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
    });

    expect(listQueryStore.store.state).toEqual({
      items: {},
      queries: {},
      itemQueries: {},
      partialQueries: {},
      partialItemsQueries: {},
    });

    listQueryStore.scheduleListQueryFetch('lowPriority', usersQueryParams);

    expect(listQueryStore.getQueryState(usersQueryParams)).toEqual({
      error: null,
      hasMore: false,
      items: [],
      refetchOnMount: false,
      status: 'loading',
      payload: { tableId: 'users' },
      wasLoaded: false,
    });
    expect(listQueryStore.store.state.items).toEqual({});

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchSnapshot();

    expect(serverMock.fetchsCount).toBe(1);
  });

  test('refetch list with updated data', async ({ expect }) => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    listQueryStore.scheduleListQueryFetch('highPriority', usersQueryParams);

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchSnapshot();

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.getItemState('users||1'))
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "Updated User 1",
      }
    `);
    expect(listQueryStore.store.state.items).toMatchSnapshot();

    expect(serverMock.fetchsCount).toBe(1);
  });

  test('refetch list with error', async () => {
    const {
      serverMock,
      store: listQueryStore,
      forceListUpdate,
    } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    serverMock.setFetchError('error');

    forceListUpdate(usersQueryParams);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": true,
        }
      `);

    // refetch with success
    serverMock.setFetchError(null);

    forceListUpdate(usersQueryParams);

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
  });

  test('load list with error', async () => {
    const {
      serverMock,
      store: listQueryStore,
      forceListUpdate,
    } = createTestEnv({
      initialServerData,
    });

    serverMock.setFetchError('error');

    forceListUpdate(usersQueryParams);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "hasMore": false,
          "items": [],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": false,
        }
      `);

    // refetch with success
    serverMock.setFetchError(null);

    forceListUpdate(usersQueryParams);

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "loading",
          "wasLoaded": false,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "hasMore": false,
          "items": [
            "users||1",
            "users||2",
            "users||3",
            "users||4",
            "users||5",
          ],
          "payload": {
            "tableId": "users",
          },
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
  });

  test('fetch with size', async ({ expect }) => {
    const query = { tableId: 'products' as const };

    const {
      serverMock,
      store: listQueryStore,
      forceListUpdate,
    } = createTestEnv({
      initialServerData,
      defaultQuerySize: 5,
    });

    listQueryStore.scheduleListQueryFetch('highPriority', query, 5);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(query)).toMatchInlineSnapshotString(`
      {
        "error": null,
        "hasMore": true,
        "items": [
          "products||1",
          "products||2",
          "products||3",
          "products||4",
          "products||5",
        ],
        "payload": {
          "tableId": "products",
        },
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
    expect(listQueryStore.store.state.items).toMatchSnapshot();

    expect(serverMock.fetchsCount).toBe(1);

    // load more
    listQueryStore.loadMore(query);

    expect(listQueryStore.getQueryState(query)).toMatchInlineSnapshotString(`
      {
        "error": null,
        "hasMore": true,
        "items": [
          "products||1",
          "products||2",
          "products||3",
          "products||4",
          "products||5",
        ],
        "payload": {
          "tableId": "products",
        },
        "refetchOnMount": false,
        "status": "loadingMore",
        "wasLoaded": true,
      }
    `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(query)).toMatchInlineSnapshotString(`
      {
        "error": null,
        "hasMore": true,
        "items": [
          "products||1",
          "products||2",
          "products||3",
          "products||4",
          "products||5",
          "products||6",
          "products||7",
          "products||8",
          "products||9",
          "products||10",
        ],
        "payload": {
          "tableId": "products",
        },
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
    expect(listQueryStore.store.state.items).toMatchSnapshot();

    // refetch keep size
    forceListUpdate(query);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(query)).toMatchInlineSnapshotString(`
      {
        "error": null,
        "hasMore": true,
        "items": [
          "products||1",
          "products||2",
          "products||3",
          "products||4",
          "products||5",
          "products||6",
          "products||7",
          "products||8",
          "products||9",
          "products||10",
        ],
        "payload": {
          "tableId": "products",
        },
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
  });

  test('do not load more if the query not exists or hasMore === false', () => {
    const { store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(listQueryStore.loadMore(usersQueryParams, 10)).toBe('skipped');
    expect(listQueryStore.loadMore({ tableId: 'not found' }, 10)).toBe(
      'skipped',
    );
  });

  test.concurrent(
    'multiple fetches with different payloads not cancel each other, but cancel same payload fetches',
    async () => {
      const { serverMock, store: listQueryStore } = createTestEnv({
        initialServerData,
      });

      const fetch = listQueryStore.scheduleListQueryFetch;

      fetch('lowPriority', { tableId: 'users' });
      fetch('lowPriority', { tableId: 'products' });
      fetch('lowPriority', { tableId: 'orders' });

      fetch('lowPriority', { tableId: 'users' });
      fetch('highPriority', { tableId: 'products' });
      fetch('lowPriority', { tableId: 'orders' });

      await sleep(10);

      fetch('lowPriority', { tableId: 'users' });
      fetch('lowPriority', { tableId: 'products' });
      fetch('lowPriority', { tableId: 'orders' });

      await serverMock.waitFetchIdle(40);

      expect(serverMock.fetchsCount).toBe(3);

      fetch('lowPriority', { tableId: 'users' });
      fetch('lowPriority', { tableId: 'products' });
      fetch('lowPriority', { tableId: 'orders' });

      fetch('highPriority', { tableId: 'users' });
      fetch('highPriority', { tableId: 'products' });
      fetch('highPriority', { tableId: 'orders' });

      await serverMock.waitFetchIdle(40);

      expect(serverMock.fetchsCount).toBe(6);
    },
  );
});

test.concurrent('ignore multiple load more made in sequence', async () => {
  const { store: listQueryStore, serverMock } = createTestEnv({
    initialServerData,
    defaultQuerySize: 5,
  });

  const query = { tableId: 'products' as const };

  listQueryStore.scheduleListQueryFetch('highPriority', query, 5);

  await serverMock.waitFetchIdle();

  expect(listQueryStore.getQueryState(query)?.items).toMatchInlineSnapshot(`
    [
      "products||1",
      "products||2",
      "products||3",
      "products||4",
      "products||5",
    ]
  `);

  expect(listQueryStore.loadMore(query)).toBe('started');
  expect(listQueryStore.loadMore(query)).toBe('skipped');
  expect(listQueryStore.loadMore(query)).toBe('skipped');

  await sleep(10);

  expect(listQueryStore.loadMore(query)).toBe('skipped');
  expect(listQueryStore.loadMore(query)).toBe('skipped');

  await serverMock.waitFetchIdle();

  expect(listQueryStore.getQueryState(query)?.items)
    .toMatchInlineSnapshotString(`
    [
      "products||1",
      "products||2",
      "products||3",
      "products||4",
      "products||5",
      "products||6",
      "products||7",
      "products||8",
      "products||9",
      "products||10",
    ]
  `);

  expect(listQueryStore.loadMore(query)).toBe('started');
  expect(listQueryStore.loadMore(query)).toBe('skipped');

  await serverMock.waitFetchIdle();

  expect(listQueryStore.getQueryState(query)?.items)
    .toMatchInlineSnapshotString(`
    [
      "products||1",
      "products||2",
      "products||3",
      "products||4",
      "products||5",
      "products||6",
      "products||7",
      "products||8",
      "products||9",
      "products||10",
      "products||11",
      "products||12",
      "products||13",
      "products||14",
      "products||15",
    ]
  `);
});

test.concurrent('await fetch', async () => {
  const { serverMock, store: listQueryStore } = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  });

  serverMock.produceData((draft) => {
    draft['users']![0]!.name = 'Updated User 1';
  });

  expect(listQueryStore.getItemState('users||1')).toMatchObject({
    name: 'User 1',
  });

  expect(
    await listQueryStore.awaitListQueryFetch({ tableId: 'users' }),
  ).toEqual({
    items: [
      { itemPayload: 'users||1', data: { id: 1, name: 'Updated User 1' } },
      { itemPayload: 'users||2', data: { id: 2, name: 'User 2' } },
      { itemPayload: 'users||3', data: { id: 3, name: 'User 3' } },
      { itemPayload: 'users||4', data: { id: 4, name: 'User 4' } },
      { itemPayload: 'users||5', data: { id: 5, name: 'User 5' } },
    ],
    error: null,
    hasMore: false,
  });

  serverMock.setFetchError('error');

  expect(
    await listQueryStore.awaitListQueryFetch({ tableId: 'users' }, 2),
  ).toEqual({
    items: [],
    error: { message: 'error' },
    hasMore: false,
  });

  expect(serverMock.fetchsCount).toEqual(2);
});

describe.concurrent('fetch item', () => {
  test.concurrent('fetch item', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
    });

    expect(
      listQueryStore.store.state.itemQueries['users||1'],
    ).toMatchInlineSnapshotString('undefined');

    listQueryStore.scheduleItemFetch('lowPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
      {
        "error": null,
        "payload": "users||1",
        "refetchOnMount": false,
        "status": "loading",
        "wasLoaded": false,
      }
    `);
    expect(listQueryStore.getItemState('users||1')).toMatchInlineSnapshotString(
      'undefined',
    );

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
      {
        "error": null,
        "payload": "users||1",
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
    expect(listQueryStore.getItemState('users||1'))
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    expect(serverMock.fetchsCount).toBe(1);
  });

  test.concurrent('await fetch item', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    expect(listQueryStore.getItemState('users||1')).toMatchObject({
      name: 'User 1',
    });

    expect(await listQueryStore.awaitItemFetch('users||1')).toEqual({
      data: { id: 1, name: 'Updated User 1' },
      error: null,
    });

    serverMock.setFetchError('error');

    expect(await listQueryStore.awaitItemFetch('users||1')).toEqual({
      data: null,
      error: { message: 'error' },
    });

    expect(serverMock.fetchsCount).toEqual(2);
  });

  test.concurrent('test helpers initial snapshot', async () => {
    const loaded = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    loaded.store.scheduleItemFetch('lowPriority', 'users||1');

    await loaded.serverMock.waitFetchIdle();

    const withStateSnapshot = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { items: ['users||1'] },
      disableInitialDataInvalidation: true,
    });

    expect(withStateSnapshot.store.store.state).toEqual(
      loaded.store.store.state,
    );
  });

  test.concurrent('test helpers initial snapshot 2', async () => {
    const loaded = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    loaded.store.scheduleItemFetch('lowPriority', 'users||1');
    loaded.store.scheduleListQueryFetch('lowPriority', {
      tableId: 'users',
    });

    await loaded.serverMock.waitFetchIdle();

    const withStateSnapshot = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'], items: ['users||1'] },
      disableInitialDataInvalidation: true,
    });

    expect(withStateSnapshot.store.store.state).toEqual(
      loaded.store.store.state,
    );
  });

  test('refetch item with updated data', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { items: ['users||1'] },
      disableInitialDataInvalidation: true,
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.getItemState('users||1'))
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);

    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "Updated User 1",
        },
      }
    `);

    expect(serverMock.fetchsCount).toBe(1);
  });

  test('refetch item with error', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { items: ['users||1'] },
    });

    serverMock.setFetchError('error');

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": true,
        }
      `);

    // refetch with success
    serverMock.setFetchError(null);

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "User 1",
        },
      }
    `);
  });

  test('load item with error', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
    });

    serverMock.setFetchError('error');

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": false,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`{}`);

    // refetch with success
    serverMock.setFetchError(null);

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "loading",
          "wasLoaded": false,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchInlineSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "User 1",
        },
      }
    `);
  });

  test.concurrent(
    'multiple item fetchs with different ids do not cancel each other, but cancel the ones with same id',
    async () => {
      const { serverMock, store: listQueryStore } = createTestEnv({
        initialServerData,
        disableInitialDataInvalidation: true,
      });

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('highPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      await sleep(10);

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      await serverMock.waitFetchIdle(40);

      expect(serverMock.fetchsCount).toBe(3);

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      listQueryStore.scheduleItemFetch('highPriority', 'users||1');
      listQueryStore.scheduleItemFetch('highPriority', 'users||2');
      listQueryStore.scheduleItemFetch('highPriority', 'users||3');

      await serverMock.waitFetchIdle(40);

      expect(serverMock.fetchsCount).toBe(6);
    },
  );

  test('load a item that was previously loaded by a query', async () => {
    const { serverMock, store: listQueryStore } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchInlineSnapshotString(`
        {
          "error": null,
          "payload": "users||1",
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);

    expect(listQueryStore.store.state.items['users||1'])
      .toMatchInlineSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);
  });

  test.concurrent(
    'load item should share the lowPriority throttle context of the queries',
    async () => {
      const { store: listQueryStore } = createTestEnv({
        initialServerData,
        disableInitialDataInvalidation: true,
      });

      listQueryStore.scheduleListQueryFetch('highPriority', {
        tableId: 'users',
      });

      await sleep(50);

      const result = listQueryStore.scheduleItemFetch(
        'lowPriority',
        'users||1',
      );

      expect(result).toBe('skipped');
    },
  );
});

describe('update state functions', () => {
  test('update state of one item', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||1')).toMatchInlineSnapshot(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    store.updateItemState('users||1', (data) => {
      data.name = 'User 1 updated';
    });

    expect(store.getItemState('users||1')).toMatchInlineSnapshot(`
      {
        "id": 1,
        "name": "User 1 updated",
      }
    `);
  });

  test('update multiple items state', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    store.updateItemState(['users||1', 'users||2'], () => {
      return {
        name: 'new name',
        id: 1,
      };
    });

    expect(
      simplifyArraySnapshot(
        store.getItemState(['users||1', 'users||2', 'users||3']),
      ),
    ).toMatchInlineSnapshot(`
      "
      payload: users||1, data: {name: new name, id: 1}
      payload: users||2, data: {name: new name, id: 1}
      payload: users||3, data: {id: 3, name: User 3}
      "
    `);
  });

  test('update multiple items state with filter fn', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    store.updateItemState(
      (_, state) => state.id > 2,
      (data) => {
        data.name = 'modified';
      },
    );

    expect(simplifyArraySnapshot(store.getItemState(() => true)))
      .toMatchInlineSnapshot(`
      "
      payload: users||1, data: {id: 1, name: User 1}
      payload: users||2, data: {id: 2, name: User 2}
      payload: users||3, data: {id: 3, name: modified}
      payload: users||4, data: {id: 4, name: modified}
      payload: users||5, data: {id: 5, name: modified}
      "
    `);
  });

  test('create if not exist', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    let storeUpdates = 0;
    store.store.subscribe(() => {
      storeUpdates++;
    });

    store.updateItemState(
      '20',
      (data) => {
        data.name = 'item 20';
      },
      {
        ifNothingWasUpdated: () => {
          store.addItemToState('users||20', {
            name: 'item 20',
            id: 20,
          });
        },
      },
    );

    expect(storeUpdates).toEqual(1);

    expect(simplifyArraySnapshot(store.getItemState(() => true)))
      .toMatchInlineSnapshot(`
      "
      payload: users||1, data: {id: 1, name: User 1}
      payload: users||2, data: {id: 2, name: User 2}
      payload: users||3, data: {id: 3, name: User 3}
      payload: users||4, data: {id: 4, name: User 4}
      payload: users||5, data: {id: 5, name: User 5}
      payload: users||20, data: {name: item 20, id: 20}
      "
    `);
  });

  test('addItemToState', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||20')).toBeUndefined();

    store.addItemToState('users||20', {
      name: 'item users||20',
      id: 20,
    });

    expect(store.getItemState('users||20')).toMatchInlineSnapshot(`
      {
        "id": 20,
        "name": "item users||20",
      }
    `);
    expect(store.store.state.itemQueries['users||20']).toMatchInlineSnapshot(`
      {
        "error": null,
        "payload": "users||20",
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
  });

  test('addItemToState with addItemToQueries', () => {
    const { store } = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      disableInitialDataInvalidation: true,
    });

    expect(store.getItemState('users||20')).toBeUndefined();

    store.addItemToState(
      'users||20',
      {
        name: 'item users||20',
        id: 20,
      },
      {
        addItemToQueries: {
          queries: { tableId: 'users' },
          appendTo: 'start',
        },
      },
    );

    expect(store.store.state).toEqual({
      itemQueries: {
        'users||1': {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||2': {
          error: null,
          payload: 'users||2',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||20': {
          error: null,
          payload: 'users||20',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||3': {
          error: null,
          payload: 'users||3',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||4': {
          error: null,
          payload: 'users||4',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||5': {
          error: null,
          payload: 'users||5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      items: {
        'users||1': { id: 1, name: 'User 1' },
        'users||2': { id: 2, name: 'User 2' },
        'users||20': { id: 20, name: 'item users||20' },
        'users||3': { id: 3, name: 'User 3' },
        'users||4': { id: 4, name: 'User 4' },
        'users||5': { id: 5, name: 'User 5' },
      },
      queries: {
        [`{"tableId":"users"}`]: {
          error: null,
          hasMore: false,
          items: [
            'users||20',
            'users||1',
            'users||2',
            'users||3',
            'users||4',
            'users||5',
          ],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      partialQueries: {},
      partialItemsQueries: {},
    });
  });

  test('addItemToState with existing items and addItemToQueries', () => {
    const { store } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||1')).not.toBeUndefined();

    store.addItemToState(
      'users||1',
      {
        name: 'item users||20',
        id: 20,
      },
      {
        addItemToQueries: {
          queries: { tableId: 'users' },
          appendTo: 'start',
        },
      },
    );

    expect(store.store.state).toEqual({
      partialQueries: {},
      partialItemsQueries: {},
      itemQueries: {
        'users||1': {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||2': {
          error: null,
          payload: 'users||2',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||3': {
          error: null,
          payload: 'users||3',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||4': {
          error: null,
          payload: 'users||4',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
        'users||5': {
          error: null,
          payload: 'users||5',
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
      items: {
        'users||1': { id: 20, name: 'item users||20' },
        'users||2': { id: 2, name: 'User 2' },
        'users||3': { id: 3, name: 'User 3' },
        'users||4': { id: 4, name: 'User 4' },
        'users||5': { id: 5, name: 'User 5' },
      },
      queries: {
        [`{"tableId":"users"}`]: {
          error: null,
          hasMore: false,
          items: ['users||1', 'users||2', 'users||3', 'users||4', 'users||5'],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });

  test('delete item state', () => {
    const { store } = createTestEnv({
      initialServerData,
      disableInitialDataInvalidation: true,
      useLoadedSnapshot: { tables: ['users'] },
    });

    expect(store.getItemState('users||1')).toBeDefined();

    store.deleteItemState('users||1');

    expect(store.getItemState('users||1')).toBeNull();

    expect(store.scheduleItemFetch('highPriority', 'users||1')).toBe('started');

    const defaultItemQueryProps = {
      error: null,
      refetchOnMount: false,
      status: 'success',
      wasLoaded: true,
    };
    expect(store.store.state).toEqual({
      partialQueries: {},
      partialItemsQueries: {},
      itemQueries: {
        'users||1': {
          error: null,
          payload: 'users||1',
          refetchOnMount: false,
          status: 'loading',
          wasLoaded: false,
        },
        'users||2': { ...defaultItemQueryProps, payload: 'users||2' },
        'users||3': { ...defaultItemQueryProps, payload: 'users||3' },
        'users||4': { ...defaultItemQueryProps, payload: 'users||4' },
        'users||5': { ...defaultItemQueryProps, payload: 'users||5' },
      },
      items: {
        'users||1': null,
        'users||2': { id: 2, name: 'User 2' },
        'users||3': { id: 3, name: 'User 3' },
        'users||4': { id: 4, name: 'User 4' },
        'users||5': { id: 5, name: 'User 5' },
      },
      queries: {
        '{"tableId":"users"}': {
          error: null,
          hasMore: false,
          items: ['users||2', 'users||3', 'users||4', 'users||5'],
          payload: { tableId: 'users' },
          refetchOnMount: false,
          status: 'success',
          wasLoaded: true,
        },
      },
    });
  });
});

describe('an item invalidation with lower priority should not override one with higher priority', () => {
  const itemId = 'users||1';
  const testEnvOptions = {
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  };

  test.concurrent('not override high priority update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'highPriority',
      queryPayload: false,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'lowPriority',
      queryPayload: false,
    });

    expect(env.store.store.state.itemQueries[itemId]?.refetchOnMount).toEqual(
      'highPriority',
    );
  });

  test.concurrent('not override rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'realtimeUpdate',
      queryPayload: false,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'lowPriority',
      queryPayload: false,
    });

    expect(env.store.store.state.itemQueries[itemId]?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test.concurrent('not override highPriority with rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'highPriority',
      queryPayload: false,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: itemId,
      type: 'realtimeUpdate',
      queryPayload: false,
    });

    expect(env.store.store.state.itemQueries[itemId]?.refetchOnMount).toEqual(
      'highPriority',
    );
  });
});

describe('a query invalidation with lower priority should not override one with higher priority', () => {
  const queryPayload = { tableId: 'users' };
  const testEnvOptions = {
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  };

  test.concurrent('not override high priority update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      itemPayload: false,
      type: 'highPriority',
      queryPayload,
    });

    env.store.invalidateQueryAndItems({
      itemPayload: false,
      type: 'lowPriority',
      queryPayload,
    });

    expect(env.store.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'highPriority',
    );
  });

  test.concurrent('not override rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'realtimeUpdate',
      itemPayload: false,
    });

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'lowPriority',
      itemPayload: false,
    });

    expect(env.store.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'realtimeUpdate',
    );
  });

  test.concurrent('not override highPriority with rtu update', () => {
    const env = createTestEnv(testEnvOptions);

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'highPriority',
      itemPayload: false,
    });

    env.store.invalidateQueryAndItems({
      queryPayload,
      type: 'realtimeUpdate',
      itemPayload: false,
    });

    expect(env.store.getQueryState(queryPayload)?.refetchOnMount).toEqual(
      'highPriority',
    );
  });
});

test('invalidate everything does not cause a problem', () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  });

  env.store.invalidateQueryAndItems({
    queryPayload: () => true,
    itemPayload: () => true,
  });

  expect(env.store.store.state).toEqual({
    partialQueries: {},
    partialItemsQueries: {},
    itemQueries: {
      'users||1': {
        error: null,
        payload: 'users||1',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||2': {
        error: null,
        payload: 'users||2',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||3': {
        error: null,
        payload: 'users||3',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||4': {
        error: null,
        payload: 'users||4',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
      'users||5': {
        error: null,
        payload: 'users||5',
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
    },
    items: {
      'users||1': { id: 1, name: 'User 1' },
      'users||2': { id: 2, name: 'User 2' },
      'users||3': { id: 3, name: 'User 3' },
      'users||4': { id: 4, name: 'User 4' },
      'users||5': { id: 5, name: 'User 5' },
    },
    queries: {
      [`{"tableId":"users"}`]: {
        error: null,
        hasMore: false,
        items: ['users||1', 'users||2', 'users||3', 'users||4', 'users||5'],
        payload: { tableId: 'users' },
        refetchOnMount: 'highPriority',
        status: 'success',
        wasLoaded: true,
      },
    },
  });
});
