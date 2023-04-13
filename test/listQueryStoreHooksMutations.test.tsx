import { renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  createDefaultListQueryStore,
  Tables,
} from './utils/createDefaultListQueryStore';
import { randomInt } from './utils/math';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { createRenderStore, waitElapsedTime } from './utils/storeUtils';

const createTestEnv = createDefaultListQueryStore;

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

async function updateItemName(
  { store, serverMock }: ReturnType<typeof createTestEnv>,
  tableId: string,
  itemId: number,
  newText: string,
  {
    revalidate,
    optimisticUpdate,
    duration,
  }: {
    revalidate?: boolean;
    optimisticUpdate?: boolean;
    duration?: number;
  } = {},
) {
  const id = `${tableId}||${itemId}`;
  const endMutation = store.startItemMutation(id);

  if (optimisticUpdate) {
    store.updateItemState(id, (draftData) => {
      draftData.name = newText;
    });
  }

  const result = await serverMock.emulateMutation(
    (data) => {
      data[tableId]![Number(itemId) - 1]!.name = newText;
    },
    { duration: duration ?? randomInt(500, 1000) },
  );

  endMutation();

  if (revalidate) store.invalidateItem(id);

  return result;
}

async function addItemWithIdGeneratedByServer(
  { store, serverMock }: ReturnType<typeof createTestEnv>,
  tableId: string,
  name: string,
  {
    revalidate: invalidateAfterMutation,
    duration,
  }: {
    revalidate?: boolean;
    duration?: number;
  } = {},
) {
  const endMutation = store.startItemMutation(`${tableId}||?`);

  let id: number | undefined;

  const result = await serverMock.emulateMutation(
    (data) => {
      id = data[tableId]!.length + 1;
      data[tableId]?.push({ id, name });
    },
    { duration: duration ?? randomInt(500, 1000) },
  );

  endMutation();

  store.addItemToState(`${tableId}||${id}`, {
    id: id!,
    name,
  });

  if (invalidateAfterMutation) store.invalidateItem(`${tableId}||${id}`);

  return result;
}

async function addItemWithIdGeneratedByClient(
  { store, serverMock }: ReturnType<typeof createTestEnv>,
  tableId: string,
  userId: string,
  name: string,
  {
    revalidate,
    duration,
  }: {
    revalidate?: boolean;
    duration?: number;
  } = {},
) {
  const id = `${tableId}||${userId}`;
  const endMutation = store.startItemMutation(id);

  store.addItemToState(id, {
    id: Number(userId),
    name,
  });

  const result = await serverMock.emulateMutation(
    (data) => {
      data[tableId]?.push({ id: Number(userId), name });
    },
    { duration: duration ?? randomInt(500, 1000) },
  );

  endMutation();

  if (revalidate) store.invalidateItem(id, 'highPriority');

  return result;
}

async function deleteItem(
  { store, serverMock }: ReturnType<typeof createTestEnv>,
  tableId: string,
  itemId: number,
  {
    revalidate,
    duration,
    optimisticUpdate,
  }: {
    revalidate?: boolean;
    optimisticUpdate?: boolean;
    duration?: number;
  } = {},
) {
  const id = `${tableId}||${itemId}`;
  const endMutation = store.startItemMutation(id);

  if (optimisticUpdate) {
    store.deleteItemState(id);
  }

  const result = await serverMock.emulateMutation(
    (data) => {
      data[tableId]!.splice(itemId - 1, 1);
    },
    { duration: duration ?? randomInt(500, 1000) },
  );

  endMutation();

  if (revalidate) store.invalidateItem(id);

  return result;
}

