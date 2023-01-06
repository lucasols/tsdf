import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sleep } from './utils/sleep';
import {
  createDefaultCollectionStore,
  DefaultCollectionState,
} from './utils/storeUtils';

async function waitInitializationFetch(store: any) {
  store.scheduleFetch('lowPriority', '1');
  await sleep(35);
}

const defaultTodo = { title: 'todo', completed: false };

describe('test helpers', () => {
  test('start with store initialized state', () => {
    const { collectionStore } = createDefaultCollectionStore({
      serverInitialData: { '1': defaultTodo, '2': defaultTodo },
      initializeStoreWithServerData: true,
    });

    expect(collectionStore.store.state).toEqual({
      '1': {
        data: { completed: false, title: 'todo' },
        error: null,
        payload: '1',
        refetchOnMount: false,
        status: 'success',
      },
      '2': {
        data: { completed: false, title: 'todo' },
        error: null,
        payload: '2',
        refetchOnMount: false,
        status: 'success',
      },
    });
  });
});

describe('fetch lifecicle', () => {
  const { serverMock, collectionStore } = createDefaultCollectionStore();

  test('fetch resource', async () => {
    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({});

    collectionStore.scheduleFetch('lowPriority', '1');

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: null,
        error: null,
        refetchOnMount: false,
        status: 'loading',
        payload: '1',
      },
    });

    await sleep(serverMock.fetchDuration + 5);

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: { title: 'todo', completed: false },
        error: null,
        refetchOnMount: false,
        status: 'success',
        payload: '1',
      },
    });

    expect(serverMock.numOfFetchs).toBe(1);
  });

  test('refetch resource with new data', async () => {
    serverMock.mutateData({
      '1': {
        title: 'new title',
        completed: false,
      },
    });

    collectionStore.scheduleFetch('highPriority', '1');

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: { title: 'todo', completed: false },
        error: null,
        refetchOnMount: false,
        status: 'refetching',
        payload: '1',
      },
    });

    await sleep(serverMock.fetchDuration + 5);

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: { title: 'new title', completed: false },
        error: null,
        refetchOnMount: false,
        status: 'success',
        payload: '1',
      },
    });

    expect(serverMock.numOfFetchs).toBe(2);
  });

  test('refetch resource with error', async () => {
    serverMock.trhowErrorInNextFetch('error');

    collectionStore.scheduleFetch('highPriority', '1');

    await sleep(serverMock.fetchDuration + 5);

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: { title: 'new title', completed: false },
        error: { message: 'error' },
        refetchOnMount: false,
        status: 'error',
        payload: '1',
      },
    });
  });
});

test.concurrent(
  'multiple low priority fetchs at same time trigger only one fetch',
  async () => {
    const { serverMock, collectionStore } = createDefaultCollectionStore();

    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '1');

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: null,
        error: null,
        payload: '1',
        refetchOnMount: false,
        status: 'loading',
      },
    });

    await sleep(serverMock.fetchDuration + 5);

    expect(serverMock.numOfFetchs).toEqual(1);

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': {
        data: { title: 'todo', completed: false },
        error: null,
        refetchOnMount: false,
        status: 'success',
        payload: '1',
      },
    });
  },
);

test.concurrent('initialization fetch', async () => {
  const { collectionStore } = createDefaultCollectionStore();

  await waitInitializationFetch(collectionStore);

  expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
    '1': {
      data: { title: 'todo', completed: false },
      error: null,
      refetchOnMount: false,
      status: 'success',
      payload: '1',
    },
  });
});

test.concurrent('await fetch', async () => {
  const { serverMock, collectionStore } = createDefaultCollectionStore();

  await waitInitializationFetch(collectionStore);

  serverMock.mutateData({ '1': { title: 'new title', completed: false } });

  expect(collectionStore.getItemState('1')).toMatchObject({
    data: { title: 'todo', completed: false },
  });

  expect(await collectionStore.awaitFetch('1')).toEqual({
    data: { title: 'new title', completed: false },
    error: null,
  });

  serverMock.trhowErrorInNextFetch('error');

  expect(await collectionStore.awaitFetch('1')).toEqual({
    data: null,
    error: {
      message: 'error',
    },
  });

  expect(serverMock.numOfFetchs).toEqual(3);
});

test.concurrent(
  'multiple fetchs with different payloads not cancel each other, but cancel same payload fetchs',
  async () => {
    const { serverMock, collectionStore } = createDefaultCollectionStore({
      serverInitialData: {
        '1': defaultTodo,
        '2': defaultTodo,
        '3': defaultTodo,
        '4': defaultTodo,
        '5': defaultTodo,
        '6': defaultTodo,
        '7': defaultTodo,
      },
    });

    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '2');
    collectionStore.scheduleFetch('lowPriority', '3');
    collectionStore.scheduleFetch('lowPriority', '4');
    collectionStore.scheduleFetch('lowPriority', '5');
    collectionStore.scheduleFetch('lowPriority', '6');
    collectionStore.scheduleFetch('lowPriority', '7');

    await sleep(10);

    collectionStore.scheduleFetch('lowPriority', '1');
    collectionStore.scheduleFetch('lowPriority', '2');
    collectionStore.scheduleFetch('lowPriority', '3');
    collectionStore.scheduleFetch('lowPriority', '4');
    collectionStore.scheduleFetch('lowPriority', '5');
    collectionStore.scheduleFetch('lowPriority', '6');
    collectionStore.scheduleFetch('lowPriority', '7');

    await sleep(serverMock.fetchDuration + 5);

    expect(serverMock.numOfFetchs).toEqual(7);

    const defaultState = {
      data: defaultTodo,
      error: null,
      refetchOnMount: false,
      status: 'success' as const,
    };

    expect(collectionStore.store.state).toEqual<DefaultCollectionState>({
      '1': { ...defaultState, payload: '1' },
      '2': { ...defaultState, payload: '2' },
      '3': { ...defaultState, payload: '3' },
      '4': { ...defaultState, payload: '4' },
      '5': { ...defaultState, payload: '5' },
      '6': { ...defaultState, payload: '6' },
      '7': { ...defaultState, payload: '7' },
    });
  },
);

