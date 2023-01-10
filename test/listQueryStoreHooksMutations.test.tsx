import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import {
  createDefaultListQueryStore,
  Tables,
} from './utils/createDefaultListQueryStore';
import { randomInt } from './utils/math';
import { range } from './utils/range';
import { sleep } from './utils/sleep';
import { createRenderStore } from './utils/storeUtils';

const createTestEnv = createDefaultListQueryStore;

const initialServerData: Tables = {
  users: range(1, 5).map((id) => ({ id, name: `User ${id}` })),
  products: range(1, 50).map((id) => ({ id, name: `Product ${id}` })),
  orders: range(1, 50).map((id) => ({ id, name: `Order ${id}` })),
};

async function updateItemName(
  { store, serverMock }: ReturnType<typeof createTestEnv>,
  tableId: string,
  itemId: string,
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

test.concurrent('user updating the name of a record', async () => {
  const env = createTestEnv({
    initialServerData,
    useLoadedSnapshot: { tables: ['users', 'products'] },
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

  function waitTypingInterval() {
    const time = randomInt(226, 300);
    return sleep(time);
  }

  function setName(name: string) {
    updateItemName(env, 'users', '1', name, {
      optimisticUpdate: true,
      revalidate: true,
    });
  }

  // perform mutation
  setName('');

  expect(env.store.getItemState('users||1')).toMatchObject({ name: '' });

  await waitTypingInterval();

  setName('T');

  await waitTypingInterval();

  setName('Ty');

  await waitTypingInterval();

  setName('Typ');

  await waitTypingInterval();

  act(() => {
    setName('Type');
  });

  await env.serverMock.waitFetchIdle(0, 1500);

  expect(env.store.getItemState('users||1')).toMatchObject({ name: 'Type' });

  expect(renders.snapshot).toMatchSnapshotString(`
    "
    status: success -- data: {id:1, name:User 1}
    status: success -- data: {id:1, name:}
    status: success -- data: {id:1, name:T}
    status: success -- data: {id:1, name:Ty}
    status: success -- data: {id:1, name:Typ}
    status: success -- data: {id:1, name:Type}
    status: refetching -- data: {id:1, name:Type}
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

    updateItemName(env, 'users', '1', 'newName', {
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

test.only('creation mutation with id generated by client', async () => {
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

test('user change multiple records in sequence with RTU enabled', async () => {});

test('query receives a RTU while the query is loading by the component mount', async () => {});

test('delete mutation with RTU', async () => {});

test('creation mutation with RTU', async () => {});

test('simple update mutation with RTU', async () => {});
