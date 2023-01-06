import { deepEqual, Store } from 't-state';
import { T } from 'vitest/dist/types-bae746aa';
import {
  newTSDFCollectionStore,
  TSDFCollectionStore,
  TSFDCollectionState,
} from '../../src/collectionStore';
import { newTSDFDocumentStore } from '../../src/documentStore';
import { mockServerResource } from '../mocks/fetchMock';
import { arrayWithPrev } from './arrayUtils';

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

export type DefaultDocStoreData = {
  hello: string;
};

export function createDefaultDocumentStore({
  serverHello = 'world',
  storeWithInitialData,
  debug,
}: {
  serverHello?: string;
  storeWithInitialData?: boolean;
  debug?: never;
} = {}) {
  const serverMock = mockServerResource<DefaultDocStoreData>({
    initialData: { hello: serverHello },
    logFetchs: debug,
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

  if (debug as any) {
    documentStore.store.subscribe(({ current }) => {
      // eslint-disable-next-line no-console
      console.log(serverMock.relativeTime(), current);
    });
  }

  return { serverMock, documentStore, getElapsedTime };
}

type Todo = {
  title: string;
  completed: boolean;
  description?: string;
};

type ServerData = Record<string, Todo | null>;

export type DefaultCollectionState = TSFDCollectionState<
  Todo,
  string,
  StoreError
>;

export type DefaultCollectionStore = TSDFCollectionStore<
  Todo,
  StoreError,
  string,
  string
>;

export function createDefaultCollectionStore({
  serverInitialData = { '1': { title: 'todo', completed: false } },
  initializeStoreWithServerData,
  randomTimeout,
}: {
  serverInitialData?: ServerData;
  initializeStoreWithServerData?: boolean;
  /** default: 30-100 */
  randomTimeout?: true;
} = {}) {
  const serverMock = mockServerResource<ServerData, Todo>({
    initialData: serverInitialData,
    randomTimeout,
    fetchSelector(data, params) {
      const todo = data && data[params];

      if (!todo) {
        throw new Error('Not found');
      }

      return todo;
    },
  });

  const collectionStore = newTSDFCollectionStore({
    fetchFn: serverMock.fetch,
    errorNormalizer: normalizeError,
    getCollectionItemPayload: (data) => data,
  });

  if (initializeStoreWithServerData) {
    const initialState: DefaultCollectionState = {};

    for (const [id, todo] of Object.entries(serverInitialData)) {
      initialState[id] = {
        data: todo,
        status: 'success',
        error: null,
        payload: id,
        refetchOnMount: false,
      };
    }

    collectionStore.store.setState(initialState);
  }

  const startTime = Date.now();

  function getElapsedTime() {
    return Date.now() - startTime;
  }

  const renderResults: any[] = [];

  function onRender(renderResult: any) {
    renderResults.push(renderResult);
  }

  return {
    serverMock,
    collectionStore,
    getElapsedTime,
    onRender,
    renderResults,
  };
}

export function createRenderStore() {
  let renders: any[] = [];
  let rendersTime: number[] = [];
  let startTime = Date.now();

  function add(render: Record<string, unknown>) {
    renders.push(render);
    rendersTime.push(Date.now() - startTime);

    if (renders.length > 100) {
      throw new Error('Too many renders');
    }
  }

  function renderCount() {
    return renders.length;
  }

  function getSnapshot(rendersToSnapshot: any[]) {
    return `\n${rendersToSnapshot
      .map((render) => {
        let line = '';

        for (const [key, value] of Object.entries(render)) {
          line += `${key}: ${
            typeof value === 'object' && value !== null
              ? JSON.stringify(value).replace(/"/g, '').replace(/,/g, ', ')
              : value
          } -- `;
        }

        line = line.slice(0, -4);
        return line;
      })
      .join('\n')}\n`;
  }

  return {
    add,
    reset(keepLastRender = false) {
      renders = keepLastRender ? [renders.at(-1)] : [];
      rendersTime = [];
      startTime = Date.now();
    },
    get snapshot() {
      return getSnapshot(renders);
    },
    get changesSnapshot() {
      const changes: any[] = [];

      for (const [current, prev] of arrayWithPrev(renders)) {
        if (!deepEqual(current, prev)) {
          changes.push(current);
        }
      }

      return getSnapshot(changes);
    },
    renderCount,
    get rendersTime() {
      return rendersTime;
    },
  };
}

export function createValueStore<T>(initialValue: T) {
  const store = new Store({
    state: { value: initialValue },
  });

  return {
    store,
    useValue() {
      return store.useSelector((state) => state.value);
    },
    set(value: T) {
      store.setState({ value });
    },
  };
}
