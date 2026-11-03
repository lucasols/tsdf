import { sleep } from '@ls-stack/utils/sleep';
import {
  afterEach,
  assert,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { mutationSkipped } from '../../src/main';
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
  test('document store uses the manager blockWindowClose default', async () => {
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

  test('collection store uses the manager blockWindowClose default', async () => {
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

  test('list query store uses the manager blockWindowClose default', async () => {
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

  test('non-debounced mutations block window close until they settle', async () => {
    const { blockWindowClose, unblock } = createBlockWindowCloseSpy();
    const env = createDocumentStoreTestEnv(1, { blockWindowClose });

    // A regular mutation that takes 2s to finish, e.g. a chat message send
    // waiting on link previews before posting
    const mutationPromise = env.apiStore.performMutation({
      mutation: async () => {
        await sleep(2000);
        return 'ok';
      },
    });

    // Window close is blocked as soon as the mutation starts...
    expect(blockWindowClose).toHaveBeenCalledTimes(1);
    expect(unblock).not.toHaveBeenCalled();

    // ...and stays blocked while the mutation is still in flight
    await advanceTime(1999);
    expect(unblock).not.toHaveBeenCalled();

    // Only released once the mutation settles
    await advanceTime(1);
    const result = await mutationPromise;

    assert(result.ok);
    expect(blockWindowClose).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledTimes(1);
  });

  test('failed mutations release the window close block', async () => {
    const { blockWindowClose, unblock } = createBlockWindowCloseSpy();
    const env = createCollectionStoreTestEnv(
      { 'item-1': { name: 'Item 1' } },
      { blockWindowClose },
    );

    const mutationPromise = env.apiStore.performMutation('item-1', {
      mutation: async () => {
        await sleep(500);
        throw new Error('server error');
      },
    });

    // Blocked while the failing request is in flight
    expect(blockWindowClose).toHaveBeenCalledTimes(1);
    expect(unblock).not.toHaveBeenCalled();

    await advanceTime(500);
    const result = await mutationPromise;

    // The block is released even though the mutation failed with the
    // server error
    assert(!result.ok);
    expect(result.error).toMatchInlineSnapshot(`
      Error#:
        message: 'server error'
        name: 'StoreMutationError'
        kind: 'error'
        code: 500
        id: 'fetch-error'
        cause:
          Error#: { message: 'server error', name: 'Error' }
    `);
    expect(unblock).toHaveBeenCalledTimes(1);
  });

  test('superseded debounced mutations release their window close block', async () => {
    const { blockWindowClose, unblock } = createBlockWindowCloseSpy();
    const env = createListQueryStoreTestEnv(
      { users: [{ id: 1, name: 'User 1' }] },
      { blockWindowClose },
    );

    const debounce = {
      context: 'list-query:superseded-block-window-close',
      payload: 'users||1',
      ms: 20,
    };

    const firstMutation = env.apiStore.performMutation('users||1', {
      debounce,
      mutation: () => Promise.resolve('first'),
    });
    const secondMutation = env.apiStore.performMutation('users||1', {
      debounce,
      mutation: () => Promise.resolve('second'),
    });

    // Both calls hold a block while waiting for the debounce
    expect(blockWindowClose).toHaveBeenCalledTimes(2);
    expect(unblock).not.toHaveBeenCalled();

    await advanceTime(20);
    const [firstResult, secondResult] = await Promise.all([
      firstMutation,
      secondMutation,
    ]);

    // The superseded call is skipped, the last one is sent, and both
    // release their blocks
    assert(!firstResult.ok);
    expect(firstResult.error).toBe(mutationSkipped);
    assert(secondResult.ok);
    expect(secondResult.value).toBe('second');
    expect(unblock).toHaveBeenCalledTimes(2);
  });

  test('blockWindowClose is disabled when the manager default is null', async () => {
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
