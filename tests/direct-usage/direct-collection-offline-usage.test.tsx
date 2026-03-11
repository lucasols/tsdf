import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_boolean, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createCollectionStore,
  type CollectionOfflineOperationDefinition,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  localPersistentStorage,
} from '../../src/main';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';

const todoSchema = rc_object({ title: rc_string, completed: rc_boolean });
const todoInputSchema = rc_object({ id: rc_string, title: rc_string });
const FETCH_DELAY_MS = 30;
type TodoPayload = { id: string };
type TodoItem = { title: string; completed: boolean };

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type RenameTodoOperations = {
  renameTodo: CollectionOfflineOperationDefinition<
    TodoItem,
    TodoPayload,
    { id: string; title: string },
    unknown,
    { id: string; title: string }
  >;
};

function createTypedCollectionStore_() {
  return createCollectionStore<TodoItem, TodoPayload, RenameTodoOperations>({
    id: 'typed-direct-offline-collection',
    getSessionKey: () => 'typed-direct-offline-collection-session',
    fetchFn: (_payload_: TodoPayload) =>
      Promise.resolve({ title: 'typed', completed: false }),
    getCollectionItemKey: (payload: TodoPayload) => payload.id,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 1,
    baseCoalescingWindowMs: 1,
    blockWindowClose: null,
    persistentStorage: {
      storeName: 'typed-direct-offline-collection',
      adapter: localPersistentStorage,
      schema: todoSchema,
      offlineMode: {
        operations: {
          renameTodo: {
            inputSchema: todoInputSchema,
            execute: ({ input }) => input,
          },
        },
      },
    },
  });
}

type CollectionOfflineOption = NonNullable<
  Parameters<
    ReturnType<typeof createTypedCollectionStore_>['performMutation']
  >[1]['offline']
>;

const validCollectionOfflineOption_: CollectionOfflineOption = {
  operation: 'renameTodo',
  input: { id: '1', title: 'Offline todo' },
};
const invalidCollectionOfflineInput_: CollectionOfflineOption | undefined =
  // @ts-expect-error invalid collection offline input must be rejected
  { operation: 'renameTodo', input: { title: 'x' } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_INITIAL_TIME);
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

test('direct collection store offline public api works and stays strongly typed', async () => {
  let online = true;
  const sessionKey = 'direct-collection-offline-session';
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });

  const todoState = new Map<string, TodoItem>([
    ['1', { title: 'Todo 1', completed: false }],
  ]);

  const collectionStore = createCollectionStore<
    TodoItem,
    TodoPayload,
    RenameTodoOperations
  >({
    id: 'direct-collection-offline',
    getSessionKey: () => sessionKey,
    fetchFn: async (payload: TodoPayload) => {
      await delay(FETCH_DELAY_MS);
      const item = todoState.get(payload.id);
      if (!item) {
        throw new Error(`Missing todo ${payload.id}`);
      }
      return { ...item };
    },
    getCollectionItemKey: (payload: TodoPayload) => payload.id,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      storeName: 'direct-collection-offline',
      adapter: localPersistentStorage,
      schema: todoSchema,
      offlineMode: {
        network: { enabled: true, getIsOffline: () => !online },
        operations: {
          renameTodo: {
            inputSchema: todoInputSchema,
            execute: ({ input, helpers }) => {
              todoState.set(input.id, { title: input.title, completed: false });
              helpers.updateItemState({ id: input.id }, (item) => ({
                ...item,
                title: input.title,
              }));
              return input;
            },
          },
        },
      },
    },
  });

  const payload = { id: '1' };
  const collectionHook = renderHook(() => collectionStore.useItem(payload));
  await flushAllTimers();

  expect(validCollectionOfflineOption_).toMatchInlineSnapshot(`
    input: { id: '1', title: 'Offline todo' }
    operation: 'renameTodo'
  `);
  expect(invalidCollectionOfflineInput_).toBeDefined();
  expect(collectionHook.result.current.data).toMatchInlineSnapshot(`
    completed: '❌'
    title: 'Todo 1'
  `);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
  });

  online = false;
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
  await Promise.resolve();

  await act(async () => {
    await collectionStore.performMutation(payload, {
      optimisticUpdate: (itemPayload) => {
        collectionStore.updateItemState(itemPayload, (item) => ({
          ...item,
          title: 'Todo 1 offline',
        }));
      },
      mutation: () =>
        Promise.resolve({ title: 'Todo 1 offline', completed: false }),
      offline: {
        operation: 'renameTodo',
        input: { id: '1', title: 'Todo 1 offline' },
      },
    });
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(collectionStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  await collectionStore.resolveOfflineConflict('missing', {
    resolution: 'noop',
  });
  expect(
    pick(collectionHook.result.current, [
      'data',
      'itemStateKey',
      'payload',
      'status',
    ]),
  ).toMatchInlineSnapshot(`
    data: { completed: '❌', title: 'Todo 1 offline' }
    itemStateKey: '"1'
    payload: { id: '1' }
    status: 'success'
  `);
  expect(collectionStore.getOfflineEntities()).toMatchObject([
    { entityKey: '"1', pendingMutations: 1, storeType: 'collection' },
  ]);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchObject([
    { storeName: 'direct-collection-offline' },
  ]);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'offline',
    effectiveOffline: true,
    network: { active: true, enabled: true },
  });

  await act(async () => {
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
  });

  expect(collectionStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(collectionHook.result.current.isPendingOfflineSync).toBe(false);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });
});

