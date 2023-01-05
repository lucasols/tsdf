import { newTSDFDocumentStore } from '../../src/documentStore';
import { mockServerResource } from '../mocks/fetchMock';

export type StoreError = {
  message: string;
};

export function normalizeError(exception: unknown): StoreError {
  if (exception instanceof Error) {
    return {
      message: exception.message,
    };
  }

  return {
    message: String(exception),
  };
}

export type DefaultStoreData = {
  hello: string;
};

export function createDefaultDocumentStore({
  serverHello = 'world',
  storeWithInitialData,
}: { serverHello?: string; storeWithInitialData?: boolean } = {}) {
  const serverMock = mockServerResource<DefaultStoreData>({
    initialData: { hello: serverHello },
  });

  const documentStore = newTSDFDocumentStore({
    fetchFn: serverMock.fetchWitoutSelector,
    initialData: storeWithInitialData ? { hello: 'world' } : undefined,
    errorNormalizer: normalizeError,
  });

  const startTime = Date.now();

  function getElapsedTime() {
    return Date.now() - startTime;
  }

  return { serverMock, documentStore, getElapsedTime };
}
