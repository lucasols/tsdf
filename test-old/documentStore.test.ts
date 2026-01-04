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

const createTestEnv = createDefaultDocumentStore;

describe('fetch lifecicle', () => {
  const { serverMock, store: documentStore } = createDefaultDocumentStore();

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

    await sleep(serverMock.fetchDuration + 5);

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: {
        hello: 'world',
      },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });
  });

  test(
    'refetch resource with new data',
    async () => {
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

      await sleep(serverMock.fetchDuration + 25);

      expect(documentStore.store.state).toEqual<DocumentStoreState>({
        data: {
          hello: 'new data',
        },
        error: null,
        refetchOnMount: false,
        status: 'success',
      });

      expect(serverMock.fetchsCount).toBe(2);
    },
    { retry: 3 },
  );

  test('refetch resource with error', async () => {
    serverMock.setFetchError('error');

    documentStore.scheduleFetch('highPriority');

    await sleep(serverMock.fetchDuration + 5);

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

test.concurrent('start with initialized data', () => {
  const serverMock = mockServerResource<any>({
    initialData: null,
  });

  const documentStore = newTSDFDocumentStore({
    fetchFn: serverMock.fetchWitoutSelector,
    getInitialData: () => ({ hello: 'initial data' }),
    errorNormalizer: normalizeError,
    disableInitialDataInvalidation: true,
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
      getInitialData: () => ({ hello: 'world' }),
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

    await sleep(serverMock.fetchDuration + 5);

    expect(serverMock.fetchsCount).toBe(1);

    expect(documentStore.store.state).toEqual<DocumentStoreState>({
      data: { hello: 'new data' },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });
  },
);

test.concurrent('await fetch', async () => {
  const { serverMock, store: documentStore } = createDefaultDocumentStore({
    useLoadedSnapshot: true,
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

  serverMock.setFetchError('error');

  expect(await documentStore.awaitFetch()).toEqual({
    data: null,
    error: {
      message: 'error',
    },
  });
});

describe('an invalidation with lower priority should not override one with higher priority', () => {
  test.concurrent('not override high priority update', () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
    });

    env.store.invalidateData('highPriority');

    env.store.invalidateData('lowPriority');

    expect(env.store.store.state.refetchOnMount).toEqual('highPriority');
  });

  test.concurrent('not override rtu update', () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
    });

    env.store.invalidateData('realtimeUpdate');

    env.store.invalidateData('lowPriority');

    expect(env.store.store.state.refetchOnMount).toEqual('realtimeUpdate');
  });

  test.concurrent('not override highPriority with rtu update', () => {
    const env = createTestEnv({
      useLoadedSnapshot: true,
    });

    env.store.invalidateData('highPriority');

    env.store.invalidateData('realtimeUpdate');

    expect(env.store.store.state.refetchOnMount).toEqual('highPriority');
  });
});
