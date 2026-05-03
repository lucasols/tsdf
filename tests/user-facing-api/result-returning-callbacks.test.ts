import { typingTest } from '@ls-stack/utils/typingTestUtils';
import { Result } from 't-result';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  createCollectionStore,
  createDocumentStore,
  createListQueryStore,
  createStoreManager,
  StoreFetchError,
  StoreMutationError,
  type StoreError,
} from '../../src/main';
import { flushAllTimers } from '../utils/genericTestUtils';

const TEST_NOW = new Date('2025-01-01T00:00:00.000Z').getTime();

const storesToDispose: { dispose: () => void }[] = [];
let nextStoreId = 0;

class ApiError extends Error {
  readonly path: string;
  readonly method: StoreError['method'];
  readonly code: number;

  constructor(
    message: string,
    path: string,
    method: StoreError['method'] = 'GET',
    code = 500,
  ) {
    super(message);
    this.name = 'ApiError';
    this.path = path;
    this.method = method;
    this.code = code;
  }
}

function normalizeError(exception: Error): StoreError {
  if (exception instanceof ApiError) {
    return {
      code: exception.code,
      id: 'fetch-error',
      message: exception.message,
      path: exception.path,
      method: exception.method,
    };
  }

  return { code: 500, id: 'unexpected-error', message: exception.message };
}

function createManager() {
  return createStoreManager({
    getSessionKey: () => 'test-session',
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 0,
    baseCoalescingWindowMs: 0,
    blockWindowClose: null,
  });
}

function trackStore<TStore extends { dispose: () => void }>(store: TStore) {
  storesToDispose.push(store);
  return store;
}

