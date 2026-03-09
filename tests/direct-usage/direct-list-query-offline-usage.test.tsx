import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_number, rc_object, rc_string } from 'runcheck';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createListQueryStore,
  getGlobalOfflineEntities,
  getGlobalOfflineStatus,
  type ListQueryOfflineOperationDefinition,
} from '../../src/main';
import type { OfflineMutationDescriptor } from '../../src/persistentStorage/offline/types';
import { normalizeError, TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers, pick } from '../utils/genericTestUtils';

type UsersQueryPayload = { tableId: 'users' };
type UserPayload = { tableId: 'users'; id: number };
type User = { id: number; name: string };

const userSchema = rc_object({ id: rc_number, name: rc_string });
const userInputSchema = rc_object({ id: rc_number, name: rc_string });
const FETCH_DELAY_MS = 30;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

type RenameUserOperations = {
  renameUser: ListQueryOfflineOperationDefinition<
    User,
    UsersQueryPayload,
    UserPayload,
    { id: number; name: string },
    unknown,
    { id: number; name: string }
  >;
};

const typedListQueryOperations_: RenameUserOperations = {
  renameUser: { inputSchema: userInputSchema, execute: ({ input }) => input },
};

const typedListQueryStore_ = createListQueryStore<
  User,
  UsersQueryPayload,
  UserPayload,
  false,
  false,
  RenameUserOperations
>({
  id: 'typed-direct-offline-list-query',
  getSessionKey: () => 'typed-direct-offline-list-query-session',
  fetchListFn: (_payload_: UsersQueryPayload) =>
    Promise.resolve({ items: [], hasMore: false }),
  fetchItemFn: (payload: UserPayload) =>
    Promise.resolve({ id: payload.id, name: 'typed' }),
  getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
  getItemKey: (payload: UserPayload) => ['users', payload.id],
  errorNormalizer: normalizeError,
  defaultQuerySize: 2,
  lowPriorityThrottleMs: 1,
  baseCoalescingWindowMs: 1,
  blockWindowClose: null,
  persistentStorage: {
    storeName: 'typed-direct-offline-list-query',
    backend: 'localStorage',
    schema: userSchema,
    offlineMode: { operations: typedListQueryOperations_ },
  },
});

const validListQueryOfflineOption_: OfflineMutationDescriptor<
  typeof typedListQueryOperations_
> = { operation: 'renameUser', input: { id: 1, name: 'Offline Ada' } };

function assertTypedListQueryOfflineUsage_() {
  void typedListQueryStore_.performMutation(
    { tableId: 'users', id: 1 },
    {
      mutation: () => Promise.resolve({ id: 1, name: 'Ada' }),
      offline: { operation: 'renameUser', input: { id: 1, name: 'Ada' } },
    },
  );

  void typedListQueryStore_.performMutation(
    { tableId: 'users', id: 1 },
    {
      mutation: () => Promise.resolve({ id: 1, name: 'Ada' }),
      offline: {
        operation: 'renameUser',
        // @ts-expect-error invalid list-query offline input must be rejected
        input: { id: 'x', name: 'Ada' },
      },
    },
  );
}

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