test.concurrent('user updating the name of a record', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users', 'products'] },
  });

  const renders = createRenderStore();

  env.serverMock.setFetchDuration(263);

  renderHook(() => {
    const { data, status } = env.store.useItem('users||1', {
      disableRefetchOnMount: true,
    });

    renders.add({ status, data });
  });

  function setName(name: string, duration: number) {
    updateItemName(env, 'users', 1, name, {
      optimisticUpdate: true,
      revalidate: true,
      duration,
    });
  }

  // perform mutation
  setName('', 530);

  expect(env.store.getItemState('users||1')).toMatchObject({ name: '' });

  await sleep(263);

  setName('T', 662);

  await sleep(263);

  setName('Ty', 560);

  await sleep(300);

  setName('Typ', 560);

  await sleep(226);

  env.serverMock.setFetchDuration(230);

  setName('Type', 523);

  await env.serverMock.waitFetchIdle(500, 1500);

  expect(env.store.getItemState('users||1')).toMatchObject({ name: 'Type' });

  expect(renders.snapshot).toMatchSnapshotString(`
    "
    status: success -- data: {id:1, name:User 1}
    status: success -- data: {id:1, name:}
    status: success -- data: {id:1, name:T}
    status: success -- data: {id:1, name:Ty}
    status: success -- data: {id:1, name:Typ}
    status: success -- data: {id:1, name:Type}
    "
  `);

  expect(env.serverMock.fetchsCount).toBe(1);
});

test.concurrent(
  'user updating the name of a record, but a RTU is received for a table while the update is in progress',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users', 'products'] },
      emulateRTU: true,
    });

    const renders = createRenderStore();

    env.serverMock.setFetchDuration([200, 400]);

    renderHook(() => {
      const { data, status } = env.store.useItem('users||1', {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
      });

      renders.add({ status, data });
    });

    updateItemName(env, 'users', 1, 'newName', {
      optimisticUpdate: true,
      revalidate: true,
      duration: 400,
    });

    await sleep(350);

    env.serverMock.produceData((data) => {
      data.users![0]!.name = 'RTU';
    });

    await env.serverMock.waitFetchIdle();

    expect(env.store.getItemState('users||1')).toMatchObject({ name: 'RTU' });

    expect(env.serverMock.fetchsCount).toBe(1);

    expect(renders.snapshot).toMatchSnapshotString(`
    "
    status: success -- data: {id:1, name:User 1}
    status: success -- data: {id:1, name:newName}
    status: refetching -- data: {id:1, name:newName}
    status: success -- data: {id:1, name:RTU}
    "
  `);
  },
);

test.concurrent('creation mutation with id generated by server', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  });

  const renders = createRenderStore();

  env.serverMock.setFetchDuration([200, 400]);

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data;
        },
      },
    );

    renders.add({ status, items });
  });

  addItemWithIdGeneratedByServer(env, 'users', 'newUser', {
    revalidate: true,
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(env.serverMock.fetchsCount).toBe(1);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [{id:1, name:User 1}, {id:2, name:User 2}, {id:3, name:User 3}, {id:4, name:User 4}, {id:5, name:User 5}]
    status: refetching -- items: [{id:1, name:User 1}, {id:2, name:User 2}, {id:3, name:User 3}, {id:4, name:User 4}, {id:5, name:User 5}]
    status: success -- items: [{id:1, name:User 1}, {id:2, name:User 2}, {id:3, name:User 3}, {id:4, name:User 4}, {id:5, name:User 5}, {id:6, name:newUser}]
    "
  `);
});

test.concurrent('creation mutation with id generated by client', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
  });

  const renders = createRenderStore();

  env.serverMock.setFetchDuration([200, 400]);

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data;
        },
      },
    );

    renders.add({ status, items });
  });

  addItemWithIdGeneratedByClient(env, 'users', '7', 'newUser', {
    revalidate: true,
  });

  await sleep(10);

  const mountWihtItemRenders = createRenderStore();

  // mount comp to check if the mount loading is a problem
  renderHook(() => {
    const { data, status } = env.store.useItem('users||7', {
      returnRefetchingStatus: true,
    });

    mountWihtItemRenders.add({ status, data });
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(env.serverMock.fetchsCount).toBe(2);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [{id:1, name:User 1}, {id:2, name:User 2}, {id:3, name:User 3}, {id:4, name:User 4}, {id:5, name:User 5}]
    status: refetching -- items: [{id:1, name:User 1}, {id:2, name:User 2}, {id:3, name:User 3}, {id:4, name:User 4}, {id:5, name:User 5}]
    status: success -- items: [{id:1, name:User 1}, {id:2, name:User 2}, {id:3, name:User 3}, {id:4, name:User 4}, {id:5, name:User 5}, {id:7, name:newUser}]
    "
  `);

  expect(mountWihtItemRenders.getSnapshot({ arrays: 'all' }))
    .toMatchSnapshotString(`
    "
    status: success -- data: {id:7, name:newUser}
    status: refetching -- data: {id:7, name:newUser}
    status: success -- data: {id:7, name:newUser}
    "
  `);
});