test('collection offline accumulation merges same-item mutations and keeps different items separate', async () => {
  let online = true;
  const sessionKey = 'direct-collection-offline-accumulation-session';
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });

  const todoState = new Map<string, TodoItem>([
    ['1', { title: 'Todo 1', completed: false }],
    ['2', { title: 'Todo 2', completed: false }],
  ]);
  const execute = vi.fn(
    ({
      input,
      helpers,
    }: {
      input: { id: string; title: string };
      helpers: {
        getItemState: (payload: TodoPayload) => TodoItem | null;
        updateItemState: (
          payload: TodoPayload | TodoPayload[],
          updater: (item: TodoItem) => TodoItem | undefined,
        ) => boolean;
        addItemToState: (payload: TodoPayload, data: TodoItem) => void;
        deleteItemState: (payload: TodoPayload | TodoPayload[]) => void;
        invalidateItem: (payload: TodoPayload) => void;
        getItemKey: (payload: TodoPayload) => string;
      };
    }) => {
      todoState.set(input.id, { title: input.title, completed: false });
      helpers.updateItemState({ id: input.id }, (item) => ({
        ...item,
        title: input.title,
      }));
      return input;
    },
  );

  const collectionStore = createCollectionStore<
    TodoItem,
    TodoPayload,
    RenameTodoOperations
  >({
    id: 'direct-collection-offline-accumulation',
    getSessionKey: () => sessionKey,
    fetchFn: async (payload: TodoPayload) => {
      await delay(FETCH_DELAY_MS);
      const item = todoState.get(payload.id);
      if (!item) {
        throw new Error(`Missing todo ${payload.id}`);
      }
      return { ...item };
    },
    getCollectionItemKey: (payload: TodoPayload) => payload.id,
    errorNormalizer: normalizeError,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      storeName: 'direct-collection-offline-accumulation',
      adapter: localPersistentStorage,
      schema: todoSchema,
      offlineMode: {
        network: { enabled: true, getIsOffline: () => !online },
        operations: {
          renameTodo: {
            inputSchema: todoInputSchema,
            accumulation: { mergeInput: ({ incomingInput }) => incomingInput },
            execute,
          },
        },
      },
    },
  });

  await flushAllTimers();

  online = false;
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
  await Promise.resolve();

  await act(async () => {
    await collectionStore.performMutation(
      { id: '1' },
      {
        optimisticUpdate: (itemPayload) => {
          collectionStore.updateItemState(itemPayload, (item) => ({
            ...item,
            title: 'Todo 1 first',
          }));
        },
        mutation: () =>
          Promise.resolve({ title: 'Todo 1 first', completed: false }),
        offline: {
          operation: 'renameTodo',
          input: { id: '1', title: 'Todo 1 first' },
        },
      },
    );
  });

  await act(async () => {
    await collectionStore.performMutation(
      { id: '1' },
      {
        optimisticUpdate: (itemPayload) => {
          collectionStore.updateItemState(itemPayload, (item) => ({
            ...item,
            title: 'Todo 1 second',
          }));
        },
        mutation: () =>
          Promise.resolve({ title: 'Todo 1 second', completed: false }),
        offline: {
          operation: 'renameTodo',
          input: { id: '1', title: 'Todo 1 second' },
        },
      },
    );
  });

  await act(async () => {
    await collectionStore.performMutation(
      { id: '2' },
      {
        optimisticUpdate: (itemPayload) => {
          collectionStore.updateItemState(itemPayload, (item) => ({
            ...item,
            title: 'Todo 2 offline',
          }));
        },
        mutation: () =>
          Promise.resolve({ title: 'Todo 2 offline', completed: false }),
        offline: {
          operation: 'renameTodo',
          input: { id: '2', title: 'Todo 2 offline' },
        },
      },
    );
  });
  await Promise.resolve();

  expect(collectionStore.getOfflineEntities()).toMatchObject([
    { entityKey: '"1', pendingMutations: 1, storeType: 'collection' },
    { entityKey: '"2', pendingMutations: 1, storeType: 'collection' },
  ]);

  await act(async () => {
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTimersAsync();
  });

  expect(execute).toHaveBeenCalledTimes(2);
  expect(
    execute.mock.calls
      .map((call) => call[0].input)
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  ).toMatchInlineSnapshot(`
    - { id: '1', title: 'Todo 1 second' }
    - { id: '2', title: 'Todo 2 offline' }
  `);
});