describe('update state functions', async () => {
  const serverInitialData = {
    '1': { ...defaultTodo, completed: true },
    '2': { ...defaultTodo, completed: true },
    '3': defaultTodo,
    '4': defaultTodo,
    '5': defaultTodo,
  };

  describe('updateItemState', () => {
    test('update state of one item', () => {
      const { collectionStore } = createDefaultCollectionStore({
        serverInitialData,
        initializeStoreWithServerData: true,
      });

      expect(collectionStore.getItemState('1')?.data).toEqual({
        completed: true,
        title: 'todo',
      });

      collectionStore.updateItemState('1', (data) => {
        data.title = 'new title';
      });

      expect(collectionStore.getItemState('1')?.data).toEqual({
        completed: true,
        title: 'new title',
      });
    });

    test('update multiple itens state', () => {
      const { collectionStore } = createDefaultCollectionStore({
        serverInitialData,
        initializeStoreWithServerData: true,
      });

      collectionStore.updateItemState(['1', '2'], () => {
        return {
          title: 'new title 2',
          completed: false,
        };
      });

      expect(
        collectionStore.getItemState(['1', '2', '3'])?.map((item) => {
          return { id: item.payload, ...item.data };
        }),
      ).toEqual([
        { completed: false, id: '1', title: 'new title 2' },
        { completed: false, id: '2', title: 'new title 2' },
        // 3 is not updated
        { completed: false, id: '3', title: 'todo' },
      ]);
    });

    test('update multiple itens state with filter fn', () => {
      const { collectionStore } = createDefaultCollectionStore({
        serverInitialData,
        initializeStoreWithServerData: true,
      });

      collectionStore.updateItemState(
        (_, data) => !!data?.completed,
        (data) => {
          data.completed = false;
          data.title = 'modified';
        },
      );

      expect(
        collectionStore
          .getItemState(() => true)
          .map((item) => {
            return { id: item.payload, ...item.data };
          }),
      ).toEqual([
        { completed: false, id: '1', title: 'modified' },
        { completed: false, id: '2', title: 'modified' },
        { completed: false, id: '3', title: 'todo' },
        { completed: false, id: '4', title: 'todo' },
        { completed: false, id: '5', title: 'todo' },
      ]);
    });

    test('create if not exist', () => {
      const { collectionStore } = createDefaultCollectionStore({
        serverInitialData,
        initializeStoreWithServerData: true,
      });

      let storeUpdates = 0;
      collectionStore.store.subscribe(() => {
        storeUpdates++;
      });

      collectionStore.updateItemState(
        '6',
        (data) => {
          data.title = 'item 6';
        },
        () => {
          collectionStore.addItemToState('6', {
            title: 'item 6',
            completed: false,
          });
        },
      );

      expect(storeUpdates).toEqual(1);

      expect(collectionStore.getItemState('6')).toEqual({
        data: { completed: false, title: 'item 6' },
        error: null,
        payload: '6',
        refetchOnMount: false,
        status: 'success',
      });
    });

    test('create multiple if not exist', () => {
      const { collectionStore } = createDefaultCollectionStore({
        serverInitialData,
        initializeStoreWithServerData: true,
      });

      let storeUpdates = 0;
      collectionStore.store.subscribe(() => {
        storeUpdates++;
      });

      collectionStore.updateItemState(
        (id) => id === '?',
        (data) => {
          data.title = 'item 6';
        },
        () => {
          collectionStore.addItemToState('6', {
            title: 'item 6',
            completed: false,
          });
          collectionStore.addItemToState('7', {
            title: 'item 7',
            completed: false,
          });
        },
      );

      expect(storeUpdates).toEqual(1);

      expect(collectionStore.getItemState(['6', '7', '5'])).toEqual([
        {
          data: { completed: false, title: 'item 6' },
          error: null,
          payload: '6',
          refetchOnMount: false,
          status: 'success',
        },
        {
          data: { completed: false, title: 'item 7' },
          error: null,
          payload: '7',
          refetchOnMount: false,
          status: 'success',
        },
        {
          data: { completed: false, title: 'todo' },
          error: null,
          payload: '5',
          refetchOnMount: false,
          status: 'success',
        },
      ]);
    });
  });

  test('addItemToState', () => {
    const { collectionStore } = createDefaultCollectionStore({
      serverInitialData,
      initializeStoreWithServerData: true,
    });

    expect(collectionStore.getItemState('6')).toBeUndefined();

    collectionStore.addItemToState('6', {
      title: 'item 6',
      completed: false,
    });

    expect(collectionStore.getItemState('6')).toEqual({
      data: { completed: false, title: 'item 6' },
      error: null,
      payload: '6',
      refetchOnMount: false,
      status: 'success',
    });
  });

  test('deleteItemState', () => {
    const { collectionStore } = createDefaultCollectionStore({
      serverInitialData,
      initializeStoreWithServerData: true,
    });

    expect(collectionStore.getItemState('1')).toBeDefined();

    collectionStore.deleteItemState('1');

    expect(collectionStore.getItemState('1')).toBeNull();

    expect(collectionStore.scheduleFetch('highPriority', '1')).toBe('skipped');
  });
});