test.concurrent(
  'user change multiple records in sequence with RTU enabled',
  async () => {
    const env = createTestEnv({
      initialServerData,
      useLoadedSnapshot: { tables: ['users'] },
      emulateRTU: true,
    });

    const renders = createRenderStore();

    env.serverMock.setFetchDuration([200, 400]);

    renderHook(() => {
      const { items, status } = env.store.useListQuery(
        { tableId: 'users' },
        {
          returnRefetchingStatus: true,
          disableRefetchOnMount: true,
          itemSelector(data) {
            return `${data.id}:${data.name}`;
          },
        },
      );

      renders.add({ status, items });
    });

    function updateName(itemId: number, newName: string) {
      updateItemName(env, 'users', itemId, newName, {
        revalidate: false,
        optimisticUpdate: true,
      });
    }

    updateName(1, '✅');

    await sleep(200);

    updateName(2, '❌');

    await sleep(250);

    updateName(3, '✅');

    await sleep(230);

    updateName(4, '❌');

    await sleep(250);

    updateName(5, '✅');

    await sleep(250);

    updateName(3, '❌');

    await sleep(250);

    await env.serverMock.waitFetchIdle(400, 1500);

    expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [1:User 1, 2:User 2, 3:User 3, 4:User 4, 5:User 5]
    status: success -- items: [1:✅, 2:User 2, 3:User 3, 4:User 4, 5:User 5]
    status: success -- items: [1:✅, 2:❌, 3:User 3, 4:User 4, 5:User 5]
    status: success -- items: [1:✅, 2:❌, 3:✅, 4:User 4, 5:User 5]
    status: success -- items: [1:✅, 2:❌, 3:✅, 4:❌, 5:User 5]
    status: success -- items: [1:✅, 2:❌, 3:✅, 4:❌, 5:✅]
    status: success -- items: [1:✅, 2:❌, 3:❌, 4:❌, 5:✅]
    status: refetching -- items: [1:✅, 2:❌, 3:❌, 4:❌, 5:✅]
    status: success -- items: [1:✅, 2:❌, 3:❌, 4:❌, 5:✅]
    "
  `);
  },
  { retry: 3 },
);

test.concurrent(
  'query receives a RTU while the query is loading by the component mount',
  async () => {
    const env = createTestEnv({
      initialServerData,
      emulateRTU: true,
    });

    const renders = createRenderStore();

    env.serverMock.setFetchDuration(400);

    renderHook(() => {
      const { data, status } = env.store.useItem('users||2', {
        returnRefetchingStatus: true,
      });

      renders.add({ status, data });
    });

    await sleep(50);

    env.serverMock.produceData((draft) => {
      draft['users']![1]!.name = '✅';
    });

    await env.serverMock.waitFetchIdle(400, 1500);

    expect(renders.snapshot).toMatchSnapshotString(`
    "
    status: loading -- data: null
    status: success -- data: {id:2, name:✅}
    "
  `);
  },
);

test.concurrent('delete mutation with RTU', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    emulateRTU: true,
  });

  const renders = createRenderStore();

  env.serverMock.setFetchDuration(400);

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data.name;
        },
      },
    );

    renders.add({ status, items });
  });

  deleteItem(env, 'users', 2, { optimisticUpdate: true, duration: 600 });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [User 1, User 2, User 3, User 4, User 5]
    status: success -- items: [User 1, User 3, User 4, User 5]
    status: refetching -- items: [User 1, User 3, User 4, User 5]
    status: success -- items: [User 1, User 3, User 4, User 5]
    "
  `);
});