test('direct list-query store offline public api works and stays strongly typed', async () => {
  let online = true;
  const sessionKey = 'direct-list-query-offline-session';
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });

  const userState = new Map<number, User>([
    [1, { id: 1, name: 'Ada' }],
    [2, { id: 2, name: 'Grace' }],
  ]);

  const listQueryStore = createListQueryStore<
    User,
    UsersQueryPayload,
    UserPayload,
    false,
    false,
    RenameUserOperations
  >({
    id: 'direct-list-query-offline',
    getSessionKey: () => sessionKey,
    fetchListFn: async (_payload__: UsersQueryPayload, size: number) => {
      await delay(FETCH_DELAY_MS);
      return {
        items: [...userState.values()]
          .slice(0, size)
          .map((user) => ({
            itemPayload: { tableId: 'users' as const, id: user.id },
            data: { ...user },
          })),
        hasMore: userState.size > size,
      };
    },
    fetchItemFn: async (payload: UserPayload) => {
      await delay(FETCH_DELAY_MS);
      const item = userState.get(payload.id);
      if (!item) {
        throw new Error(`Missing user ${payload.id}`);
      }
      return { ...item };
    },
    getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
    getItemKey: (payload: UserPayload) => ['users', payload.id],
    errorNormalizer: normalizeError,
    defaultQuerySize: 2,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      storeName: 'direct-list-query-offline',
      backend: 'localStorage',
      schema: userSchema,
      offlineMode: {
        network: { enabled: true, getIsOffline: () => !online },
        operations: {
          renameUser: {
            inputSchema: userInputSchema,
            execute: ({ input, helpers }) => {
              userState.set(input.id, { id: input.id, name: input.name });
              helpers.updateItemState(
                { tableId: 'users', id: input.id },
                (item) => ({ ...item, name: input.name }),
              );
              return input;
            },
          },
        },
      },
    },
  });

  const queryPayload = { tableId: 'users' as const };
  const userPayload = { tableId: 'users' as const, id: 1 };

  const listHook = renderHook(() =>
    listQueryStore.useListQuery(queryPayload, {
      loadSize: 2,
      itemSelector: (item) => item.name,
    }),
  );
  await flushAllTimers();

  expect(validListQueryOfflineOption_).toMatchInlineSnapshot(`
    input: { id: 1, name: 'Offline Ada' }
    operation: 'renameUser'
  `);
  expect(assertTypedListQueryOfflineUsage_).toBeTypeOf('function');
  expect(listHook.result.current.items).toMatchInlineSnapshot(`
    ['Ada', 'Grace']
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
    await listQueryStore.performMutation(userPayload, {
      optimisticUpdate: (payload) => {
        if (Array.isArray(payload) || typeof payload === 'function') return;
        listQueryStore.updateItemState(payload, (item) => ({
          ...item,
          name: 'Ada offline',
        }));
      },
      mutation: () => Promise.resolve({ id: 1, name: 'Ada offline' }),
      offline: {
        operation: 'renameUser',
        input: { id: 1, name: 'Ada offline' },
      },
    });
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(listQueryStore.getOfflineConflicts()).toMatchInlineSnapshot(`[]`);
  await listQueryStore.resolveOfflineConflict('missing', {
    resolution: 'noop',
  });
  expect(
    pick(listHook.result.current, ['items', 'payload', 'queryKey', 'status']),
  ).toMatchInlineSnapshot(`
    items: ['Ada offline', 'Grace']
    payload: { tableId: 'users' }
    queryKey: '["users"]'
    status: 'success'
  `);
  expect(listQueryStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: listQueryStore.getItemKey(userPayload),
      pendingMutations: 1,
      storeType: 'listQuery',
    },
  ]);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchObject([
    { storeName: 'direct-list-query-offline' },
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

  expect(listQueryStore.getOfflineEntities()).toMatchInlineSnapshot(`[]`);
  expect(getGlobalOfflineEntities(sessionKey)).toMatchInlineSnapshot(`[]`);
  expect(listHook.result.current.isPendingOfflineSync).toBe(false);
  expect(getGlobalOfflineStatus(sessionKey)).toMatchObject({
    effectiveMode: 'online',
    effectiveOffline: false,
    network: { active: false, enabled: true },
  });
});

test('list-query offline accumulation merges same-item mutations and keeps different items separate', async () => {
  let online = true;
  const sessionKey = 'direct-list-query-offline-accumulation-session';
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });

  const userState = new Map<number, User>([
    [1, { id: 1, name: 'Ada' }],
    [2, { id: 2, name: 'Grace' }],
  ]);
  const execute = vi.fn(
    ({
      input,
      helpers,
    }: {
      input: { id: number; name: string };
      helpers: {
        getItemState: (payload: UserPayload) => User | null;
        updateItemState: (
          payload: UserPayload | UserPayload[],
          updater: (item: User) => User | undefined,
        ) => boolean;
        addItemToState: (payload: UserPayload, data: User) => void;
        deleteItemState: (payload: UserPayload | UserPayload[]) => void;
        invalidateItem: (payload: UserPayload) => void;
        invalidateQueryAndItems: (args: {
          itemPayload:
            | UserPayload
            | UserPayload[]
            | ((item: UserPayload) => boolean)
            | false;
          queryPayload:
            | UsersQueryPayload
            | UsersQueryPayload[]
            | ((query: UsersQueryPayload) => boolean)
            | false;
        }) => void;
        getItemKey: (payload: UserPayload) => string;
        getQueryKey: (payload: UsersQueryPayload) => string;
      };
    }) => {
      userState.set(input.id, { id: input.id, name: input.name });
      helpers.updateItemState({ tableId: 'users', id: input.id }, (item) => ({
        ...item,
        name: input.name,
      }));
      return { id: input.id, name: input.name };
    },
  );

  const listQueryStore = createListQueryStore<
    User,
    UsersQueryPayload,
    UserPayload,
    false,
    false,
    RenameUserOperations
  >({
    id: 'direct-list-query-offline-accumulation',
    getSessionKey: () => sessionKey,
    fetchListFn: async (_payload__: UsersQueryPayload, size: number) => {
      await delay(FETCH_DELAY_MS);
      return {
        items: [...userState.values()]
          .slice(0, size)
          .map((user) => ({
            itemPayload: { tableId: 'users' as const, id: user.id },
            data: { ...user },
          })),
        hasMore: userState.size > size,
      };
    },
    fetchItemFn: async (payload: UserPayload) => {
      await delay(FETCH_DELAY_MS);
      const item = userState.get(payload.id);
      if (!item) {
        throw new Error(`Missing user ${payload.id}`);
      }
      return { ...item };
    },
    getQueryKey: (_payload_: UsersQueryPayload) => ['users'],
    getItemKey: (payload: UserPayload) => ['users', payload.id],
    errorNormalizer: normalizeError,
    defaultQuerySize: 2,
    lowPriorityThrottleMs: 5,
    baseCoalescingWindowMs: 10,
    blockWindowClose: null,
    persistentStorage: {
      storeName: 'direct-list-query-offline-accumulation',
      backend: 'localStorage',
      schema: userSchema,
      offlineMode: {
        network: { enabled: true, getIsOffline: () => !online },
        operations: {
          renameUser: {
            inputSchema: userInputSchema,
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
    await listQueryStore.performMutation(
      { tableId: 'users', id: 1 },
      {
        optimisticUpdate: (payload) => {
          if (Array.isArray(payload) || typeof payload === 'function') return;
          listQueryStore.updateItemState(payload, (item) => ({
            ...item,
            name: 'Ada first',
          }));
        },
        mutation: () => Promise.resolve({ id: 1, name: 'Ada first' }),
        offline: {
          operation: 'renameUser',
          input: { id: 1, name: 'Ada first' },
        },
      },
    );
  });

  await act(async () => {
    await listQueryStore.performMutation(
      { tableId: 'users', id: 1 },
      {
        optimisticUpdate: (payload) => {
          if (Array.isArray(payload) || typeof payload === 'function') return;
          listQueryStore.updateItemState(payload, (item) => ({
            ...item,
            name: 'Ada second',
          }));
        },
        mutation: () => Promise.resolve({ id: 1, name: 'Ada second' }),
        offline: {
          operation: 'renameUser',
          input: { id: 1, name: 'Ada second' },
        },
      },
    );
  });

  await act(async () => {
    await listQueryStore.performMutation(
      { tableId: 'users', id: 2 },
      {
        optimisticUpdate: (payload) => {
          if (Array.isArray(payload) || typeof payload === 'function') return;
          listQueryStore.updateItemState(payload, (item) => ({
            ...item,
            name: 'Grace offline',
          }));
        },
        mutation: () => Promise.resolve({ id: 2, name: 'Grace offline' }),
        offline: {
          operation: 'renameUser',
          input: { id: 2, name: 'Grace offline' },
        },
      },
    );
  });
  await Promise.resolve();

  expect(listQueryStore.getOfflineEntities()).toMatchObject([
    {
      entityKey: listQueryStore.getItemKey({ tableId: 'users', id: 1 }),
      pendingMutations: 1,
      storeType: 'listQuery',
    },
    {
      entityKey: listQueryStore.getItemKey({ tableId: 'users', id: 2 }),
      pendingMutations: 1,
      storeType: 'listQuery',
    },
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
      .toSorted((left, right) => left.id - right.id),
  ).toMatchInlineSnapshot(`
    - { id: 1, name: 'Ada second' }
    - { id: 2, name: 'Grace offline' }
  `);
});
