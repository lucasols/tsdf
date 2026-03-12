import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { rc_string } from 'runcheck';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { localPersistentStorage } from '../../src/main';
import { createListQueryStoreTestEnv } from '../mocks/listQueryStoreTestEnv';
import { TEST_INITIAL_TIME } from '../mocks/testEnvUtils';
import { flushAllTimers } from '../utils/genericTestUtils';
import { createOfflineNetworkMock } from '../utils/networkMock';
import {
  collectionCreateInputSchema,
  listQueryQueryPayloadSchema,
} from './offlineTestShared';
import {
  type CreateListQueryUserOperations,
  type PatchUserOperations,
  userPatchSchema,
  userRowSchema,
} from './offlineReplayTestShared';

describe('offline replay list-query behavior', () => {
  let network = createOfflineNetworkMock();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_INITIAL_TIME);
    network = createOfflineNetworkMock();
    network.install();
    localStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    localStorage.clear();
  });

  test('list-query offline replay uses explicit entity refs from the offline input', async () => {
    network.setOffline();
    const execute = vi.fn(
      ({
        input,
        enqueuedAt,
      }: {
        input: { itemId: string; name: string };
        enqueuedAt: number;
      }) => {
        expect(enqueuedAt).toBe(TEST_INITIAL_TIME);
        env.apiStore.updateItemState(input.itemId, (item) => ({
          ...item,
          name: input.name,
        }));

        return { name: input.name };
      },
    );

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(
      { users: [{ id: 1, name: 'Ada' }] },
      {
        getSessionKey: () => 'offline-replay-mutation-payload-session',
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          storeName: 'offline-replay-mutation-payload',
          adapter: localPersistentStorage,
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            operations: {
              patchUserName: {
                inputSchema: userPatchSchema,
                getEntityRefs: ({ input }) => [input.itemId],
                execute,
              },
            },
          },
        },
      },
    );

    await env.apiStore.performMutation('users||1', {
      mutation: () => Promise.resolve({ name: 'Ada offline' }),
      offline: {
        operation: 'patchUserName',
        input: { itemId: 'users||1', name: 'Ada offline' },
      },
    });

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]?.input.itemId).toBe('users||1');
  });

  test('type safety: list-query test env requires explicit offline operation typing', () => {
    const initialTables = { users: [{ id: 1, name: 'Ada' }] };
    const plainEnv = createListQueryStoreTestEnv(initialTables);
    const typedEnv = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      PatchUserOperations
    >(initialTables);

    function typeCheck_() {
      void plainEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada offline' }),
        // @ts-expect-error - offline mutations should not be available by default
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
      });

      void typedEnv.apiStore.performMutation('users||1', {
        mutation: () => Promise.resolve({ name: 'Ada offline' }),
        offline: {
          operation: 'patchUserName',
          input: { itemId: 'users||1', name: 'Ada offline' },
        },
      });
    }

    void typeCheck_;
    expect(true).toBe(true);
  });

  test('list-query temp creates keep manually inserted query items after replay', async () => {
    network.setOffline();
    let nextUserId = 3;

    const env = createListQueryStoreTestEnv<
      { id: number; name: string },
      false,
      false,
      CreateListQueryUserOperations
    >(
      {
        users: [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ],
      },
      {
        getSessionKey: () => 'offline-replay-temp-list-query-session',
        testScenario: { loaded: { queries: [{ tableId: 'users' }] } },
        persistentStorage: {
          storeName: 'offline-replay-temp-list-query',
          adapter: localPersistentStorage,
          schema: userRowSchema,
          itemPayloadSchema: rc_string,
          queryPayloadSchema: listQueryQueryPayloadSchema,
          offlineMode: {
            network: network.config,
            operations: {
              createUser: {
                inputSchema: collectionCreateInputSchema,
                getEntityRefs: () => [],
                tempEntity: {
                  createTempId: (input) => `temp:${input.name}`,
                  buildPendingEntity: (input) => ({ id: -1, name: input.name }),
                  reconcileServerEntity: (result) => ({
                    finalPayload: `users||${result.id}`,
                    finalData: result,
                  }),
                },
                execute: ({ input }) => {
                  const result = { id: nextUserId, name: input.name };
                  nextUserId += 1;
                  return result;
                },
              },
            },
          },
        },
      },
    );

    const hook = renderHook(() => {
      const query = env.apiStore.useListQuery(
        { tableId: 'users' },
        { itemSelector: (item) => item.name },
      );
      env.trackItemUI('query-status', query.status);
      env.trackItemUI('query-items', query.items.join(', '));
      return query;
    });
    await flushAllTimers();

    await act(async () => {
      await env.apiStore.performMutation(null, {
        optimisticUpdate: () => {
          env.apiStore.addItemToState(
            'temp:Linus offline',
            { id: -1, name: 'Linus offline' },
            {
              addItemToQueries: {
                queries: [{ tableId: 'users' }],
                appendTo: 'end',
              },
            },
          );
        },
        mutation: () => Promise.resolve({ id: 3, name: 'Linus offline' }),
        offline: { operation: 'createUser', input: { name: 'Linus offline' } },
      });
    });

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus offline']
    `);

    act(() => {
      network.goOnline();
    });
    await flushAllTimers();

    expect(hook.result.current.items).toMatchInlineSnapshot(`
      ['Ada', 'Grace', 'Linus offline']
    `);
    expect(env.apiStore.getItemState('users||3')).toMatchInlineSnapshot(`
      id: 3
      name: 'Linus offline'
    `);
    expect(
      env.serverTable.getRequestHistory('list', { includeTime: false }),
    ).toMatchInlineSnapshot(`[]`);
    expect(env.timelineString).toMatchInlineSnapshot(`
      "
      time | query-items               | query-status |
      0    | Ada, Grace                | success      | [query-status, query-items] ui-initialized
      10ms | Ada, Grace                | error        | [query-status] ui-changed
      4s   | Ada, Grace, Linus offline | error        | [query-items] ui-changed
      "
    `);

    hook.unmount();
  });
});