test.concurrent('creation mutation with RTU', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    emulateRTU: true,
  });

  const renders = createRenderStore();

  env.serverMock.setFetchDuration(400);

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data.name;
        },
      },
    );

    renders.add({ status, items });
  });

  addItemWithIdGeneratedByClient(env, 'users', '8', '🆕');

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [User 1, User 2, User 3, User 4, User 5]
    status: refetching -- items: [User 1, User 2, User 3, User 4, User 5]
    status: success -- items: [User 1, User 2, User 3, User 4, User 5, 🆕]
    "
  `);
});

test.concurrent('simple update mutation with RTU', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    emulateRTU: true,
  });

  const renders = createRenderStore();

  env.serverMock.setFetchDuration(400);

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data.name;
        },
      },
    );

    renders.add({ status, items });
  });

  updateItemName(env, 'users', 5, '🆕');

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [User 1, User 2, User 3, User 4, User 5]
    status: refetching -- items: [User 1, User 2, User 3, User 4, User 5]
    status: success -- items: [User 1, User 2, User 3, User 4, 🆕]
    "
  `);
});

test.concurrent('RTU throttling', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    emulateRTU: true,
    dynamicRTUThrottleMs(lastDuration) {
      if (lastDuration < 100) {
        return 200;
      }

      return 300;
    },
  });

  const renders = createRenderStore();

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data.name;
        },
      },
    );

    renders.add({ status, items });
  });

  const waitUntil = waitElapsedTime();

  env.serverMock.setFetchDuration(200);

  updateItemName(env, 'users', 5, '1', { duration: 100 });

  await waitUntil(350);

  env.serverMock.setFetchDuration(30);

  updateItemName(env, 'users', 5, '2', { duration: 100 });

  await waitUntil(670);

  updateItemName(env, 'users', 5, '3', { duration: 100 });

  await waitUntil(900);

  expect(
    env.serverMock.fetchs[1]!.time.start - env.serverMock.fetchs[0]!.time.end,
  ).toBeGreaterThanOrEqual(300);

  const diffLastFetch =
    env.serverMock.fetchs[2]!.time.start - env.serverMock.fetchs[1]!.time.end;

  expect(diffLastFetch).toBeGreaterThanOrEqual(200);
  expect(diffLastFetch).toBeLessThan(300);

  expect(renders.getSnapshot({ arrays: 'firstAndLast' }))
    .toMatchSnapshotString(`
    "
    status: success -- items: [User 1, ...(3 between), User 5]
    status: refetching -- items: [User 1, ...(3 between), User 5]
    status: success -- items: [User 1, ...(3 between), 1]
    status: refetching -- items: [User 1, ...(3 between), 1]
    status: success -- items: [User 1, ...(3 between), 2]
    status: refetching -- items: [User 1, ...(3 between), 2]
    status: success -- items: [User 1, ...(3 between), 3]
    "
  `);
});

test.concurrent('mount component after a RTU', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users'] },
    emulateRTU: true,
    dynamicRTUThrottleMs(lastDuration) {
      if (lastDuration < 100) {
        return 200;
      }

      return 300;
    },
  });

  const renders = createRenderStore();

  env.serverMock.produceData((draft) => {
    draft['users']?.push({
      id: 6,
      name: 'User 6',
    });
  });

  await sleep(100);

  expect(env.store.store.state.queries).toMatchSnapshotString(`
    {
      "[{\\"tableId\\":\\"users\\"}]": {
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
        "refetchOnMount": "realtimeUpdate",
        "status": "success",
        "wasLoaded": true,
      },
    }
  `);

  renderHook(() => {
    const { items, status } = env.store.useListQuery(
      { tableId: 'users' },
      {
        returnRefetchingStatus: true,
        disableRefetchOnMount: true,
        itemSelector(data) {
          return data.name;
        },
      },
    );

    renders.add({ status, items });
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(renders.getSnapshot({ arrays: 'all' })).toMatchSnapshotString(`
    "
    status: success -- items: [User 1, User 2, User 3, User 4, User 5]
    status: refetching -- items: [User 1, User 2, User 3, User 4, User 5]
    status: success -- items: [User 1, User 2, User 3, User 4, User 5, User 6]
    "
  `);
});
