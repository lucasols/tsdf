import { describe, expect, test } from 'vitest';
import {
  createDefaultListQueryStore,
  Tables,
} from './utils/createDefaultListQueryStore';
import { range } from './utils/range';
import { sleep } from './utils/sleep';

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

const usersQueryParams = { tableId: 'users' };

describe.concurrent('test helpers', () => {
  test('snapshot is equal to loaded state', async () => {
    const loaded = createDefaultListQueryStore({
      initialServerData,
    });

    loaded.forceListUpdate(usersQueryParams);

    await loaded.serverMock.waitFetchIdle();

    const withUserSnapshot = createDefaultListQueryStore({
      initialServerData,
      loadLoadedTablesSnapshot: 'users',
    });

    expect(loaded.listQueryStore.store.state).toEqual(
      withUserSnapshot.listQueryStore.store.state,
    );

    loaded.forceListUpdate({ tableId: 'products' });

    await loaded.serverMock.waitFetchIdle();

    const withSnapshot = createDefaultListQueryStore({
      initialServerData,
      loadLoadedTablesSnapshot: ['users', 'products'],
    });

    expect(loaded.listQueryStore.store.state).toEqual(
      withSnapshot.listQueryStore.store.state,
    );
  });
});

describe.concurrent('fetch query', () => {
  test('fetch query', async () => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
    });

    expect(listQueryStore.store.state).toEqual({
      items: {},
      queries: {},
      itemQueries: {},
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
      .toMatchSnapshotString(`
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

    expect(serverMock.numOfFetchs).toBe(1);
  });

  test('refetch list with updated data', async ({ expect }) => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      loadLoadedTablesSnapshot: 'users',
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    listQueryStore.scheduleListQueryFetch('highPriority', usersQueryParams);

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchSnapshotString(`
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
      .toMatchSnapshotString(`
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
    expect(listQueryStore.getItemState('users||1')).toMatchSnapshotString(`
      {
        "id": 1,
        "name": "Updated User 1",
      }
    `);
    expect(listQueryStore.store.state.items).toMatchSnapshot();

    expect(serverMock.numOfFetchs).toBe(1);
  });

  // FIXLATER: add error tests to other stores
  test('refetch list with error', async () => {
    const { serverMock, listQueryStore, forceListUpdate } =
      createDefaultListQueryStore({
        initialServerData,
        loadLoadedTablesSnapshot: 'users',
      });

    serverMock.setFetchError('error');

    forceListUpdate(usersQueryParams);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchSnapshotString(`
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
      .toMatchSnapshotString(`
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
      .toMatchSnapshotString(`
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
    const { serverMock, listQueryStore, forceListUpdate } =
      createDefaultListQueryStore({
        initialServerData,
      });

    serverMock.setFetchError('error');

    forceListUpdate(usersQueryParams);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(usersQueryParams))
      .toMatchSnapshotString(`
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
      .toMatchSnapshotString(`
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
      .toMatchSnapshotString(`
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

    const { serverMock, listQueryStore, forceListUpdate } =
      createDefaultListQueryStore({
        initialServerData,
        defaultQuerySize: 5,
      });

    listQueryStore.scheduleListQueryFetch('highPriority', query, 5);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.getQueryState(query)).toMatchSnapshotString(`
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

    expect(serverMock.numOfFetchs).toBe(1);

    // load more
    listQueryStore.loadMore(query, 5);

    expect(listQueryStore.getQueryState(query)).toMatchSnapshotString(`
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

    expect(listQueryStore.getQueryState(query)).toMatchSnapshotString(`
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

    expect(listQueryStore.getQueryState(query)).toMatchSnapshotString(`
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

  test('do not load more if the query not exists or hasMore === false', async () => {
    const { listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      loadLoadedTablesSnapshot: 'users',
    });

    expect(listQueryStore.loadMore(usersQueryParams, 10)).toBe('skipped');
    expect(listQueryStore.loadMore({ tableId: 'not found' }, 10)).toBe(
      'skipped',
    );
  });

  test.concurrent(
    'multiple fetchs with different payloads not cancel each other, but cancel same payload fetchs',
    async () => {
      const { serverMock, listQueryStore } = createDefaultListQueryStore({
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

      expect(serverMock.numOfFetchs).toBe(3);

      fetch('lowPriority', { tableId: 'users' });
      fetch('lowPriority', { tableId: 'products' });
      fetch('lowPriority', { tableId: 'orders' });

      fetch('highPriority', { tableId: 'users' });
      fetch('highPriority', { tableId: 'products' });
      fetch('highPriority', { tableId: 'orders' });

      await serverMock.waitFetchIdle(40);

      expect(serverMock.numOfFetchs).toBe(6);
    },
  );
});

test.concurrent('await fetch', async () => {
  const { serverMock, listQueryStore } = createDefaultListQueryStore({
    initialServerData,
    loadLoadedTablesSnapshot: 'users',
  });

  serverMock.produceData((draft) => {
    draft['users']![0]!.name = 'Updated User 1';
  });

  expect(listQueryStore.getItemState('users||1')).toMatchObject({
    name: 'User 1',
  });

  expect(await listQueryStore.awaitListFetch({ tableId: 'users' })).toEqual({
    items: [
      { id: 'users||1', data: { id: 1, name: 'Updated User 1' } },
      { id: 'users||2', data: { id: 2, name: 'User 2' } },
      { id: 'users||3', data: { id: 3, name: 'User 3' } },
      { id: 'users||4', data: { id: 4, name: 'User 4' } },
      { id: 'users||5', data: { id: 5, name: 'User 5' } },
    ],
    error: null,
    hasMore: false,
  });

  serverMock.setFetchError('error');

  expect(await listQueryStore.awaitListFetch({ tableId: 'users' }, 2)).toEqual({
    items: [],
    error: { message: 'error' },
    hasMore: false,
  });

  expect(serverMock.numOfFetchs).toEqual(2);
});

describe.concurrent('fetch item', () => {
  test('fetch item', async () => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
    });

    expect(
      listQueryStore.store.state.itemQueries['users||1'],
    ).toMatchSnapshotString('undefined');

    listQueryStore.scheduleItemFetch('lowPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
      {
        "error": null,
        "refetchOnMount": false,
        "status": "loading",
        "wasLoaded": false,
      }
    `);
    expect(listQueryStore.getItemState('users||1')).toMatchSnapshotString(
      'undefined',
    );

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
      {
        "error": null,
        "refetchOnMount": false,
        "status": "success",
        "wasLoaded": true,
      }
    `);
    expect(listQueryStore.getItemState('users||1')).toMatchSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    expect(serverMock.numOfFetchs).toBe(1);
  });

  test.concurrent('test helpers inital snapshot', async () => {
    const loaded = createDefaultListQueryStore({ initialServerData });

    loaded.listQueryStore.scheduleItemFetch('lowPriority', 'users||1');

    await loaded.serverMock.waitFetchIdle();

    const withStateSnapshot = createDefaultListQueryStore({
      initialServerData,
      loadLoadedItemsSnapshot: ['users||1'],
    });

    expect(withStateSnapshot.listQueryStore.store.state).toEqual(
      loaded.listQueryStore.store.state,
    );
  });

  test.concurrent('test helpers inital snapshot 2', async () => {
    const loaded = createDefaultListQueryStore({ initialServerData });

    loaded.listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
    loaded.listQueryStore.scheduleListQueryFetch('lowPriority', {
      tableId: 'users',
    });

    await loaded.serverMock.waitFetchIdle();

    const withStateSnapshot = createDefaultListQueryStore({
      initialServerData,
      loadLoadedItemsSnapshot: ['users||1'],
      loadLoadedTablesSnapshot: 'users',
    });

    expect(withStateSnapshot.listQueryStore.store.state).toEqual(
      loaded.listQueryStore.store.state,
    );
  });

  test('refetch item with updated data', async () => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      loadLoadedItemsSnapshot: ['users||1'],
    });

    serverMock.produceData((draft) => {
      draft['users']![0]!.name = 'Updated User 1';
    });

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.getItemState('users||1')).toMatchSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);

    expect(listQueryStore.store.state.items).toMatchSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "Updated User 1",
        },
      }
    `);

    expect(serverMock.numOfFetchs).toBe(1);
  });

  test('refetch item with error', async () => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      loadLoadedItemsSnapshot: ['users||1'],
    });

    serverMock.setFetchError('error');

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": true,
        }
      `);

    // refetch with success
    serverMock.setFetchError(null);

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchSnapshotString(`
      {
        "users||1": {
          "id": 1,
          "name": "User 1",
        },
      }
    `);
  });

  test('load item with error', async () => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
    });

    serverMock.setFetchError('error');

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": {
            "message": "error",
          },
          "refetchOnMount": false,
          "status": "error",
          "wasLoaded": false,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchSnapshotString(`{}`);

    // refetch with success
    serverMock.setFetchError(null);

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "loading",
          "wasLoaded": false,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);
    expect(listQueryStore.store.state.items).toMatchSnapshotString(`
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
      const { serverMock, listQueryStore } = createDefaultListQueryStore({
        initialServerData,
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

      expect(serverMock.numOfFetchs).toBe(3);

      listQueryStore.scheduleItemFetch('lowPriority', 'users||1');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||2');
      listQueryStore.scheduleItemFetch('lowPriority', 'users||3');

      listQueryStore.scheduleItemFetch('highPriority', 'users||1');
      listQueryStore.scheduleItemFetch('highPriority', 'users||2');
      listQueryStore.scheduleItemFetch('highPriority', 'users||3');

      await serverMock.waitFetchIdle(40);

      expect(serverMock.numOfFetchs).toBe(6);
    },
  );

  test('load a item that was previously loaded by a query', async () => {
    const { serverMock, listQueryStore } = createDefaultListQueryStore({
      initialServerData,
      loadLoadedTablesSnapshot: ['users'],
    });

    listQueryStore.scheduleItemFetch('highPriority', 'users||1');

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "refetching",
          "wasLoaded": true,
        }
      `);

    await serverMock.waitFetchIdle();

    expect(listQueryStore.store.state.itemQueries['users||1'])
      .toMatchSnapshotString(`
        {
          "error": null,
          "refetchOnMount": false,
          "status": "success",
          "wasLoaded": true,
        }
      `);

    expect(listQueryStore.store.state.items['users||1']).toMatchSnapshotString(`
      {
        "id": 1,
        "name": "User 1",
      }
    `);
  });

  test.concurrent(
    'load item should share the lowPriority throttle context of the queries',
    async () => {
      const { listQueryStore } = createDefaultListQueryStore({
        initialServerData,
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

  test('load a query and in the middle of the fetch load an item that return a different data for the item', async () => {});
});
