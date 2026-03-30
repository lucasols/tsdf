import {
  afterEach,
  assert,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { createCollectionStoreTestEnv } from '../mocks/collectionStoreTestEnv';
import { createDocumentStoreTestEnv } from '../mocks/documentStoreTestEnv';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { advanceTime } from '../utils/genericTestUtils';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
});

function createBlockWindowCloseSpy() {
  const unblock = vi.fn();
  const blockWindowClose = vi.fn(() => ({ unblock }));

  return { blockWindowClose, unblock };
}

describe('performMutation blockWindowClose', () => {
  test('document store supports custom blockWindowClose option', async () => {
    const { blockWindowClose, unblock } = createBlockWindowCloseSpy();
    const env = createDocumentStoreTestEnv(1, { blockWindowClose });

    const mutationPromise = env.apiStore.performMutation({
      debounce: {
        context: 'document:block-window-close',
        payload: 'doc-1',
        ms: 20,
      },
      mutation: () => Promise.resolve('ok'),
    });

    await advanceTime(20);
    const result = await mutationPromise;

    assert(result.ok);
    expect(result.value).toBe('ok');
    expect(blockWindowClose).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledTimes(1);
  });

  test('collection store supports custom blockWindowClose option', async () => {
    const { blockWindowClose, unblock } = createBlockWindowCloseSpy();
    const env = createCollectionStoreTestEnv(
      { 'item-1': { name: 'Item 1' } },
      { blockWindowClose },
    );

    const mutationPromise = env.apiStore.performMutation('item-1', {
      debounce: {
        context: 'collection:block-window-close',
        payload: 'item-1',
        ms: 20,
      },
      mutation: () => Promise.resolve('ok'),
    });

    await advanceTime(20);
    const result = await mutationPromise;

    assert(result.ok);
    expect(result.value).toBe('ok');
    expect(blockWindowClose).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledTimes(1);
  });

  test('list query store supports custom blockWindowClose option', async () => {
    const { blockWindowClose, unblock } = createBlockWindowCloseSpy();
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'User 1' }] },
      { blockWindowClose },
    );

    const mutationPromise = env.apiStore.performMutation('users||1', {
      debounce: {
        context: 'list-query:block-window-close',
        payload: 'users||1',
        ms: 20,
      },
      mutation: () => Promise.resolve('ok'),
    });

    await advanceTime(20);
    const result = await mutationPromise;

    assert(result.ok);
    expect(result.value).toBe('ok');
    expect(blockWindowClose).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledTimes(1);
  });

  test('blockWindowClose disabled when store option is null', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    const documentEnv = createDocumentStoreTestEnv(1);
    const collectionEnv = createCollectionStoreTestEnv({
      'item-1': { name: 'Item 1' },
    });
    const listQueryEnv = createListQueryStoreTestEnv({
      users: [{ id: 1, name: 'User 1' }],
    });

    const documentMutation = documentEnv.apiStore.performMutation({
      debounce: {
        context: 'null-document:block-window-close',
        payload: 'doc-1',
        ms: 20,
      },
      mutation: () => Promise.resolve('ok-doc'),
    });

    const collectionMutation = collectionEnv.apiStore.performMutation(
      'item-1',
      {
        debounce: {
          context: 'null-collection:block-window-close',
          payload: 'item-1',
          ms: 20,
        },
        mutation: () => Promise.resolve('ok-collection'),
      },
    );

    const listQueryMutation = listQueryEnv.apiStore.performMutation(
      'users||1',
      {
        debounce: {
          context: 'null-list-query:block-window-close',
          payload: 'users||1',
          ms: 20,
        },
        mutation: () => Promise.resolve('ok-list-query'),
      },
    );

    await advanceTime(20);

    const [documentResult, collectionResult, listQueryResult] =
      await Promise.all([
        documentMutation,
        collectionMutation,
        listQueryMutation,
      ]);

    const beforeUnloadEventCalls = addEventListenerSpy.mock.calls.filter(
      (args) => args[0] === 'beforeunload',
    );
    const removeBeforeUnloadEventCalls =
      removeEventListenerSpy.mock.calls.filter(
        (args) => args[0] === 'beforeunload',
      );

    assert(documentResult.ok);
    assert(collectionResult.ok);
    assert(listQueryResult.ok);
    expect(beforeUnloadEventCalls).toHaveLength(0);
    expect(removeBeforeUnloadEventCalls).toHaveLength(0);

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });
});
