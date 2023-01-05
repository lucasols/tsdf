import { describe, expect, test } from 'vitest';
import {
  newTSDFDocumentStore,
  TSDFDocumentStoreState,
} from '../src/documentStore';
import { mockServerResource } from './mocks/fetchMock';
import { sleep } from './utils/sleep';
import {
  createDefaultDocumentStore,
  normalizeError,
  StoreError,
} from './utils/storeUtils';

type DocumentStoreState = TSDFDocumentStoreState<any, StoreError>;

describe('fetch lifecicle', () => {
  const { serverMock, documentStore } = createDefaultDocumentStore();

  test('fetch resource', async () => {
    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: null,
      error: null,
      refetchOnMount: false,
      status: 'idle',
    });

    documentStore.scheduleFetch('lowPriority');

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: null,
      error: null,
      refetchOnMount: false,
      status: 'loading',
    });

    await sleep(serverMock.timeout + 5);

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: {
        hello: 'world',
      },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });
  });

  test('refetch resource with new data', async () => {
    serverMock.mutateData({ hello: 'new data' });

    documentStore.scheduleFetch('highPriority');

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: {
        hello: 'world',
      },
      error: null,
      refetchOnMount: false,
      status: 'refetching',
    });

    await sleep(serverMock.timeout + 5);

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: {
        hello: 'new data',
      },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });

    expect(serverMock.numOfFetchs).toBe(2);
  });

  test('refetch resource with error', async () => {
    serverMock.trhowErrorInNextFetch('error');

    documentStore.scheduleFetch('highPriority');

    await sleep(serverMock.timeout + 5);

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: {
        hello: 'new data',
      },
      error: {
        message: 'error',
      },
      refetchOnMount: false,
      status: 'error',
    });
  });
});

test.concurrent('start with initialized data', async () => {
  const serverMock = mockServerResource<any>({
    initialData: null,
  });

  const documentStore = newTSDFDocumentStore({
    fetchFn: serverMock.fetchWitoutSelector,
    initialData: { hello: 'initial data' },
    errorNormalizer: normalizeError,
  });

  expect(documentStore.store.state).toEqual<DocumentStoreState>({
    data: {
      hello: 'initial data',
    },
    error: null,
    refetchOnMount: false,
    status: 'success',
  });
});

test.concurrent(
  'multiple low priority fetchs at same time trigger only one fetch',
  async () => {
    const serverMock = mockServerResource<any>({
      initialData: { hello: 'new data' },
    });

    const documentStore = newTSDFDocumentStore({
      fetchFn: serverMock.fetchWitoutSelector,
      initialData: { hello: 'world' },
      errorNormalizer: normalizeError,
    });

    documentStore.scheduleFetch('lowPriority');
    documentStore.scheduleFetch('lowPriority');
    documentStore.scheduleFetch('lowPriority');
    documentStore.scheduleFetch('lowPriority');

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: { hello: 'world' },
      error: null,
      refetchOnMount: false,
      status: 'refetching',
    });

    await sleep(serverMock.timeout + 5);

    expect(serverMock.numOfFetchs).toBe(1);

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: { hello: 'new data' },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });
  },
);

test.concurrent('await fetch', async () => {
  const { serverMock, documentStore } = createDefaultDocumentStore({
    storeWithInitialData: true,
  });

  serverMock.mutateData({ hello: 'new data' });

  expect(documentStore.store.state).toMatchObject({
    data: {
      hello: 'world',
    },
  });

  expect(await documentStore.awaitFetch()).toEqual({
    data: {
      hello: 'new data',
    },
    error: null,
  });

  serverMock.trhowErrorInNextFetch('error');

  expect(await documentStore.awaitFetch()).toEqual({
    data: null,
    error: {
      message: 'error',
    },
  });
});
