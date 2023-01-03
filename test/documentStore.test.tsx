import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createDocumentStore,
  DocumentStore,
  DocumentStoreState,
} from '../src/documentStore';
import { mockServerResource } from './mocks/fetchMock';
import { sleep } from './utils/sleep';
import { cleanup, render } from '@testing-library/react';

type DefaultStoreData = {
  hello: string;
};

function createDefaultDocumentStore({
  serverHello = 'world',
  storeWithInitialData,
}: { serverHello?: string; storeWithInitialData?: boolean } = {}) {
  const serverMock = mockServerResource<DefaultStoreData>({
    initialData: { hello: serverHello },
  });

  const documentStore = createDocumentStore({
    fetchFn: serverMock.fetch,
    initialData: storeWithInitialData ? { hello: 'world' } : undefined,
  });

  return { serverMock, documentStore };
}

describe('fetch lifecicle', () => {
  const { serverMock, documentStore } = createDefaultDocumentStore();

  test('fetch resource', async () => {
    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
      data: null,
      error: null,
      refetchOnMount: false,
      status: 'idle',
    });

    documentStore.scheduleFetch();

    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
      data: null,
      error: null,
      refetchOnMount: false,
      status: 'loading',
    });

    await sleep(serverMock.timeout + 5);

    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
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

    documentStore.scheduleFetch();

    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
      data: {
        hello: 'world',
      },
      error: null,
      refetchOnMount: false,
      status: 'refetching',
    });

    await sleep(serverMock.timeout + 5);

    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
      data: {
        hello: 'new data',
      },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });
  });

  test('refetch resource with error', async () => {
    serverMock.trhowErrorInNextFetch('error');

    documentStore.scheduleFetch();

    await sleep(serverMock.timeout + 5);

    expect(documentStore.store.state).toMatchInlineSnapshot(`
      {
        "data": {
          "hello": "new data",
        },
        "error": {
          "exception": [Error: error],
          "message": "error",
        },
        "refetchOnMount": false,
        "status": "error",
      }
    `);
  });
});

test.concurrent('start with initialized data', async () => {
  const serverMock = mockServerResource<any>();

  const documentStore = createDocumentStore({
    fetchFn: serverMock.fetch,
    initialData: { hello: 'initial data' },
  });

  expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
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

    const fetchSpy = vi.spyOn(serverMock, 'fetch');

    const documentStore = createDocumentStore({
      fetchFn: serverMock.fetch,
      initialData: { hello: 'world' },
    });

    documentStore.scheduleFetch();
    documentStore.scheduleFetch();
    documentStore.scheduleFetch();
    documentStore.scheduleFetch();

    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
      data: { hello: 'world' },
      error: null,
      refetchOnMount: false,
      status: 'refetching',
    });

    await sleep(serverMock.timeout + 5);

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    expect(documentStore.store.state).toEqual<DocumentStoreState<any>>({
      data: { hello: 'new data' },
      error: null,
      refetchOnMount: false,
      status: 'success',
    });
  },
);

const Component = ({ store }: { store: DocumentStore<any> }) => {
  const { data, status, isLoading } = store.useDocument();

  return (
    <div>
      <div data-testid="status">{status}</div>
      <div data-testid="isLoading">{isLoading ? 'true' : 'false'}</div>
      <div data-testid="data">{JSON.stringify(data)}</div>
    </div>
  );
};

describe('useDocument', () => {
  afterEach(() => {
    cleanup();
  });

  test('load data', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore();

    const { getByTestId, unmount } = render(
      <Component store={documentStore} />,
    );

    expect(getByTestId('status').textContent).toBe('loading');
    expect(getByTestId('isLoading').textContent).toBe('true');
    expect(getByTestId('data').textContent).toBe('null');

    await sleep(serverMock.timeout + 5);

    expect(getByTestId('status').textContent).toBe('success');
    expect(getByTestId('isLoading').textContent).toBe('false');
    expect(getByTestId('data').textContent).toBe('{"hello":"world"}');

    unmount();
  });

  test('invalidate data', async () => {
    const { serverMock, documentStore } = createDefaultDocumentStore({
      storeWithInitialData: true,
    });

    const { getByTestId } = render(<Component store={documentStore} />);

    expect(getByTestId('data').textContent).toBe('{"hello":"world"}');

    serverMock.mutateData({ hello: 'was invalidated' });
    documentStore.invalidateData();

    await sleep(serverMock.timeout + 5);

    expect(getByTestId('data').textContent).toBe('{"hello":"was invalidated"}');
  });
});
