import { describe, expect, test } from 'vitest';
import { sleep } from './utils/sleep';
import {
  createDefaultCollectionStore,
  DefaultCollectionState,
} from './utils/storeUtils';

async function waitInitializationFetch(store: any) {
  store.scheduleFetch('lowPriority', '1');
  await sleep(35);
}

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

    await sleep(serverMock.timeout + 5);

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

    await sleep(serverMock.timeout + 5);

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

    await sleep(serverMock.timeout + 5);

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

    await sleep(serverMock.timeout + 5);

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
    const todo = { title: 'todo', completed: false };
    const { serverMock, collectionStore } = createDefaultCollectionStore({
      initialData: {
        '1': todo,
        '2': todo,
        '3': todo,
        '4': todo,
        '5': todo,
        '6': todo,
        '7': todo,
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

    await sleep(serverMock.timeout + 5);

    expect(serverMock.numOfFetchs).toEqual(7);

    const defaultState = {
      data: todo,
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