function createStoreId(label: string) {
  nextStoreId += 1;
  return `result-callbacks-${label}-${nextStoreId}`;
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(() => {
  for (const store of storesToDispose.splice(0)) {
    store.dispose();
  }

  vi.runOnlyPendingTimers();
});

describe('Result-returning fetch functions', () => {
  test('document fetch accepts Result.ok and Result.err', async () => {
    const fetchDocumentFromApi = () => Promise.resolve(Result.ok({ value: 2 }));

    const okStore = trackStore(
      createDocumentStore({
        id: createStoreId('document-ok'),
        storeManager: createManager(),
        fetchFn: () => fetchDocumentFromApi(),
      }),
    );

    const okPromise = okStore.getDataFromStateOrFetch();

    await flushAllTimers();

    const okResult = await okPromise;

    expect(okResult.ok ? okResult.value : null).toMatchInlineSnapshot(`
      value: 2
    `);

    const fetchDocumentErrorFromApi = () =>
      Promise.resolve(
        Result.err(new ApiError('result fetch failed', '/document')),
      );

    const errStore = trackStore(
      createDocumentStore<{ value: number }>({
        id: createStoreId('document-error'),
        storeManager: createManager(),
        fetchFn: () => fetchDocumentErrorFromApi(),
      }),
    );

    const errPromise = errStore.getDataFromStateOrFetch();

    await flushAllTimers();

    const errResult = await errPromise;

    expect(errResult.ok).toBe(false);
    expect(errResult.ok ? null : errResult.error).toBeInstanceOf(
      StoreFetchError,
    );
    expect(errResult.ok ? null : errResult.error).toMatchInlineSnapshot(`
      Error#:
        message: 'result fetch failed'
        name: 'StoreFetchError'
        code: 500
        id: 'fetch-error'
        type: 'fetch'
        path: '/document'
        method: 'GET'
    `);
  });

  test('collection fetch accepts Result.ok and Result.err', async () => {
    const fetchItemFromApi = () =>
      Promise.resolve(Result.ok({ value: { name: 'result' } }));

    const okStore = trackStore(
      createCollectionStore<{ value: { name: string } }, string>({
        id: createStoreId('collection-ok'),
        storeManager: createManager(),
        fetchFn: () => fetchItemFromApi(),
      }),
    );

    const okPromise = okStore.getItemFromStateOrFetch('item-1');

    await flushAllTimers();

    const okResult = await okPromise;

    expect(okResult.ok ? okResult.value : null).toMatchInlineSnapshot(`
      value: { name: 'result' }
    `);

    const fetchItemErrorFromApi = () =>
      Promise.resolve(
        Result.err(
          new ApiError('collection result fetch failed', '/collection/item-1'),
        ),
      );

    const errStore = trackStore(
      createCollectionStore<{ value: { name: string } }, string>({
        id: createStoreId('collection-error'),
        storeManager: createManager(),
        fetchFn: () => fetchItemErrorFromApi(),
      }),
    );

    const errPromise = errStore.getItemFromStateOrFetch('item-1');

    await flushAllTimers();

    const errResult = await errPromise;

    expect(errResult.ok ? null : errResult.error).toBeInstanceOf(
      StoreFetchError,
    );
    expect(errResult.ok ? null : errResult.error.message).toBe(
      'collection result fetch failed',
    );
  });

  test('list query fetch accepts Result.ok and Result.err', async () => {
    const fetchListFromApi = () =>
      Promise.resolve(
        Result.ok({
          items: [{ itemPayload: 'users||1', data: { id: 1, name: 'result' } }],
          hasMore: false,
        }),
      );

    const okStore = trackStore(
      createListQueryStore<
        { id: number; name: string },
        { tableId: string },
        string
      >({
        id: createStoreId('list-ok'),
        storeManager: createManager(),
        fetchListFn: () => fetchListFromApi(),
      }),
    );

    const okPromise = okStore.getQueryFromStateOrFetch({ tableId: 'users' });

    await flushAllTimers();

    const okResult = await okPromise;

    expect(okResult.ok ? okResult.value : null).toMatchInlineSnapshot(`
      hasMore: '❌'
      items:
        - data: { id: 1, name: 'result' }
          itemPayload: 'users||1'
    `);

    const fetchListErrorFromApi = () =>
      Promise.resolve(
        Result.err(new ApiError('list result fetch failed', '/list/users')),
      );

    const errStore = trackStore(
      createListQueryStore<
        { id: number; name: string },
        { tableId: string },
        string
      >({
        id: createStoreId('list-error'),
        storeManager: createManager(),
        fetchListFn: () => fetchListErrorFromApi(),
      }),
    );

    const errPromise = errStore.getQueryFromStateOrFetch({ tableId: 'users' });

    await flushAllTimers();

    const errResult = await errPromise;

    expect(errResult.ok ? null : errResult.error).toBeInstanceOf(
      StoreFetchError,
    );
    expect(errResult.ok ? null : errResult.error.message).toBe(
      'list result fetch failed',
    );
  });
});

describe('Result-returning mutations', () => {
  test('document mutation accepts promised Result and promised value-or-throw callbacks', async () => {
    const store = trackStore(
      createDocumentStore<{ value: number }>({
        id: createStoreId('document-mutation'),
        storeManager: createManager(),
        fetchFn: () => Promise.resolve({ value: 1 }),
      }),
    );

    const loadPromise = store.getDataFromStateOrFetch();

    await flushAllTimers();

    expect((await loadPromise).ok ? store.store.state.data : null)
      .toMatchInlineSnapshot(`
        value: 1
      `);

    const saveDocumentWithResult = () =>
      Promise.resolve(Result.ok({ value: 2 }));

    const okResult = await store.performMutation({
      mutation: () => saveDocumentWithResult(),
    });

    expect(okResult.ok ? okResult.value : null).toMatchInlineSnapshot(`
      value: 2
    `);

    const saveDocumentValueOrThrow = () => Promise.resolve({ value: 3 });

    const valueResult = await store.performMutation({
      mutation: () => saveDocumentValueOrThrow(),
    });

    expect(valueResult.ok ? valueResult.value : null).toMatchInlineSnapshot(`
      value: 3
    `);

    const failDocumentWithResult = () =>
      Promise.resolve(
        Result.err(new ApiError('result mutation failed', '/document', 'POST')),
      );

    const errResult = await store.performMutation({
      optimisticUpdate: () => {
        store.updateState((draft) => {
          draft.value = 99;
        });
      },
      mutation: () => failDocumentWithResult(),
    });

    expect(errResult.ok ? null : errResult.error).toBeInstanceOf(
      StoreMutationError,
    );

    if (errResult.ok || !(errResult.error instanceof StoreMutationError)) {
      throw new Error('Expected mutation to fail with StoreMutationError');
    }

    expect({
      name: errResult.error.name,
      message: errResult.error.message,
      kind: errResult.error.kind,
      code: errResult.error.code,
      id: errResult.error.id,
      path: errResult.error.path,
      method: errResult.error.method,
    }).toMatchInlineSnapshot(`
      code: 500
      id: 'fetch-error'
      kind: 'error'
      message: 'result mutation failed'
      method: 'POST'
      name: 'StoreMutationError'
      path: '/document'
    `);
    expect(store.store.state.data).toMatchInlineSnapshot(`
      value: 1
    `);
  });

  test('collection and list-query mutations unwrap Result.ok', async () => {
    const collectionStore = trackStore(
      createCollectionStore<{ name: string }, string>({
        id: createStoreId('collection-mutation'),
        storeManager: createManager(),
        fetchFn: () => Promise.resolve({ name: 'server' }),
      }),
    );
    const listStore = trackStore(
      createListQueryStore<
        { id: number; name: string },
        { tableId: string },
        string
      >({
        id: createStoreId('list-mutation'),
        storeManager: createManager(),
        fetchListFn: () => Promise.resolve({ items: [], hasMore: false }),
      }),
    );

    collectionStore.addItemToState('item-1', { name: 'server' });
    listStore.addItemToState('users||1', { id: 1, name: 'server' });

    const saveCollectionWithResult = () =>
      Promise.resolve(Result.ok({ saved: 'collection' }));
    const saveListWithResult = () =>
      Promise.resolve(Result.ok({ saved: 'list' }));

    const collectionResult = await collectionStore.performMutation('item-1', {
      mutation: () => saveCollectionWithResult(),
    });
    const listResult = await listStore.performMutation('users||1', {
      mutation: () => saveListWithResult(),
      onSuccess(response_) {
        typingTest.expectTypesAreEqual<typeof response_, { saved: string }>();
      },
    });

    expect(collectionResult.ok ? collectionResult.value : null)
      .toMatchInlineSnapshot(`
        saved: 'collection'
      `);
    expect(listResult.ok ? listResult.value : null).toMatchInlineSnapshot(`
      saved: 'list'
    `);
  });
});
